// app/api/bridge/twilio-flex/conversations-webhook/route.ts
// Twilio Conversations Service-level webhook receiver — Phase 4 active.
//
// Triggered when a message is posted to ANY conversation on the
// IS8bd6c045... TT-dedicated Conversations Service. The webhook URL was
// attached during Phase 3 prereq ledger row B2 and has been live (but
// dormant) since 2026-05-03. Phase 4 lights it up.
//
// Per Phase 4 brief Deliverable #5, agent reply via Flex composer in Task
// Canvas → Conversations onMessageAdded webhook → this route → pp-client.addReply
// (with source='flex' for Loop Discipline Matrix PATH 1 short-circuit).
//
// Loop prevention (Matrix PATH 4):
//   1. Verify X-Twilio-Signature (HMAC-SHA1)
//   2. Skip messages where Author === 'customer' (own outbound from
//      handlers.onTicketRepliedCustomer; would otherwise loop)
//   3. Idempotency on twilioMessageSid (Twilio retries on non-200)
//   4. Lookup ticketId via twilio_bridge_mappings.conversation_sid
//   5. pp-client.addReply with source: 'flex' (round-trips back via PP webhook
//      → ticket.replied.agent → handlers.onTicketRepliedAgent observes; Matrix
//      PATH 1 source-tag check shorts it out)
//
// Note re: Conversations Service-level signing key: this verifier uses the
// account auth token. The IS service currently has NO service-level signing
// key configured (verified during Phase 3 prereq ledger Phase B B2). If
// anyone later configures a service-level signing key, this verifier silently
// starts failing. See twilio-client.ts header for the assumption rationale.

import { NextRequest, NextResponse } from 'next/server';
import { addReply } from '@/pp-client';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import { verifyTwilioSignature } from '@/adapters/bridge/human/twilio-flex/twilio-client';
import {
  getBridgeMappingByConversationSid,
  isBridgeKeyProcessed,
  markBridgeKeyProcessed,
} from '@/adapters/bridge/human/twilio-flex/bridge-db';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';
import { stripHtmlForBridge } from '@/adapters/bridge/human/twilio-flex/html-strip';

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

    // Signature verification (HMAC-SHA1 with account auth token)
    const valid = verifyTwilioSignature({
      fullUrl,
      formParams,
      signatureHeader,
      authToken: connieTwilioConfig.authToken,
    });
    if (!valid) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversations-webhook',
        warning: 'signature verification failed',
        fullUrl,
        hasSignature: !!signatureHeader,
      }));
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    const eventType = formParams.EventType;
    if (eventType !== 'onMessageAdded') {
      // Twilio fires many event types on a Conversation; we only act on
      // onMessageAdded. Return 200 silently to avoid Twilio's retry storm.
      return NextResponse.json({ ok: true, ignored: eventType }, { status: 200 });
    }

    const conversationSid = formParams.ConversationSid;
    const messageSid = formParams.MessageSid;
    const author = formParams.Author ?? '';
    const body = formParams.Body ?? '';

    if (!conversationSid || !messageSid) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversations-webhook',
        warning: 'missing ConversationSid or MessageSid',
        formParams: Object.keys(formParams),
      }));
      return NextResponse.json({ ok: true, skipped: 'missing-ids' }, { status: 200 });
    }

    // Loop Discipline Matrix PATH 4: skip messages we authored ourselves.
    // handlers.onTicketRepliedCustomer posts with Author='customer'. If we
    // re-process those here, we'd write a duplicate to PP + create a loop.
    if (author === 'customer') {
      return NextResponse.json({ ok: true, skipped: 'own-customer-message' }, { status: 200 });
    }

    // Idempotency guard — Twilio retries on non-200; even on 200 we don't
    // trust uniqueness without an explicit check.
    const idempotencyKey = `pp:reply:${messageSid}`;
    if (await isBridgeKeyProcessed(idempotencyKey)) {
      return NextResponse.json({ ok: true, skipped: 'duplicate' }, { status: 200 });
    }

    // Lookup the PP ticket via the Conversation mapping.
    const mapping = await getBridgeMappingByConversationSid(conversationSid);
    if (!mapping) {
      // Stray message on the service — shouldn't happen on a TT-dedicated
      // service, but be defensive (and don't 500 — 200 silent skip is the
      // right thing for Twilio retry behavior).
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversations-webhook',
        warning: 'no bridge mapping for conversation',
        conversationSid,
        messageSid,
      }));
      return NextResponse.json({ ok: true, skipped: 'no-mapping' }, { status: 200 });
    }

    // HTML-strip the body before posting to PP. Phase 4 D8 — Flex composer
    // can produce HTML if agents paste rich content; PP expects plain-ish text.
    const cleanBody = stripHtmlForBridge(body);

    // Post the agent's message back to PP as a reply tagged with source='flex'.
    // The 'flex' tag round-trips through PP's webhook → ticket.replied.agent
    // → handlers.onTicketRepliedAgent observes (no Twilio re-write per Loop
    // Discipline Matrix PATH 1).
    await addReply(
      mapping.ticketId,
      { body: cleanBody, source: BRIDGE_METADATA.source },
      connieConfig,
    );

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'conversations-webhook',
      ok: true,
      ticketId: mapping.ticketId,
      conversationSid,
      messageSid,
      author,
    }));

    return NextResponse.json({ ok: true, ticketId: mapping.ticketId }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'conversations-webhook',
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
