// adapters/bridge/human/twilio-flex/handlers.ts
// Pure event handlers: receive normalized CoreEvents from pp-client; call
// Twilio APIs via twilio-client; persist mappings via bridge-db.
//
// Loop prevention: each handler short-circuits when event.source === 'flex'
// (the BRIDGE_METADATA.source tag). This is the same source-tag transit
// convention pp-client uses on its outbound write path (X-PP-Source header).
//
// Handlers are exported individually so register.ts can wire them to specific
// CoreEvent kinds via pp-client's subscribe() surface.

import type { CoreEvent } from '@/pp-client/types';
import type { TwilioClient } from './twilio-client';
import {
  upsertBridgeMapping,
  getBridgeMappingByTicketId,
  isBridgeKeyProcessed,
  markBridgeKeyProcessed,
} from './bridge-db';
import { BRIDGE_METADATA } from './types';

// ============================================================================
// onTicketCreated — outbound: PP ticket.created → Twilio Interaction (Task + Conversation)
// ============================================================================

export async function onTicketCreated(
  event: Extract<CoreEvent, { kind: 'ticket.created' }>,
  twilio: TwilioClient,
): Promise<void> {
  const ticket = event.ticket;
  const idempotencyKey = `twilio:interaction:${ticket.id}`;

  if (await isBridgeKeyProcessed(idempotencyKey)) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      info: 'duplicate event skipped',
      ticketId: ticket.id,
      idempotencyKey,
    }));
    return;
  }

  const profileUrl = `${twilio.config.iframeBaseUrl}/${ticket.id}`;

  try {
    const result = await twilio.createInteraction(
      {
        subject: ticket.subject,
        attributes: {
          profile_url: profileUrl,
          ticketId: ticket.id,
          deploymentId: twilio.config.deploymentId,   // load-bearing for task-webhook discriminator gate
          customerScope: ticket.customerScope,
          customerName: ticket.customer.name,
          customerEmail: ticket.customer.email,
          customerPhone: ticket.customer.phone,
          priority: ticket.priority,
          type: twilio.config.taskAttributeType,
        },
      },
      idempotencyKey,
    );

    await upsertBridgeMapping({
      ticketId: ticket.id,
      interactionSid: result.interactionSid,
      conversationSid: result.conversationSid,
      taskSid: result.taskSid ?? null,
    });

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      ok: true,
      ticketId: ticket.id,
      interactionSid: result.interactionSid,
      conversationSid: result.conversationSid,
      taskSid: result.taskSid,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      error: err instanceof Error ? err.message : String(err),
      ticketId: ticket.id,
    }));
    throw err;
  }
}

// ============================================================================
// onTicketRepliedCustomer — outbound: PP customer-side reply → Twilio Conversation message
// ============================================================================

export async function onTicketRepliedCustomer(
  event: Extract<CoreEvent, { kind: 'ticket.replied.customer' }>,
  twilio: TwilioClient,
): Promise<void> {
  // Loop prevention: if THIS event was caused by a bridge-side write (source: 'flex'
  // on the reply), short-circuit. This shouldn't fire for ticket.replied.customer
  // since customer replies don't carry the flex source tag, but be defensive.
  if (event.reply.source === BRIDGE_METADATA.source) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      info: 'loop prevention: skipping bridge-originated reply',
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    return;
  }

  const idempotencyKey = `twilio:message:${event.reply.id}`;
  if (await isBridgeKeyProcessed(idempotencyKey)) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      info: 'duplicate event skipped',
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    return;
  }

  const mapping = await getBridgeMappingByTicketId(event.ticketId);
  if (!mapping) {
    console.warn(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      warning: 'no bridge mapping for ticket; ticket likely created outside this bridge',
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    return;
  }

  try {
    const result = await twilio.postConversationMessage(
      {
        conversationSid: mapping.conversationSid,
        body: event.reply.body,
        author: 'customer',
      },
      idempotencyKey,
    );

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      ok: true,
      ticketId: event.ticketId,
      replyId: event.reply.id,
      messageSid: result.messageSid,
      conversationSid: result.conversationSid,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      error: err instanceof Error ? err.message : String(err),
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    throw err;
  }
}

// ============================================================================
// onTicketRepliedAgent — short-circuit (Phase 3 doesn't fire any side effect for
// agent replies; they originated from Flex via inbound webhook, NOT from PP).
//
// Loop prevention: if reply.source === 'flex', it was OUR write — definitely skip.
// Even if not 'flex', agent replies originate inside PP (admin UI etc.) — Phase 3
// doesn't echo those back to Flex. Phase 4 may decide otherwise.
// ============================================================================

export async function onTicketRepliedAgent(
  event: Extract<CoreEvent, { kind: 'ticket.replied.agent' }>,
  _twilio: TwilioClient,
): Promise<void> {
  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    handler: 'onTicketRepliedAgent',
    info: 'agent-side reply observed; Phase 3 takes no action',
    ticketId: event.ticketId,
    replyId: event.reply.id,
    source: event.reply.source,
  }));
}
