// pp-client/event-mapper.ts
// Translates raw tt_webhook_bridge payloads into normalized CoreEvent instances.
// No bridge-specific knowledge here.
// source discrimination is presence/absence ONLY — no string comparison against bridge names.
//
// Source read-side decision (Refinement #1):
//   This implementation uses Option 1: payload-included source.
//   The mapper reads `data.reply.source` or `data.source` directly from the webhook
//   payload. If the bridge omits `source` from the payload, the mapper falls back to
//   `data.reply.staffid` presence as the agent signal, then defaults to customer.
//   This avoids an extra round-trip GET to PP.app and keeps the receiver fast.
//   If/when PP-CTO confirms `source` is reliably included by tt_webhook_bridge, this
//   stays the canonical path. Option 2 (extra GET on /api/tickets/reply/{id}) and
//   Option 3 (bridge enrichment) are NOT used at this time.

import { convert } from 'html-to-text';
import type { CoreEvent, Reply, DeploymentConfig } from './types';
import { mapPpTicketToNormalized, mapPpReplyToNormalized } from './api-client';

interface RawWebhookEnvelope {
  event?: string;
  timestamp?: string | number;
  data?: Record<string, unknown>;
  signature?: string;
}

function stripHtml(raw: string): string {
  if (!raw) return '';
  try {
    return convert(raw, { wordwrap: false }).trim();
  } catch {
    return raw;
  }
}

export function mapWebhookPayload(
  rawPayload: unknown,
  config: DeploymentConfig,
): CoreEvent[] {
  if (!rawPayload || typeof rawPayload !== 'object') {
    console.warn(JSON.stringify({ pp_event_mapper: true, warning: 'invalid payload' }));
    return [];
  }
  const envelope = rawPayload as RawWebhookEnvelope;
  const event = envelope.event;
  const data = envelope.data ?? {};

  switch (event) {
    case 'ticket.created': {
      const rawTicket = (data.ticket ?? {}) as Record<string, unknown>;
      const ticket = mapPpTicketToNormalized(rawTicket, config);
      return [{ kind: 'ticket.created', ticket }];
    }

    case 'ticket.replied': {
      const rawTicket = (data.ticket ?? {}) as Record<string, unknown>;
      const replyId = data.reply_id;
      const ticketId = String(
        (rawTicket as { ticketid?: string | number; id?: string | number }).ticketid ??
          (rawTicket as { id?: string | number }).id ??
          '',
      );

      // Source read-side decision: presence/absence ONLY, no string comparison.
      // 1. Prefer source on data.reply.source or data.source if bridge includes it.
      // 2. Fall back to staffid presence as agent signal.
      // 3. Otherwise, customer.
      const replyData = (data.reply ?? {}) as Record<string, unknown> & {
        source?: string;
        staffid?: string | number;
        message?: string;
        description?: string;
        body?: string;
        date?: string;
      };
      const sourceFromPayload =
        (replyData.source as string | undefined) ?? (data.source as string | undefined);
      const staffid = replyData.staffid;

      // TTB-24 (Sprint 2.0 reopen, 2026-05-08): internal-note discriminator.
      // Perfex's webhook payload does NOT include the isinternal flag in
      // data.reply — verified via production observation on ticket #66:
      // keys = ["id","ticketid","userid","contactid","name","email","date",
      // "message","attachment","admin","source"]. `admin` is null for both
      // internal AND customer-visible replies posted via API/canvas (only
      // populated when posted through staff UI, apparently). NO `isinternal`,
      // `is_admin`, etc. fields exist.
      //
      // Working channel: PP DOES echo the X-PP-Source header back as
      // data.reply.source. Bridge encodes internal vs public into the source
      // value itself — `flex` for customer-visible, `flex-internal` for
      // internal notes (see adapters/bridge/human/twilio-flex/types.ts
      // BRIDGE_METADATA + app/api/bridge/twilio-flex/internal-note/route.ts).
      // event-mapper substring-matches 'internal' in source to set the flag.
      // Defensive: retain the candidate-field probe in case a future PP addon
      // starts populating these. If PP webhook payload shape changes, the
      // probe will set internalNote=true even before we update the source-tag
      // discriminator. Per S3 B3 (TTB-14 cleanup), the per-reply diagnostic
      // emit was removed as production noise — re-add a console.log here only
      // if a regression investigation needs the keys+values dump.
      const internalCandidates = [
        'admin',
        'isadmin',
        'is_admin',
        'isinternal',
        'is_internal',
        'internal_note',
        'internalnote',
      ];
      const internalFromCandidates = internalCandidates.some((k) => {
        const v = (replyData as Record<string, unknown>)[k];
        return v === '1' || v === 1 || v === true || v === 'true';
      });
      const internalFromSource = typeof sourceFromPayload === 'string'
        && sourceFromPayload.toLowerCase().includes('internal');
      const internalNote = internalFromSource || internalFromCandidates;

      const rawBody = replyData.message ?? replyData.description ?? replyData.body ?? '';
      const stripped = stripHtml(String(rawBody));

      const baseReply: Reply = mapPpReplyToNormalized(
        {
          id: replyId as string | number | undefined,
          message: rawBody as string,
          source: sourceFromPayload,
          staffid: staffid as string | number | undefined,
          date: replyData.date,
        },
        ticketId,
        rawBody as string,
      );
      baseReply.body = stripped;
      baseReply.bodyRaw = String(rawBody);
      baseReply.internalNote = internalNote;

      // Discrimination logic (presence/absence only — never compare source strings)
      let kind: 'ticket.replied.agent' | 'ticket.replied.customer';
      if (sourceFromPayload) {
        kind = 'ticket.replied.agent';
        baseReply.authorKind = 'agent';
        baseReply.source = sourceFromPayload;
      } else if (staffid) {
        kind = 'ticket.replied.agent';
        baseReply.authorKind = 'agent';
      } else {
        kind = 'ticket.replied.customer';
        baseReply.authorKind = 'customer';
      }

      return [{ kind, ticketId, reply: baseReply }];
    }

    case 'ticket.status_changed': {
      const rawTicket = (data.ticket ?? {}) as Record<string, unknown>;
      const newStatusId = Number(data.new_status_id ?? 0);
      const previousStatusId = Number(data.previous_status_id ?? 0);
      const ticket = mapPpTicketToNormalized(rawTicket, config);
      const ticketId = ticket.id;

      const events: CoreEvent[] = [
        { kind: 'ticket.status_changed', ticketId, newStatusId, previousStatusId, ticket },
      ];

      if (
        config.statusMap.resolved !== undefined &&
        newStatusId === config.statusMap.resolved
      ) {
        events.push({ kind: 'ticket.resolved', ticketId });
      }
      if (newStatusId === config.statusMap.closed) {
        events.push({ kind: 'ticket.closed', ticketId });
      }

      return events;
    }

    case 'ticket.deleted': {
      const ticketId = String(data.ticket_id ?? '');
      return [{ kind: 'ticket.deleted', ticketId }];
    }

    default: {
      console.warn(
        JSON.stringify({ pp_event_mapper: true, warning: 'unknown event kind', event }),
      );
      return [];
    }
  }
}
