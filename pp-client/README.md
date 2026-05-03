# pp-client

The normalized API gateway between TroubleTracker adapters and PP.app.

`pp-client` is the **only** place in TroubleTracker allowed to import PP.app
SDKs, hit PP.app URLs, or know about Perfex data shapes. Adapters speak
`pp-client`'s normalized interface; they never see PP.app directly.

`pp-client` is replaceable in principle: if Onreb ever moves off PP.app,
only this folder changes — no adapter changes.

---

## 1. What pp-client is

- The boundary between bridge adapters (Phase 2+) and the upstream ticketing
  system (PP.app today).
- A typed surface (`Ticket`, `Reply`, `CoreEvent`) that hides everything
  PP.app/Perfex-specific.
- A normalized event stream (`CoreEvent`) emitted from a webhook receiver.
- A pluggable handler registry (`subscribe`) that adapters wire into.

---

## 2. Public methods

```ts
createTicket(input: CreateTicketInput, config: DeploymentConfig): Promise<Ticket>
getTicket(ticketId: string, config: DeploymentConfig): Promise<Ticket>
addReply(ticketId: string, reply: { body: string; source?: string; isInternal?: boolean }, config: DeploymentConfig): Promise<Reply>
updateStatus(ticketId: string, status: TicketStatus, config: DeploymentConfig): Promise<Ticket>
resolveTicket(ticketId: string, config: DeploymentConfig): Promise<Ticket>
closeTicket(ticketId: string, config: DeploymentConfig): Promise<Ticket>
```

All errors are typed (`PpClientAuthError`, `PpClientNotFoundError`,
`PpClientRateLimitError`, `PpClientServerError`,
`DeploymentNotConfiguredError`). No `{ success: false }` returns, no
silent `undefined`.

---

## 3. CoreEvent kinds

Seven event kinds, four raw + two derived + delete:

| Kind                          | Source                                 | When it fires                                      |
| ----------------------------- | -------------------------------------- | -------------------------------------------------- |
| `ticket.created`              | raw (`ticket.created` webhook)         | A new ticket reaches PP.app.                       |
| `ticket.replied.customer`     | raw (`ticket.replied`, no source/staff) | The end customer posts a reply.                    |
| `ticket.replied.agent`        | raw (`ticket.replied`, source/staff)    | An agent (any bridge) posts a reply.               |
| `ticket.status_changed`       | raw (`ticket.status_changed`)          | Any status transition (always emitted).            |
| `ticket.resolved`             | derived from `status_changed`          | New status id matches `config.statusMap.resolved`. |
| `ticket.closed`               | derived from `status_changed`          | New status id matches `config.statusMap.closed`.   |
| `ticket.deleted`              | raw (`ticket.deleted`)                 | A ticket is deleted upstream.                      |

`ticket.replied` is **never** emitted to adapters — it is always
discriminated into `.customer` or `.agent` first (see §6).

`ticket.status_changed` is **always** emitted, even when a derived
`ticket.resolved` / `ticket.closed` event also fires for the same status
transition. Adapters can subscribe to whichever granularity they need.

---

## 4. DeploymentConfig

```ts
interface DeploymentConfig {
  tenantUrl: string;           // upstream tenant base URL
  tenantApiToken: string;      // upstream tenant API token
  customerScopeRule: (req: unknown) => string;
  statusMap: {
    open: number;              // upstream status id, default 1
    in_progress: number;       // upstream status id, default 2
    waiting: number;           // upstream status id, default 4
    resolved?: number;         // optional — resolveTicket throws DeploymentNotConfiguredError if absent
    closed: number;            // upstream status id, default 5
  };
  customFieldIds: {
    ticket: {
      customer_scope: number;  // numeric ID of the ticket-scoped 'customer_scope' custom field
      intake_source: number;   // numeric ID of the ticket-scoped 'intake_source' custom field
    };
  };
}
```

`statusMap.resolved` is optional because not every deployment uses a
"resolved" state. `resolveTicket` throws `DeploymentNotConfiguredError`
when called against a deployment that has not configured it.

`customFieldIds` is REQUIRED. Perfex's POST `/api/tickets` accepts custom
fields keyed as `custom_fields[<fieldto>][<numeric_field_id>] = <value>`
— slug-keyed payloads are silently dropped. Each deployment must enumerate
the numeric IDs of fields it expects pp-client to populate. Field IDs are
tenant-local; look them up via:

```sql
SELECT id, slug FROM <tenant_prefix>_tblcustomfields WHERE fieldto='tickets';
```

Default upstream status ids on the TroubleTracker tenant:
`open=1, in_progress=2, waiting=4, resolved=3, closed=5`.

Default custom-field IDs on the TroubleTracker tenant (Connie deployment):
`customer_scope=1, intake_source=2`.

---

## 5. Webhook receiver

| Concern             | Detail                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Route               | `POST /api/pp-webhook`                                              |
| Sig algorithm       | HMAC-SHA256                                                         |
| Sig key             | `process.env.PP_WEBHOOK_SIGNING_SECRET`                             |
| Sig location        | INSIDE JSON body as the `signature` field                           |
| Verifier            | Raw-body splice (NOT JSON re-serialize — see below)                 |
| Idempotency         | Postgres table `pp_webhook_idempotency`, 24h TTL                    |
| Idempotency key     | `${event}:${timestamp}` from the envelope                           |

### Signature verification (raw-body splice)

PP.app signs the bytes of `json_encode({event, timestamp, data})` and
inserts the resulting hex digest into the same JSON object as the
`signature` field. To verify, the receiver:

1. Reads the raw body bytes (Buffer).
2. Finds the substring `,"signature":"<64-hex>"` (or `"signature":"<64-hex>",`
   if at the start of the object).
3. Splices that substring out, leaving the bytes that PP.app actually signed.
4. Computes HMAC-SHA256 over the spliced bytes with the signing secret.
5. Compares the computed digest against the extracted signature using
   `crypto.timingSafeEqual`.

This is **not the same as** JSON-parsing the payload, removing the
`signature` field, and re-serializing — that would fail because field
order, whitespace, and escaping wouldn't match what PP.app signed.

---

## 6. Sub-event discrimination rule

Reply events are split into `.customer` vs `.agent` purely by the
**presence or absence** of upstream metadata fields. There is no
string comparison against any bridge name — `source` is treated as
opaque.

```
if (reply.source)        → kind = 'ticket.replied.agent'
else if (reply.staffid)  → kind = 'ticket.replied.agent'
else                     → kind = 'ticket.replied.customer'
```

This means any future bridge can use any unique `source` value (or none,
if it relies on `staffid`) without touching `pp-client`.

---

## 7. Customer-scope mechanism

Each ticket carries a `customerScope` field that captures the program /
brand bucket the ticket belongs to (NSS, HHOVV, Lifeline, etc.).
`pp-client` round-trips it cleanly:

| Operation          | Behavior                                                    |
| ------------------ | ----------------------------------------------------------- |
| `createTicket`     | Writes `customer_scope` custom field on the upstream ticket |
| `getTicket`        | Reads it back from the upstream ticket's custom fields      |
| Webhook events     | Emitted as `ticket.customerScope` on every event payload    |

The custom-field name `customer_scope` is hardcoded inside `pp-client`
on purpose. There is no config knob — adapters that need scope-based
routing read `ticket.customerScope` and decide.

---

## 8. Source read-side decision

Three options were on the table for how the event mapper learns the
opaque `source` value off a `ticket.replied` webhook payload:

1. **Payload-included** — the bridge enriches the payload with `source`
   (on `data.reply.source` or `data.source`); the mapper reads it directly.
2. **Extra GET** — fetch reply detail at `GET /api/tickets/reply/{id}` and
   read `source` from the response.
3. **Bridge enrichment** — bridge stamps `source` into a payload field
   we control, then PP-CTO confirms the contract.

**Phase 1 uses Option 1 (payload-included).** The mapper reads
`data.reply.source` or `data.source` directly off the webhook envelope;
if neither is present, it falls back to `data.reply.staffid` presence as
the agent signal, then defaults to customer. This avoids a per-reply
round-trip back to PP.app and keeps the receiver fast.

If/when `tt_webhook_bridge` is ever updated to omit `source` from the
payload, switch to Option 2 by uncommenting the helper in
`event-mapper.ts` (intentionally inlined as a single function for
easy swap).

---

## 9. What pp-client does NOT do

- No vendor-bridge knowledge (no contact-channel SDK awareness, no
  routing rules, no IVR, no per-bridge conditional logic).
- No multi-tenant routing — the adapter constructs a `DeploymentConfig`
  per request and passes it in.
- No ticket-lifecycle state persistence — PP.app owns lifecycle truth.
  `pp-client` never caches ticket state.
- No adapter-specific business rules — no "if scope=X then assign queue Y."
  That's the adapter's job.

---

## 10. Grep verification

These two greps must return zero matches (Phase 1 acceptance gate):

```bash
# No upstream-system knowledge outside pp-client/
grep -r "peopleperson\|perfex" --include="*.ts" --include="*.tsx" . | grep -v "pp-client/"

# No bridge-specific knowledge inside pp-client/
grep -r "twilio\|flex\|taskrouter" --include="*.ts" --include="*.tsx" pp-client/
```

If either grep fires, it indicates a leak across the abstraction
boundary that needs to be cleaned up before merging.
