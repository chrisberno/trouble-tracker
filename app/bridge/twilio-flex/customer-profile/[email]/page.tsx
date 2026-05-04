// app/bridge/twilio-flex/customer-profile/[email]/page.tsx
// Phase 4 customer-profile iframe — server-side rendered.
//
// Loaded inside CCT's enhanced_crm_container in the right column ("Agent Tools"
// panel) when an agent accepts a TT bridge task. The eCRM container url
// template flips from {{task.profile_url}} (per-ticket iframe) to a
// {{task.customerEmail}}-driven URL (this route) at Phase 8a cutover.
//
// Phase 4 ships this route LIVE, but the eCRM template change waits for
// Phase 8a per CCTO sequencing answer (avoids breaking legacy /task?ticketId=X
// iframe semantics during Phase 4 deploy window). Iframe is therefore
// reachable + functional during Phase 4 but not yet in the agent flow.
//
// Email-collision policy (CEO defaults + PP-CTO Ask 2): pp-client.searchCustomersByEmail
// returns Customer[] sorted by lastTicketAuthorAt DESC NULLS LAST. We take [0]
// as the primary record. If length > 1, render a disclosure banner so the
// agent knows dupes exist + invites them to investigate/merge in PP admin.

import { searchCustomersByEmail } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import {
  PpClientNotFoundError,
  PpClientAuthError,
  PpClientError,
} from '@/pp-client';
import type { EnrichedCustomer } from '@/pp-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ email: string }>;
}

function ErrorState({ title, message, email }: { title: string; message: string; email: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow p-6 max-w-md w-full">
        <h1 className="text-xl font-bold text-red-600 mb-2">{title}</h1>
        <p className="text-gray-700 mb-4">{message}</p>
        <p className="text-sm text-gray-500">
          Email: <code className="bg-gray-100 px-1 py-0.5 rounded">{email}</code>
        </p>
      </div>
    </div>
  );
}

function NoMatchState({ email }: { email: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow p-6 max-w-md w-full">
        <h1 className="text-xl font-bold text-gray-900 mb-2">No customer record</h1>
        <p className="text-gray-700 mb-4">
          No PP customer record matches{' '}
          <code className="bg-gray-100 px-1 py-0.5 rounded">{email}</code>.
        </p>
        <p className="text-sm text-gray-500">
          This may indicate a new lead — agent can create the customer record from PP admin if needed.
        </p>
      </div>
    </div>
  );
}

function CollisionDisclosure({ count, email, tenantUrl }: { count: number; email: string; tenantUrl: string }) {
  const ppAdminLink = `${tenantUrl.replace(/\/$/, '')}/admin/clients?q=${encodeURIComponent(email)}`;
  return (
    <div className="bg-amber-50 border-l-4 border-amber-400 rounded p-3 text-sm">
      <p className="text-amber-900 font-medium">
        ⚠ {count} records share <code className="bg-amber-100 px-1 rounded">{email}</code>
      </p>
      <p className="text-amber-800 text-xs mt-1">
        Showing most-recent-ticket-author.{' '}
        <a
          href={ppAdminLink}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-amber-700"
        >
          Investigate dupes in PP admin →
        </a>
      </p>
    </div>
  );
}

export default async function CustomerProfilePage({ params }: PageProps) {
  const { email: emailRaw } = await params;
  const email = decodeURIComponent(emailRaw).trim();

  if (!email || !email.includes('@')) {
    return (
      <ErrorState
        title="Invalid email"
        message="The email address in the URL is malformed."
        email={emailRaw}
      />
    );
  }

  let customers: EnrichedCustomer[];
  try {
    customers = await searchCustomersByEmail(email, connieConfig);
  } catch (err) {
    if (err instanceof PpClientAuthError) {
      return (
        <ErrorState
          title="Auth failed"
          message="The TroubleTracker tenant API token rejected this request. Check TROUBLETRACKER_TENANT_API_TOKEN."
          email={email}
        />
      );
    }
    if (err instanceof PpClientNotFoundError) {
      return <NoMatchState email={email} />;
    }
    const detail = err instanceof PpClientError ? err.message : 'Unknown error fetching customer';
    return <ErrorState title="Failed to load customer profile" message={detail} email={email} />;
  }

  if (customers.length === 0) {
    return <NoMatchState email={email} />;
  }

  const primary = customers[0];
  const isCollision = customers.length > 1;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {isCollision && (
          <CollisionDisclosure
            count={customers.length}
            email={email}
            tenantUrl={connieConfig.tenantUrl}
          />
        )}

        {/* Primary customer card */}
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Customer</p>
              <h1 className="text-lg font-semibold text-gray-900">{primary.name}</h1>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500 uppercase tracking-wide">PP ID</p>
              <p className="font-mono text-sm text-gray-700">#{primary.id}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm pt-3 border-t border-gray-100">
            <div>
              <p className="text-gray-500 text-xs">Email</p>
              <p className="font-medium text-gray-900 truncate" title={primary.email}>
                {primary.email}
              </p>
            </div>
            {primary.phone && (
              <div>
                <p className="text-gray-500 text-xs">Phone</p>
                <p className="font-medium text-gray-900">{primary.phone}</p>
              </div>
            )}
            {primary.organization && primary.organization !== primary.name && (
              <div className="sm:col-span-2">
                <p className="text-gray-500 text-xs">Organization</p>
                <p className="font-medium text-gray-900">{primary.organization}</p>
              </div>
            )}
            <div className="sm:col-span-2">
              <p className="text-gray-500 text-xs">Last ticket activity</p>
              <p className="font-medium text-gray-900">
                {primary.lastTicketAuthorAt
                  ? new Date(primary.lastTicketAuthorAt).toLocaleString()
                  : '(no ticket history)'}
              </p>
            </div>
          </div>
        </div>

        {/* Open in PP escape hatch */}
        <div className="text-right">
          <a
            href={`${connieConfig.tenantUrl.replace(/\/$/, '')}/admin/clients/client/${encodeURIComponent(primary.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-700 underline"
          >
            Open customer in PP admin →
          </a>
        </div>
      </div>
    </div>
  );
}
