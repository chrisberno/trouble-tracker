# pp-client

TroubleTracker's gateway to PeoplePerson (PP.app). This is the **only folder in the TroubleTracker repo allowed to import PP.app SDKs, hit PP.app URLs, or know about Perfex data shapes.**

All inbound adapters and bridge adapters call only `pp-client`'s normalized interface — never PP.app's API directly. `pp-client` exposes a clean, normalized event model (`ticket.created`, `ticket.updated`, `ticket.replied`, `ticket.resolved`, `ticket.closed`) that is stable regardless of changes in PP.app's underlying API.

Phase 1 will implement `pp-client` v1: `api-client.ts` (REST wrapper, auth, retry), `event-mapper.ts` (PP.app webhooks → normalized events), and `types.ts` (normalized ticket/event shapes).

Per Manifesto v2.1: `pp-client` is replaceable in principle — if Onreb ever moves off PP.app, only this folder changes; no adapter changes.
