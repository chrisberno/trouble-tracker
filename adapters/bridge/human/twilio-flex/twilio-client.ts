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
// TaskRouter Tasks API — create a Task directly on the Workspace
//
// PIVOT (Phase 3 v2, 2026-05-04): the original brief specified the Flex
// Interactions API (`POST flex.twilio.com/v1/Interactions`). Live e2e smoke
// (ticket 15) revealed that endpoint rejects our auth + body across many
// shape variants on this account. The legacy production code at
// `lib/taskrouter.ts:75-85` AND Connie's basecamp-v26.02
// (taskrouter.private.js:194-213) both use the TaskRouter Tasks API directly
// on the same workspace + same auth — known-working in production for ~1 year.
// Pivoted Phase 3 to match that proven pattern.
//
// What we lose: Twilio Interactions doesn't auto-create a Conversation, so
// agent reply round-trip via WorkBench's native Conversation UI is N/A.
// Phase 3 agent UX is iframe-driven (status flip, customer reply, internal
// note buttons in our iframe POST to bridge endpoints).
//
// Phase 4 may revisit Conversations integration when we wire the customer
// email loop. `postConversationMessage()` is kept defined below for that
// forward-compat use; not called in Phase 3.
// ============================================================================

export interface CreateTaskInput {
  workflowSid: string;
  taskChannel: string;          // unique_name: 'default', 'email', 'voice', 'chat', etc.
  friendlyName: string;         // drives queue list line 1; legacy: `Support Ticket: <title>`
  priority: number;             // legacy mapping: high=0, medium=5, low=10
  timeout: number;              // seconds; legacy default 3600
  attributes: Record<string, unknown>;  // serialized as JSON in the Attributes form param
}

export interface CreateTaskResult {
  taskSid: string;
  attributes: Record<string, unknown>;
}

interface RawTask {
  sid?: string;
  task_sid?: string;
  attributes?: string;          // Twilio returns this as a JSON string
  workflow_sid?: string;
  workspace_sid?: string;
  date_created?: string;
}

/**
 * POST /v1/Workspaces/{WS}/Tasks on taskrouter.twilio.com.
 *
 * Form-encoded body shape mirrors `lib/taskrouter.ts:66-85` exactly so the
 * resulting task is rendered by basecamp's Flex plugin identically to legacy
 * NSS PCA tasks (line 1 friendly name, line 2 origin/customerScope, etc.).
 *
 * Auth: Basic accountSid:authToken. Same auth that drives B3 (TaskRouter
 * event-callback URL) — known-working on this account.
 */
export async function createTask(
  input: CreateTaskInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<CreateTaskResult> {
  const formBody: Record<string, string> = {
    WorkflowSid: input.workflowSid,
    TaskChannel: input.taskChannel,
    FriendlyName: input.friendlyName,
    Priority: String(input.priority),
    Timeout: String(input.timeout),
    Attributes: JSON.stringify(input.attributes),
  };

  const url = `https://taskrouter.twilio.com/v1/Workspaces/${encodeURIComponent(
    config.workspaceSid,
  )}/Tasks`;

  const raw = await twilioFetch<RawTask>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const taskSid = raw.sid ?? raw.task_sid ?? '';
  if (!taskSid) {
    throw new TwilioServerError(
      `createTask: missing sid in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  let parsedAttributes: Record<string, unknown> = {};
  if (typeof raw.attributes === 'string') {
    try {
      parsedAttributes = JSON.parse(raw.attributes);
    } catch {
      // Twilio occasionally returns attributes as already-an-object (SDK behavior);
      // fall through with empty parsed result if parse fails.
    }
  }

  return { taskSid, attributes: parsedAttributes };
}

// ============================================================================
// Conversations API — post a message to an existing Conversation
//
// Phase 3 NOTE: this function is unused after the Phase 3 pivot to TaskRouter
// Tasks API. Kept defined (not deleted) for Phase 4 forward-compat when we
// wire the customer email feedback loop, which may need to push customer
// emails through Conversations into agent-side Flex UIs. Until Phase 4
// activates this, no callers exist; tree-shaker may remove it.
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
// Conversations API — create conversation, add participant, add first message
//
// Phase 3 v3 (TTB-1, 2026-05-05): Pattern B chain. handlers.ts uses these to
// build the conversation context BEFORE the Interaction is created, so that
// the bound task lands in the Connie canvas with the message thread + composer
// rendered natively.
//
// CRITICAL: conversationsServiceSid in deployment config MUST be the Flex
// default chat service SID (CCT: IS91e4bcb2939d4672a007ef27d323ad41). Flex
// workers can only be added as participants to conversations in their service.
// Wrong service = HTTP 400 on agent accept. This was the root cause of the
// Phase 3 v2 pivot to Pattern A (raw POST /Tasks).
// ============================================================================

export interface CreateConversationInput {
  friendlyName: string;
  attributes: Record<string, unknown>;
}

interface RawConversation {
  sid?: string;
  chat_service_sid?: string;
  friendly_name?: string;
  state?: string;
  attributes?: string;
}

export interface CreateConversationResult {
  conversationSid: string;
  chatServiceSid: string;
}

export async function createConversation(
  input: CreateConversationInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<CreateConversationResult> {
  const url = `https://conversations.twilio.com/v1/Services/${encodeURIComponent(
    config.conversationsServiceSid,
  )}/Conversations`;

  const formBody: Record<string, string> = {
    FriendlyName: input.friendlyName,
    Attributes: JSON.stringify(input.attributes),
  };

  const raw = await twilioFetch<RawConversation>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const conversationSid = raw.sid ?? '';
  if (!conversationSid) {
    throw new TwilioServerError(
      `createConversation: missing sid in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return {
    conversationSid,
    chatServiceSid: raw.chat_service_sid ?? config.conversationsServiceSid,
  };
}

export interface AddParticipantInput {
  conversationSid: string;
  identity: string;                    // proxy identity for the customer
  attributes: Record<string, unknown>;
}

interface RawParticipant {
  sid?: string;
  identity?: string;
}

export interface AddParticipantResult {
  participantSid: string;
  identity: string;
}

export async function addConversationParticipant(
  input: AddParticipantInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<AddParticipantResult> {
  const url = `https://conversations.twilio.com/v1/Services/${encodeURIComponent(
    config.conversationsServiceSid,
  )}/Conversations/${encodeURIComponent(input.conversationSid)}/Participants`;

  const formBody: Record<string, string> = {
    Identity: input.identity,
    Attributes: JSON.stringify(input.attributes),
  };

  const raw = await twilioFetch<RawParticipant>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const participantSid = raw.sid ?? '';
  if (!participantSid) {
    throw new TwilioServerError(
      `addConversationParticipant: missing sid in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return { participantSid, identity: raw.identity ?? input.identity };
}

// ============================================================================
// Flex Interactions API — create Interaction with conversation bound
//
// This is the canonical Twilio path that produces a properly-bound Flex task:
//   - Channel.properties.media_channel_sid links to the existing Conversation
//   - Routing creates the TaskRouter task with attributes + queue
//   - Returned task has flexInteractionSid + flexInteractionChannelSid +
//     conversations.media wired so the agent canvas renders natively
// ============================================================================

export interface CreateInteractionInput {
  conversationSid: string;
  initiatedBy: 'customer' | 'agent';
  channelType: 'chat' | 'sms' | 'email' | 'whatsapp' | 'web';
  workflowSid: string;
  taskChannelUniqueName: string;
  taskAttributes: Record<string, unknown>;
}

interface RawInteractionRoutingProps {
  sid?: string;
  attributes?: string;
  task_channel_unique_name?: string;
  workflow_sid?: string;
  workspace_sid?: string;
  assignment_status?: string;
}

interface RawInteractionChannel {
  sid?: string;
  type?: string;
}

interface RawInteraction {
  sid?: string;
  channel?: RawInteractionChannel;
  routing?: { properties?: RawInteractionRoutingProps };
}

export interface CreateInteractionResult {
  interactionSid: string;
  channelSid: string;                  // UO... — interaction-level channel
  taskSid: string;
  conversationSid: string;             // pass-through for caller convenience
}

export async function createInteraction(
  input: CreateInteractionInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<CreateInteractionResult> {
  const url = 'https://flex-api.twilio.com/v1/Interactions';

  const channel = {
    type: input.channelType,
    initiated_by: input.initiatedBy,
    properties: { media_channel_sid: input.conversationSid },
  };

  const routing = {
    properties: {
      workspace_sid: config.workspaceSid,
      workflow_sid: input.workflowSid,
      task_channel_unique_name: input.taskChannelUniqueName,
      attributes: input.taskAttributes,
    },
  };

  const formBody: Record<string, string> = {
    Channel: JSON.stringify(channel),
    Routing: JSON.stringify(routing),
  };

  const raw = await twilioFetch<RawInteraction>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const interactionSid = raw.sid ?? '';
  const channelSid = raw.channel?.sid ?? '';
  const taskSid = raw.routing?.properties?.sid ?? '';

  if (!interactionSid || !taskSid) {
    throw new TwilioServerError(
      `createInteraction: missing required SIDs in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return {
    interactionSid,
    channelSid,
    taskSid,
    conversationSid: input.conversationSid,
  };
}

// ============================================================================
// Conversation Webhooks API — register per-conversation webhook
//
// Phase 5 (TTB-1): subscribe to onMessageAdded events on each TT-managed
// Conversation so agent canvas replies forward to PP.app addReply. The webhook
// URL includes ticketId as a query param so the receiver doesn't need a
// conversation lookup.
// ============================================================================

export interface AddConversationWebhookInput {
  conversationSid: string;
  url: string;                         // full URL (may include query string)
  filters: string[];                   // e.g. ['onMessageAdded']
  method?: 'POST' | 'GET';
}

interface RawConversationWebhook {
  sid?: string;
  conversation_sid?: string;
  target?: string;
}

export interface AddConversationWebhookResult {
  webhookSid: string;
}

export async function addConversationWebhook(
  input: AddConversationWebhookInput,
  config: TwilioBridgeConfig,
  idempotencyKey: string,
): Promise<AddConversationWebhookResult> {
  const url = `https://conversations.twilio.com/v1/Services/${encodeURIComponent(
    config.conversationsServiceSid,
  )}/Conversations/${encodeURIComponent(input.conversationSid)}/Webhooks`;

  // For multi-value Configuration.Filters, Twilio expects repeated form params.
  // Single-filter case (Phase 5 MVP) uses a single value.
  const formBody: Record<string, string> = {
    Target: 'webhook',
    'Configuration.Url': input.url,
    'Configuration.Method': input.method ?? 'POST',
    'Configuration.Filters': input.filters.join(','),
  };

  const raw = await twilioFetch<RawConversationWebhook>({
    method: 'POST',
    url,
    formBody,
    accountSid: config.accountSid,
    authToken: config.authToken,
    idempotencyKey,
  });

  const webhookSid = raw.sid ?? '';
  if (!webhookSid) {
    throw new TwilioServerError(
      `addConversationWebhook: missing sid in Twilio response (got: ${JSON.stringify(raw)})`,
    );
  }

  return { webhookSid };
}

// ============================================================================
// Conversations Media Content Service (MCS) — fetch a media binary
//
// TTB-13 Bug 2 (TTB-1, 2026-05-05): when a Connie agent attaches a file in the
// canvas composer, Twilio stores it on MCS and references it from the
// onMessageAdded webhook payload's `Media` field (JSON-stringified array of
// {sid, filename, content_type, size, category}). To forward to PP.app as a
// ticket attachment we:
//   1. GET https://mcs.us1.twilio.com/v1/Services/{ChatServiceSid}/Media/{MediaSid}
//      with Basic auth → returns metadata + presigned `links.content_direct_temporary`
//   2. GET that presigned URL (no auth) → returns the binary
//
// MCS host is fixed to us1 — Conversations Service IS91e4bcb... is provisioned
// in us1. If we ever deploy in another region, this needs region awareness.
// ============================================================================

export interface FetchConversationMediaInput {
  chatServiceSid: string;                  // Conversations Service SID (IS...)
  mediaSid: string;                        // Media SID (ME...)
}

export interface FetchedConversationMedia {
  sid: string;
  filename: string;
  contentType: string;
  size: number;
  data: Buffer;                            // binary
}

interface RawMediaMetadata {
  sid?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  links?: { content_direct_temporary?: string; content?: string };
}

export async function fetchConversationMedia(
  input: FetchConversationMediaInput,
  config: TwilioBridgeConfig,
): Promise<FetchedConversationMedia> {
  // Step 1: fetch metadata + presigned URL.
  const metadataUrl = `https://mcs.us1.twilio.com/v1/Services/${encodeURIComponent(
    input.chatServiceSid,
  )}/Media/${encodeURIComponent(input.mediaSid)}`;

  const meta = await twilioFetch<RawMediaMetadata>({
    method: 'GET',
    url: metadataUrl,
    accountSid: config.accountSid,
    authToken: config.authToken,
  });

  const presignedUrl = meta.links?.content_direct_temporary;
  if (!presignedUrl) {
    throw new TwilioServerError(
      `fetchConversationMedia: missing content_direct_temporary in MCS response for ${input.mediaSid}`,
    );
  }

  // Step 2: download binary from presigned URL (no auth — URL is signed).
  const start = Date.now();
  const res = await fetch(presignedUrl);
  const durationMs = Date.now() - start;
  if (!res.ok) {
    throw new TwilioServerError(
      `fetchConversationMedia: presigned download failed (${res.status}) for ${input.mediaSid}`,
      res.status,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  const data = Buffer.from(arrayBuffer);

  console.log(JSON.stringify({
    twilio_client: true,
    op: 'fetchConversationMedia',
    mediaSid: input.mediaSid,
    chatServiceSid: input.chatServiceSid,
    bytes: data.length,
    contentType: meta.content_type,
    durationMs,
  }));

  return {
    sid: meta.sid ?? input.mediaSid,
    filename: meta.filename ?? `${input.mediaSid}.bin`,
    contentType: meta.content_type ?? 'application/octet-stream',
    size: meta.size ?? data.length,
    data,
  };
}

// ============================================================================
// Builder — collects all the surface a handler needs in one object
// ============================================================================

export interface TwilioClient {
  config: TwilioBridgeConfig;
  createTask: (input: CreateTaskInput, idempotencyKey: string) => Promise<CreateTaskResult>;
  postConversationMessage: (input: PostMessageInput, idempotencyKey: string) => Promise<PostMessageResult>;
  // Phase 3 v3 (TTB-1) — Pattern B chain
  createConversation: (input: CreateConversationInput, idempotencyKey: string) => Promise<CreateConversationResult>;
  addConversationParticipant: (input: AddParticipantInput, idempotencyKey: string) => Promise<AddParticipantResult>;
  createInteraction: (input: CreateInteractionInput, idempotencyKey: string) => Promise<CreateInteractionResult>;
  // Phase 5 (TTB-1) — agent canvas reply forwarder
  addConversationWebhook: (input: AddConversationWebhookInput, idempotencyKey: string) => Promise<AddConversationWebhookResult>;
  // TTB-13 Bug 2 — attachment forwarding
  fetchConversationMedia: (input: FetchConversationMediaInput) => Promise<FetchedConversationMedia>;
  verifySignature: (opts: Omit<Parameters<typeof verifyTwilioSignature>[0], 'authToken'>) => boolean;
}

export function buildTwilioClient(config: TwilioBridgeConfig): TwilioClient {
  return {
    config,
    createTask: (input, idempotencyKey) => createTask(input, config, idempotencyKey),
    postConversationMessage: (input, idempotencyKey) => postConversationMessage(input, config, idempotencyKey),
    createConversation: (input, idempotencyKey) => createConversation(input, config, idempotencyKey),
    addConversationParticipant: (input, idempotencyKey) => addConversationParticipant(input, config, idempotencyKey),
    createInteraction: (input, idempotencyKey) => createInteraction(input, config, idempotencyKey),
    addConversationWebhook: (input, idempotencyKey) => addConversationWebhook(input, config, idempotencyKey),
    fetchConversationMedia: (input) => fetchConversationMedia(input, config),
    verifySignature: (opts) => verifyTwilioSignature({ ...opts, authToken: config.authToken }),
  };
}
