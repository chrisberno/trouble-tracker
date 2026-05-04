// app/bridge/twilio-flex/ticket/[id]/page.tsx
// Server-side rendered ticket-context iframe.
// Loaded inside CCT's enhanced_crm_container via attributes.profile_url
// (see handlers.onTicketCreated which sets profile_url to <iframeBaseUrl>/<ticketId>).
//
// Server-fetches the ticket via pp-client. Browser receives HTML only;
// PP.app token never crosses the network boundary to the client.
//
// CSP frame-ancestors is configured globally in vercel.json to permit
// flex.twilio.com + connie.team domains. No per-route header changes needed.

import { getTicket } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import {
  PpClientNotFoundError,
  PpClientAuthError,
  PpClientError,
} from '@/pp-client';
import type { Ticket } from '@/pp-client';
import { TicketActions } from './TicketActions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

function StatusBadge({ status }: { status: Ticket['status'] }) {
  const colorMap: Record<Ticket['status'], string> = {
    open: 'bg-green-100 text-green-800',
    in_progress: 'bg-yellow-100 text-yellow-800',
    waiting: 'bg-blue-100 text-blue-800',
    resolved: 'bg-purple-100 text-purple-800',
    closed: 'bg-gray-100 text-gray-800',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium ${colorMap[status]}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: Ticket['priority'] }) {
  const colorMap: Record<Ticket['priority'], string> = {
    low: 'bg-gray-100 text-gray-700',
    medium: 'bg-blue-100 text-blue-700',
    high: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colorMap[priority]}`}>
      {priority}
    </span>
  );
}

function ErrorState({ title, message, ticketId }: { title: string; message: string; ticketId: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow p-6 max-w-md w-full">
        <h1 className="text-xl font-bold text-red-600 mb-2">{title}</h1>
        <p className="text-gray-700 mb-4">{message}</p>
        <p className="text-sm text-gray-500">Ticket ID: <code className="bg-gray-100 px-1 py-0.5 rounded">{ticketId}</code></p>
      </div>
    </div>
  );
}

export default async function TicketContextPage({ params }: PageProps) {
  const { id: ticketId } = await params;

  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketId, connieConfig);
  } catch (err) {
    if (err instanceof PpClientNotFoundError) {
      return <ErrorState title="Ticket not found" message="No ticket exists with this ID on the TroubleTracker tenant." ticketId={ticketId} />;
    }
    if (err instanceof PpClientAuthError) {
      return <ErrorState title="Auth failed" message="The TroubleTracker tenant API token rejected this request. Check TROUBLETRACKER_TENANT_API_TOKEN." ticketId={ticketId} />;
    }
    const detail = err instanceof PpClientError ? err.message : 'Unknown error fetching ticket';
    return <ErrorState title="Failed to load ticket" message={detail} ticketId={ticketId} />;
  }

  // PP.app admin tenant URL for the escape-hatch link (supervisor edge cases).
  const ppAdminUrl = `${connieConfig.tenantUrl.replace(/\/$/, '')}/admin/tickets/${encodeURIComponent(ticket.id)}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                <span>Ticket #{ticket.id}</span>
                <span>·</span>
                <span>Scope: {ticket.customerScope || 'Unknown'}</span>
                <span>·</span>
                <span>Source: {ticket.intakeSource || 'unknown'}</span>
              </div>
              <h1 className="text-lg font-semibold text-gray-900">{ticket.subject}</h1>
            </div>
            <div className="flex items-center gap-2">
              <PriorityBadge priority={ticket.priority} />
              <StatusBadge status={ticket.status} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm pt-3 border-t border-gray-100">
            <div>
              <p className="text-gray-500 text-xs">Customer</p>
              <p className="font-medium text-gray-900">{ticket.customer.name}</p>
            </div>
            {ticket.customer.email && (
              <div>
                <p className="text-gray-500 text-xs">Email</p>
                <p className="font-medium text-gray-900 truncate" title={ticket.customer.email}>{ticket.customer.email}</p>
              </div>
            )}
            {ticket.customer.phone && (
              <div>
                <p className="text-gray-500 text-xs">Phone</p>
                <p className="font-medium text-gray-900">{ticket.customer.phone}</p>
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">Description</h2>
          <p className="text-gray-800 whitespace-pre-wrap text-sm">{ticket.description || '(no description)'}</p>
        </div>

        {/* Action footer (client component) */}
        <TicketActions
          ticketId={ticket.id}
          currentStatus={ticket.status}
        />

        {/* Escape hatch */}
        <div className="text-right">
          <a
            href={ppAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-700 underline"
          >
            Open in PP →
          </a>
        </div>
      </div>
    </div>
  );
}
