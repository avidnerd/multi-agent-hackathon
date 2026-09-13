import { createLogger, LOG_LEVELS, type LogLevel } from "@trip/core";
import { googleCalendarTwin } from "./google-calendar/twin";
import { inventoryTwin } from "./inventory/twin";
import { startTwin } from "./kit/twin-app";
import { twilioTwin } from "./twilio/twin";

const DEFAULT_PORTS = { inventory: 4100, twilio: 4101, calendar: 4102 } as const;
const EXIT_FAILURE = 1;

function portFrom(url: string | undefined, fallback: number): number {
  if (url === undefined || url === "") return fallback;
  const port = Number(new URL(url).port);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

const minLevel: LogLevel = LOG_LEVELS.find((level) => level === process.env.LOG_LEVEL) ?? "info";
const logger = createLogger({ sink: (line) => process.stdout.write(`${JSON.stringify(line)}\n`), now: () => new Date(), minLevel });

const running = await Promise.all([
  startTwin(inventoryTwin, portFrom(process.env.TWIN_INVENTORY_URL, DEFAULT_PORTS.inventory)),
  startTwin(twilioTwin, portFrom(process.env.TWIN_TWILIO_URL, DEFAULT_PORTS.twilio)),
  startTwin(googleCalendarTwin, portFrom(process.env.TWIN_CALENDAR_URL, DEFAULT_PORTS.calendar)),
]);
for (const twin of running) logger.info("twin.listening", { twin: twin.twin.runtime.name, url: twin.url });

async function shutdown(signal: string): Promise<void> {
  logger.info("twin.stopping", { signal });
  await Promise.all(running.map((twin) => twin.close()));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error("twin.stop_failed", { detail: error instanceof Error ? error.message : String(error) });
      process.exit(EXIT_FAILURE);
    });
  });
}
