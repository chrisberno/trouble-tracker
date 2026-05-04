// app/api/bridge/twilio-flex/conversations-webhook/route.ts
// Twilio Conversations Service-level webhook receiver.
// Triggered when a message is posted to ANY conversation on the
// IS8bd6c045... TT-dedicated Conversations Service.
//
// This receiver:
//   1. Verifies X-Twilio-Signature (returns 403 on fail)
//   2. Filters to EventType=onMessageAdded only
//   3. Skips messages we authored ourselves (Author=customer — that came from
//      our outbound write in handlers.onTicketRepliedCustomer)
//   4. For agent-side messages: looks up ticketId from twilio_bridge_mappings
//      via conversationSid; calls pp-client.addReply with source: 'flex'
//      (the source tag round-trips through PP's webhook back here, gets
//      mapped to ticket.replied.agent, and skipped by handlers.onTicketRepliedAgent)
//   5. Idempotency on twilioMessageSid prevents duplicate addReply on retries

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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Twilio sends webhooks via x-www-form-urlencoded. Reconstruct the form params
// and the full URL for signature verification.
function reconstructFullUrl(req: NextRequest): string {
  // Per Twilio: signature is computed against the URL Twilio sent the request to.
  // Behind Vercel, the public URL may differ from req.url's host. Use the
  // x-forwarded-host + x-forwarded-proto headers to reconstruct.
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

    // Signature verification (HMAC-SHA1 with account auth token — see
    // twilio-client.ts comment for service-level signing key caveat).
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
      // Twilio sends many event types; we only care about onMessageAdded.
      // Return 200 silently to avoid Twilio's retry storm.
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

    // Skip messages we authored ourselves (outbound from onTicketRepliedCustomer
    // sets Author='customer'). This prevents the customer→bridge→customer→bridge
    // infinite loop on the Twilio side.
    if (author === 'customer') {
      return NextResponse.json({ ok: true, skipped: 'own-customer-message' }, { status: 200 });
    }

    // Idempotency guard — Twilio retries on non-200 + occasionally on 200s.
    const idempotencyKey = `pp:reply:${messageSid}`;
    if (await isBridgeKeyProcessed(idempotencyKey)) {
      return NextResponse.json({ ok: true, skipped: 'duplicate' }, { status: 200 });
    }

    // Lookup the PP ticket via the conversation mapping.
    const mapping = await getBridgeMappingByConversationSid(conversationSid);
    if (!mapping) {
      // This conversation isn't ours — could be a stray message on the service
      // (shouldn't happen on a TT-dedicated service, but be defensive).
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversations-webhook',
        warning: 'no bridge mapping for conversation',
        conversationSid,
        messageSid,
      }));
      return NextResponse.json({ ok: true, skipped: 'no-mapping' }, { status: 200 });
    }

    // Post the agent's message back to PP as a reply tagged with source='flex'.
    // The 'flex' tag round-trips through PP's webhook → ticket.replied.agent,
    // where handlers.onTicketRepliedAgent observes (no Twilio re-write).
    await addReply(
      mapping.ticketId,
      { body, source: BRIDGE_METADATA.source },
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
    // idempotency layer will handle reprocessing on the next genuine event.
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 200 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
