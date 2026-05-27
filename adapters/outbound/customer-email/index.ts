// adapters/outbound/customer-email/index.ts
//
// Sprint 2.0 Co-headline 2 — customer-email send public surface.
//
// Two send paths:
//   1. sendTicketCreatedEmail(ticket) — fired on ticket.created event from PP.
//   2. sendAgentReplyEmail(ticket, reply) — fired on ticket.replied.agent
//      event from PP, when an agent has posted a public reply.
//
// Internal notes (PR #5 / PR #13 surface) MUST NOT trigger emails.
// Acceptance gate #6 from Sprint 2.0 doc. Filter logic lives here so the
// brand-firewall + filtering policy is in one place adapter-side. See
// register.ts for the wiring that calls these.

import type { Ticket, Reply } from '@/pp-client/types';
import { sendCustomerEmail } from './mailgun';
import { renderTicketCreatedEmail, renderAgentReplyEmail } from './templates';

// replyTo is sourced from deployment.channels.customerEmail.replyTo when the
// subscriber is registered via register.ts. The legacy hardcoded fallback in
// mailgun.ts (DEFAULT_REPLY_TO) is retained as a safety net for any
// pre-Sprint-4.0 call paths that may not have plumbed config through yet,
// but the canonical surface is this argument.
export async function sendTicketCreatedEmail(
  ticket: Ticket,
  options: { replyTo?: string } = {},
): Promise<void> {
  if (!ticket.customer.email) {
    console.log(JSON.stringify({
      customer_email: true,
      info: 'no customer email; skipping create-confirmation',
      ticketId: ticket.id,
    }));
    return;
  }
  const tmpl = renderTicketCreatedEmail(ticket);
  await sendCustomerEmail({
    to: ticket.customer.email,
    toName: ticket.customer.name,
    subject: tmpl.subject,
    textBody: tmpl.textBody,
    htmlBody: tmpl.htmlBody,
    replyTo: options.replyTo,
    tags: ['ticket-created', `scope-${ticket.customerScope || 'unknown'}`],
    customVars: { ticketId: ticket.id, eventKind: 'ticket.created' },
    ticketId: ticket.id,
  });
}

export async function sendAgentReplyEmail(args: {
  ticket: Ticket;
  reply: Reply;
  replyTo?: string;
}): Promise<void> {
  const { ticket, reply, replyTo } = args;

  // TTB-24 (Sprint 2.0 reopen, 2026-05-08): acceptance gate #6 fix.
  // Original defensive filter (`authorKind === 'agent'` + non-empty body)
  // was structurally insufficient — internal notes are also agent-authored
  // and have non-empty bodies. CCTO-4 + CEO smoke on ticket #65 (replyId 34)
  // confirmed leak. Fix: pp-client/event-mapper now extracts an
  // `internalNote: boolean` flag from Perfex's webhook payload (probing
  // `admin`/`isadmin`/`is_admin`/`isinternal`/`is_internal`/`internal_note`/
  // `internalnote`). Customer-email subscriber rejects when internalNote
  // is true.
  if (reply.internalNote === true) {
    console.log(JSON.stringify({
      customer_email: true,
      info: 'reply is internal note; skipping reply-notification (TTB-24 gate)',
      ticketId: ticket.id,
      replyId: reply.id,
    }));
    return;
  }
  if (reply.authorKind !== 'agent') {
    console.log(JSON.stringify({
      customer_email: true,
      info: 'reply not agent-authored; skipping reply-notification',
      ticketId: ticket.id,
      authorKind: reply.authorKind,
    }));
    return;
  }
  if (!reply.body?.trim()) {
    console.log(JSON.stringify({
      customer_email: true,
      info: 'empty reply body; skipping reply-notification',
      ticketId: ticket.id,
    }));
    return;
  }
  if (!ticket.customer.email) {
    console.log(JSON.stringify({
      customer_email: true,
      info: 'no customer email; skipping reply-notification',
      ticketId: ticket.id,
    }));
    return;
  }

  const tmpl = renderAgentReplyEmail({ ticket, replyBody: reply.body });
  await sendCustomerEmail({
    to: ticket.customer.email,
    toName: ticket.customer.name,
    subject: tmpl.subject,
    textBody: tmpl.textBody,
    htmlBody: tmpl.htmlBody,
    replyTo,
    tags: ['agent-reply', `scope-${ticket.customerScope || 'unknown'}`],
    customVars: {
      ticketId: ticket.id,
      replyId: reply.id,
      eventKind: 'ticket.replied.agent',
    },
    ticketId: ticket.id,
  });
}

export { register } from './register';
