import { ok } from "@trip/core";
import type { InboundMessage, MessagingClient } from "./interfaces";

export interface MessagingRoute {
  readonly handles: readonly string[];
  readonly client: MessagingClient;
}

/**
 * Sends each member's messages through the client that owns their handle, falling back otherwise.
 * Used by the live demo so one real phone gets real iMessages while the rest of the group is simulated
 * on the Twilio twin. The agent sees one MessagingClient and cannot tell the difference.
 */
export function createRoutedMessagingClient(routes: readonly MessagingRoute[], fallback: MessagingClient): MessagingClient {
  const clientFor = (handle: string): MessagingClient => routes.find((r) => r.handles.includes(handle))?.client ?? fallback;
  return {
    channel: routes[0]?.client.channel ?? fallback.channel,
    send: (message) => clientFor(message.to).send(message),
    listInbound: async (since, from) => {
      const routed = new Set(routes.flatMap((r) => r.handles));
      const requests: Array<[MessagingClient, readonly string[] | undefined]> = [
        ...routes.map((r): [MessagingClient, readonly string[]] => [r.client, from === undefined ? r.handles : from.filter((h) => r.handles.includes(h))]),
        [fallback, from?.filter((h) => !routed.has(h))],
      ];
      const merged: InboundMessage[] = [];
      for (const [client, handles] of requests) {
        if (handles !== undefined && handles.length === 0) continue;
        const result = await client.listInbound(since, handles);
        if (!result.ok) return result;
        merged.push(...result.value);
      }
      return ok(merged.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)));
    },
  };
}
