# adapters/inbound/web-form

The web form inbound adapter. Accepts form submissions, validates and
normalizes input into a ticket payload, and hands it to
`pp-client.createTicket()` — never to PP.app's API directly.

Per Manifesto v2.2 adapter contract: every inbound adapter must
authenticate/validate input, normalize it into a ticket payload, call
`pp-client.createTicket(payload)`, and return the appropriate
acknowledgment to the intake source.

Until Phase 8 cutover, the legacy production form lives at `app/page.tsx`
and `app/api/tickets/route.ts` and is preserved untouched. The Phase 2
adapter is wired to `/intake` (form) and `/api/intake` (POST handler).

---

## 1. WebFormIntakePayload

```ts
interface WebFormIntakePayload {
  title: string;          // ticket subject
  description: string;    // ticket body / "tell us more"
  customerName: string;
  customerEmail: string;  // required — PP.app /api/contacts requires it
  customerPhone: string;
  customerScope: string;  // resolved server-side BEFORE this is called
}
```

5 user-visible fields. Email was added mid-Phase-2 (2026-05-03) when
smoke #10 surfaced PP.app's `/api/contacts` requiring email at
contact-create time. CEO+CTO call: PP.app is the Core, its data model
wins. Email also re-enables `pp-client.ensureCustomer`'s email-based
dedup path. Company is still omitted.

## 2. IntakeResult

```ts
interface IntakeResult {
  status: 'success' | 'failure';
  ticketId?: string;
  errorMessage?: string;
}
```

`success` always carries a `ticketId`. `failure` always carries an
`errorMessage` safe to display to the end user (no upstream stack traces
or internal IDs leak).

## 3. customerScope resolution

**Referer-based ONLY.** No query-param fallback. The deployment's
`customerScopeRule` (in `deployments/connie/index.ts`) reads
`req.headers.referer` (or `referrer`), iterates `customerScopes` from
`deployments/connie/config.json`, and returns the first entry whose
`refererMatch` substring appears in the referer. If nothing matches or
the referer is absent, returns `'Unknown'`.

The handler is deployment-agnostic — it accepts the scope string the
deployment computed. Adding a new deployment = ship a new
`deployments/{id}/index.ts` whose `customerScopeRule` resolves scope
however that deployment needs.

## 4. Failure modes

| Mode                       | Trigger                                                                   | Handler returns                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Validation error           | Any of title/description/customerName/customerEmail/customerPhone/customerScope blank, or email fails `^.+@.+\..+$` | `{ status: 'failure', errorMessage: 'Missing required fields: <list>' }` or `'Please enter a valid email address.'` (route surfaces as 400) |
| PP.app downtime / auth     | `PpClientServerError`, `PpClientRateLimitError`, or `PpClientAuthError`   | `{ status: 'failure', errorMessage: 'Support system temporarily unavailable. Please try again shortly.' }` (503)  |
| Unknown error              | Anything else thrown from `createTicket`                                  | `{ status: 'failure', errorMessage: 'An unexpected error occurred. Please try again.' }` (503)                    |

Every failure path also emits a structured log line with
`web_form_intake: true` for observability.

## 5. fallbackEmail handling — option (c)

The handler is deliberately agnostic to the deployment's fallback email.
The API route at `app/api/intake/route.ts` reads `fallbackEmail` from
`deployments/connie/config.json` and includes it in the 503 JSON
response. The form (`app/intake/page.tsx`) renders it as a `mailto:`
link when the response carries it. This keeps the handler reusable
across deployments without coupling it to deployment config.

## 6. Adding a new deployment

1. Create `deployments/{id}/config.json` with the same shape as
   `deployments/connie/config.json` (id, ppTenant, statusMap,
   customerScopes, defaultPriority, corsAllowlist, fallbackEmail).
2. Create `deployments/{id}/index.ts` exporting `build{Id}Config()` that
   hydrates the JSON into a runtime `DeploymentConfig` (importing
   `DeploymentConfig` as a type-only import from `@/pp-client/types`).
3. Either point the existing `app/api/intake/route.ts` at the new config
   (single-deployment), or fork the route into a deployment-aware entry
   when a second deployment ships (multi-deployment routing is out of
   scope for Phase 2 per the brief).

The handler in this folder takes any `DeploymentConfig` — it does not
need to change when a new deployment is added.
