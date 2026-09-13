import { mapResult, type AppError } from "@trip/core";
import { TWILIO_ERROR_CODES, TwilioErrorSchema, TwilioMessagePageSchema, TwilioMessageSchema } from "./contracts";
import { httpRequest, type FetchLike } from "./http";
import type { MessagingClient } from "./interfaces";

export interface TwilioConfig {
  /** https://api.twilio.com in real mode, the twin's URL otherwise. */
  readonly baseUrl: string;
  readonly accountSid: string;
  readonly fromNumber: string;
  /** Account auth token. Used when no API key is given. */
  readonly authToken?: string;
  /** An API key (SK...) and its secret sign requests instead of the auth token; the URL still uses the account SID. */
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
  readonly timeoutMs?: number;
}

const INBOUND_PAGE_SIZE = 200;
const ISO_DATE_LENGTH = 10;

function twilioFailure(status: number, body: unknown, to: string): AppError | null {
  const parsed = TwilioErrorSchema.safeParse(body);
  if (!parsed.success) return null;
  const { code, message } = parsed.data;
  if (code === TWILIO_ERROR_CODES.unsubscribedRecipient) {
    return { kind: "conflict", service: "messaging", resource: `recipient ${to}`, code: String(code), detail: message };
  }
  return { kind: "upstream_failed", service: "messaging", status, detail: `${code}: ${message}` };
}

export function createTwilioMessagingClient(config: TwilioConfig, fetchImpl: FetchLike = fetch): MessagingClient {
  const [username, password] =
    config.apiKeySid !== undefined && config.apiKeySecret !== undefined ? [config.apiKeySid, config.apiKeySecret] : [config.accountSid, config.authToken ?? ""];
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const messagesUrl = `${config.baseUrl}/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

  return {
    channel: "sms",

    send: async ({ to, body }) => {
      const result = await httpRequest(fetchImpl, {
        service: "messaging",
        method: "POST",
        url: messagesUrl,
        headers: { authorization },
        body: { kind: "form", value: { To: to, From: config.fromNumber, Body: body } },
        schema: TwilioMessageSchema,
        resource: `message to ${to}`,
        timeoutMs: config.timeoutMs,
        mapFailure: (status, responseBody) => twilioFailure(status, responseBody, to),
      });
      return mapResult(result, (m) => ({ externalId: m.sid, to: m.to, sentAt: new Date(Date.parse(m.date_created)).toISOString() }));
    },

    listInbound: async (since, from) => {
      // Twilio filters DateSent by calendar day only, so this deliberately over-fetches and trims.
      const params = new URLSearchParams({
        To: config.fromNumber,
        "DateSent>": since.toISOString().slice(0, ISO_DATE_LENGTH),
        PageSize: String(INBOUND_PAGE_SIZE),
      });
      const result = await httpRequest(fetchImpl, {
        service: "messaging",
        method: "GET",
        url: `${messagesUrl}?${params}`,
        headers: { authorization },
        schema: TwilioMessagePageSchema,
        resource: "inbound messages",
        timeoutMs: config.timeoutMs,
        mapFailure: (status, responseBody) => twilioFailure(status, responseBody, config.fromNumber),
      });
      return mapResult(result, (page) =>
        page.messages
          .filter((m) => m.direction === "inbound" && Date.parse(m.date_sent ?? m.date_created) >= since.getTime())
          .filter((m) => from === undefined || from.includes(m.from))
          .map((m) => ({
            externalId: m.sid,
            from: m.from,
            body: m.body,
            receivedAt: new Date(Date.parse(m.date_sent ?? m.date_created)).toISOString(),
          })),
      );
    },
  };
}
