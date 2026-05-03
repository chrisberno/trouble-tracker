import { createTicket } from '@/pp-client/index';
import type { DeploymentConfig } from '@/pp-client/types';
import {
  PpClientServerError,
  PpClientRateLimitError,
  PpClientAuthError,
} from '@/pp-client/types';

export interface WebFormIntakePayload {
  title: string;
  description: string;
  customerName: string;
  customerPhone: string;
  customerScope: string;
  // NOTE: no email, no company per CEO defaults 2026-05-03
}

export interface IntakeResult {
  status: 'success' | 'failure';
  ticketId?: string;
  errorMessage?: string;
}

export async function handleWebFormIntake(
  payload: WebFormIntakePayload,
  deployment: DeploymentConfig,
): Promise<IntakeResult> {
  const title = (payload.title ?? '').trim();
  const description = (payload.description ?? '').trim();
  const customerName = (payload.customerName ?? '').trim();
  const customerPhoneRaw = (payload.customerPhone ?? '').trim();
  const customerScope = (payload.customerScope ?? '').trim();

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!description) missing.push('description');
  if (!customerName) missing.push('customerName');
  if (!customerPhoneRaw) missing.push('customerPhone');
  if (!customerScope) missing.push('customerScope');
  if (missing.length > 0) {
    return {
      status: 'failure',
      errorMessage: `Missing required fields: ${missing.join(', ')}`,
    };
  }

  const customerPhone = customerPhoneRaw.replace(/\D/g, '');

  try {
    const ticket = await createTicket(
      {
        subject: title,
        description,
        priority: 'medium',
        customer: { name: customerName, phone: customerPhone },
        customerScope,
        intakeSource: 'web-form',
      },
      deployment,
    );
    console.log(
      JSON.stringify({
        web_form_intake: true,
        status: 'success',
        ticketId: ticket.id,
      }),
    );
    return { status: 'success', ticketId: ticket.id };
  } catch (err) {
    if (
      err instanceof PpClientServerError ||
      err instanceof PpClientRateLimitError ||
      err instanceof PpClientAuthError
    ) {
      console.log(
        JSON.stringify({
          web_form_intake: true,
          status: 'failure',
          error: err.message,
        }),
      );
      return {
        status: 'failure',
        errorMessage: 'Support system temporarily unavailable. Please try again shortly.',
      };
    }
    console.log(
      JSON.stringify({
        web_form_intake: true,
        status: 'failure',
        error: String(err),
      }),
    );
    return {
      status: 'failure',
      errorMessage: 'An unexpected error occurred. Please try again.',
    };
  }
}
