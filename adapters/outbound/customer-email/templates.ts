// adapters/outbound/customer-email/templates.ts
//
// Connie-branded customer-email templates. ALL content is Connie-owned —
// branding firewall: NO Perfex / PeoplePerson / TroubleTracker platform
// strings appear anywhere in From, Subject, body, or footer.
// (See feedback_pp_brand_firewall_in_connie_deliverables.md, 2026-05-08.)
//
// Templates render plain-text + HTML pairs. Plain-text is required by Mailgun
// for accessibility and spam-folder hygiene; HTML is what most clients render.
//
// Sprint 3.0 C1 (TTB-27, 2026-05-08): polish pass.
//   - Connie-branded top bar + footer (brand blue, no images — keeps the
//     email self-contained; no CDN hunt + no off-client load).
//   - UTM tagging on outbound homepage links so email-driven traffic shows
//     up cleanly in connie.plus analytics.
//   - Soften the reply-hint copy. Reply-To routes to support@connie.team
//     today (eforw → NSS Exchange → human reads) — replies do NOT auto-add
//     back into the ticket until TTB-25 (S3 C2) ships. After C2 lands,
//     restore the "automatically added" phrasing in renderTicketCreatedEmail
//     and renderAgentReplyEmail.
//   - Accessibility: role="presentation" on layout tables, sufficient
//     contrast on body copy and CTA, alt-text on the lone decorative
//     element (the header bar uses background color, not an image).
//   - Table-based layout for maximum client compat (Outlook, Apple Mail,
//     Gmail mobile webmail and native apps all render tables consistently;
//     div+max-width works in Gmail but breaks in Outlook). Inline styles
//     throughout — most clients strip <style> blocks.

import type { Ticket } from '@/pp-client/types';

const SUPPORT_EMAIL = 'support@connie.team';
const HOMEPAGE_URL = 'https://connie.plus';
const HOMEPAGE_URL_TAGGED = `${HOMEPAGE_URL}?utm_source=email&utm_medium=ticket-update`;

const BRAND_BLUE = '#2563eb';
const BRAND_BLUE_DARK = '#1d4ed8';
const TEXT_PRIMARY = '#111827';
const TEXT_BODY = '#1f2937';
const TEXT_MUTED = '#4b5563';
const TEXT_SUBTLE = '#6b7280';
const BORDER_LIGHT = '#e5e7eb';
const SURFACE_BODY = '#ffffff';
const SURFACE_BG = '#f9fafb';

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
    `If you have anything to add, just reply to this email — it will reach our team.`,
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
      `If you have anything to add, just reply to this email — it will reach our team.`,
      `Need help in the meantime? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_BLUE};">${SUPPORT_EMAIL}</a>.`,
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
    `To respond, just reply to this email — it will reach our team.`,
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
      `To respond, just reply to this email — it will reach our team.`,
    ],
  });

  return { subject, textBody, htmlBody };
}

// ============================================================================
// Shared HTML scaffold — table-based layout for cross-client compat (Outlook
// strips most CSS layout; tables render consistently). Inline styles only;
// most clients strip <style> blocks. role="presentation" on the layout
// tables tells screen readers to ignore the table semantics.
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
    .map((p) => `<p style="margin:0 0 16px 0;line-height:1.5;color:${TEXT_BODY};font-size:15px;">${p}</p>`)
    .join('\n');
  const closing = a.closingParagraphs
    .map((p) => `<p style="margin:0 0 12px 0;line-height:1.5;color:${TEXT_MUTED};font-size:14px;">${p}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(a.headline)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE_BG};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE_BG};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${SURFACE_BODY};border:1px solid ${BORDER_LIGHT};border-radius:8px;overflow:hidden;">
        <tr>
          <td style="background:${BRAND_BLUE};padding:16px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:0.3px;">Connie Care Team</td>
                <td align="right" style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#dbeafe;font-size:12px;">support@connie.team</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 24px 24px 24px;">
            <h1 style="margin:0 0 20px 0;font-size:20px;font-weight:600;color:${TEXT_PRIMARY};line-height:1.3;">${escapeHtml(a.headline)}</h1>
            <p style="margin:0 0 16px 0;line-height:1.5;color:${TEXT_BODY};font-size:15px;">${a.greeting}</p>
            ${paras}
            <blockquote style="margin:16px 0;padding:14px 16px;border-left:3px solid ${BORDER_LIGHT};background:${SURFACE_BG};color:#374151;white-space:pre-wrap;font-size:14px;border-radius:4px;">${a.quotedBlock}</blockquote>
            ${closing}
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 24px 24px;">
            <hr style="border:none;border-top:1px solid ${BORDER_LIGHT};margin:0 0 16px 0;">
            <p style="margin:0;font-size:12px;color:${TEXT_SUBTLE};line-height:1.5;">
              — Connie Care Team<br>
              <a href="${HOMEPAGE_URL_TAGGED}" style="color:${BRAND_BLUE_DARK};text-decoration:none;">${HOMEPAGE_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
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
