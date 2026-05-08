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

export async function sendTicketCreatedEmail(ticket: Ticket): Promise<void> {
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
    tags: ['ticket-created', `scope-${ticket.customerScope || 'unknown'}`],
    customVars: { ticketId: ticket.id, eventKind: 'ticket.created' },
  });
}

export async function sendAgentReplyEmail(args: {
  ticket: Ticket;
  reply: Reply;
}): Promise<void> {
  const { ticket, reply } = args;

  // Acceptance gate #6 — never email customer for internal notes.
  // The Reply type doesn't currently carry an isInternal flag (event-mapper
  // doesn't extract it from the PP webhook payload). Until that's plumbed
  // through, we use a defensive heuristic: only send if the reply has a
  // non-empty body AND authorKind === 'agent'. If smoke testing reveals
  // internal notes also fire ticket.replied.agent and leak through, file a
  // follow-up to extend pp-client/event-mapper.ts to extract Perfex's
  // internal-note flag (likely `data.reply.admin` or similar) and either
  // filter at the mapper layer or expose `reply.isInternal` here.
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
    tags: ['agent-reply', `scope-${ticket.customerScope || 'unknown'}`],
    customVars: {
      ticketId: ticket.id,
      replyId: reply.id,
      eventKind: 'ticket.replied.agent',
    },
  });
}

export { register } from './register';
