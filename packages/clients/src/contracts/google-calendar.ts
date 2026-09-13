import { z } from "zod";

/**
 * The subset of Google Calendar API v3 we use. Notable real behaviours the twin reproduces:
 * Google does not reject overlapping events (overlap has to be checked with freeBusy); a
 * client-supplied event id that already exists returns 409 even after the event was deleted;
 * deleting an already-deleted event returns 410.
 */

export const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Google's rule for client-supplied ids: base32hex characters, 5 to 1024 long. */
export const GOOGLE_EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;
export const TWIN_GOOGLE_ACCESS_TOKEN = "twin-access-token";

export const EventDateTimeSchema = z.object({ dateTime: z.string(), timeZone: z.string().optional() });

export const AttendeeSchema = z.object({
  email: z.email(),
  responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
});

export const ExtendedPropertiesSchema = z.object({
  private: z.record(z.string(), z.string()).optional(),
  shared: z.record(z.string(), z.string()).optional(),
});

export const GoogleEventSchema = z.object({
  kind: z.literal("calendar#event"),
  id: z.string(),
  etag: z.string(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  htmlLink: z.string(),
  created: z.string(),
  updated: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: EventDateTimeSchema,
  end: EventDateTimeSchema,
  attendees: z.array(AttendeeSchema).optional(),
  transparency: z.enum(["opaque", "transparent"]).optional(),
  extendedProperties: ExtendedPropertiesSchema.optional(),
  sequence: z.number().int().nonnegative(),
});
export type GoogleEvent = z.infer<typeof GoogleEventSchema>;

export const GoogleEventWriteSchema = z.object({
  id: z.string().regex(GOOGLE_EVENT_ID_PATTERN, "Invalid resource id value.").optional(),
  summary: z.string(),
  description: z.string().optional(),
  start: EventDateTimeSchema,
  end: EventDateTimeSchema,
  attendees: z.array(AttendeeSchema).optional(),
  transparency: z.enum(["opaque", "transparent"]).optional(),
  extendedProperties: ExtendedPropertiesSchema.optional(),
});
export type GoogleEventWrite = z.infer<typeof GoogleEventWriteSchema>;

export const GoogleEventPatchSchema = GoogleEventWriteSchema.omit({ id: true }).partial();
export type GoogleEventPatch = z.infer<typeof GoogleEventPatchSchema>;

export const GoogleEventListSchema = z.object({
  kind: z.literal("calendar#events"),
  items: z.array(GoogleEventSchema),
  nextPageToken: z.string().optional(),
});

export const FreeBusyRequestSchema = z.object({
  timeMin: z.string(),
  timeMax: z.string(),
  items: z.array(z.object({ id: z.string() })).min(1),
});

export const FreeBusyResponseSchema = z.object({
  kind: z.literal("calendar#freeBusy"),
  timeMin: z.string(),
  timeMax: z.string(),
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })),
      errors: z.array(z.object({ domain: z.string(), reason: z.string() })).optional(),
    }),
  ),
});

export const GoogleErrorBodySchema = z.object({
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    errors: z.array(z.object({ domain: z.string(), reason: z.string(), message: z.string() })).optional(),
    status: z.string().optional(),
  }),
});

export const BusyBlockSchema = z.object({ start: z.string(), end: z.string() });

/** Twin-only: a member shares their calendar's free/busy with the organizer, as done once in Google Calendar settings. */
export const InjectedCalendarEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member_calendar_shared"), email: z.email(), busy: z.array(BusyBlockSchema) }),
]);
export type InjectedCalendarEvent = z.infer<typeof InjectedCalendarEventSchema>;

export const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string(),
});
