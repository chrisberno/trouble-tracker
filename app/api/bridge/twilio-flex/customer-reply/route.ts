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
  // S7: set by the portal CLIENT view (TicketActions viewerMode='client'). When
  // true, the reply is tagged source='client' (customer-originated) so it flows
  // through the reopen/notify pipeline rather than the agent reply path.
  fromClient?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => ({}))) as CustomerReplyBody;

    const ticketId = typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const replyBody = typeof payload.body === 'string' ? payload.body.trim() : '';
    const fromClient = payload.fromClient === true;

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId required' }, { status: 400 });
    }
    if (!replyBody) {
      return NextResponse.json({ error: 'body required' }, { status: 400 });
    }

    // S7: agent replies keep source='flex' (BRIDGE_METADATA.source) → emailed to
    // the customer, observed only. CLIENT portal replies get source='client'
    // (customer-originated) → flow through the bump/reopen/notify pipeline so
    // they reach the CCT agent, and are NOT emailed back to the customer.
    const source = fromClient ? 'client' : BRIDGE_METADATA.source;

    const reply = await addReply(
      ticketId,
      { body: replyBody, isInternal: false, source },
      connieConfig,
    );

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'customer-reply',
      ok: true,
      ticketId,
      replyId: reply.id,
      source,
      fromClient,
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
