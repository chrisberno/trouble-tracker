// pp-client/api-client.ts
// The ONLY file in TroubleTracker allowed to know PP.app's REST API shape.
// No Twilio, Flex, TaskRouter, or bridge-specific knowledge here.

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
  name?: string;
  firstname?: string;
  lastname?: string;
  company?: string;
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
    raw.name ||
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

interface PpCustomerCreateResponse {
  userid?: number | string;
  id?: number | string;
  message?: string;
  status?: boolean;
}

interface PpCustomerListItem {
  userid?: number | string;
  id?: number | string;
  email?: string;
  company?: string;
}

async function ensureCustomer(
  customer: { name: string; email?: string; phone?: string },
  config: DeploymentConfig,
): Promise<string> {
  if (customer.email) {
    try {
      const search = await ppFetch<PpCustomerListItem[] | { data?: PpCustomerListItem[] }>({
        method: 'GET',
        path: `/api/customers/search/${encodeURIComponent(customer.email)}`,
        config,
      });
      const list = Array.isArray(search) ? search : (search?.data ?? []);
      if (list.length > 0) {
        const found = list[0];
        const id = found.userid ?? found.id;
        if (id !== undefined) return String(id);
      }
    } catch (err) {
      if (!(err instanceof PpClientNotFoundError)) {
        // ignore non-404 search failures and fall through to create
      }
    }
  }

  try {
    const created = await ppFetch<PpCustomerCreateResponse>({
      method: 'POST',
      path: '/api/customers',
      body: {
        company: customer.name,
        email: customer.email,
        phonenumber: customer.phone,
      },
      config,
    });
    const id = created.userid ?? created.id;
    if (id !== undefined) return String(id);
    throw new PpClientServerError('createCustomer returned no id');
  } catch (err) {
    if (err instanceof PpClientError && err.statusCode === 409 && customer.email) {
      const search = await ppFetch<PpCustomerListItem[] | { data?: PpCustomerListItem[] }>({
        method: 'GET',
        path: `/api/customers/search/${encodeURIComponent(customer.email)}`,
        config,
      });
      const list = Array.isArray(search) ? search : (search?.data ?? []);
      if (list.length > 0) {
        const id = list[0].userid ?? list[0].id;
        if (id !== undefined) return String(id);
      }
    }
    throw err;
  }
}

interface PpCreateTicketResponse {
  ticketid?: number | string;
  id?: number | string;
  ticket_id?: number | string;
  data?: PpTicketShape;
  message?: string;
  status?: boolean;
}

export async function createTicket(
  input: CreateTicketInput,
  config: DeploymentConfig,
): Promise<Ticket> {
  const customerId = await ensureCustomer(input.customer, config);

  const body = {
    subject: input.subject,
    body: input.description,
    clientid: customerId,
    priority: PRIORITY_TO_PP[input.priority],
    status: config.statusMap.open,
    custom_fields: {
      customer_scope: input.customerScope,
      intake_source: input.intakeSource,
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

  const newId = String(res.ticketid ?? res.ticket_id ?? res.id ?? res.data?.ticketid ?? '');
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
  const res = await ppFetch<PpTicketShape | { data?: PpTicketShape }>({
    method: 'GET',
    path: `/api/tickets/${encodeURIComponent(ticketId)}`,
    config,
    ticketId,
  });
  const raw = (res as { data?: PpTicketShape }).data ?? (res as PpTicketShape);
  if (!raw || (!raw.ticketid && !raw.id)) {
    throw new PpClientNotFoundError(`Ticket ${ticketId} not found`);
  }
  return mapPpTicketToNormalized(raw, config);
}

interface PpReplyResponse {
  reply_id?: number | string;
  id?: number | string;
  data?: PpReplyShape;
  message?: string;
  status?: boolean;
}

export async function addReply(
  ticketId: string,
  reply: { body: string; source?: string; isInternal?: boolean },
  config: DeploymentConfig,
): Promise<Reply> {
  const extraHeaders: Record<string, string> = {};
  if (reply.source) extraHeaders['X-PP-Source'] = reply.source;

  const res = await ppFetch<PpReplyResponse>({
    method: 'POST',
    path: `/api/tickets/reply/${encodeURIComponent(ticketId)}`,
    body: {
      description: reply.body,
      isinternal: reply.isInternal ? 1 : 0,
    },
    config,
    extraHeaders,
    ticketId,
  });

  const replyShape: PpReplyShape = res.data ?? {
    id: res.reply_id ?? res.id,
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
