// app/api/bridge/twilio-flex/conversation-message/route.ts
// Phase 5 (TTB-1): Twilio Conversations webhook receiver for onMessageAdded.
// Forwards Connie agent canvas replies to PP.app as ticket replies, closing
// the canvas-to-PP loop. Customer-authored messages (proxy identity matches
// the connie-customer-* prefix) are filtered out — those are seeded by us
// (the ticket's first message + future PP customer-reply pushes), forwarding
// them would cause echo loops.
//
// URL pattern: /api/bridge/twilio-flex/conversation-message?ticketId=<id>
// The ticketId is baked into the webhook URL during conversation creation
// (handlers.ts onTicketCreated Step 4) so we can look up PP without a
// Conversation fetch on every message event.
//
// Loop prevention rules (in order of evaluation):
//   1. Drop if EventType !== 'onMessageAdded'
//   2. Drop if Author starts with 'connie-customer-' (our customer proxy)
//   3. Drop if Body is empty
//   4. Otherwise: forward to pp-client.addReply with source='flex'
//
// pp-client tags the addReply with X-PP-Source: flex; PP.app fires
// ticket.replied.agent back to us; bridge handlers.ts:onTicketRepliedAgent
// observes event.source === 'flex' and takes no Twilio-side action.
// No-op terminus = no loop.

import { NextRequest, NextResponse } from 'next/server';
import { addReply } from '@/pp-client';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import { verifyTwilioSignature } from '@/adapters/bridge/human/twilio-flex/twilio-client';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';

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
    new URLSearchParams(rawBody).forEach((value, key) => { formParams[key] = value; });

    const signatureHeader = request.headers.get('x-twilio-signature') ?? '';
    const fullUrl = reconstructFullUrl(request);

    const valid = verifyTwilioSignature({
      fullUrl,
      formParams,
      signatureHeader,
      authToken: connieTwilioConfig.authToken,
    });
    if (!valid) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversation-message',
        warning: 'signature verification failed',
        fullUrl,
        hasSignature: !!signatureHeader,
      }));
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    const eventType = formParams.EventType ?? '';
    if (eventType !== 'onMessageAdded') {
      return NextResponse.json({ ok: true, skipped: 'not-message-added', eventType }, { status: 200 });
    }

    const author = formParams.Author ?? '';
    if (!author || author.startsWith('connie-customer-')) {
      return NextResponse.json({ ok: true, skipped: 'customer-or-empty-author', author }, { status: 200 });
    }

    const body = formParams.Body ?? '';
    if (!body.trim()) {
      return NextResponse.json({ ok: true, skipped: 'empty-body' }, { status: 200 });
    }

    const url = new URL(request.url);
    const ticketId = url.searchParams.get('ticketId') ?? '';
    if (!ticketId) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'conversation-message',
        warning: 'missing ticketId query param — webhook URL drift?',
        conversationSid: formParams.ConversationSid,
      }));
      return NextResponse.json({ ok: false, error: 'missing-ticketId' }, { status: 400 });
    }

    const reply = await addReply(
      ticketId,
      { body, isInternal: false, source: BRIDGE_METADATA.source },
      connieConfig,
    );

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'conversation-message',
      ok: true,
      ticketId,
      replyId: reply.id,
      conversationSid: formParams.ConversationSid,
      messageSid: formParams.MessageSid,
      author,
    }));

    return NextResponse.json({ ok: true, ticketId, replyId: reply.id }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'conversation-message',
      error: err instanceof Error ? err.message : String(err),
    }));
    // Return 200 so Twilio doesn't retry storms — idempotency / replay is
    // handled at higher layer (PP doesn't deduplicate replies; we accept
    // very-rare duplicates as the operational trade-off here).
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 200 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
