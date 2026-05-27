// pp-client/types.ts
// Normalized ticket/event/reply shapes — the contract every adapter speaks.
// No PP.app/Perfex specifics leak past this surface.

// Normalized ticket — what adapters see, regardless of PP.app shape underneath
export interface Ticket {
  id: string;                    // PP.app ticket ID (string for stability)
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  customer: { name: string; email?: string; phone?: string };
  customerScope: string;         // NSS / HHOVV / Lifeline / etc. — stored via custom field 'customer_scope'
  intakeSource: string;          // 'web-form' | 'email' | 'sms' | etc.
  createdAt: string;             // ISO 8601
  updatedAt: string;
}

export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high';

// 4 raw events from PP via tt_webhook_bridge; ticket.resolved and ticket.closed are DERIVED
export type CoreEvent =
  | { kind: 'ticket.created';          ticket: Ticket }
  | { kind: 'ticket.replied.customer'; ticketId: string; reply: Reply }
  | { kind: 'ticket.replied.agent';    ticketId: string; reply: Reply }
  | { kind: 'ticket.status_changed';   ticketId: string; newStatusId: number; previousStatusId: number; ticket: Ticket }
  | { kind: 'ticket.resolved';         ticketId: string }
  | { kind: 'ticket.closed';           ticketId: string }
  | { kind: 'ticket.deleted';          ticketId: string };

export interface Reply {
  id: string;
  ticketId: string;
  body: string;            // HTML-stripped — pp-client's job
  bodyRaw?: string;        // original pre-strip body, for audit
  authorKind: 'customer' | 'agent' | 'system';
  authorIdentifier?: string;  // email or staff ID
  source?: string;         // opaque bridge metadata — presence = agent, absence = customer
  // TTB-24 (Sprint 2.0 reopen, 2026-05-08): internal-note flag from Perfex.
  // Webhook payload typically carries `admin: '0'` (visible reply) vs `admin: '1'`
  // (internal note); event-mapper.ts checks several candidate field names
  // because Perfex's API surface is under-documented and varies by release.
  // Customer-email subscriber MUST skip when this is true (acceptance gate #6).
  internalNote?: boolean;
  createdAt: string;
}

// Attachment input for addReply. Adapters pre-fetch the binary (e.g. from
// Twilio MCS) and pass it in as a Buffer along with filename + content type.
// pp-client converts to multipart on the wire — Perfex's reply endpoint
// accepts `attachments[]` array notation in multipart/form-data.
export interface ReplyAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

// Deployment config — adapters pass this in; pp-client uses what it's given
export interface DeploymentConfig {
  tenantUrl: string;           // e.g. https://troubletracker.peopleperson.app
  tenantApiToken: string;      // from TROUBLETRACKER_TENANT_API_TOKEN
  customerScopeRule: (req: unknown) => string;
  statusMap: {
    open: number;              // Perfex status ID for 'open' (default: 1)
    in_progress: number;       // Perfex status ID for 'in_progress' (default: 2)
    waiting: number;           // Perfex status ID for 'waiting' (default: 4)
    resolved?: number;         // Perfex status ID for 'resolved' — optional; resolveTicket throws if absent
    closed: number;            // Perfex status ID for 'closed' (default: 5)
  };
  // Per-tenant numeric IDs for custom fields. Perfex's POST /api/tickets accepts
  // custom_fields keyed as custom_fields[<fieldto>][<numeric_id>] = <value>; slug-keyed
  // shapes are silently dropped. Each deployment must enumerate the IDs of fields it
  // expects pp-client to populate. Field IDs are local to a tenant — look up via
  // SELECT id, slug FROM <tenant_prefix>_tblcustomfields.
  customFieldIds: {
    ticket: {
      customer_scope: number;  // ID of the ticket-scoped 'customer_scope' field
      intake_source: number;   // ID of the ticket-scoped 'intake_source' field
    };
  };
  // Sprint 4.0 — per-deployment channel configuration. Substrate reads these
  // and conditionally registers subscribers / overrides hardcoded defaults.
  // Absence preserves pre-S4.0 behavior (customer-email always-on, no Flex
  // customer-reply subscriber).
  channels?: ChannelsConfig;
}

// Per-deployment channel toggles. Mirrors the basecamp flex-project-template
// feature-management pattern: enabled-or-not, plus the narrow set of knobs
// each channel needs. Adding a new channel = new block here + new reader in
// the relevant adapter's register.ts.
export interface ChannelsConfig {
  customerEmail?: CustomerEmailChannelConfig;
  flexCustomerReplyNotification?: FlexCustomerReplyNotificationConfig;
}

export interface CustomerEmailChannelConfig {
  // Master toggle. false = customer-email subscribers don't register at all,
  // substrate stays silent on ticket.created / ticket.replied.agent.
  enabled: boolean;
  // Which PP events fire outbound mail. Subset of ['ticket.created',
  // 'ticket.replied.agent']. Order-insensitive. Absent or empty array = no
  // events fire (effectively `enabled: false`).
  events: Array<'ticket.created' | 'ticket.replied.agent'>;
  // Reply-To header on outbound mail. Customer's reply lands here.
  //   - 'support@connie.team' (legacy): human inbox, no round-trip
  //   - 'replies@crm.connie.center' (Sprint 4.0): Mailgun-managed, route
  //     forwards to /api/email-inbound + mirrors to support@connie.team
  replyTo: string;
  // Optional: documentation-only mirror of where the Mailgun route's forward()
  // action delivers a copy. Code does not consume this value — it's recorded
  // here so the deployment file is the single source of truth on where
  // customer replies end up. The actual forward target is configured in the
  // Mailgun route (Task 4).
  replyToForward?: string;
  // Optional: documentation-only flag. true = the Mailgun inbound route
  // (notify=/api/email-inbound) is configured for replyTo. Code does not
  // consume this — it's a config-file canary so future ops know whether the
  // round-trip is wired without spelunking through Mailgun dashboard.
  inboundWebhook?: boolean;
}

export interface FlexCustomerReplyNotificationConfig {
  // When true, the bridge handler emits the Flex-side surface for
  // ticket.replied.customer events: task.attributes.ticketHasNewReply=true on
  // the assigned task + a Flex notification to the assigned agent. The
  // basecamp ticket-reply-notification feature (Task 3) reads the attribute
  // and renders the canvas badge. When false, no attribute mutation, no
  // notification.
  enabled: boolean;
}

// Typed errors — never return undefined or { success: false }
export class PpClientError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'PpClientError';
  }
}
export class PpClientAuthError extends PpClientError {
  constructor(message = 'Authentication failed') { super(message, 401); this.name = 'PpClientAuthError'; }
}
export class PpClientNotFoundError extends PpClientError {
  constructor(message = 'Resource not found') { super(message, 404); this.name = 'PpClientNotFoundError'; }
}
export class PpClientRateLimitError extends PpClientError {
  constructor(message = 'Rate limit exceeded') { super(message, 429); this.name = 'PpClientRateLimitError'; }
}
export class PpClientServerError extends PpClientError {
  constructor(message = 'PP.app server error', statusCode = 500) { super(message, statusCode); this.name = 'PpClientServerError'; }
}
export class DeploymentNotConfiguredError extends PpClientError {
  constructor(message: string) { super(message); this.name = 'DeploymentNotConfiguredError'; }
}

// Input type for createTicket
export interface CreateTicketInput {
  subject: string;
  description: string;
  priority: TicketPriority;
  customer: { name: string; email?: string; phone?: string };
  customerScope: string;
  intakeSource: string;
}
