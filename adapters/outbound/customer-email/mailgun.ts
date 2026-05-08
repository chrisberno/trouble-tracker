// adapters/outbound/customer-email/mailgun.ts
//
// Direct Mailgun HTTP API client for customer-facing emails. Bypasses PP's
// SMTP route entirely — see Sprint 2.0 Co-headline 2 implementation note.
//
// Why direct API instead of PP SMTP:
//   1. PP's "Email Templates" wiring requires a per-domain SMTP password,
//      which Mailgun's Developer-tier API key cannot manage and the existing
//      postmaster@crm.connie.center credential is in active use (28 sends/30d
//      via SPOK / Connie infra) — resetting it would break those senders.
//   2. Direct send keeps Connie-branded template content under our version
//      control (branding firewall — no Perfex platform strings can leak).
//   3. Multi-tenant clean: works identically for NSS/Lifeline/HHOVV without
//      per-tenant SMTP wiring.
//   4. PP customer-record `*_emails` opt-out flags don't apply (we're not
//      using PP's mailer at all).
//
// Failure mode: send failures are logged but do NOT throw past the caller.
// Bridge handlers stay best-effort — email is enrichment, not load-bearing.

const MAILGUN_DOMAIN = 'crm.connie.center';
const MAILGUN_API_BASE = 'https://api.mailgun.net/v3';

export interface SendEmailInput {
  to: string;                  // customer email
  toName?: string;             // optional customer display name
  subject: string;
  textBody: string;            // plain-text fallback
  htmlBody: string;            // HTML rendering
  replyTo?: string;            // overrides default support@connie.team
  tags?: string[];             // Mailgun-side tagging (max 3 tags per Mailgun rules)
  customVars?: Record<string, string>;
}

export interface SendEmailResult {
  ok: boolean;
  mailgunId?: string;          // Mailgun message-id when delivered
  error?: string;
}

const DEFAULT_FROM = 'Connie Care Team <tickets@crm.connie.center>';
const DEFAULT_REPLY_TO = 'support@connie.team';

export async function sendCustomerEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.warn(JSON.stringify({
      customer_email: true,
      warning: 'MAILGUN_API_KEY not set; skipping send',
      to: redactEmail(input.to),
      subject: input.subject,
    }));
    return { ok: false, error: 'MAILGUN_API_KEY not configured' };
  }

  const url = `${MAILGUN_API_BASE}/${encodeURIComponent(MAILGUN_DOMAIN)}/messages`;
  const formData = new URLSearchParams();
  formData.append('from', DEFAULT_FROM);
  const toAddr = input.toName ? `${input.toName} <${input.to}>` : input.to;
  formData.append('to', toAddr);
  formData.append('subject', input.subject);
  formData.append('text', input.textBody);
  formData.append('html', input.htmlBody);
  formData.append('h:Reply-To', input.replyTo ?? DEFAULT_REPLY_TO);
  for (const tag of input.tags ?? []) {
    formData.append('o:tag', tag);
  }
  for (const [k, v] of Object.entries(input.customVars ?? {})) {
    formData.append(`v:${k}`, v);
  }

  const auth = Buffer.from(`api:${apiKey}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      console.warn(JSON.stringify({
        customer_email: true,
        warning: 'Mailgun rejected send',
        status: res.status,
        body: text.slice(0, 500),
        to: redactEmail(input.to),
        subject: input.subject,
        tags: input.tags,
      }));
      return { ok: false, error: `Mailgun ${res.status}: ${text.slice(0, 200)}` };
    }

    let mailgunId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { id?: string };
      mailgunId = parsed.id;
    } catch {
      // non-JSON success response — still treated as ok
    }

    console.log(JSON.stringify({
      customer_email: true,
      ok: true,
      mailgunId,
      to: redactEmail(input.to),
      subject: input.subject,
      tags: input.tags,
    }));
    return { ok: true, mailgunId };
  } catch (err) {
    console.warn(JSON.stringify({
      customer_email: true,
      warning: 'Mailgun send threw',
      error: err instanceof Error ? err.message : String(err),
      to: redactEmail(input.to),
      subject: input.subject,
    }));
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Lightweight email redaction for logs — keeps domain visible for debugging,
// hides local part. e.g. chris@chrisberno.dev → c***@chrisberno.dev
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
