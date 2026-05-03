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
  createdAt: string;
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
