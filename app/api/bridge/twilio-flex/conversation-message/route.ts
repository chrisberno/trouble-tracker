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
//   3. Drop if Body is empty AND no Media attached
//   4. Otherwise: forward to pp-client.addReply with source='flex'
//      (including any media fetched from Twilio MCS as PP attachments)
//
// pp-client tags the addReply with X-PP-Source: flex; PP.app fires
// ticket.replied.agent back to us; bridge handlers.ts:onTicketRepliedAgent
// observes event.source === 'flex' and takes no Twilio-side action.
// No-op terminus = no loop.
//
// TTB-13 Bug 2 (2026-05-05): media-bearing onMessageAdded webhooks include
// `Media` as a JSON-stringified array of {sid, filename, content_type,
// size, category}. We fetch each via Twilio MCS, attach to PP via Perfex's
// /api/tickets/reply/{id} multipart `attachments[]` field. When Body is
// empty but Media is present, a placeholder body of "(attachment)" is used
// so PP doesn't reject the reply for missing message text.

import { NextRequest, NextResponse } from 'next/server';
import type { ReplyAttachment } from '@/pp-client';
import { addReply } from '@/pp-client';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import {
  verifyTwilioSignature,
  fetchConversationMedia,
} from '@/adapters/bridge/human/twilio-flex/twilio-client';
import { BRIDGE_METADATA } from '@/adapters/bridge/human/twilio-flex';

// Twilio Media field shape per onMessageAdded webhook for media-bearing msgs.
// Fields the array entries carry — we only use sid, filename, content_type.
interface TwilioMediaEntry {
  Sid?: string;
  sid?: string;
  Filename?: string;
  filename?: string;
  ContentType?: string;
  content_type?: string;
  Size?: number;
  size?: number;
  Category?: string;
  category?: string;
}

function parseMediaField(raw: string): TwilioMediaEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as TwilioMediaEntry[];
    return [];
  } catch {
    return [];
  }
}

function mediaSid(m: TwilioMediaEntry): string {
  return m.Sid ?? m.sid ?? '';
}

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
    const mediaEntries = parseMediaField(formParams.Media ?? '');
    const hasMedia = mediaEntries.length > 0;

    if (!body.trim() && !hasMedia) {
      return NextResponse.json({ ok: true, skipped: 'empty-body-no-media' }, { status: 200 });
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

    // Fetch media binaries from Twilio MCS in parallel. Per-media failures are
    // logged but don't fail the whole reply — agent's text content still gets
    // through. ChatServiceSid comes from the webhook payload (Twilio sends it
    // on every onMessageAdded for Conversations).
    let attachments: ReplyAttachment[] = [];
    if (hasMedia) {
      const chatServiceSid = formParams.ChatServiceSid ?? connieTwilioConfig.conversationsServiceSid;
      const fetched = await Promise.all(
        mediaEntries.map(async (m) => {
          const sid = mediaSid(m);
          if (!sid) return null;
          try {
            const media = await fetchConversationMedia({
              chatServiceSid,
              mediaSid: sid,
            }, connieTwilioConfig);
            return {
              filename: media.filename,
              contentType: media.contentType,
              data: media.data,
            } satisfies ReplyAttachment;
          } catch (mediaErr) {
            console.warn(JSON.stringify({
              bridge: 'twilio-flex',
              route: 'conversation-message',
              warning: 'media fetch failed; continuing without this attachment',
              mediaSid: sid,
              error: mediaErr instanceof Error ? mediaErr.message : String(mediaErr),
            }));
            return null;
          }
        }),
      );
      attachments = fetched.filter((a): a is ReplyAttachment => a !== null);
    }

    // PP rejects empty `message` field. When the agent sends media-only
    // (no text), use a placeholder so the reply is accepted; the attachment
    // itself is the agent's intended content.
    const replyBody = body.trim() ? body : '(attachment)';

    const reply = await addReply(
      ticketId,
      {
        body: replyBody,
        isInternal: false,
        source: BRIDGE_METADATA.source,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
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
      mediaCount: mediaEntries.length,
      attachmentsForwarded: attachments.length,
    }));

    return NextResponse.json({
      ok: true,
      ticketId,
      replyId: reply.id,
      attachmentsForwarded: attachments.length,
    }, { status: 200 });
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
