import { NextRequest, NextResponse } from 'next/server';

// This endpoint will be called by the ticket creation to trigger TaskRouter
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticketId, title, description, customerName, customerPhone, origin, appBaseUrl } = body;
    
    // Get Twilio credentials from environment variables
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_RTC_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_RTC_AUTH_TOKEN;
    
    // Debug logging (without exposing full credentials)
    console.log('TWILIO_ACCOUNT_SID:', TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.substring(0, 10)}...` : 'undefined');
    console.log('TWILIO_AUTH_TOKEN:', TWILIO_AUTH_TOKEN ? `${TWILIO_AUTH_TOKEN.substring(0, 8)}...` : 'undefined');
    
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.error('Twilio credentials not configured');
      // Don't fail the request - ticket was created successfully
      return NextResponse.json({ 
        success: true, 
        warning: 'TaskRouter integration not configured' 
      });
    }
    
    // Determine priority based on content
    const priority = determinePriority(title, description);
    
    // Call TaskRouter API directly (more reliable than Studio Flow)
    const taskRouterUrl = `https://taskrouter.twilio.com/v1/Workspaces/WSfe43abb4378f0f1e2ebb98877c03bd1d/Tasks`;
    
    // Build the profile URL for the Enhanced CRM Container
    const baseUrl = appBaseUrl || 'https://trouble-ticket-app.vercel.app';
    const profileUrl = `${baseUrl}/task?ticketId=${ticketId}&customerName=${encodeURIComponent(customerName)}&customerPhone=${encodeURIComponent(customerPhone)}&origin=${encodeURIComponent(origin)}&title=${encodeURIComponent(title)}&priority=${priority}`;

    // Create rich task attributes for better Flex display
    const taskAttributes = {
      // Primary display fields
      name: `🎫 Support Ticket: ${title}`,
      type: 'support_ticket',
      skill: 'Support',  // Important for routing

      // CRM container URL - loaded by Enhanced CRM Container in Flex
      profile_url: profileUrl,

      // Ticket information
      ticketId: ticketId,
      title: title,
      description: description,
      urgency: priority,

      // Customer information
      customerName: customerName,
      customerPhone: customerPhone,
      customers: {
        name: customerName,
        phone: customerPhone,
        organization: origin
      },

      // Metadata
      origin: origin,
      timestamp: new Date().toISOString(),
      channel: 'support-ticket',
      channelType: 'support',
      conversationsTaskKey: `support_ticket_${ticketId}`
    };
    
    const taskPayload = new URLSearchParams({
      'WorkflowSid': 'WW2c597b1d5a96635b6cb0b6d261c9ede8',
      'TaskChannel': 'default',
      'FriendlyName': `🎫 Support Ticket: ${title.replace(/[^\w\s-]/g, '')}`,  // Remove special chars that break encoding
      'Priority': priority === 'high' ? '0' : priority === 'medium' ? '5' : '10',  // Numeric priority
      'Timeout': '3600',  // 1 hour timeout
      'Attributes': JSON.stringify(taskAttributes)
    });

    const response = await fetch(taskRouterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      },
      body: taskPayload.toString()
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to create TaskRouter task:', errorText);
      // Don't fail the request - ticket was created successfully
      return NextResponse.json({ 
        success: true, 
        warning: 'Failed to notify support team',
        error: errorText
      });
    }
    
    const result = await response.json();
    
    return NextResponse.json({
      success: true,
      taskCreated: true,
      taskSid: result.sid,
      taskStatus: result.assignment_status
    });
    
  } catch (error) {
    console.error('Error triggering TaskRouter:', error);
    // Don't fail the request - ticket was created successfully
    return NextResponse.json({ 
      success: true, 
      warning: 'Failed to notify support team',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Helper function to determine priority based on keywords
function determinePriority(title: string, description: string): string {
  const content = `${title} ${description}`.toLowerCase();
  
  if (content.includes('urgent') || content.includes('emergency') || content.includes('down')) {
    return 'high';
  }
  if (content.includes('bug') || content.includes('error') || content.includes('broken')) {
    return 'medium';
  }
  return 'low';
}