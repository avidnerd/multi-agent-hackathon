import { ok } from "@trip/core";
import type { ClientConfig } from "./config";
import { GOOGLE_CALENDAR_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL, TWILIO_API_BASE_URL, TWIN_GOOGLE_ACCESS_TOKEN, TWIN_TWILIO_CREDENTIALS } from "./contracts";
import { createGoogleCalendarClient, createGoogleTokenProvider } from "./google-calendar-client";
import type { FetchLike } from "./http";
import { createIMessageClient } from "./imessage-client";
import type { CalendarClient, InventoryClient, MessagingClient } from "./interfaces";
import { createInventoryClient } from "./inventory-client";
import { createTwilioMessagingClient } from "./twilio-client";

export interface Clients {
  readonly inventory: InventoryClient;
  readonly messaging: MessagingClient;
  readonly calendar: CalendarClient;
}

/** The only place that knows whether a client is real or twinned. */
export function createClients(config: ClientConfig, fetchImpl: FetchLike = fetch): Clients {
  const messaging =
    config.messaging.MESSAGING_MODE === "imessage"
      ? createIMessageClient({ chatDbPath: config.messaging.IMESSAGE_CHAT_DB })
      : config.messaging.MESSAGING_MODE === "twilio"
      ? createTwilioMessagingClient(
          {
            baseUrl: TWILIO_API_BASE_URL,
            accountSid: config.messaging.TWILIO_ACCOUNT_SID,
            authToken: config.messaging.TWILIO_AUTH_TOKEN,
            apiKeySid: config.messaging.TWILIO_API_KEY_SID,
            apiKeySecret: config.messaging.TWILIO_API_KEY_SECRET,
            fromNumber: config.messaging.TWILIO_FROM_NUMBER,
          },
          fetchImpl,
        )
      : createTwilioMessagingClient({ baseUrl: config.messaging.TWIN_TWILIO_URL, ...TWIN_TWILIO_CREDENTIALS }, fetchImpl);

  const calendar =
    config.calendar.CALENDAR_MODE === "google"
      ? createGoogleCalendarClient(
          {
            baseUrl: GOOGLE_CALENDAR_API_BASE_URL,
            calendarId: config.calendar.GOOGLE_CALENDAR_ID,
            accessToken: createGoogleTokenProvider(
              {
                tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
                clientId: config.calendar.GOOGLE_CLIENT_ID,
                clientSecret: config.calendar.GOOGLE_CLIENT_SECRET,
                refreshToken: config.calendar.GOOGLE_REFRESH_TOKEN,
              },
              fetchImpl,
            ),
          },
          fetchImpl,
        )
      : createGoogleCalendarClient(
          { baseUrl: config.calendar.TWIN_CALENDAR_URL, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) },
          fetchImpl,
        );

  const inventory = createInventoryClient({ baseUrl: config.inventory.TWIN_INVENTORY_URL }, fetchImpl);
  return { inventory, messaging, calendar };
}
