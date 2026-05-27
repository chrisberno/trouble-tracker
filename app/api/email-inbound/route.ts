// app/api/email-inbound/route.ts
//
// TTB-25 / Sprint 3.0 C2 — customer email-reply round-trip into PP.
//
// Receives Mailgun-routed inbound email (parsed body POST) when a customer
// replies to a ticket-update email, extracts the originating ticketId, and
// posts the reply body to PP via pp-client.addReply with source='email' for
// loop prevention.
//
// =============================================================================
// HOW THIS HANGS TOGETHER
// =============================================================================
//
// 1. Outbound (S3 C1 + this commit's mailgun.ts change): every customer email
//    we send sets a custom Message-Id of the form
//    `<ticket-{ticketId}-{nanoid}@crm.connie.center>`. Most mail clients quote
//    the original Message-Id verbatim into In-Reply-To when a user hits
//    "Reply", so the customer's reply lands here with the ticket id embedded
//    in the In-Reply-To header.
//
// 2. Mailgun route (CEO-configured infrastructure — NOT in this commit):
//    a route on a Mailgun-managed inbound address forwards the parsed reply
//    to this endpoint via POST. Two viable address shapes:
//      a) Single address — `replies@crm.connie.center` — Mailgun route
//         `match_recipient("replies@crm.connie.center")` → store() + forward()
//         to support@connie.team (preserves human safety net) + notify() this
//         webhook URL.
//      b) Sub-addressed pattern — `replies+ticket-{id}@crm.connie.center` —
//         Mailgun route `match_recipient("replies\+ticket-.*@crm\.connie\.center")`.
//         Slightly more deterministic (ticket id is in the recipient itself)
//         but requires the outbound Reply-To to be sub-addressed too.
//    Pattern (a) is recommended for v1: simpler config + In-Reply-To header
//    is reliable enough for a well-behaved mail client. Sub-addressing is
//    available as a defensive fallback if In-Reply-To is missing.
//
// 3. Outbound Reply-To (CEO infrastructure decision — NOT in this commit):
//    today DEFAULT_REPLY_TO is `support@connie.team` (eforw → NSS Exchange →
//    human reads). To activate C2's round-trip, change DEFAULT_REPLY_TO in
//    mailgun.ts to a Mailgun-managed inbound address (e.g.
//    `replies@crm.connie.center`). The Mailgun route's forward() action keeps
//    support@connie.team in the loop so humans still see all replies; the
//    notify() action gives us the webhook hit for the round-trip.
//
// =============================================================================
// MAILGUN POST FORMAT (parsed route)
// =============================================================================
//
// Mailgun's "Parsed" inbound POST body is application/x-www-form-urlencoded
// (NOT multipart unless attachments are present). Standard fields:
//   recipient            — the address that received the mail
//   sender               — envelope sender
//   from                 — header From
//   subject              — header Subject
//   body-plain           — plain-text body
//   body-html            — HTML body (optional; may be absent)
//   stripped-text        — body-plain with quoted history removed (best-effort)
//   stripped-signature   — signature stripped from stripped-text
//   Message-Id           — inbound Message-Id
//   In-Reply-To          — inbound In-Reply-To header (load-bearing for us)
//   References           — full thread chain
//   timestamp, token, signature  — Mailgun signature triple for HMAC verify
//
// =============================================================================
// SIGNATURE VERIFICATION
// =============================================================================
//
// Mailgun signs inbound webhook posts: signature = HMAC-SHA256(api_key,
// timestamp + token).hex. We verify with the same MAILGUN_API_KEY env var
// the outbound adapter uses (single key for the account, not a separate
// signing key on the developer tier).
//
// =============================================================================
// LOOP PREVENTION
// =============================================================================
//
// The webhook calls pp-client.addReply with source='email'. PP creates the
// reply WITHOUT a staffid (the customer is not an agent), so PP's webhook
// fires `ticket.replied.customer` not `ticket.replied.agent`. The
// customer-email subscriber only listens on `ticket.replied.agent`, so the
// email-sourced reply does NOT trigger another customer-email send. No loop.
//
// Defensive: even if PP misclassifies, the subscriber's authorKind filter
// already rejects non-'agent' replies. Belt-and-suspenders.
//
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { addReply } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Reject signed timestamps older than this — defense against replayed posts
// captured off the wire. Mailgun retries on 5xx for up to 8 hours, so the
// window must accommodate that. 8h + small margin.
const MAX_SIGNATURE_AGE_SECONDS = 8 * 60 * 60 + 5 * 60;

interface ParsedInbound {
  recipient: string;
  sender: string;
  subject: string;
  bodyPlain: string;
  strippedText: string;
  inReplyTo: string;
  references: string;
  messageId: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Mailgun parsed-route POSTs as form-urlencoded by default; multipart only
    // when the inbound mail has attachments and we ask for raw MIME. We use
    // parsed → form-urlencoded for v1 (no attachment forwarding yet — TTB-20
    // is the dedicated submitter-side attachment item).
    const ctype = request.headers.get('content-type') ?? '';
    if (!ctype.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      console.warn(JSON.stringify({
        email_inbound: true,
        warning: 'unexpected content-type; expected x-www-form-urlencoded',
        contentType: ctype,
      }));
      // Mailgun sees 406 as a permanent failure — won't retry. Use 400 for
      // malformed, 5xx for transient.
      return NextResponse.json({ error: 'unexpected content-type' }, { status: 400 });
    }

    const rawBody = await request.text();
    const params = new URLSearchParams(rawBody);

    // Step 1 — authenticate the request. Two paths accepted (either suffices):
    //
    //   (a) URL shared-secret: ?secret=<MAILGUN_INBOUND_SHARED_SECRET>
    //       Used by Mailgun route `forward(URL?secret=...)`. Bypasses HMAC.
    //       Adopted Sprint 4.0 (2026-05-27) after we discovered Mailgun's
    //       webhook signing key is dashboard-only on Developer-tier API and
    //       cannot be programmatically fetched. The shared secret achieves
    //       the same auth goal: only the holder of the route config can
    //       legitimately fire this endpoint.
    //
    //   (b) Mailgun HMAC signature triple (timestamp + token + signature)
    //       HMAC'd against MAILGUN_WEBHOOK_SIGNING_KEY (preferred) or
    //       MAILGUN_API_KEY (legacy fallback for accounts where the API key
    //       IS the signing key). This path remains for backward compat and
    //       defense in depth — if the URL secret leaks but the HMAC works,
    //       we still accept; if the URL secret is right but HMAC is missing,
    //       we still accept.
    //
    // Either path verified → continue. Neither → 401.
    const sharedSecret = process.env.MAILGUN_INBOUND_SHARED_SECRET ?? '';
    const providedSecret = request.nextUrl.searchParams.get('secret') ?? '';
    const sharedSecretOk =
      sharedSecret.length > 0 &&
      providedSecret.length === sharedSecret.length &&
      crypto.timingSafeEqual(
        Buffer.from(providedSecret),
        Buffer.from(sharedSecret),
      );

    let hmacOk = false;
    let hmacReason = '(shared-secret path not attempted)';
    if (!sharedSecretOk) {
      const timestamp = params.get('timestamp') ?? '';
      const token = params.get('token') ?? '';
      const signature = params.get('signature') ?? '';
      const verifyResult = verifyMailgunSignature(timestamp, token, signature);
      hmacOk = verifyResult.ok;
      if (!verifyResult.ok) hmacReason = verifyResult.reason;
    }

    if (!sharedSecretOk && !hmacOk) {
      console.warn(JSON.stringify({
        email_inbound: true,
        warning: 'authentication failed',
        sharedSecretProvided: providedSecret.length > 0,
        sharedSecretConfigured: sharedSecret.length > 0,
        hmacReason,
      }));
      return NextResponse.json({ error: 'authentication failed' }, { status: 401 });
    }

    console.log(JSON.stringify({
      email_inbound: true,
      info: 'authenticated',
      method: sharedSecretOk ? 'shared-secret' : 'hmac',
    }));

    // Step 2 — extract canonical fields.
    const parsed: ParsedInbound = {
      recipient: params.get('recipient') ?? '',
      sender: params.get('sender') ?? '',
      subject: params.get('subject') ?? '',
      bodyPlain: params.get('body-plain') ?? '',
      strippedText: params.get('stripped-text') ?? '',
      inReplyTo: params.get('In-Reply-To') ?? params.get('in-reply-to') ?? '',
      references: params.get('References') ?? params.get('references') ?? '',
      messageId: params.get('Message-Id') ?? params.get('message-id') ?? '',
    };

    // Step 3 — resolve ticketId via three fallbacks (most-reliable first).
    const ticketId = resolveTicketId(parsed);
    if (!ticketId) {
      console.warn(JSON.stringify({
        email_inbound: true,
        warning: 'could not resolve ticketId from inbound reply',
        recipient: parsed.recipient,
        sender: redactEmail(parsed.sender),
        subject: parsed.subject.slice(0, 80),
        inReplyTo: parsed.inReplyTo,
        references: parsed.references.slice(0, 200),
      }));
      // 200 (not 5xx) — Mailgun shouldn't retry; the message is unmappable.
      // The forward() action of the Mailgun route still delivered the email to
      // support@connie.team for human follow-up.
      return NextResponse.json({ ok: true, info: 'ticket-id unresolved; humans handle' }, { status: 200 });
    }

    // Step 4 — extract reply body. Prefer stripped-text (quoted history
    // removed by Mailgun) over body-plain, since customers tend to reply
    // above the quoted email.
    const replyBody = (parsed.strippedText || parsed.bodyPlain).trim();
    if (!replyBody) {
      console.warn(JSON.stringify({
        email_inbound: true,
        warning: 'empty reply body; skipping addReply',
        ticketId,
        sender: redactEmail(parsed.sender),
      }));
      return NextResponse.json({ ok: true, info: 'empty body; nothing to add' }, { status: 200 });
    }

    // Step 5 — post to PP with source='email' tag for loop prevention.
    try {
      await addReply(
        ticketId,
        { body: replyBody, source: 'email' },
        connieConfig,
      );
    } catch (err) {
      console.error(JSON.stringify({
        email_inbound: true,
        error: 'pp-client.addReply failed',
        ticketId,
        sender: redactEmail(parsed.sender),
        message: err instanceof Error ? err.message : String(err),
      }));
      // 503 — Mailgun retries. PP API may be transiently down.
      return NextResponse.json({ error: 'addReply failed' }, { status: 503 });
    }

    console.log(JSON.stringify({
      email_inbound: true,
      ok: true,
      ticketId,
      sender: redactEmail(parsed.sender),
      bodyLen: replyBody.length,
      resolutionPath: parsed.inReplyTo
        ? 'in-reply-to'
        : parsed.recipient.includes('+')
        ? 'sub-addressed-recipient'
        : 'subject-regex',
    }));

    return NextResponse.json({ ok: true, ticketId }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      email_inbound: true,
      error: 'unhandled exception',
      message: err instanceof Error ? err.message : String(err),
    }));
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'method not allowed' }, { status: 405 });
}

// =============================================================================
// Signature verification — Mailgun's HMAC-SHA256(api_key, timestamp + token)
// =============================================================================

function verifyMailgunSignature(
  timestamp: string,
  token: string,
  signature: string,
): { ok: true } | { ok: false; reason: string } {
  if (!timestamp || !token || !signature) {
    return { ok: false, reason: 'missing signature triple' };
  }
  // Sprint 4.0 (2026-05-27): prefer MAILGUN_WEBHOOK_SIGNING_KEY when set
  // (modern Mailgun accounts use a separate HTTP webhook signing key,
  // dashboard-only). Fall back to MAILGUN_API_KEY for older accounts where
  // the API key IS the signing key.
  const signingKey =
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY ?? process.env.MAILGUN_API_KEY;
  if (!signingKey) {
    return { ok: false, reason: 'no signing key configured' };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, reason: `timestamp age ${ageSeconds}s exceeds window` };
  }
  const computed = crypto.createHmac('sha256', signingKey).update(timestamp + token).digest('hex');
  // Constant-time comparison.
  if (computed.length !== signature.length) return { ok: false, reason: 'signature length mismatch' };
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || a.length === 0) return { ok: false, reason: 'signature parse failed' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'hmac mismatch' };
  return { ok: true };
}

// =============================================================================
// Ticket-id resolution — three strategies
// =============================================================================

// Match `<ticket-123-...@crm.connie.center>` or bare `ticket-123-...@...`.
const IN_REPLY_TO_TICKET_RE = /ticket-([0-9]+)-[a-f0-9]+@/i;

// Match local-part like `replies+ticket-123` or `support+ticket-123`.
const SUB_ADDRESS_TICKET_RE = /[+]ticket-([0-9]+)@/i;

// Match subject `Re: Ticket #123` (allowing `RE:`, `re:`, `Fwd: Re: Ticket #123`).
const SUBJECT_TICKET_RE = /Ticket\s*#\s*([0-9]+)/i;

function resolveTicketId(parsed: ParsedInbound): string | null {
  // Strategy 1 — In-Reply-To header. Most reliable: most mail clients quote
  // the original Message-Id verbatim. Outbound Message-Id format (mailgun.ts)
  // embeds the ticket id, so the regex below extracts it cleanly.
  const fromInReplyTo = parsed.inReplyTo.match(IN_REPLY_TO_TICKET_RE)
    || parsed.references.match(IN_REPLY_TO_TICKET_RE);
  if (fromInReplyTo) return fromInReplyTo[1];

  // Strategy 2 — sub-addressed recipient. If the Mailgun route uses a
  // sub-addressed pattern (`replies+ticket-123@…`), the ticket id is in the
  // recipient itself.
  const fromRecipient = parsed.recipient.match(SUB_ADDRESS_TICKET_RE);
  if (fromRecipient) return fromRecipient[1];

  // Strategy 3 — subject regex. Fragile (subject can be edited or stripped)
  // but useful as a final fallback.
  const fromSubject = parsed.subject.match(SUBJECT_TICKET_RE);
  if (fromSubject) return fromSubject[1];

  return null;
}

// =============================================================================
// Redaction for logs
// =============================================================================

function redactEmail(email: string): string {
  if (!email) return '***';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
