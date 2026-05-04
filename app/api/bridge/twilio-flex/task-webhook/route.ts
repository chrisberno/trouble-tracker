// app/api/bridge/twilio-flex/task-webhook/route.ts
// Twilio TaskRouter Workspace event-callback receiver.
// Triggered when ANY task on the CCT Workspace transitions state — INCLUDING
// legacy production tasks created by lib/taskrouter.ts.
//
// ============================================================================
// LOAD-BEARING SAFETY GATE — read this carefully before modifying.
// ============================================================================
//
// When ledger row B3 fires (post-Phase-3-deploy go-live), the live CCT
// Workspace starts firing event callbacks here for EVERY task transition.
// That includes legacy production tasks from lib/taskrouter.ts which set
// task attributes including a `ticketId` field (Postgres-backed legacy ID,
// type-incompatible with PP ticket IDs).
//
// **The discriminator is `attributes.deploymentId`, NOT presence of `ticketId`.**
// Bridge-created Interactions (handlers.onTicketCreated) set
// deploymentId: <currentDeployment.id>; legacy lib/taskrouter.ts does not.
//
// The gate MUST be the FIRST check in the handler, BEFORE any pp-client call.
// CCTO caught this during brief review v1.2; without the gate, B3-fire would
// fire pp-client.closeTicket(<legacy-postgres-id>) and break Connie production.
//
// CTO must visually verify this gate's presence + position pre-merge per
// Definition of done step #8.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { closeTicket } from '@/pp-client';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import { verifyTwilioSignature } from '@/adapters/bridge/human/twilio-flex/twilio-client';
import {
  isBridgeKeyProcessed,
  markBridgeKeyProcessed,
} from '@/adapters/bridge/human/twilio-flex/bridge-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reconstructFullUrl(req: NextRequest): string {
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const url = new URL(req.url);
  return `${forwardedProto}://${forwardedHost}${url.pathname}${url.search}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    const formParams: Record<string, string> = {};
    const parsed = new URLSearchParams(rawBody);
    parsed.forEach((value, key) => { formParams[key] = value; });

    const signatureHeader = request.headers.get('x-twilio-signature') ?? '';
    const fullUrl = reconstructFullUrl(request);

    // Signature verification (HMAC-SHA1 with account auth token).
    const valid = verifyTwilioSignature({
      fullUrl,
      formParams,
      signatureHeader,
      authToken: connieTwilioConfig.authToken,
    });
    if (!valid) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'task-webhook',
        warning: 'signature verification failed',
        fullUrl,
        hasSignature: !!signatureHeader,
      }));
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Parse TaskAttributes (Twilio sends as a JSON string).
    let attributes: Record<string, unknown>;
    try {
      attributes = JSON.parse(formParams.TaskAttributes ?? '{}');
    } catch {
      attributes = {};
    }

    // ========================================================================
    // DISCRIMINATOR GATE — MUST be the FIRST check, before any pp-client call.
    // See file header for why this is load-bearing.
    // ========================================================================
    if (attributes.deploymentId !== connieTwilioConfig.deploymentId) {
      // Legacy task or task from a different deployment. NOT ours. Return 200
      // silently — this endpoint never acts on non-bridge tasks.
      return NextResponse.json({ ok: true, skipped: 'not-bridge-task' }, { status: 200 });
    }

    // Defensive secondary check: bridge-created tasks always have ticketId.
    // If missing, something upstream is wrong — short-circuit safely.
    const ticketId = typeof attributes.ticketId === 'string' || typeof attributes.ticketId === 'number'
      ? String(attributes.ticketId)
      : '';
    if (!ticketId) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'task-webhook',
        warning: 'bridge task missing ticketId attribute',
        taskSid: formParams.TaskSid,
        attributes,
      }));
      return NextResponse.json({ ok: true, skipped: 'no-ticket-id' }, { status: 200 });
    }

    const eventType = formParams.EventType;
    const taskSid = formParams.TaskSid ?? '';

    if (eventType === 'task.completed') {
      const idempotencyKey = `pp:close:${taskSid}`;
      if (await isBridgeKeyProcessed(idempotencyKey)) {
        return NextResponse.json({ ok: true, skipped: 'duplicate-close' }, { status: 200 });
      }

      // Connie deployment uses 'closed' semantics — statusMap.resolved is omitted
      // so resolveTicket would throw DeploymentNotConfiguredError. Use closeTicket.
      await closeTicket(ticketId, connieConfig);
      await markBridgeKeyProcessed(idempotencyKey);

      console.log(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'task-webhook',
        ok: true,
        action: 'closed',
        ticketId,
        taskSid,
      }));

      return NextResponse.json({ ok: true, action: 'closed', ticketId }, { status: 200 });
    }

    if (eventType === 'task.canceled') {
      // Phase 3: log only. Could indicate agent declined; the ticket stays open
      // and the bridge takes no PP-side action. Phase 4 may add disposition.
      console.log(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'task-webhook',
        info: 'task canceled; no PP-side action taken',
        ticketId,
        taskSid,
      }));
      return NextResponse.json({ ok: true, action: 'logged' }, { status: 200 });
    }

    // Other EventTypes (reservation.created, reservation.accepted, etc.) —
    // Phase 3 takes no action. Return 200 silently.
    return NextResponse.json({ ok: true, ignored: eventType }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'task-webhook',
      error: err instanceof Error ? err.message : String(err),
    }));
    // Return 200 even on internal errors to prevent Twilio retry storms;
    // idempotency layer handles reprocessing on the next genuine event.
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 200 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
