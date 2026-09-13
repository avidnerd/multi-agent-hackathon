import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { err, ok } from "@trip/core";
import type { InboundMessage, MessagingClient } from "./interfaces";

/**
 * Real iMessage through this Mac's Messages app. Sends go through AppleScript; replies are read
 * from the local Messages database. No carrier registration is needed, but it only reaches Apple
 * devices, only works while this Mac is signed in and awake, and cannot see replies sent from the
 * same Apple ID the Mac is signed into.
 */

export const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const NANOS_PER_MS = 1_000_000;
const NANOS_PER_MS_BIG = 1_000_000n;
const MS_PER_SECOND = 1_000;
/** Old databases stored seconds since 2001; anything below this cannot be nanoseconds. */
const SECONDS_EPOCH_CEILING = 1e11;
export const IMESSAGE_SEND_TIMEOUT_MS = 20_000;
const INBOUND_LIMIT = 500;
const FULL_DISK_ACCESS_HINT = "Grant Full Disk Access to the app running the agent (System Settings > Privacy & Security > Full Disk Access) and restart it";

export type AppleScriptOutcome = { readonly ok: true } | { readonly ok: false; readonly timedOut: boolean; readonly detail: string };
export type AppleScriptRunner = (args: readonly string[], timeoutMs: number) => Promise<AppleScriptOutcome>;

export const runOsascript: AppleScriptRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("osascript", [...args], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error === null) resolve({ ok: true });
      else resolve({ ok: false, timedOut: error.killed === true, detail: (stderr || error.message).trim() });
    });
  });

/**
 * Recipient and body travel as argv, never spliced into the script, so message text cannot become AppleScript.
 * Accounts are walked one by one because some (Game Center, disabled RCS) throw when asked their service type,
 * which makes a `whose service type = iMessage` filter fail outright.
 */
const SEND_SCRIPT = [
  "on run argv",
  "set targetHandle to item 1 of argv",
  "set messageText to item 2 of argv",
  'tell application "Messages"',
  "set targetService to missing value",
  "repeat with candidate in accounts",
  "try",
  "if service type of candidate is iMessage and enabled of candidate then",
  "set targetService to candidate",
  "exit repeat",
  "end if",
  "end try",
  "end repeat",
  'if targetService is missing value then error "No enabled iMessage account in Messages"',
  "set targetBuddy to participant targetHandle of targetService",
  "send messageText to targetBuddy",
  "end tell",
  "end run",
] as const;

export const sendArgs = (to: string, body: string): string[] => [...SEND_SCRIPT.flatMap((line) => ["-e", line]), to, body];

/** Group chats are found by their display name; name and body travel as argv like the 1:1 script. */
const GROUP_SEND_SCRIPT = [
  "on run argv",
  "set chatName to item 1 of argv",
  "set messageText to item 2 of argv",
  'tell application "Messages"',
  "set targetChat to missing value",
  "repeat with candidate in chats",
  "try",
  "if name of candidate is chatName then",
  "set targetChat to candidate",
  "exit repeat",
  "end if",
  "end try",
  "end repeat",
  'if targetChat is missing value then error "No Messages group named " & chatName',
  "send messageText to targetChat",
  "end tell",
  "end run",
] as const;

export const groupSendArgs = (chatName: string, body: string): string[] => [...GROUP_SEND_SCRIPT.flatMap((line) => ["-e", line]), chatName, body];

const NSSTRING_MARKER = "NSString";
/** Bytes between the class name and the length prefix in a typedstream NSString. */
const NSSTRING_HEADER_BYTES = 5;
const TWO_BYTE_LENGTH_FLAG = 0x81;

/**
 * Since macOS Ventura many messages keep their text only in attributedBody, an archived
 * NSAttributedString. The plain string follows the NSString class marker, prefixed by its length.
 */
export function decodeAttributedBody(blob: Uint8Array): string | null {
  const bytes = Buffer.from(blob);
  const marker = bytes.indexOf(NSSTRING_MARKER);
  if (marker === -1) return null;
  let cursor = marker + NSSTRING_MARKER.length + NSSTRING_HEADER_BYTES;
  const lead = bytes[cursor];
  if (lead === undefined) return null;
  let length = lead;
  cursor += 1;
  if (lead === TWO_BYTE_LENGTH_FLAG) {
    if (cursor + 2 > bytes.length) return null;
    length = bytes.readUInt16LE(cursor);
    cursor += 2;
  }
  if (cursor + length > bytes.length) return null;
  return bytes.subarray(cursor, cursor + length).toString("utf8");
}

const ChatRowSchema = z.object({
  guid: z.string(),
  text: z.string().nullable(),
  attributedBody: z.instanceof(Uint8Array).nullable(),
  date: z.union([z.number(), z.bigint()]),
  handle: z.string(),
});

const appleDateToMs = (date: number | bigint): number => {
  const value = Number(date);
  return value < SECONDS_EPOCH_CEILING ? APPLE_EPOCH_MS + value * MS_PER_SECOND : APPLE_EPOCH_MS + value / NANOS_PER_MS;
};

export interface IMessageConfig {
  readonly chatDbPath?: string;
  /**
   * When set, every message goes to this group chat instead of a 1:1 thread, and only replies posted
   * in that group are read. The member a message is meant for is still named in its text.
   */
  readonly groupChatName?: string;
  readonly runAppleScript?: AppleScriptRunner;
  readonly now?: () => Date;
}

export function createIMessageClient(config: IMessageConfig = {}): MessagingClient {
  const chatDbPath = config.chatDbPath ?? CHAT_DB_PATH;
  const run = config.runAppleScript ?? runOsascript;
  const now = config.now ?? (() => new Date());

  return {
    channel: "imessage",

    send: async ({ to, body }) => {
      const group = config.groupChatName;
      const outcome = await run(group === undefined ? sendArgs(to, body) : groupSendArgs(group, body), IMESSAGE_SEND_TIMEOUT_MS);
      if (!outcome.ok) {
        // A send that timed out may still have gone out, and Messages has no idempotency, so it is never marked retry-safe.
        return err(
          outcome.timedOut
            ? { kind: "timeout", service: "messaging", afterMs: IMESSAGE_SEND_TIMEOUT_MS, retrySafe: false }
            : { kind: "upstream_failed", service: "messaging", status: null, detail: `Messages refused the send: ${outcome.detail}` },
        );
      }
      const sentAt = now().toISOString();
      return ok({ externalId: `imessage:${to}:${sentAt}`, to, sentAt });
    },

    listInbound: async (since, from) => {
      if (from === undefined || from.length === 0) {
        return err({ kind: "validation_failed", boundary: "user_input", issues: ["iMessage only reads replies from named trip members; pass their handles"] });
      }
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(chatDbPath, { readOnly: true });
        const placeholders = from.map(() => "?").join(", ");
        const group = config.groupChatName;
        const groupJoin = group === undefined ? "" : "JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id";
        const groupFilter = group === undefined ? "" : "AND c.display_name = ?";
        const statement = db.prepare(
          `SELECT m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody, m.date AS date, h.id AS handle
           FROM message m JOIN handle h ON h.ROWID = m.handle_id ${groupJoin}
           WHERE m.is_from_me = 0 AND m.date >= ? ${groupFilter} AND h.id IN (${placeholders})
           ORDER BY m.date ASC LIMIT ${INBOUND_LIMIT}`,
        );
        // Message dates are nanoseconds since 2001, past Number's safe range; node:sqlite throws unless asked for BigInt.
        statement.setReadBigInts(true);
        const sinceNanos = BigInt(Math.max(0, Math.floor(since.getTime() - APPLE_EPOCH_MS))) * NANOS_PER_MS_BIG;
        const rows = group === undefined ? statement.all(sinceNanos, ...from) : statement.all(sinceNanos, group, ...from);
        const messages: InboundMessage[] = [];
        for (const raw of rows) {
          const row = ChatRowSchema.safeParse(raw);
          if (!row.success) continue;
          const body = row.data.text ?? (row.data.attributedBody === null ? null : decodeAttributedBody(row.data.attributedBody));
          // Tapbacks, stickers and attachments carry no text; they are not answers.
          if (body === null || body.trim().length === 0) continue;
          messages.push({ externalId: row.data.guid, from: row.data.handle, body, receivedAt: new Date(appleDateToMs(row.data.date)).toISOString() });
        }
        return ok(messages);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const denied = /unable to open|authorization denied|not permitted/i.test(detail);
        return err({ kind: "upstream_failed", service: "messaging", status: null, detail: denied ? `${detail}. ${FULL_DISK_ACCESS_HINT}` : detail });
      } finally {
        db?.close();
      }
    },
  };
}
