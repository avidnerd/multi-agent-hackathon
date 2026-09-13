import { z } from "zod";
import { PhoneE164Schema } from "@trip/core";

/** The subset of Twilio's 2010-04-01 Messages API we use, with Twilio's own field names and error codes. */

export const TWILIO_API_BASE_URL = "https://api.twilio.com";
export const TWILIO_MAX_BODY_CHARS = 1600;

export const TWILIO_ERROR_CODES = {
  authenticate: 20003,
  notFound: 20404,
  tooManyRequests: 20429,
  invalidToNumber: 21211,
  missingBody: 21602,
  invalidFromNumber: 21606,
  unsubscribedRecipient: 21610,
  bodyTooLong: 21617,
} as const;

/** Twilio's default opt-out and opt-in keywords. Carriers and Twilio honour these without app code. */
export const TWILIO_STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"] as const;
export const TWILIO_START_KEYWORDS = ["START", "YES", "UNSTOP"] as const;

/** Credentials the Twilio twin accepts. +15005550006 is Twilio's own magic test sender. */
export const TWIN_TWILIO_CREDENTIALS = {
  accountSid: "AC00000000000000000000000000000000",
  authToken: "twin-auth-token",
  fromNumber: "+15005550006",
} as const;

export const TwilioMessageSchema = z.object({
  sid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/),
  account_sid: z.string(),
  to: z.string(),
  from: z.string(),
  body: z.string(),
  status: z.enum(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed", "receiving", "received"]),
  direction: z.enum(["inbound", "outbound-api", "outbound-call", "outbound-reply"]),
  date_created: z.string(),
  date_updated: z.string(),
  date_sent: z.string().nullable(),
  num_segments: z.string(),
  error_code: z.number().int().nullable(),
  error_message: z.string().nullable(),
  price: z.string().nullable(),
  uri: z.string(),
});
export type TwilioMessage = z.infer<typeof TwilioMessageSchema>;

export const TwilioMessagePageSchema = z.object({
  messages: z.array(TwilioMessageSchema),
  page: z.number().int().nonnegative(),
  page_size: z.number().int().positive(),
  next_page_uri: z.string().nullable(),
  uri: z.string(),
});

export const TwilioErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  more_info: z.string(),
  status: z.number().int(),
});

/** Twilio renders timestamps in RFC 2822 with a numeric zone, e.g. "Fri, 09 Oct 2026 17:40:00 +0000". */
export function toRfc2822(ms: number): string {
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

export const InjectedTwilioEventSchema = z.discriminatedUnion("kind", [
  /** A member texting the agent's number. */
  z.object({ kind: z.literal("inbound_sms"), from: PhoneE164Schema, body: z.string().min(1).max(TWILIO_MAX_BODY_CHARS) }),
]);
export type InjectedTwilioEvent = z.infer<typeof InjectedTwilioEventSchema>;
