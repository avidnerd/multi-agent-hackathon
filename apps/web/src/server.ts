import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describeError } from "@trip/core";
import { createTripSession } from "./session";

const DEFAULT_PORT = 4300;
const EXIT_FAILURE = 1;
const HTTP = { ok: 200, notFound: 404, conflict: 409, serverError: 500 } as const;
const PORT = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC_FILES: Readonly<Record<string, string>> = {
  "/index.html": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
};

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const created = await createTripSession(process.env);
if (!created.ok) {
  out(`Concorde could not start: ${describeError(created.error)}`);
  process.exit(EXIT_FAILURE);
}
const trip = created.ok ? created.value : (undefined as never);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const handle = async (): Promise<void> => {
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, HTTP.ok, trip.snapshot());
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const action = trip.actions[url.pathname.slice("/api/".length)];
      if (action === undefined) return json(res, HTTP.notFound, { error: `There is no action at ${url.pathname}` });
      const result = await action();
      return result.ok ? json(res, HTTP.ok, trip.snapshot()) : json(res, HTTP.conflict, { error: describeError(result.error) });
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const type = STATIC_FILES[path];
    if (req.method !== "GET" || type === undefined) return json(res, HTTP.notFound, { error: `Nothing at ${url.pathname}` });
    res.writeHead(HTTP.ok, { "content-type": type });
    res.end(await readFile(join(PUBLIC_DIR, path)));
  };
  handle().catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    out(`request ${req.method} ${url.pathname} failed: ${detail}`);
    if (!res.headersSent) json(res, HTTP.serverError, { error: detail });
  });
}).listen(PORT, "127.0.0.1", () => out(`Concorde board on http://127.0.0.1:${PORT}`));
