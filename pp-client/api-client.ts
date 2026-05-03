// pp-client/api-client.ts
// The ONLY file in TroubleTracker allowed to know PP.app's REST API shape.
// No bridge-specific knowledge (no contact-channel, routing, or vendor SDK
// awareness) — those concerns live in adapters, never here.

import type {
  Ticket,
  Reply,
  TicketStatus,
  TicketPriority,
  DeploymentConfig,
  CreateTicketInput,
} from './types';
import {
  PpClientError,
  PpClientAuthError,
  PpClientNotFoundError,
  PpClientRateLimitError,
  PpClientServerError,
  DeploymentNotConfiguredError,
} from './types';

const PRIORITY_TO_PP: Record<TicketPriority, number> = { low: 1, medium: 2, high: 3 };
const PP_TO_PRIORITY: Record<number, TicketPriority> = { 1: 'low', 2: 'medium', 3: 'high' };

interface PpFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  config: DeploymentConfig;
  extraHeaders?: Record<string, string>;
  ticketId?: string;
}

async function ppFetch<T>(opts: PpFetchOptions): Promise<T> {
  const url = `${opts.config.tenantUrl.replace(/\/$/, '')}${opts.path}`;
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    let statusCode = 0;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        authtoken: opts.config.tenantApiToken,
        ...(opts.extraHeaders ?? {}),
      };

      const res = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      statusCode = res.status;
      const durationMs = Date.now() - start;

      console.log(
        JSON.stringify({
          pp_client: true,
          method: opts.method,
          url,
          statusCode,
          durationMs,
          ticketId: opts.ticketId,
          attempt,
        }),
      );

      if (res.status === 429) {
        throw new PpClientRateLimitError();
      }
      if (res.status === 401 || res.status === 403) {
        throw new PpClientAuthError();
      }
      if (res.status === 404) {
        throw new PpClientNotFoundError();
      }
      if (res.status >= 500) {
        if (attempt < maxAttempts) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
          lastError = new PpClientServerError(`PP.app server returned ${res.status}`, res.status);
          continue;
        }
        throw new PpClientServerError(`PP.app server returned ${res.status}`, res.status);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new PpClientError(`PP.app request failed (${res.status}): ${text}`, res.status);
      }

      const text = await res.text();
      if (!text) {
        return {} as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      if (
        err instanceof PpClientRateLimitError ||
        err instanceof PpClientAuthError ||
        err instanceof PpClientNotFoundError
      ) {
        throw err;
      }
      if (err instanceof PpClientError && err.statusCode && err.statusCode < 500) {
        throw err;
      }
      lastError = err;
      if (attempt >= maxAttempts) {
        if (err instanceof PpClientError) throw err;
        throw new PpClientServerError(
          err instanceof Error ? err.message : 'Unknown PP.app fetch error',
          statusCode || 500,
        );
      }
      const backoff = 1000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  if (lastError instanceof PpClientError) throw lastError;
  throw new PpClientServerError('Exhausted retries with no successful PP.app response');
}

function reverseStatusLookup(
  statusId: number,
  statusMap: DeploymentConfig['statusMap'],
): TicketStatus {
  if (statusId === statusMap.open) return 'open';
  if (statusId === statusMap.in_progress) return 'in_progress';
  if (statusId === statusMap.waiting) return 'waiting';
  if (statusMap.resolved !== undefined && statusId === statusMap.resolved) return 'resolved';
  if (statusId === statusMap.closed) return 'closed';
  return 'open';
}

interface PpTicketShape {
  ticketid?: number | string;
  id?: number | string;
  subject?: string;
  body?: string;
  message?: string;
  status?: number | string;
  priority?: number | string;
  clientid?: number | string;
  userid?: number | string;
  contactid?: number | string;
  firstname?: string | null;
  lastname?: string | null;
  user_firstname?: string | null;
  user_lastname?: string | null;
  company?: string | null;
  email?: string;
  phonenumber?: string;
  phone?: string;
  custom_fields?: Record<string, string | number | undefined>;
  customfields?: Array<{ name?: string; slug?: string; value?: string }>;
  datecreated?: string;
  date?: string;
  last_reply?: string;
  lastreply?: string;
}

function readCustomField(
  ticket: PpTicketShape,
  key: string,
): string | undefined {
  if (ticket.custom_fields && ticket.custom_fields[key] !== undefined) {
    const v = ticket.custom_fields[key];
    return v === undefined || v === null ? undefined : String(v);
  }
  if (Array.isArray(ticket.customfields)) {
    for (const cf of ticket.customfields) {
      if (cf?.name === key || cf?.slug === key) {
        return cf.value;
      }
    }
  }
  return undefined;
}

export function mapPpTicketToNormalized(
  raw: PpTicketShape,
  config: DeploymentConfig,
): Ticket {
  const id = String(raw.ticketid ?? raw.id ?? '');
  const subject = raw.subject ?? '';
  const description = raw.body ?? raw.message ?? '';

  const statusNum =
    typeof raw.status === 'string' ? parseInt(raw.status, 10) : (raw.status ?? config.statusMap.open);
  const status = reverseStatusLookup(statusNum, config.statusMap);

  const priorityNum =
    typeof raw.priority === 'string' ? parseInt(raw.priority, 10) : (raw.priority ?? 2);
  const priority = PP_TO_PRIORITY[priorityNum] ?? 'medium';

  const customerName =
    raw.company ||
    [raw.firstname, raw.lastname].filter(Boolean).join(' ').trim() ||
    [raw.user_firstname, raw.user_lastname].filter(Boolean).join(' ').trim() ||
    'Unknown';
  const customer: Ticket['customer'] = {
    name: customerName,
    email: raw.email,
    phone: raw.phonenumber ?? raw.phone,
  };

  const customerScope = readCustomField(raw, 'customer_scope') ?? '';
  const intakeSource = readCustomField(raw, 'intake_source') ?? '';

  const createdAtRaw = raw.datecreated ?? raw.date ?? '';
  const updatedAtRaw = raw.last_reply ?? raw.lastreply ?? createdAtRaw;
  const toIso = (v: string): string => {
    if (!v) return new Date().toISOString();
    const d = new Date(v.replace(' ', 'T'));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  };

  return {
    id,
    subject,
    description,
    status,
    priority,
    customer,
    customerScope,
    intakeSource,
    createdAt: toIso(createdAtRaw),
    updatedAt: toIso(updatedAtRaw),
  };
}

interface PpReplyShape {
  id?: number | string;
  reply_id?: number | string;
  ticketid?: number | string;
  ticket_id?: number | string;
  message?: string;
  description?: string;
  body?: string;
  staffid?: number | string;
  contactid?: number | string;
  email?: string;
  source?: string;
  date?: string;
  datecreated?: string;
}

export function mapPpReplyToNormalized(
  raw: PpReplyShape,
  ticketId: string,
  fallbackBody?: string,
): Reply {
  const id = String(raw.id ?? raw.reply_id ?? '');
  const bodyRaw = raw.message ?? raw.description ?? raw.body ?? fallbackBody ?? '';
  const source = raw.source;
  const staffid = raw.staffid;
  const authorKind: Reply['authorKind'] = source || staffid ? 'agent' : 'customer';
  const authorIdentifier = staffid ? String(staffid) : raw.email;
  const createdRaw = raw.date ?? raw.datecreated ?? '';
  const createdAt =
    createdRaw && !isNaN(new Date(createdRaw.replace(' ', 'T')).getTime())
      ? new Date(createdRaw.replace(' ', 'T')).toISOString()
      : new Date().toISOString();

  return {
    id,
    ticketId,
    body: bodyRaw,
    bodyRaw,
    authorKind,
    authorIdentifier,
    source,
    createdAt,
  };
}

interface PpCreateResponse {
  status?: boolean;
  message?: string;
  record_id?: number | string;
  userid?: number | string;
  id?: number | string;
  data?: { id?: number | string; userid?: number | string; record_id?: number | string };
}

interface PpContactShape {
  id?: number | string;
  userid?: number | string;
  email?: string;
  is_primary?: number | string;
}

async function ensureContactForCustomer(
  customerId: string,
  customer: { name: string; email?: string; phone?: string },
  config: DeploymentConfig,
): Promise<string> {
  // Look up existing contacts for this customer (primary first)
  try {
    const contacts = await ppFetch<PpContactShape[] | { data?: PpContactShape[] }>({
      method: 'GET',
      path: `/api/contacts/${encodeURIComponent(customerId)}`,
      config,
    });
    const list = Array.isArray(contacts) ? contacts : (contacts?.data ?? []);
    if (list.length > 0) {
      const primary = list.find((c) => c.is_primary == 1 || c.is_primary === '1') ?? list[0];
      if (primary?.id !== undefined) return String(primary.id);
    }
  } catch (err) {
    if (!(err instanceof PpClientNotFoundError)) {
      // fall through and try create
    }
  }

  // Split a single name into first/last (best-effort).
  const parts = (customer.name ?? '').trim().split(/\s+/);
  const firstname = parts[0] || 'Customer';
  const lastname = parts.slice(1).join(' ') || '-';

  await ppFetch<PpCreateResponse>({
    method: 'POST',
    path: '/api/contacts',
    body: {
      customer_id: customerId,
      firstname,
      lastname,
      email: customer.email,
      phonenumber: customer.phone,
      is_primary: 'on',
    },
    config,
  });

  // Re-fetch to get the new contact id
  const refetch = await ppFetch<PpContactShape[] | { data?: PpContactShape[] }>({
    method: 'GET',
    path: `/api/contacts/${encodeURIComponent(customerId)}`,
    config,
  });
  const list = Array.isArray(refetch) ? refetch : (refetch?.data ?? []);
  const primary = list.find((c) => c.is_primary == 1 || c.is_primary === '1') ?? list[0];
  if (primary?.id !== undefined) return String(primary.id);
  throw new PpClientServerError('ensureContactForCustomer: no contact id returned by PP.app');
}

async function ensureCustomer(
  customer: { name: string; email?: string; phone?: string },
  config: DeploymentConfig,
): Promise<{ customerId: string; contactId: string }> {
  // Email is unique across PP.app contacts. If a contact with this email
  // already exists, reuse its customer_id + contact_id rather than creating
  // duplicates (PP.app would 409 on the contact create otherwise).
  if (customer.email) {
    try {
      const existing = await ppFetch<PpContactShape[] | { data?: PpContactShape[] }>({
        method: 'GET',
        path: `/api/contacts/search/${encodeURIComponent(customer.email)}`,
        config,
      });
      const list = Array.isArray(existing) ? existing : (existing?.data ?? []);
      if (list.length > 0) {
        const found = list[0];
        const contactId = found.id !== undefined ? String(found.id) : '';
        const customerId = found.userid !== undefined ? String(found.userid) : '';
        if (contactId && customerId) {
          return { customerId, contactId };
        }
      }
    } catch (err) {
      if (!(err instanceof PpClientNotFoundError)) {
        // ignore non-404 search failures and fall through to create
      }
    }
  }

  const created = await ppFetch<PpCreateResponse>({
    method: 'POST',
    path: '/api/customers',
    body: {
      company: customer.name,
      phonenumber: customer.phone,
    },
    config,
  });

  const customerId = String(
    created.record_id ?? created.userid ?? created.id ?? created.data?.record_id ?? created.data?.userid ?? '',
  );
  if (!customerId) {
    throw new PpClientServerError('createCustomer returned no id');
  }

  const contactId = await ensureContactForCustomer(customerId, customer, config);
  return { customerId, contactId };
}

interface PpCreateTicketResponse {
  status?: boolean;
  message?: string;
  record_id?: number | string;
  ticketid?: number | string;
  id?: number | string;
  ticket_id?: number | string;
  data?: PpTicketShape;
}

// PP.app default department id used when adapters don't override.
// PP-CTO confirmed the TroubleTracker tenant ships with department=1 ("General").
const DEFAULT_DEPARTMENT_ID = '1';

export async function createTicket(
  input: CreateTicketInput,
  config: DeploymentConfig,
): Promise<Ticket> {
  const { customerId, contactId } = await ensureCustomer(input.customer, config);

  // Perfex's POST /api/tickets accepts custom_fields keyed as
  //   custom_fields[<fieldto>][<numeric_field_id>] = <value>
  // (handle_custom_fields_post in application/helpers/custom_fields_helper.php
  // iterates as `foreach ($custom_fields as $fieldto => $fields) { foreach ($fields
  // as $field_id => $value) { ... } }`). Slug-keyed flat shape is silently dropped
  // — every adapter must pass numeric IDs from DeploymentConfig.customFieldIds.
  // Phase 2 regression: prior shape was custom_fields: { customer_scope: ..., intake_source: ... }
  // which never persisted. Field IDs are tenant-local; look them up via
  //   SELECT id, slug FROM <tenant_prefix>_tblcustomfields WHERE fieldto='tickets';
  const body: Record<string, unknown> = {
    subject: input.subject,
    body: input.description,
    message: input.description, // PP.app stores body in the `message` column on read
    clientid: customerId,
    contactid: contactId,
    department: DEFAULT_DEPARTMENT_ID,
    priority: PRIORITY_TO_PP[input.priority],
    status: config.statusMap.open,
    custom_fields: {
      tickets: {
        [config.customFieldIds.ticket.customer_scope]: input.customerScope,
        [config.customFieldIds.ticket.intake_source]: input.intakeSource,
      },
    },
  };

  const idempotencyKey = `${input.intakeSource}:${input.customerScope}:${Date.now()}`;

  const res = await ppFetch<PpCreateTicketResponse>({
    method: 'POST',
    path: '/api/tickets',
    body,
    config,
    extraHeaders: { 'X-Idempotency-Key': idempotencyKey },
  });

  const newId = String(
    res.record_id ?? res.ticketid ?? res.ticket_id ?? res.id ?? res.data?.ticketid ?? '',
  );
  if (!newId) {
    if (res.data) {
      return mapPpTicketToNormalized(res.data, config);
    }
    throw new PpClientServerError('createTicket: no ticket id returned by PP.app');
  }

  return getTicket(newId, config);
}

export async function getTicket(
  ticketId: string,
  config: DeploymentConfig,
): Promise<Ticket> {
  const res = await ppFetch<
    PpTicketShape | PpTicketShape[] | { data?: PpTicketShape | PpTicketShape[] }
  >({
    method: 'GET',
    path: `/api/tickets/${encodeURIComponent(ticketId)}`,
    config,
    ticketId,
  });

  // PP.app returns either a single object, an array of one, or { data: ... }.
  let raw: PpTicketShape | undefined;
  if (Array.isArray(res)) {
    raw = res[0];
  } else if (res && typeof res === 'object' && 'data' in res) {
    const d = (res as { data?: PpTicketShape | PpTicketShape[] }).data;
    raw = Array.isArray(d) ? d[0] : d;
  } else {
    raw = res as PpTicketShape;
  }

  if (!raw || (!raw.ticketid && !raw.id)) {
    throw new PpClientNotFoundError(`Ticket ${ticketId} not found`);
  }
  return mapPpTicketToNormalized(raw, config);
}

interface PpReplyResponse {
  status?: boolean;
  message?: string;
  record_id?: number | string;
  reply_id?: number | string;
  id?: number | string;
  data?: PpReplyShape;
}

export async function addReply(
  ticketId: string,
  reply: { body: string; source?: string; isInternal?: boolean },
  config: DeploymentConfig,
): Promise<Reply> {
  const extraHeaders: Record<string, string> = {};
  if (reply.source) extraHeaders['X-PP-Source'] = reply.source;

  // PP.app's reply endpoint expects the body field to be `message`
  // (not `description` — the brief had it wrong; verified live 2026-05-03).
  const res = await ppFetch<PpReplyResponse>({
    method: 'POST',
    path: `/api/tickets/reply/${encodeURIComponent(ticketId)}`,
    body: {
      message: reply.body,
      description: reply.body,
      isinternal: reply.isInternal ? 1 : 0,
    },
    config,
    extraHeaders,
    ticketId,
  });

  const replyShape: PpReplyShape = res.data ?? {
    id: res.record_id ?? res.reply_id ?? res.id,
    description: reply.body,
    source: reply.source,
  };
  const normalized = mapPpReplyToNormalized(replyShape, ticketId, reply.body);
  if (reply.source) normalized.source = reply.source;
  return normalized;
}

export async function updateStatus(
  ticketId: string,
  status: TicketStatus,
  config: DeploymentConfig,
): Promise<Ticket> {
  if (status === 'resolved' && config.statusMap.resolved === undefined) {
    throw new DeploymentNotConfiguredError(
      'resolveTicket requires statusMap.resolved to be configured for this deployment',
    );
  }

  const statusId =
    status === 'open'
      ? config.statusMap.open
      : status === 'in_progress'
        ? config.statusMap.in_progress
        : status === 'waiting'
          ? config.statusMap.waiting
          : status === 'resolved'
            ? (config.statusMap.resolved as number)
            : config.statusMap.closed;

  await ppFetch<unknown>({
    method: 'PUT',
    path: `/api/tickets/${encodeURIComponent(ticketId)}`,
    body: { status: statusId },
    config,
    ticketId,
  });

  return getTicket(ticketId, config);
}

export async function resolveTicket(
  ticketId: string,
  config: DeploymentConfig,
): Promise<Ticket> {
  return updateStatus(ticketId, 'resolved', config);
}

export async function closeTicket(
  ticketId: string,
  config: DeploymentConfig,
): Promise<Ticket> {
  return updateStatus(ticketId, 'closed', config);
}
