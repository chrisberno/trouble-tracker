// adapters/bridge/human/twilio-flex/dispatch.ts
// In-process dispatch helper for the Twilio Flex bridge.
//
// Why this exists (2026-05-15): the bridge's race-loss path historically
// produced empty scope on task.attributes because pp-client's pub/sub
// publish() did not reach the bridge handler registered in /api/intake's
// runtime (Vercel per-route module isolation + bundler tree-shake — see
// adapters/inbound/web-form/handler.ts comments at the publish() site).
// PP's ticket.created webhook fires AFTER intake's prewriteBridgeMappingScope
// races against the bridge handler's read of bridge-db; race-loss tickets
// shipped with empty scope.
//
// This helper sidesteps the bundler concern entirely: a direct cross-module
// import of onTicketCreated + buildTwilioClient. /api/intake/route.ts wraps
// the call in next/server's after() for fire-and-forget semantics — form
// returns 201 immediately; bridge dispatch runs out-of-band with scope
// already known from the intake body.
//
// Idempotency safety net: PP's ticket.created webhook still fires after
// intake completes. The webhook receiver's bridge dispatch path re-enters
// onTicketCreated with the SAME ticketId → SAME idempotency key
// (`twilio:task:<ticketId>`) → isBridgeKeyProcessed returns true → handler
// short-circuits. No duplicate Twilio resources, no second TaskRouter task.
// This is the "in-process is fast-path, webhook is eventual-consistency
// backstop" doctrine (CTO-Connie, 2026-05-15).
//
// Error semantics: swallow + structured log. If onTicketCreated throws
// mid-execution (Twilio rate limit, network blip, partial Pattern B
// failure), customer still sees 201 from intake. PP webhook fires
// ~5-10s later, idempotency keys for partially-completed steps short-
// circuit, partially-failed steps retry. Eventual consistency.

import type { CoreEvent } from '@/pp-client/types';
import { buildTwilioClient } from './twilio-client';
import { onTicketCreated } from './handlers';
import type { TwilioBridgeConfig } from './types';

export async function dispatchTicketCreated(
  event: Extract<CoreEvent, { kind: 'ticket.created' }>,
  config: TwilioBridgeConfig,
): Promise<void> {
  const start = Date.now();
  try {
    const twilio = buildTwilioClient(config);
    await onTicketCreated(event, twilio);
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      dispatch: 'in-process',
      info: 'ticket.created dispatched',
      ticketId: event.ticket.id,
      durationMs: Date.now() - start,
    }));
  } catch (err) {
    // Swallow — PP webhook is the eventual-consistency backstop.
    // Idempotency keys protect against double-execution of successful steps.
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      dispatch: 'in-process',
      error: err instanceof Error ? err.message : String(err),
      ticketId: event.ticket.id,
      durationMs: Date.now() - start,
      info: 'PP webhook backstop will retry',
    }));
  }
}
