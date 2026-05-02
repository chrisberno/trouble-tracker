# adapters/bridge/human/twilio-flex

The Twilio Flex bridge adapter. Subscribes to ticket events from `pp-client`, translates them into Twilio Interactions API calls (`channel.type=email`), and reports resolution outcomes back through `pp-client`.

Declares `resolverType: "human"` per the bridge adapter contract.

**Iframe-URL coupling (Manifesto v2.1 §Bridge adapter contract):** This bridge surfaces a ticket-context iframe in the Twilio Flex Enhanced CRM Container. The iframe URL pattern (`/adapters/bridge/human/twilio-flex/ticket/[id]`) is part of this bridge's contract with the CCT resolver platform's allowed-origins and CSP/iframe-source config. If this URL pattern changes, the CCT Enhanced CRM Container settings must change in lockstep.

Phase 3 will implement this adapter. Until Phase 8 cutover, the production Twilio integration lives at `lib/taskrouter.ts` (legacy path, preserved through Phase 8).
