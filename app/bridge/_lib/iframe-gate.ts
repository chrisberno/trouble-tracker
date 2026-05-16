// app/bridge/_lib/iframe-gate.ts
//
// Server-side iframe-only gate for /bridge/* pages.
//
// Checks the request's Referer header against an allowlist of Connie tenant
// domains + Twilio Flex domains + self-origin. Returns { allowed: false } for
// direct-browser visits, deliberate sharing, and any other off-allowlist origin.
//
// Honest scope: this is a UX deterrent + brand-firewall guard, NOT security.
// Referer is spoofable via curl/headers in 5 seconds. Real defense for
// PII-adjacent surfaces is signed tokens issued by the embedding host
// (e.g., connie.plus → HMAC-signed param → verified server-side here).
// That's a separate sprint item (Connie Ticket Tracker COP).
//
// Allowlist mirrors `vercel.json` CSP `frame-ancestors`:
//   - 'self' (any host serving this app — handles vercel.app + preview URLs)
//   - *.connie.team (all Connie tenant subdomains)
//   - flex.twilio.com + *.flex.twilio.com (CCT WorkBench task pane)
//   - *.twilio.com / *.twil.io (Flex variants)
//
// Development bypass: when NODE_ENV !== 'production', always allowed.
// Local `npm run dev` works without faking a Referer header.

import { headers } from 'next/headers';

const ALLOWED_HOSTS: RegExp[] = [
  /^connie\.team$/,
  /^[a-z0-9-]+\.connie\.team$/,
  /^flex\.twilio\.com$/,
  /^[a-z0-9-]+\.flex\.twilio\.com$/,
  /^[a-z0-9-]+\.twilio\.com$/,
  /^[a-z0-9-]+\.twil\.io$/,
];

export type IframeGateResult =
  | { allowed: true; referer: string; host: string }
  | { allowed: false; reason: 'no_referer' | 'invalid_referer' | 'blocked_host'; referer: string; host: string | null };

export async function checkIframeOrigin(): Promise<IframeGateResult> {
  if (process.env.NODE_ENV !== 'production') {
    return { allowed: true, referer: '(dev-bypass)', host: 'localhost' };
  }
  const h = await headers();
  const referer = h.get('referer') ?? '';
  const selfHost = (h.get('host') ?? '').toLowerCase();
  const secFetchDest = (h.get('sec-fetch-dest') ?? '').toLowerCase();

  // Sec-Fetch-Dest is a forbidden header (browser-set, not script-settable).
  // 'iframe'/'frame' = browser-confirmed embed; CSP frame-ancestors already
  // gates who may embed us. Required for embeddings where the parent strips
  // Referer via Referrer-Policy (e.g., NSS careteam.connie.team).
  if (secFetchDest === 'iframe' || secFetchDest === 'frame') {
    return { allowed: true, referer: referer || '(sec-fetch-dest=iframe)', host: 'iframe-embed' };
  }

  if (!referer) {
    return { allowed: false, reason: 'no_referer', referer: '', host: null };
  }

  let refHost: string;
  try {
    refHost = new URL(referer).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: 'invalid_referer', referer, host: null };
  }

  // Same-origin = intra-app navigation (list → detail → back). Always allowed.
  if (refHost === selfHost) {
    return { allowed: true, referer, host: refHost };
  }

  const matched = ALLOWED_HOSTS.some((pattern) => pattern.test(refHost));
  if (!matched) {
    return { allowed: false, reason: 'blocked_host', referer, host: refHost };
  }
  return { allowed: true, referer, host: refHost };
}
