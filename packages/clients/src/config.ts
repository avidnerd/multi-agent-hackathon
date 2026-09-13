import { z } from "zod";
import { err, ok, PhoneE164Schema, type Result } from "@trip/core";

/** Empty strings from a .env template mean "not set". */
const unsetIfEmpty = (value: unknown): unknown => (value === "" ? undefined : value);
const required = z.preprocess(unsetIfEmpty, z.string().min(1));

const MessagingConfigSchema = z.discriminatedUnion("MESSAGING_MODE", [
  z.object({ MESSAGING_MODE: z.literal("twin"), TWIN_TWILIO_URL: z.url().default("http://127.0.0.1:4101") }),
  z.object({
    MESSAGING_MODE: z.literal("twilio"),
    TWILIO_ACCOUNT_SID: z.preprocess(unsetIfEmpty, z.string().regex(/^AC[0-9a-f]{32}$/, "must look like AC followed by 32 hex characters")),
    TWILIO_AUTH_TOKEN: required,
    TWILIO_FROM_NUMBER: z.preprocess(unsetIfEmpty, PhoneE164Schema),
  }),
]);

const CalendarConfigSchema = z.discriminatedUnion("CALENDAR_MODE", [
  z.object({ CALENDAR_MODE: z.literal("twin"), TWIN_CALENDAR_URL: z.url().default("http://127.0.0.1:4102") }),
  z.object({
    CALENDAR_MODE: z.literal("google"),
    GOOGLE_CLIENT_ID: required,
    GOOGLE_CLIENT_SECRET: required,
    GOOGLE_REFRESH_TOKEN: required,
    GOOGLE_CALENDAR_ID: z.preprocess(unsetIfEmpty, z.string().default("primary")),
  }),
]);

const InventoryConfigSchema = z.object({ TWIN_INVENTORY_URL: z.url().default("http://127.0.0.1:4100") });

export interface ClientConfig {
  readonly messaging: z.infer<typeof MessagingConfigSchema>;
  readonly calendar: z.infer<typeof CalendarConfigSchema>;
  readonly inventory: z.infer<typeof InventoryConfigSchema>;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function parseClientConfig(env: Env): Result<ClientConfig> {
  const withModes = {
    ...env,
    MESSAGING_MODE: unsetIfEmpty(env.MESSAGING_MODE) ?? "twin",
    CALENDAR_MODE: unsetIfEmpty(env.CALENDAR_MODE) ?? "twin",
    TWIN_INVENTORY_URL: unsetIfEmpty(env.TWIN_INVENTORY_URL),
    TWIN_TWILIO_URL: unsetIfEmpty(env.TWIN_TWILIO_URL),
    TWIN_CALENDAR_URL: unsetIfEmpty(env.TWIN_CALENDAR_URL),
  };
  const messaging = MessagingConfigSchema.safeParse(withModes);
  const calendar = CalendarConfigSchema.safeParse(withModes);
  const inventory = InventoryConfigSchema.safeParse(withModes);
  if (messaging.success && calendar.success && inventory.success) {
    return ok({ messaging: messaging.data, calendar: calendar.data, inventory: inventory.data });
  }
  const issues = [messaging.error, calendar.error, inventory.error]
    .flatMap((e) => e?.issues ?? [])
    .map((i) => `${i.path.join(".")}: ${i.message}`);
  return err({ kind: "validation_failed", boundary: "config", issues });
}
