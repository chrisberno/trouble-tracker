# deployments/connie

Deployment configuration for the Connie deployment — TroubleTracker's first production tenant.

Phase 6 will add `config.json` here, specifying: which inbound adapters are active, which bridge adapter is active (Twilio Flex), which PP.app package is applied, and which branding configuration is used.

Per Manifesto v2.1: customer-specific names appear only in `deployments/{client-id}/` — never in `pp-client/`, adapter code, or `branding/troubletracker/`. Multi-tenancy is delegated to PP.app's `perfex_saas` module.
