// app/api/bridge/twilio-flex/internal-note/route.ts
// Iframe action endpoint: agent adds an internal note to the ticket.
// POSTed by the iframe page client-side; server-side calls pp-client.addReply
// with isInternal=true and source='flex' (loop prevention via source-tag).

import { NextRequest, NextResponse } from 'next/server';
import { addReply } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InternalNoteBody {
  ticketId?: unknown;
  body?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => ({}))) as InternalNoteBody;

    const ticketId = typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const noteBody = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId required' }, { status: 400 });
    }
    if (!noteBody) {
      return NextResponse.json({ error: 'body required' }, { status: 400 });
    }

    const reply = await addReply(
      ticketId,
      { body: noteBody, isInternal: true, source: BRIDGE_METADATA.source },
      connieConfig,
    );

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'internal-note',
      ok: true,
      ticketId,
      replyId: reply.id,
    }));

    return NextResponse.json({ ok: true, ticketId, replyId: reply.id }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'internal-note',
      error: err instanceof Error ? err.message : String(err),
    }));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal note add failed' },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
