const WORKSPACE_SID = 'WSfe43abb4378f0f1e2ebb98877c03bd1d';
const WORKFLOW_SID = 'WW2c597b1d5a96635b6cb0b6d261c9ede8';
const APP_BASE_URL = 'https://trouble-ticket-app.vercel.app';

type TicketData = {
  ticketId: number;
  title: string;
  description: string;
  customerName: string;
  customerPhone: string;
  origin: string;
};

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

export async function createTaskRouterTask(data: TicketData) {
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_RTC_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_RTC_AUTH_TOKEN;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('Twilio credentials not configured - skipping TaskRouter task creation');
    return null;
  }

  const priority = determinePriority(data.title, data.description);

  const profileUrl = `${APP_BASE_URL}/task?ticketId=${data.ticketId}&customerName=${encodeURIComponent(data.customerName)}&customerPhone=${encodeURIComponent(data.customerPhone)}&origin=${encodeURIComponent(data.origin)}&title=${encodeURIComponent(data.title)}&priority=${priority}`;

  const taskAttributes = {
    name: `Support Ticket: ${data.title}`,
    type: 'support_ticket',
    skill: 'Support',

    profile_url: profileUrl,

    ticketId: data.ticketId,
    title: data.title,
    description: data.description,
    urgency: priority,

    customerName: data.customerName,
    customerPhone: data.customerPhone,
    customers: {
      name: data.customerName,
      phone: data.customerPhone,
      organization: data.origin,
    },

    origin: data.origin,
    timestamp: new Date().toISOString(),
    channel: 'support-ticket',
    channelType: 'support',
    conversationsTaskKey: `support_ticket_${data.ticketId}`,
  };

  const taskPayload = new URLSearchParams({
    WorkflowSid: WORKFLOW_SID,
    TaskChannel: 'default',
    FriendlyName: `Support Ticket: ${data.title.replace(/[^\w\s-]/g, '')}`,
    Priority: priority === 'high' ? '0' : priority === 'medium' ? '5' : '10',
    Timeout: '3600',
    Attributes: JSON.stringify(taskAttributes),
  });

  const response = await fetch(
    `https://taskrouter.twilio.com/v1/Workspaces/${WORKSPACE_SID}/Tasks`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body: taskPayload.toString(),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Failed to create TaskRouter task:', errorText);
    throw new Error(`TaskRouter API error: ${response.status}`);
  }

  return response.json();
}
