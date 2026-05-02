# TroubleTracker

**TroubleTracker is a branded surface and adapter network on top of PeoplePerson (PP.app)**, Onreb's foundational ticketing substrate. It is the first wedge product in the Onreb portfolio.

> **Production parallel coexistence — active through Phase 8**
> The legacy production code (`lib/`, `app/api/tickets/`, `app/page.tsx`, `app/task/`) is serving real Connie/CCT traffic right now and is preserved untouched through Phase 8 cutover. New v2.0 code is being built in parallel under the new folder structure below. Both paths deploy to the same Vercel project on every push. NSS continues using the legacy path with zero behavioral change until Phase 8.

---

## Architecture (v2.0)

Per Manifesto v2.1 (`~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/documents/manifesto.md`):

- **The Core is PP.app** — Onreb-owned ticketing engine via the `perfex_saas` multi-tenant module. PP.app owns ticket identity, state machine, history, SLA logic, assignment, multi-tenancy, and audit trail. TroubleTracker's repo contains zero authoritative lifecycle state.
- **`pp-client/`** is the only place in this repo allowed to import PP.app SDKs, hit PP.app URLs, or know about Perfex data shapes. All adapters call `pp-client`'s normalized interface only.
- **Inbound adapters** accept intake from any source (web form, email, SMS, API, etc.) and hand normalized payloads to `pp-client`.
- **Bridge adapters** subscribe to ticket events from `pp-client` and route them to resolvers (human, AI, or script).
- **Deployments** are PP.app tenants with the TroubleTracker package applied — one config file per client, no code changes per client.

---

## Folder structure

```
trouble-tracker/

# NEW v2.0 (built in Phases 1–6, active post-Phase 8 cutover):
pp-client/                      # Phase 1 — only place that knows PP.app exists
adapters/
  inbound/
    web-form/                   # Phase 2 — new web form inbound adapter
  bridge/
    human/
      twilio-flex/              # Phase 3 — Twilio Flex bridge adapter
branding/
  troubletracker/               # Phase 4 — brand assets (post-productization gate)
deployments/
  connie/                       # Phase 6 — Connie deployment config.json

# LEGACY PRODUCTION (preserved through Phase 8, retired in Phase 9):
app/
  page.tsx                      # production form — DO NOT TOUCH until Phase 9
  task/page.tsx                 # production iframe — DO NOT TOUCH until Phase 9
  api/tickets/route.ts          # production API — DO NOT TOUCH until Phase 9
  api/tickets/[id]/route.ts     # production API — DO NOT TOUCH until Phase 9
lib/
  db.ts                         # production DB (Vercel Postgres) — DO NOT TOUCH until Phase 9
  taskrouter.ts                 # production Twilio ghost-task — DO NOT TOUCH until Phase 9
```

---

## Sprint 1.0 — Phase status

Per Sprint 1.0 doc (`~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/technical/dev-logs/sprint-1.0-2026-04-30-trouble-tracker-poc.md`) and Roadmap v1.1 (`~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/documents/roadmap.md`):

| Phase | Description | Status |
|-------|-------------|--------|
| 0a | CCT operational readiness (iframe, TaskRouter workflow, channel capacity) | In progress (CTO-Connie) |
| 0b | PP.app v0.3.9 disposition | ✅ Deferred (recorded) |
| 0c | PP.app master cron triage | In progress |
| 0d | PP.app TroubleTracker package configuration | In progress |
| 0e | Repo rename + v2.0 folder restructure | ✅ Complete |
| 0f | Twilio token rotation + history scrub | 🔄 Token rotated ✅; history scrub pending |
| 1 | `pp-client` v1 gateway | Not started |
| 2 | Web form inbound adapter (new path) | Not started |
| 3 | Twilio Flex bridge adapter (Interactions API) | Not started |
| 4 | Customer feedback loop | Not started |
| 5 | Lifecycle automation | Not started |
| 6 | Connie deployment config | Not started |
| 7 | End-to-end UAT (new path) | Not started |
| 8 | Cutover + 14-day production soak | Not started |
| 9 | Legacy code retirement | Not started |

**Cutover (Phase 8):** form submit target swaps from legacy `/api/tickets` → new `/api/intake/web-form`. Legacy code retired in Phase 9 after the 14-day soak gate passes.

---

## Production deployment

- **URL:** `https://trouble-ticket-app.vercel.app` (canonical production alias, preserved through all phases)
- **Vercel project:** `chris-projects-78159ab5` team / `trouble-ticket-app` project / `prj_RqxBrrVVji7JzP257yHjvCyx7mE8`
- **GitHub repo:** `chrisberno/trouble-tracker`
- **Auto-deploy:** every push to `main` triggers a Vercel deploy

---

## Key documents

- **Manifesto v2.1:** `~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/documents/manifesto.md`
- **Roadmap v1.1:** `~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/documents/roadmap.md`
- **Sprint 1.0 doc:** `~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/technical/dev-logs/sprint-1.0-2026-04-30-trouble-tracker-poc.md`
- **IP allocation:** `~/projects/I.P./2026-04-30-trouble-tracker-ip-allocation.md`
- **Project knowledge home:** `~/projects/chrisberno.dev/vault/chrisberno-dev-vault/projects/trouble-tracker-app/`

---

## IP

Onreb portfolio property. Connie integrates as a customer; NSS is the launch UAT customer.
