import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIMessageClient, decodeAttributedBody, sendArgs, type AppleScriptRunner } from "./imessage-client";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const appleNanos = (iso: string): bigint => BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000n;

/** Mirrors how Messages archives a short string in attributedBody. */
function archivedBody(text: string): Uint8Array {
  const utf8 = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from("streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84", "latin1"), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), Buffer.from([utf8.length]), utf8, Buffer.from([0x86])]);
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatdb-"));
  dbPath = join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);");
  db.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(1, "+14155550101");
  db.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(2, "+19998887777");
  const insert = db.prepare("INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("g-before", "old news", null, appleNanos("2026-09-01T00:00:00Z"), 0, 1);
  insert.run("g-plain", "the 9th works", null, appleNanos("2026-09-13T18:00:00Z"), 0, 1);
  insert.run("g-archived", null, archivedBody("budget around $600"), appleNanos("2026-09-13T18:05:00Z"), 0, 1);
  insert.run("g-mine", "sent by the Mac owner", null, appleNanos("2026-09-13T18:06:00Z"), 1, 1);
  insert.run("g-stranger", "someone not on the trip", null, appleNanos("2026-09-13T18:07:00Z"), 0, 2);
  insert.run("g-tapback", null, null, appleNanos("2026-09-13T18:08:00Z"), 0, 1);
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("iMessage client", () => {
  it("reads only replies from named members after the start, decoding archived bodies", async () => {
    const client = createIMessageClient({ chatDbPath: dbPath });
    const result = await client.listInbound(new Date("2026-09-13T00:00:00Z"), ["+14155550101"]);
    expect(result).toEqual({
      ok: true,
      value: [
        { externalId: "g-plain", from: "+14155550101", body: "the 9th works", receivedAt: "2026-09-13T18:00:00.000Z" },
        { externalId: "g-archived", from: "+14155550101", body: "budget around $600", receivedAt: "2026-09-13T18:05:00.000Z" },
      ],
    });
  });

  it("reads one group chat, counting this Mac's own messages as the self member unless the agent sent them", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT); CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);");
    db.prepare("INSERT INTO chat (ROWID, display_name) VALUES (?, ?)").run(1, "trip group");
    db.prepare("INSERT INTO chat (ROWID, display_name) VALUES (?, ?)").run(2, "some other chat");
    const insert = db.prepare("INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const link = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");
    const rows: ReadonlyArray<readonly [number, string, string, string, number, number, number]> = [
      [101, "grp-concorde", "Hi Subhi, which days work?", "2026-09-13T19:00:00Z", 1, 0, 1],
      [102, "grp-self", "I can do the 9th to 11th", "2026-09-13T19:01:00Z", 1, 0, 1],
      [103, "grp-member", "same, under $800", "2026-09-13T19:02:00Z", 0, 1, 1],
      [104, "dm-member", "not in the group", "2026-09-13T19:03:00Z", 0, 1, 2],
    ];
    for (const [id, guid, text, at, fromMe, handle, chat] of rows) {
      insert.run(id, guid, text, null, appleNanos(at), fromMe, handle);
      link.run(chat, id);
    }
    db.close();

    const client = createIMessageClient({ chatDbPath: dbPath, groupChatName: "trip group", selfHandle: "+17372285422", runAppleScript: async () => ({ ok: true }) });
    await client.send({ to: "+17372285422", body: "Hi Subhi, which days work?" });
    const result = await client.listInbound(new Date("2026-09-13T18:30:00Z"), ["+17372285422", "+14155550101"]);
    expect(result).toMatchObject({
      ok: true,
      value: [
        { externalId: "grp-self", from: "+17372285422", body: "I can do the 9th to 11th" },
        { externalId: "grp-member", from: "+14155550101", body: "same, under $800" },
      ],
    });
  });

  it("refuses to read without a list of member handles", async () => {
    const result = await createIMessageClient({ chatDbPath: dbPath }).listInbound(new Date(0));
    expect(result).toMatchObject({ ok: false, error: { kind: "validation_failed" } });
  });

  it("explains the permission to grant when the database cannot be opened", async () => {
    const result = await createIMessageClient({ chatDbPath: join(dir, "missing", "chat.db") }).listInbound(new Date(0), ["+14155550101"]);
    expect(result).toMatchObject({ ok: false, error: { kind: "upstream_failed", detail: expect.stringContaining("Full Disk Access") } });
  });

  it("passes recipient and text as arguments so message text cannot become AppleScript", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: AppleScriptRunner = async (args) => {
      calls.push(args);
      return { ok: true };
    };
    const body = 'nice" & do shell script "rm -rf ~" & "';
    const sent = await createIMessageClient({ runAppleScript: runner, now: () => new Date("2026-09-13T18:00:00Z") }).send({ to: "+14155550101", body });
    expect(sent).toEqual({ ok: true, value: { externalId: "imessage:+14155550101:2026-09-13T18:00:00.000Z", to: "+14155550101", sentAt: "2026-09-13T18:00:00.000Z" } });
    expect(calls[0]?.slice(-2)).toEqual(["+14155550101", body]);
    expect(calls[0]?.filter((a) => a !== "-e").slice(0, -2).join("\n")).not.toContain("rm -rf");
    expect(sendArgs("+1", "x")).toContain("send messageText to targetBuddy");
  });

  it("never marks a timed-out send as safe to retry", async () => {
    const sent = await createIMessageClient({ runAppleScript: async () => ({ ok: false, timedOut: true, detail: "" }) }).send({ to: "+14155550101", body: "hi" });
    expect(sent).toMatchObject({ ok: false, error: { kind: "timeout", retrySafe: false } });
  });

  it("decodes a two-byte length prefix and rejects blobs without a string", () => {
    const long = "x".repeat(300);
    const blob = Buffer.concat([Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81]), Buffer.from([300 & 0xff, 300 >> 8]), Buffer.from(long)]);
    expect(decodeAttributedBody(blob)).toBe(long);
    expect(decodeAttributedBody(Buffer.from("no marker here"))).toBeNull();
  });
});
