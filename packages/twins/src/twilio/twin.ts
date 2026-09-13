import type { Request, Response, Router } from "express";
import { z } from "zod";
import { IsoDateTimeSchema, PhoneE164Schema } from "@trip/core";
import {
  InjectedTwilioEventSchema,
  TWILIO_ERROR_CODES,
  TWILIO_MAX_BODY_CHARS,
  TWILIO_START_KEYWORDS,
  TWILIO_STOP_KEYWORDS,
  TWIN_TWILIO_CREDENTIALS,
  toRfc2822,
  type TwilioMessage,
} from "@trip/clients/contracts";
import type { TwinDefinition, TwinRuntime } from "../kit/twin-app";

const MessageRecordSchema = z.object({
  sid: z.string(),
  to: z.string(),
  from: z.string(),
  body: z.string(),
  direction: z.enum(["inbound", "outbound-api"]),
  sentAt: IsoDateTimeSchema,
});
type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const TwilioStateSchema = z.object({
  accountSid: z.string(),
  authToken: z.string(),
  ownedNumbers: z.array(PhoneE164Schema).min(1),
  messages: z.array(MessageRecordSchema),
  /** Numbers that texted a stop keyword. Twilio blocks sends to them with 21610. */
  optedOut: z.array(z.string()),
  counter: z.number().int().nonnegative(),
});
export type TwilioState = z.infer<typeof TwilioStateSchema>;

const STATUS = { created: 201, badRequest: 400, unauthorized: 401, notFound: 404 } as const;
const GENERIC_CODES: Readonly<Record<string, number>> = { rate_limited: TWILIO_ERROR_CODES.tooManyRequests, not_found: TWILIO_ERROR_CODES.notFound, invalid_request: 20001, internal: 20500 };
const SID_HEX_LENGTH = 32;
const SINGLE_SEGMENT_CHARS = 160;
const MULTIPART_SEGMENT_CHARS = 153;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;
const ISO_DATE_LENGTH = 10;

const seed = (): TwilioState => ({
  accountSid: TWIN_TWILIO_CREDENTIALS.accountSid,
  authToken: TWIN_TWILIO_CREDENTIALS.authToken,
  ownedNumbers: [TWIN_TWILIO_CREDENTIALS.fromNumber],
  messages: [],
  optedOut: [],
  counter: 0,
});

function nextSid(state: TwilioState): string {
  state.counter += 1;
  return `SM${state.counter.toString(16).padStart(SID_HEX_LENGTH, "0")}`;
}

const segments = (body: string): number => (body.length <= SINGLE_SEGMENT_CHARS ? 1 : Math.ceil(body.length / MULTIPART_SEGMENT_CHARS));

function toMessage(record: MessageRecord, accountSid: string, status?: TwilioMessage["status"]): TwilioMessage {
  const stamp = toRfc2822(Date.parse(record.sentAt));
  return {
    sid: record.sid,
    account_sid: accountSid,
    to: record.to,
    from: record.from,
    body: record.body,
    status: status ?? (record.direction === "inbound" ? "received" : "delivered"),
    direction: record.direction,
    date_created: stamp,
    date_updated: stamp,
    date_sent: stamp,
    num_segments: String(segments(record.body)),
    error_code: null,
    error_message: null,
    price: null,
    uri: `/2010-04-01/Accounts/${accountSid}/Messages/${record.sid}.json`,
  };
}

const SendFormSchema = z.object({ To: z.string().optional(), From: z.string().optional(), Body: z.string().optional() });

const ListQuerySchema = z.object({
  To: z.string().optional(),
  From: z.string().optional(),
  DateSent: z.string().optional(),
  "DateSent>": z.string().optional(),
  "DateSent<": z.string().optional(),
  PageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  Page: z.coerce.number().int().nonnegative().default(0),
});

function registerRoutes(router: Router, twin: TwinRuntime<TwilioState>): void {
  const fail = (res: Response, status: number, code: number, message: string): void => twin.sendError(res, status, String(code), message);

  const authorized = (req: Request, res: Response, accountSid: string | undefined): boolean => {
    const state = twin.current();
    const [scheme, encoded] = (req.get("authorization") ?? "").split(" ");
    const credentials = scheme === "Basic" && encoded !== undefined ? Buffer.from(encoded, "base64").toString("utf8") : "";
    if (credentials !== `${state.accountSid}:${state.authToken}` || accountSid !== state.accountSid) {
      fail(res, STATUS.unauthorized, TWILIO_ERROR_CODES.authenticate, "Authenticate");
      return false;
    }
    return true;
  };

  router.post("/2010-04-01/Accounts/:accountSid/Messages.json", (req, res) => {
    if (!authorized(req, res, req.params.accountSid)) return;
    const form = SendFormSchema.safeParse(req.body ?? {});
    const { To: to = "", From: from = "", Body: body = "" } = form.success ? form.data : {};
    const state = twin.current();

    if (!PhoneE164Schema.safeParse(to).success) return fail(res, STATUS.badRequest, TWILIO_ERROR_CODES.invalidToNumber, `The 'To' number ${to} is not a valid phone number.`);
    if (!state.ownedNumbers.includes(from)) {
      return fail(res, STATUS.badRequest, TWILIO_ERROR_CODES.invalidFromNumber, `The From phone number ${from} is not a valid, SMS-capable inbound phone number or short code for your account.`);
    }
    if (body.length === 0) return fail(res, STATUS.badRequest, TWILIO_ERROR_CODES.missingBody, "Message body is required.");
    if (body.length > TWILIO_MAX_BODY_CHARS) {
      return fail(res, STATUS.badRequest, TWILIO_ERROR_CODES.bodyTooLong, `The concatenated message body exceeds the ${TWILIO_MAX_BODY_CHARS} character limit.`);
    }
    if (state.optedOut.includes(to)) return fail(res, STATUS.badRequest, TWILIO_ERROR_CODES.unsubscribedRecipient, "Attempt to send to unsubscribed recipient");

    const record = twin.write((s) => {
      const created: MessageRecord = { sid: nextSid(s), to, from, body, direction: "outbound-api", sentAt: twin.now().toISOString() };
      s.messages.push(created);
      return created;
    });
    res.status(STATUS.created).json(toMessage(record, state.accountSid, "queued"));
  });

  router.get("/2010-04-01/Accounts/:accountSid/Messages.json", (req, res) => {
    if (!authorized(req, res, req.params.accountSid)) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, STATUS.badRequest, GENERIC_CODES.invalid_request ?? 0, parsed.error.message);
    const q = parsed.data;
    const state = twin.read(req);
    // Twilio's DateSent filters compare calendar days, not instants.
    const matching = state.messages
      .filter((m) => (q.To === undefined || m.to === q.To) && (q.From === undefined || m.from === q.From))
      .filter((m) => {
        const day = m.sentAt.slice(0, ISO_DATE_LENGTH);
        return (q.DateSent === undefined || day === q.DateSent) && (q["DateSent>"] === undefined || day >= q["DateSent>"]) && (q["DateSent<"] === undefined || day <= q["DateSent<"]);
      })
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.sid.localeCompare(a.sid));
    const start = q.Page * q.PageSize;
    const page = matching.slice(start, start + q.PageSize);
    const hasMore = start + q.PageSize < matching.length;
    res.json({
      messages: page.map((m) => toMessage(m, state.accountSid)),
      page: q.Page,
      page_size: q.PageSize,
      next_page_uri: hasMore ? `${req.path}?Page=${q.Page + 1}&PageSize=${q.PageSize}` : null,
      uri: req.originalUrl,
    });
  });

  router.get("/2010-04-01/Accounts/:accountSid/Messages/:sid.json", (req, res) => {
    if (!authorized(req, res, req.params.accountSid)) return;
    const state = twin.read(req);
    const message = state.messages.find((m) => m.sid === req.params.sid);
    if (message === undefined) return fail(res, STATUS.notFound, TWILIO_ERROR_CODES.notFound, `The requested resource ${req.path} was not found`);
    res.json(toMessage(message, state.accountSid));
  });
}

export const twilioTwin: TwinDefinition<TwilioState> = {
  name: "twilio",
  // No duplicate_webhook: the client polls instead of receiving webhooks. No partial_batch: Twilio has no batch send.
  supportedFaults: ["empty_200", "write_then_timeout", "rate_limit", "stale_read", "slow"],
  stateSchema: TwilioStateSchema,
  seed,
  defaultClock: new Date("2026-10-01T16:00:00Z"),
  errorBody: (status, code, message) => {
    const numeric = /^\d+$/.test(code) ? Number(code) : (GENERIC_CODES[code] ?? GENERIC_CODES.internal ?? 0);
    return { code: numeric, message, more_info: `https://www.twilio.com/docs/errors/${numeric}`, status };
  },
  routes: registerRoutes,
  injectEvent: (twin, raw) => {
    const parsed = InjectedTwilioEventSchema.safeParse(raw);
    if (!parsed.success) return { status: STATUS.badRequest, body: { error: { code: "invalid_request", message: parsed.error.message } } };
    const event = parsed.data;
    const record = twin.write((state) => {
      const keyword = event.body.trim().toUpperCase();
      if ((TWILIO_STOP_KEYWORDS as readonly string[]).includes(keyword) && !state.optedOut.includes(event.from)) state.optedOut.push(event.from);
      if ((TWILIO_START_KEYWORDS as readonly string[]).includes(keyword)) state.optedOut = state.optedOut.filter((n) => n !== event.from);
      const created: MessageRecord = {
        sid: nextSid(state),
        to: state.ownedNumbers[0] ?? TWIN_TWILIO_CREDENTIALS.fromNumber,
        from: event.from,
        body: event.body,
        direction: "inbound",
        sentAt: twin.now().toISOString(),
      };
      state.messages.push(created);
      return created;
    });
    return { status: STATUS.created, body: toMessage(record, twin.current().accountSid) };
  },
};
