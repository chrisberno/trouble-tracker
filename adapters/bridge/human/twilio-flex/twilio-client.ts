// adapters/bridge/human/twilio-flex/twilio-client.ts
// The ONLY file in the bridge allowed to know Twilio's REST API shape.
// Mirrors pp-client/api-client.ts pattern: typed wrapper, defensive parsing,
// idempotency-key support, structured error logging.
//
// Per Manifesto v2.2: Twilio specifics never leak past this surface; pp-client
// specifics never leak in here.

import crypto from 'crypto';
import type { TwilioBridgeConfig } from './types';

// ============================================================================
// Errors
// ============================================================================

export class TwilioClientError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'TwilioClientError';
  }
}

export class TwilioAuthError extends TwilioClientError {
  constructor(message = 'Twilio auth failed') { super(message, 401); this.name = 'TwilioAuthError'; }
}

export class TwilioServerError extends TwilioClientError {
  constructor(message = 'Twilio server error', statusCode = 500) {
    super(message, statusCode);
    this.name = 'TwilioServerError';
  }
}

// ============================================================================
// REST helper
// ============================================================================

interface TwilioFetchOptions {
  method: 'GET' | 'POST';
  url: string;                            // full URL
  formBody?: Record<string, string>;      // x-www-form-urlencoded
  authToken: string;
  accountSid: string;
  idempotencyKey?: string;                // logged + de-dup'd at caller layer
}

async function twilioFetch<T>(opts: TwilioFetchOptions): Promise<T> {
  const start = Date.now();
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (opts.formBody) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.formBody).toString();
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(opts.url, { method: opts.method, headers, body });
      const durationMs = Date.now() - start;
      console.log(JSON.stringify({
        twilio_client: true,
        method: opts.method,
        url: opts.url,
        statusCode: res.status,
        durationMs,
        idempotencyKey: opts.idempotencyKey,
        attempt,
      }));

      if (res.status === 401 || res.status === 403) {
        throw new TwilioAuthError(`Twilio rejected auth (${res.status})`);
      }
      if (res.status >= 500) {
        if (attempt < maxAttempts) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
          lastError = new TwilioServerError(`Twilio server returned ${res.status}`, res.status);
          continue;
        }
        throw new TwilioServerError(`Twilio server returned ${res.status}`, res.status);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TwilioClientError(`Twilio request failed (${res.status}): ${text}`, res.status);
      }

      const text = await res.text();
      if (!text) return {} as T;
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    } catch (err) {
      if (err instanceof TwilioAuthError) throw err;
      if (err instanceof TwilioClientError && err.statusCode && err.statusCode < 500) throw err;
      lastError = err;
      if (attempt >= maxAttempts) {
        if (err instanceof TwilioClientError) throw err;
        throw new TwilioServerError(err instanceof Error ? err.message : 'Unknown Twilio fetch error');
      }
      const backoff = 1000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  if (lastError instanceof TwilioClientError) throw lastError;
  throw new TwilioServerError('Exhausted retries with no successful Twilio response');
}

// ============================================================================
// Signature verification (HMAC-SHA1 — Twilio's standard scheme)
//
// IMPORTANT: assumes Twilio is signing webhooks with the ACCOUNT auth token.
// If anyone configures a service-level signing key on the Conversations Service
// (currently IS8bd6c045... has none — verified during ledger Phase B B2), this
// verifier will silently start failing. See ledger Decisions log + brief CEO
// defaults table for the assumption + remediation path.
//
// Algorithm per https://www.twilio.com/docs/usage/webhooks/webhooks-security:
//   1. Take the full request URL (scheme + host + path + sorted query string)
//   2. For form-encoded POSTs, append each form param's name + value, sorted by name
//   3. HMAC-SHA1 the result using the auth token; base64 encode
//   4. Compare (timing-safe) to X-Twilio-Signature header
// ============================================================================

export function verifyTwilioSignature(opts: {
  fullUrl: string;                                // full URL Twilio called
  formParams: Record<string, string>;             // parsed form body (empty for GET)
  signatureHeader: string;                        // value of X-Twilio-Signature
  authToken: string;
}): boolean {
  if (!opts.signatureHeader || !opts.authToken) return false;

  // Per Twilio: sort params by name, concatenate name+value pairs (no separators).
  const sortedKeys = Object.keys(opts.formParams).sort();
  let data = opts.fullUrl;
  for (const key of sortedKeys) {
    data += key + opts.formParams[key];
  }

  const computed = crypto
    .createHmac('sha1', opts.authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');

  // Timing-safe compare. Both are base64; lengths must match.
  const a = Buffer.from(computed);
  const b = Buffer.from(opts.signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ============================================================================
// Interactions API — create a Task + underlying Conversation in one call
// ============================================================================

export interface CreateInteractionInput {
  subject: string;
  attributes: Record<string, string | number | undefined>;  // task attributes (incl. profile_url, ticketId, deploymentId, customerScope, customerName/email/phone, priority, type)
}

export interface CreateInteractionResult {
  interactionSid: string;
  conversationSid: string;
  taskSid?: string;        // populated by Twilio when routing creates a Task
}

interface RawInteraction {
  sid?: string;
  channel?: { sid?: string; type?: string };
  routing?: {
    properties?: { sid?: string; task_sid?: string };
    reservation_sid?: string;
  };
}

/**
 * POST /v1/Interactions on flex.twilio.com.
 * Creates an Interaction, which Twilio expands into:
 *   - a Conversation (the messaging substrate)
 *   - a Task in TaskRouter (assigned to the workflow's queue)
 * The conversationSid is what we persist; subsequent agent messages flow
 * through the Conversations Service-level webhook attached to that service.
 */
export async function createInteraction(
  input: CreateInteractionInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<CreateInteractionResult> {
  const channel = {
    type: config.taskChannel,
    initiated_by: 'customer',
    properties: {
      type: 'support-ticket',
      subject: input.subject,
    },
  };

  // Strip undefined attribute values; Twilio rejects them in the JSON.
  const cleanAttributes: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input.attributes)) {
    if (v !== undefined && v !== null) cleanAttributes[k] = v;
  }

  const routing = {
    properties: {
      workspace_sid: config.workspaceSid,
      workflow_sid: config.supportWorkflowSid,
      queue_sid: config.supportQueueSid,
      task_channel_unique_name: config.taskChannel,
      attributes: cleanAttributes,
    },
  };

  const formBody: Record<string, string> = {
    Channel: JSON.stringify(channel),
    Routing: JSON.stringify(routing),
  };

  const raw = await twilioFetch<RawInteraction>({
    method: 'POST',
    url: 'https://flex.twilio.com/v1/Interactions',
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const interactionSid = raw.sid ?? '';
  const conversationSid = raw.channel?.sid ?? '';
  const taskSid = raw.routing?.properties?.task_sid;
  if (!interactionSid || !conversationSid) {
    throw new TwilioServerError(
      `createInteraction: missing sid/channel in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return { interactionSid, conversationSid, taskSid };
}

// ============================================================================
// Conversations API — post a message to an existing Conversation
// ============================================================================

export interface PostMessageInput {
  conversationSid: string;
  body: string;
  author: string;        // 'customer' for customer-side; agent SID for agent-side
}

interface RawMessage {
  sid?: string;
  conversation_sid?: string;
  body?: string;
  author?: string;
  date_created?: string;
}

export interface PostMessageResult {
  messageSid: string;
  conversationSid: string;
  author?: string;
  createdAt?: string;
}

export async function postConversationMessage(
  input: PostMessageInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<PostMessageResult> {
  const url = `https://conversations.twilio.com/v1/Services/${encodeURIComponent(
    config.conversationsServiceSid,
  )}/Conversations/${encodeURIComponent(input.conversationSid)}/Messages`;

  const formBody: Record<string, string> = {
    Body: input.body,
    Author: input.author,
  };

  const raw = await twilioFetch<RawMessage>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const messageSid = raw.sid ?? '';
  if (!messageSid) {
    throw new TwilioServerError(
      `postConversationMessage: missing sid in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return {
    messageSid,
    conversationSid: raw.conversation_sid ?? input.conversationSid,
    author: raw.author,
    createdAt: raw.date_created,
  };
}

// ============================================================================
// Builder — collects all the surface a handler needs in one object
// ============================================================================

export interface TwilioClient {
  config: TwilioBridgeConfig;
  createInteraction: (input: CreateInteractionInput, idempotencyKey: string) => Promise<CreateInteractionResult>;
  postConversationMessage: (input: PostMessageInput, idempotencyKey: string) => Promise<PostMessageResult>;
  verifySignature: (opts: Omit<Parameters<typeof verifyTwilioSignature>[0], 'authToken'>) => boolean;
}

export function buildTwilioClient(config: TwilioBridgeConfig): TwilioClient {
  return {
    config,
    createInteraction: (input, idempotencyKey) => createInteraction(input, config, idempotencyKey),
    postConversationMessage: (input, idempotencyKey) => postConversationMessage(input, config, idempotencyKey),
    verifySignature: (opts) => verifyTwilioSignature({ ...opts, authToken: config.authToken }),
  };
}
