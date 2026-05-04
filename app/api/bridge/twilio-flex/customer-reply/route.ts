// app/api/bridge/twilio-flex/customer-reply/route.ts
// Iframe action endpoint: agent sends a customer-visible reply on the ticket.
// POSTed by the iframe page client-side; server-side calls pp-client.addReply
// with isInternal=false and source='flex' (loop prevention via source-tag).
//
// Phase 3 NEW route — replaces the "agent replies in WorkBench Conversation"
// pathway from the original brief (which depended on Flex Interactions API +
// Conversations integration; pivoted to TaskRouter Tasks API in Phase 3 v2).
// In Phase 3, all agent ↔ ticket interaction flows through the iframe's three
// buttons: status flip, customer reply (this), internal note.
//
// Auth model: same-origin trust (iframe same-domain via Vercel + CSP
// frame-ancestors restricts who can embed). Phase 4+ may add CCT worker SID
// validation.

import { NextRequest, NextResponse } from 'next/server';
import { addReply } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CustomerReplyBody {
  ticketId?: unknown;
  body?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => ({}))) as CustomerReplyBody;

    const ticketId = typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const replyBody = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId required' }, { status: 400 });
    }
    if (!replyBody) {
      return NextResponse.json({ error: 'body required' }, { status: 400 });
    }

    const reply = await addReply(
      ticketId,
      { body: replyBody, isInternal: false, source: BRIDGE_METADATA.source },
      connieConfig,
    );

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'customer-reply',
      ok: true,
      ticketId,
      replyId: reply.id,
    }));

    return NextResponse.json({ ok: true, ticketId, replyId: reply.id }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'customer-reply',
      error: err instanceof Error ? err.message : String(err),
    }));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Customer reply failed' },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
