# adapters/inbound/web-form

The web form inbound adapter. Accepts form submissions, validates and normalizes the input into a ticket payload, and hands it to `pp-client.createTicket()` — never to PP.app's API directly.

Phase 2 will implement the new web form here. Until Phase 8 cutover, the production form lives at `app/page.tsx` and `app/api/tickets/route.ts` (legacy paths, preserved through Phase 8).

Per Manifesto v2.1 adapter contract: every inbound adapter must authenticate/validate input, normalize it into a ticket payload, call `pp-client.createTicket(payload)`, and return the appropriate acknowledgment to the intake source.
