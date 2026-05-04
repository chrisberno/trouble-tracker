// adapters/bridge/human/twilio-flex/html-strip.ts
// Phase 4 message-body HTML strip utility — single shared util used by:
//   - handlers.onTicketRepliedCustomer (PP HTML reply → plain-text Conversation message)
//   - app/api/bridge/twilio-flex/conversations-webhook (Flex composer message → PP addReply)
//
// Per Phase 4 brief Deliverable #8: PP outbound emails are HTML; Flex composer
// renders cleanly with stripped text. Wraps html-to-text dep (added Phase 1)
// with Phase 4 config: preserve newlines, drop links/images, plain text.
//
// pp-client/event-mapper.ts already runs its own stripHtml on inbound webhook
// reply bodies (separate concern: normalizing PP-side HTML before producing
// CoreEvent). This module is for the bridge-specific outbound paths (post to
// Twilio Conversation) + inbound paths (Flex composer message → pp-client.addReply).

import { convert } from 'html-to-text';

export function stripHtmlForBridge(raw: string): string {
  if (!raw) return '';
  try {
    return convert(raw, {
      wordwrap: false,
      selectors: [
        // Drop links — keep visible text only
        { selector: 'a', options: { ignoreHref: true } },
        // Drop images entirely (no alt text spam in chat)
        { selector: 'img', format: 'skip' },
      ],
      preserveNewlines: true,
    }).trim();
  } catch {
    // Defensive: if conversion fails, return raw input rather than blowing up
    // the calling handler. Worst case Twilio gets HTML it'll render as text.
    return raw;
  }
}
