// adapters/outbound/customer-email/templates.ts
//
// Connie-branded customer-email templates. ALL content is Connie-owned —
// branding firewall: NO Perfex / PeoplePerson / TroubleTracker platform
// strings appear anywhere in From, Subject, body, or footer.
// (See feedback_pp_brand_firewall_in_connie_deliverables.md, 2026-05-08.)
//
// Templates render plain-text + HTML pairs. Plain-text is required by Mailgun
// for accessibility and spam-folder hygiene; HTML is what most clients render.

import type { Ticket } from '@/pp-client/types';

const SUPPORT_EMAIL = 'support@connie.team';
const HOMEPAGE_URL = 'https://connie.plus';

// ============================================================================
// Ticket created — confirmation to submitter
// ============================================================================

export interface TicketCreatedEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export function renderTicketCreatedEmail(ticket: Ticket): TicketCreatedEmail {
  const subject = `Ticket #${ticket.id} received — ${truncate(ticket.subject, 60)}`;

  const textBody = [
    `Hi ${ticket.customer.name || 'there'},`,
    '',
    `Thanks for reaching out — we've received your support ticket and a Connie Care Team agent will get back to you soon.`,
    '',
    `Ticket #${ticket.id}: ${ticket.subject}`,
    '',
    'What you sent us:',
    indent(ticket.description, '  '),
    '',
    `If you have anything to add, just reply to this email. Your reply will be added to the ticket automatically.`,
    '',
    `Need help in the meantime? Email ${SUPPORT_EMAIL}.`,
    '',
    '— Connie Care Team',
    HOMEPAGE_URL,
  ].join('\n');

  const htmlBody = renderHtml({
    headline: `Ticket #${ticket.id} received`,
    greeting: `Hi ${escapeHtml(ticket.customer.name || 'there')},`,
    bodyParagraphs: [
      `Thanks for reaching out — we've received your support ticket and a <strong>Connie Care Team</strong> agent will get back to you soon.`,
      `<strong>Ticket #${escapeHtml(ticket.id)}: ${escapeHtml(ticket.subject)}</strong>`,
    ],
    quotedBlock: escapeHtml(ticket.description),
    closingParagraphs: [
      `If you have anything to add, just reply to this email and your message will be added to the ticket automatically.`,
      `Need help in the meantime? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#2563eb;">${SUPPORT_EMAIL}</a>.`,
    ],
  });

  return { subject, textBody, htmlBody };
}

// ============================================================================
// Agent reply — notification to submitter
// ============================================================================

export interface AgentReplyEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export function renderAgentReplyEmail(args: {
  ticket: Ticket;
  replyBody: string;
}): AgentReplyEmail {
  const { ticket, replyBody } = args;
  const subject = `Re: Ticket #${ticket.id} — ${truncate(ticket.subject, 60)}`;

  const textBody = [
    `Hi ${ticket.customer.name || 'there'},`,
    '',
    `The Connie Care Team has replied to your ticket:`,
    '',
    `Ticket #${ticket.id}: ${ticket.subject}`,
    '',
    indent(replyBody, '  '),
    '',
    `To respond, just reply to this email. Your reply will be added to the ticket.`,
    '',
    `— Connie Care Team`,
    HOMEPAGE_URL,
  ].join('\n');

  const htmlBody = renderHtml({
    headline: `New reply on Ticket #${ticket.id}`,
    greeting: `Hi ${escapeHtml(ticket.customer.name || 'there')},`,
    bodyParagraphs: [
      `The <strong>Connie Care Team</strong> has replied to your ticket:`,
      `<strong>Ticket #${escapeHtml(ticket.id)}: ${escapeHtml(ticket.subject)}</strong>`,
    ],
    quotedBlock: escapeHtml(replyBody),
    closingParagraphs: [
      `To respond, just reply to this email — your reply will be added to the ticket.`,
    ],
  });

  return { subject, textBody, htmlBody };
}

// ============================================================================
// Shared HTML scaffold — kept simple; renders cleanly in Gmail, Outlook,
// Apple Mail. Inline styles only (most clients strip <style> blocks).
// ============================================================================

interface HtmlRenderArgs {
  headline: string;
  greeting: string;
  bodyParagraphs: string[];
  quotedBlock: string;
  closingParagraphs: string[];
}

function renderHtml(a: HtmlRenderArgs): string {
  const paras = a.bodyParagraphs
    .map((p) => `<p style="margin:0 0 16px 0;line-height:1.5;color:#1f2937;">${p}</p>`)
    .join('\n');
  const closing = a.closingParagraphs
    .map((p) => `<p style="margin:0 0 12px 0;line-height:1.5;color:#4b5563;font-size:14px;">${p}</p>`)
    .join('\n');
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;background:#ffffff;">
    <h1 style="margin:0 0 24px 0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(a.headline)}</h1>
    <p style="margin:0 0 16px 0;line-height:1.5;color:#1f2937;">${a.greeting}</p>
    ${paras}
    <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #e5e7eb;background:#f9fafb;color:#374151;white-space:pre-wrap;">${a.quotedBlock}</blockquote>
    ${closing}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="margin:0;font-size:12px;color:#6b7280;">
      — Connie Care Team<br>
      <a href="${HOMEPAGE_URL}" style="color:#2563eb;text-decoration:none;">${HOMEPAGE_URL}</a>
    </p>
  </div>
</body></html>`;
}

// ============================================================================
// String helpers
// ============================================================================

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function indent(s: string, prefix: string): string {
  return s.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
