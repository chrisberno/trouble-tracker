// pp-client/index.ts
// Public surface of pp-client. Adapters import ONLY from here.
// No PP.app/Perfex specifics leak past this boundary.

import crypto from 'crypto';
import type { CoreEvent, DeploymentConfig } from './types';
import { mapWebhookPayload } from './event-mapper';
import { isEventProcessed, markEventProcessed } from './internal-db';

export {
  createTicket,
  getTicket,
  addReply,
  updateStatus,
  resolveTicket,
  closeTicket,
} from './api-client';
export type {
  Ticket,
  Reply,
  ReplyAttachment,
  CoreEvent,
  TicketStatus,
  TicketPriority,
  DeploymentConfig,
  CreateTicketInput,
} from './types';
export {
  PpClientError,
  PpClientAuthError,
  PpClientNotFoundError,
  PpClientRateLimitError,
  PpClientServerError,
  DeploymentNotConfiguredError,
} from './types';

type EventHandler = (event: CoreEvent) => Promise<void>;
const handlers = new Map<CoreEvent['kind'], EventHandler[]>();

export function subscribe(events: CoreEvent['kind'][], handler: EventHandler): void {
  for (const kind of events) {
    const existing = handlers.get(kind) ?? [];
    handlers.set(kind, [...existing, handler]);
  }
}

// Phase 1 test handler — proves dispatch path works end-to-end.
// Phase 3 will replace this with the real bridge handler.
subscribe(
  [
    'ticket.created',
    'ticket.replied.customer',
    'ticket.replied.agent',
    'ticket.status_changed',
    'ticket.resolved',
    'ticket.closed',
    'ticket.deleted',
  ],
  async (event) => {
    const ticketId =
      'ticketId' in event ? event.ticketId : 'ticket' in event ? event.ticket.id : undefined;
    console.log(
      JSON.stringify({
        pp_client_event: true,
        kind: event.kind,
        ticketId,
        timestamp: new Date().toISOString(),
      }),
    );
  },
);

// Splice the in-body signature field out of the raw body string.
// Returns { spliced, signature } where `spliced` is the byte-string PP.app signed.
// Returns null if no signature field is found.
function spliceSignature(rawString: string): { spliced: string; signature: string } | null {
  // Match `,"signature":"<64-hex>"` or `"signature":"<64-hex>",`
  const midRe = /,"signature":"([0-9a-fA-F]{64})"/;
  const startRe = /"signature":"([0-9a-fA-F]{64})",/;

  const midMatch = rawString.match(midRe);
  if (midMatch) {
    const sig = midMatch[1];
    const spliced =
      rawString.slice(0, midMatch.index!) +
      rawString.slice(midMatch.index! + midMatch[0].length);
    return { spliced, signature: sig };
  }

  const startMatch = rawString.match(startRe);
  if (startMatch) {
    const sig = startMatch[1];
    const spliced =
      rawString.slice(0, startMatch.index!) +
      rawString.slice(startMatch.index! + startMatch[0].length);
    return { spliced, signature: sig };
  }

  return null;
}

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function handleWebhook(
  rawBody: Buffer,
  config: DeploymentConfig,
): Promise<{ events: CoreEvent[]; status: 'ok' | 'error' }> {
  const rawString = rawBody.toString('utf8');

  // 1. Splice signature out of raw body.
  const spliceResult = spliceSignature(rawString);
  if (!spliceResult) {
    console.warn(
      JSON.stringify({ pp_webhook: true, warning: 'no signature field in payload' }),
    );
    return { events: [], status: 'error' };
  }
  const { spliced, signature } = spliceResult;

  // 2. HMAC-SHA256 verify against signing secret.
  const secret = process.env.PP_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    console.warn(
      JSON.stringify({ pp_webhook: true, warning: 'PP_WEBHOOK_SIGNING_SECRET not set' }),
    );
    return { events: [], status: 'error' };
  }
  const computed = crypto.createHmac('sha256', secret).update(spliced).digest('hex');
  if (!safeHexEqual(computed, signature)) {
    console.warn(JSON.stringify({ pp_webhook: true, warning: 'signature mismatch' }));
    return { events: [], status: 'error' };
  }

  // 3. Parse the full raw body.
  let payload: { event?: string; timestamp?: string | number; data?: unknown };
  try {
    payload = JSON.parse(rawString);
  } catch (err) {
    console.warn(
      JSON.stringify({
        pp_webhook: true,
        warning: 'invalid JSON',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { events: [], status: 'error' };
  }

  if (!payload.event || !payload.timestamp) {
    console.warn(
      JSON.stringify({ pp_webhook: true, warning: 'missing event or timestamp' }),
    );
    return { events: [], status: 'error' };
  }

  // 4. Idempotency check.
  const eventId = `${payload.event}:${payload.timestamp}`;
  try {
    if (await isEventProcessed(eventId)) {
      console.log(
        JSON.stringify({ pp_webhook: true, info: 'duplicate event skipped', eventId }),
      );
      return { events: [], status: 'ok' };
    }
  } catch (err) {
    // If the idempotency store is unavailable, log but proceed — better to
    // process and risk a duplicate than drop the event entirely.
    console.warn(
      JSON.stringify({
        pp_webhook: true,
        warning: 'idempotency check failed; proceeding',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // 5. Map → CoreEvent[].
  const events = mapWebhookPayload(payload, config);

  // 6. Dispatch to registered handlers.
  for (const event of events) {
    const subscribers = handlers.get(event.kind) ?? [];
    for (const handler of subscribers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(
          JSON.stringify({
            pp_webhook: true,
            error: 'handler threw',
            kind: event.kind,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // 7. Mark as processed.
  try {
    await markEventProcessed(eventId);
  } catch (err) {
    console.warn(
      JSON.stringify({
        pp_webhook: true,
        warning: 'failed to mark event processed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { events, status: 'ok' };
}
