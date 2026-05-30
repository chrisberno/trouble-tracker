import { NextRequest, NextResponse } from 'next/server';
import { updateTicketStatus, updateTicketNotes } from '@/lib/db';
import { getTicket, PpClientNotFoundError } from '@/pp-client';
import { getBridgeMappingByTicketId } from '@/adapters/bridge/human/twilio-flex/bridge-db';
import { connieConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';

export const runtime = 'nodejs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function notFound() {
  return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: CORS });
}

// Scoped ticket-status lookup for the connie.plus /support "Track" box.
// CON-59 (2026-05-30): repointed from the dead legacy Postgres → PeoplePerson,
// and gated to the requester's tenant scope so a child account sees only its OWN
// tickets. Scope is config-driven (config.customerScopes) — the Connie child
// blueprint: a new child account works here automatically once added to that list.
// bridge-db is the source of truth for ticketId→scope (PP REST omits the custom field).
// CCT's unscoped "parent" lookup is intentionally OUT OF SCOPE here (separate sprint);
// any missing/unknown scope fails closed to "not found".
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const requestedScope = (request.nextUrl.searchParams.get('customerScope') ?? '').trim();

    const allowedChildScopes = new Set(config.customerScopes.map((c) => c.scope));
    if (!requestedScope || !allowedChildScopes.has(requestedScope)) {
      // Missing / unknown scope (includes CCT for now) → fail closed.
      return notFound();
    }

    // Tenant gate: the ticket must belong to the requester's scope.
    const mapping = await getBridgeMappingByTicketId(id);
    const ticketScope = mapping?.customerScope?.trim() || null;
    if (!ticketScope || ticketScope !== requestedScope) {
      // Cross-tenant lookup or untracked ticket → no leak.
      return notFound();
    }

    // Live status from PeoplePerson, shaped for the /support Track UI
    // (renders id / title / status / customername / description).
    const ticket = await getTicket(id, connieConfig);
    return NextResponse.json(
      {
        id: ticket.id,
        title: ticket.subject,
        status: ticket.status,
        customername: ticket.customer.name,
        description: ticket.description,
        customerScope: ticket.customerScope,
      },
      { headers: CORS },
    );
  } catch (error) {
    if (error instanceof PpClientNotFoundError) return notFound();
    console.error('Error fetching ticket:', error);
    return NextResponse.json({ error: 'Failed to fetch ticket' }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { status, notes } = body;
    
    let ticket;
    
    if (status && notes !== undefined) {
      return NextResponse.json({ error: 'Cannot update status and notes in the same request' }, { 
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }
    
    if (status) {
      ticket = await updateTicketStatus(id, status);
    } else if (notes !== undefined) {
      ticket = await updateTicketNotes(id, notes);
    } else {
      return NextResponse.json({ error: 'Either status or notes is required' }, { 
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }
    
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { 
        status: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }
    
    return NextResponse.json(ticket, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return NextResponse.json({ error: 'Failed to update ticket' }, { 
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }
}
