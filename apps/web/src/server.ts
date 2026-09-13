import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describeError, type Result } from "@trip/core";
import { createTripSession } from "./session";

const DEFAULT_PORT = 4300;
const EXIT_FAILURE = 1;
const MAX_BODY_BYTES = 8_192;
const HTTP = { ok: 200, badRequest: 400, forbidden: 403, notFound: 404, conflict: 409, tooLarge: 413, serverError: 500 } as const;
const PORT = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
/** 127.0.0.1 keeps the board on this Mac. Set WEB_HOST=0.0.0.0 so phones on the same network can open betting links. */
const HOST = process.env.WEB_HOST?.trim() || "127.0.0.1";
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const PAGES: Readonly<Record<string, string>> = { "/": "/index.html", "/markets": "/markets.html" };
const STATIC_FILES: Readonly<Record<string, string>> = {
  "/index.html": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/markets.html": "text/html; charset=utf-8",
  "/markets.css": "text/css; charset=utf-8",
  "/markets.js": "text/javascript; charset=utf-8",
};
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body is too large");
    chunks.push(buffer);
  }
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const created = await createTripSession(process.env);
if (!created.ok) {
  out(`Concorde could not start: ${describeError(created.error)}`);
  process.exit(EXIT_FAILURE);
}
const trip = created.ok ? created.value : (undefined as never);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const reply = (result: Result<null>): void => (result.ok ? json(res, HTTP.ok, { ok: true }) : json(res, HTTP.conflict, { error: describeError(result.error) }));

  const handle = async (): Promise<void> => {
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, HTTP.ok, trip.snapshot());
    if (req.method === "GET" && url.pathname === "/api/markets") return json(res, HTTP.ok, trip.market.view(url.searchParams.get("player")));
    if (req.method === "POST" && url.pathname === "/api/bet") return reply(trip.market.bet(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/question") return reply(trip.market.propose(await readJson(req)));
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      // Texting the group, drafting and approving the booking stay on this Mac even when phones can reach the server.
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return json(res, HTTP.forbidden, { error: "Only the organizer's screen on this Mac can do that" });
      const action = trip.actions[url.pathname.slice("/api/".length)];
      if (action === undefined) return json(res, HTTP.notFound, { error: `There is no action at ${url.pathname}` });
      const result = await action();
      return result.ok ? json(res, HTTP.ok, trip.snapshot()) : json(res, HTTP.conflict, { error: describeError(result.error) });
    }
    const path = PAGES[url.pathname] ?? url.pathname;
    const type = STATIC_FILES[path];
    if (req.method !== "GET" || type === undefined) return json(res, HTTP.notFound, { error: `Nothing at ${url.pathname}` });
    res.writeHead(HTTP.ok, { "content-type": type });
    res.end(await readFile(join(PUBLIC_DIR, path)));
  };

  handle().catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const status = cause instanceof SyntaxError ? HTTP.badRequest : cause instanceof RangeError ? HTTP.tooLarge : HTTP.serverError;
    if (status === HTTP.serverError) out(`request ${req.method} ${url.pathname} failed: ${detail}`);
    if (!res.headersSent) json(res, status, { error: status === HTTP.badRequest ? "That request wasn't valid JSON" : detail });
  });
}).listen(PORT, HOST, () => out(`Concorde board on http://${HOST}:${PORT}`));
