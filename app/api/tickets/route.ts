import { NextRequest, NextResponse } from 'next/server';
import { getTicketsByCustomer, createTicket } from '@/lib/db';
import { createTaskRouterTask } from '@/lib/taskrouter';

// CORS configuration - allow localhost for development testing
const allowedOrigins = ['https://connie.plus', 'http://localhost:3000'];

const corsOptions = {
  'Access-Control-Allow-Origin': 'https://connie.plus', // Will be set dynamically below
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Allow-Credentials': 'true'
};

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const dynamicCorsOptions = {
    ...corsOptions,
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? (origin || 'https://connie.plus') : 'https://connie.plus'
  };
  
  return new Response(null, {
    status: 200,
    headers: dynamicCorsOptions,
  });
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  const dynamicCorsOptions = {
    ...corsOptions,
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? (origin || 'https://connie.plus') : 'https://connie.plus'
  };

  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');
    const phone = searchParams.get('phone');
    
    const tickets = await getTicketsByCustomer(name || undefined, phone || undefined);
    return NextResponse.json(tickets, { headers: dynamicCorsOptions });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { 
      status: 500,
      headers: dynamicCorsOptions 
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, customerName, customerPhone } = body;
    
    if (!title || !description || !customerName || !customerPhone) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }
    
    const ticket = await createTicket({
      title,
      description,
      customerName,
      customerPhone,
      status: 'Open'
    });
    
    // Create TaskRouter task inline (must await - Vercel kills background fetches)
    try {
      const ticketOrigin = request.headers.get('referer')?.includes('nss.') ? 'NSS' :
                    request.headers.get('referer')?.includes('hhovv.') ? 'HHOVV' :
                    request.headers.get('referer')?.includes('dev.') ? 'DevSandBox' :
                    'Unknown';

      await createTaskRouterTask({
        ticketId: ticket.id,
        title: ticket.title,
        description: ticket.description,
        customerName: ticket.customerName,
        customerPhone: ticket.customerPhone,
        origin: ticketOrigin,
      });
    } catch (taskError) {
      console.error('Failed to create TaskRouter task:', taskError);
      // Don't throw - ticket was created successfully in DB
    }
    
    const origin = request.headers.get('origin');
    const dynamicCorsOptions = {
      ...corsOptions,
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? (origin || 'https://connie.plus') : 'https://connie.plus'
    };

    return NextResponse.json(ticket, { 
      status: 201,
      headers: dynamicCorsOptions 
    });
  } catch (error) {
    console.error('Error creating ticket:', error);
    const origin = request.headers.get('origin');
    const dynamicCorsOptions = {
      ...corsOptions,
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? (origin || 'https://connie.plus') : 'https://connie.plus'
    };
    
    return NextResponse.json({ error: 'Failed to create ticket' }, { 
      status: 500,
      headers: dynamicCorsOptions 
    });
  }
}