// app/api/bridge/twilio-flex/internal-note/route.ts
// Agent adds an internal note to the ticket.
//
// Two clients call this route:
//   1. The legacy iframe page (same-origin) — Pattern A surface, still active
//      as parallel runtime through Task 9.
//   2. The basecamp Connie Flex plugin (cross-origin from
//      https://careteam.connie.team) — Pattern B surface (Task 7 / TTB-1).
//
// Server-side calls pp-client.addReply with isInternal=true and source='flex'
// (loop prevention via source-tag).

import { NextRequest, NextResponse } from 'next/server';
import { addReply } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';
import { corsPreflight, withCors } from '@/adapters/bridge/human/twilio-flex/cors';
import { captureTicketReply } from '@/adapters/bridge/human/twilio-flex/bridge-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InternalNoteBody {
  ticketId?: unknown;
  body?: unknown;
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json().catch(() => ({}))) as InternalNoteBody;

    const ticketId = typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const noteBody = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (!ticketId) {
      return withCors(request, NextResponse.json({ error: 'ticketId required' }, { status: 400 }));
    }
    if (!noteBody) {
      return withCors(request, NextResponse.json({ error: 'body required' }, { status: 400 }));
    }

    // TTB-24: use sourceInternal so PP webhook echoes a discriminator the
    // event-mapper can use to set Reply.internalNote=true. PP doesn't include
    // the isinternal flag in webhook payloads; encoding it into source is the
    // working channel.
    const reply = await addReply(
      ticketId,
      { body: noteBody, isInternal: true, source: BRIDGE_METADATA.sourceInternal },
      connieConfig,
    );

    // S7 C2: PeoplePerson does NOT fire its reply webhook for internal notes
    // (verified via smoke — the webhook capture misses them). Capture here at
    // creation so the note appears in the AGENT conversation thread. internalNote
    // is true → the ticket view filters it out of the CLIENT thread (privacy).
    // Idempotent on (ticket_id, reply_id), so no double-capture risk.
    try {
      await captureTicketReply({
        ticketId,
        replyId: String(reply.id),
        body: noteBody,
        authorKind: 'agent',
        source: BRIDGE_METADATA.sourceInternal,
        internalNote: true,
        createdAt: reply.createdAt ?? new Date().toISOString(),
      });
    } catch (err) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'internal-note',
        info: 'reply capture failed (non-fatal)',
        ticketId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'internal-note',
      ok: true,
      ticketId,
      replyId: reply.id,
    }));

    return withCors(request, NextResponse.json({ ok: true, ticketId, replyId: reply.id }, { status: 200 }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'internal-note',
      error: err instanceof Error ? err.message : String(err),
    }));
    return withCors(
      request,
      NextResponse.json(
        { error: err instanceof Error ? err.message : 'Internal note add failed' },
        { status: 500 },
      ),
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
