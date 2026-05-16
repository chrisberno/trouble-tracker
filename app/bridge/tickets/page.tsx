// app/bridge/tickets/page.tsx
//
// TTB-1 Task 8 Phase 2 — list view of tickets, filtered by ?customerScope=.
// Server-rendered. Used by:
//   1. connie.plus "Show All Tickets" button (links here with ?customerScope=
//      derived from the iframe-context referrer detection in Phase 1B)
//   2. Phase 3 right-pane CRM container during a Pattern B task (basecamp
//      flex-config sets enhanced_crm_container.url to point here, with
//      {{task.customerScope}} interpolated)
//
// Status filter defaults to "open" — agents working a queue want active
// tickets, not closed archive. ?status=all opens up the full set.
//
// Single-ticket detail view links to the existing /bridge/twilio-flex/ticket/[id]
// page (already polished, has Reply / Status / Note buttons). No new
// detail-view route needed.
//
// TTB-17 (2026-05-07): switched from `pp-client.listTickets` (PP search-based,
// which only matches subject/description text) to `bridge-db.listTicketIdsByScope`
// + per-ticket `getTicket` fetch. PP REST does not return custom_fields in
// GET /api/tickets/<id> at any shape (verified 2026-05-06 with TT tenant token),
// AND PP search misses tickets where the scope value isn't in subject/description.
// Bridge-db is the source of truth for ticketId→scope mapping; PP is the source
// of truth for ticket content.

import Link from 'next/link';
import { getTicket } from '@/pp-client';
import type { Ticket } from '@/pp-client';
import {
  listTicketIdsByScope,
  getBridgeMappingByTicketId,
} from '@/adapters/bridge/human/twilio-flex/bridge-db';
import { connieConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';
import { checkIframeOrigin } from '../_lib/iframe-gate';
import { IframeBlocker } from '../_lib/iframe-blocker';
import { BackButton } from '../_lib/back-button';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SearchParamsShape {
  customerScope?: string;
  status?: string;
  ticketId?: string;
}

const DEFAULT_LIMIT = 50;

const ALLOWED_SCOPES = new Set(config.customerScopes.map((c) => c.scope));

const STATUS_FILTERS = ['all', 'open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  open: 'Open',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
};

function isStatusFilter(s: string): s is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(s);
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'open' ? '#16a34a'
    : status === 'in_progress' ? '#2563eb'
    : status === 'waiting' ? '#ca8a04'
    : status === 'closed' ? '#6b7280'
    : status === 'resolved' ? '#0891b2'
    : '#9ca3af';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: '12px',
      fontSize: '12px',
      fontWeight: 500,
      backgroundColor: `${color}20`,
      color,
      textTransform: 'capitalize',
    }}>{status.replace('_', ' ')}</span>
  );
}

export default async function TicketsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsShape>;
}) {
  // Iframe-only gate: reject direct-browser visits / off-allowlist origins.
  // Dev mode bypasses (NODE_ENV check inside checkIframeOrigin).
  const gate = await checkIframeOrigin();
  if (!gate.allowed) {
    return <IframeBlocker result={gate} />;
  }

  const params = await searchParams;

  // TTB-17 fix #7 (2026-05-07, Sprint 2.0): the Flex Admin Active Task URL
  // can carry `?ticketId={{task.ticketId}}` instead of `?customerScope=`.
  // task.ticketId is reliably populated on every Pattern B task; scope is
  // not (Twilio attribute-write race vs intake's bridge-db prewrite couldn't
  // be reliably resolved across 5 PRs of attempts). Bridge-db has been the
  // source of truth for ticketId→scope since PR #21 — read scope from there
  // and use it as the filter. Falls back to the original `?customerScope=`
  // path for connie.plus "Show All Tickets" callers and direct deep-links.
  const requestedTicketId = (params.ticketId ?? '').trim();
  let scopeFromTicketId: string | undefined;
  if (requestedTicketId) {
    try {
      const mapping = await getBridgeMappingByTicketId(requestedTicketId);
      const dbScope = mapping?.customerScope?.trim();
      if (dbScope && ALLOWED_SCOPES.has(dbScope)) {
        scopeFromTicketId = dbScope;
      }
    } catch (lookupErr) {
      console.warn(
        JSON.stringify({
          bridge_tickets_page: true,
          warning: 'ticketId scope lookup failed; falling back to ?customerScope= param',
          ticketId: requestedTicketId,
          error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
        }),
      );
    }
  }

  const requestedScope = scopeFromTicketId ?? (params.customerScope ?? '').trim();
  const customerScope = requestedScope && ALLOWED_SCOPES.has(requestedScope)
    ? requestedScope
    : undefined;
  const requestedStatus = (params.status ?? '').trim().toLowerCase();
  const activeStatus: StatusFilter = isStatusFilter(requestedStatus) ? requestedStatus : 'open';
  const statusFilter = activeStatus === 'all' ? undefined : activeStatus;

  let tickets: Ticket[] = [];
  let error: string | null = null;
  try {
    if (!customerScope) {
      // No scope = no list. PP doesn't expose a verified all-tickets endpoint
      // and bridge-db is keyed on scope. Render the empty state cleanly.
      tickets = [];
    } else {
      // Bridge-db owns the ticketId→scope index (TTB-17). Fetch IDs first,
      // then hydrate each from PP. Errors on individual fetches drop the row
      // rather than failing the whole page.
      const ids = await listTicketIdsByScope(customerScope, DEFAULT_LIMIT);
      const fetched = await Promise.all(
        ids.map(async (id) => {
          try {
            return await getTicket(id, connieConfig);
          } catch (fetchErr) {
            console.warn(
              JSON.stringify({
                bridge_tickets_page: true,
                warning: 'getTicket failed; row dropped',
                ticketId: id,
                error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
              }),
            );
            return null;
          }
        }),
      );
      tickets = fetched.filter((t): t is Ticket => t !== null);
      if (statusFilter) {
        tickets = tickets.filter((t) => t.status === statusFilter);
      }
      tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load tickets';
  }

  // Defensive: when scope is missing OR fails validation, the empty-state
  // copy below makes that explicit instead of misleadingly reading "All scopes".
  const headingScope = customerScope
    ?? (requestedScope ? `Unknown (${requestedScope})` : 'Not specified');

  return (
    <div style={{ minHeight: '100vh', padding: '20px', backgroundColor: '#f9fafb', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        <BackButton />
        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: 0 }}>Tickets</h1>
          <div style={{ marginTop: '6px', fontSize: '14px', color: '#4b5563' }}>
            Scope: <strong>{headingScope}</strong>
          </div>
          {customerScope && (
            <div role="tablist" style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
              {STATUS_FILTERS.map((s) => {
                const isActive = s === activeStatus;
                const linkParams = new URLSearchParams();
                linkParams.set('customerScope', customerScope);
                linkParams.set('status', s);
                if (requestedTicketId) linkParams.set('ticketId', requestedTicketId);
                return (
                  <Link
                    key={s}
                    href={`/bridge/tickets?${linkParams.toString()}`}
                    role="tab"
                    aria-selected={isActive}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '999px',
                      fontSize: '13px',
                      fontWeight: 500,
                      textDecoration: 'none',
                      backgroundColor: isActive ? '#0263E0' : '#e5e7eb',
                      color: isActive ? 'white' : '#374151',
                    }}
                  >
                    {STATUS_FILTER_LABELS[s]}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <div style={{
            padding: '12px 16px',
            backgroundColor: '#fee2e2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            color: '#991b1b',
            fontSize: '14px',
            marginBottom: '16px',
          }}>
            <strong>Couldn&apos;t load tickets:</strong> {error}
          </div>
        )}

        {tickets.length === 0 ? (
          <div style={{
            padding: '40px 16px',
            textAlign: 'center',
            backgroundColor: 'white',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
            color: '#6b7280',
          }}>
            {!customerScope ? (
              <>
                <strong>Scope required.</strong>{' '}
                This page expects a <code>?customerScope=</code> parameter (NSS, HHOVV, or Lifeline).
                {requestedScope && (
                  <>
                    {' '}Received: <code>{requestedScope}</code> (not recognized).
                  </>
                )}
              </>
            ) : (
              <>No {activeStatus === 'all' ? '' : `${STATUS_FILTER_LABELS[activeStatus].toLowerCase()} `}tickets for {customerScope}.</>
            )}
          </div>
        ) : (
          <div style={{ backgroundColor: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead style={{ backgroundColor: '#f3f4f6', textAlign: 'left' }}>
                <tr>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>#</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>Subject</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>Status</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>Customer</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <Link
                        href={`/bridge/twilio-flex/ticket/${encodeURIComponent(t.id)}`}
                        style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 500 }}
                      >
                        #{t.id}
                      </Link>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#111827' }}>{t.subject || '(no subject)'}</td>
                    <td style={{ padding: '10px 14px' }}><StatusPill status={t.status} /></td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{t.customer.name}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280', fontSize: '13px' }}>
                      {new Date(t.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tickets.length === DEFAULT_LIMIT && (
              <div style={{ padding: '10px 14px', backgroundColor: '#f9fafb', fontSize: '12px', color: '#6b7280', textAlign: 'center', borderTop: '1px solid #e5e7eb' }}>
                Showing first {DEFAULT_LIMIT}. Refine scope or visit PP admin for the full set.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
