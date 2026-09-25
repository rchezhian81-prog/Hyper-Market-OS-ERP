# Pilot feature safety (Phase 3)

_Release candidate `pilot-rc-1`. Non-production pilot only._

The owner's authorisation is for a **non-production** pilot: the dangerous "live" capabilities must be
**off or gated by default**. This document records the actual control behind each one, whether it is
default-safe, and — honestly — where a control does **not** exist on the API tier so nobody relies on a
guarantee that isn't there.

The claims marked **asserted** are proven by `tests/integration/pilot-feature-safety.test.ts`, which drives
the REAL cloud surface (the one production composes) against a **fresh pilot tenant** (an owner and nothing
else). The pipeline is default-deny for both permissions and entitlements, so a fresh-tenant assertion is a
real end-to-end assertion.

## Default-safe, asserted

| Capability | Control | Default state (asserted) |
|---|---|---|
| Live GST / e-invoice / e-way-bill filing | `assessGstPortalGate` behind `POST /v1/finance/gst-portal/gate`; only sandbox routes on the surface, no live IRP/GSP connector wired | `canGoLive:false, reason:'not_enabled'`; `killed:true` overrides `enabled` → `reason:'killed'` |
| Autonomous AI financial/inventory action | `FORBIDDEN_TOOLS` + `grantTools`/`commitProposal` (`packages/ai`), gateway admission, no commit route; **AI kill switch defaults ON** | `POST /v1/ai/agents/:agent/runs` → **503 `kill_switch_is_on`** on a fresh tenant |
| Production messaging / payment capture / other paid features | per-route `entitlement:` gate (pipeline, fail-closed); sandbox billing provider; no SMS/WhatsApp/card provider wired | every `OPTIONAL_FEATURES` entry OFF; an entitlement-gated route → **403 `feature_not_entitled`** until enabled |
| Irreversible legacy migration / cutover | `assertNonProduction` on **every** migration request; `MIGRATION_TARGET_KIND` fallback `rehearsal`; empty cutover checklist never ticks GO | `migrationTargetKind:'production'` → **403 `target_is_production`**; cutover with empty evidence → `decision.go === false` |
| Privilege / money change without a second person (§28) | maker≠checker across role-grant, price, pay-run, erasure, GRN, migration, merge, import, AI | a self-approved price change → **422 `approved_by_the_setter`** (representative; full sweep in `tests/security/separation-of-duties.test.ts`) |
| Any action without authority | `tenantAccessResolver` default-deny | a user with no grant → **403** on any protected route |

## Gated, but not "disabled by default" — stated honestly

- **Live payroll bank-file release.** Maker≠checker is enforced on the pay-run store
  (`POST /v1/hr/payroll/pay-run/:id/append`), and the bank-file route is **build-only** (needs a LOCKED run;
  transmits nothing — no bank connector on the surface). So no real payment can leave the surface. The
  **step-up re-auth** on release is a **web-erp session control, not an API control** (see the gap below).
- **"Delete my data" production execution.** The erasure execution route is **wired and executable**, gated
  by RBAC (`privacy.erasure.approve` / `privacy.erasure.execute`) + a two-person rule + subject verification
  + a prevent-restore guard (covered by `tests/integration/erasure-execution.test.ts`). It is **not** a
  default-off feature flag, and it is **DEVELOPMENT-APPROVED, LEGAL-CONFIRMATION-REQUIRED** — the code wires
  the workflow, it does not make a compliance claim. In the pilot it runs against synthetic PII only.

## Known gap — do NOT rely on this

- **Recent re-authentication / step-up for sensitive actions does not exist at the API tier.** The kernel
  request pipeline and `services/identity` do not check token freshness or require re-auth for sensitive
  routes; step-up lives only in the browser/session layer (`web-erp` payroll re-auth, `customer-app`). This
  is recorded as **GAP-SEC-06** in `docs/audit/SECURITY_PRIVACY_THREAT_MODEL.md`. For the pilot, sensitive
  actions are protected by RBAC + maker-checker + audit, **not** by API-tier step-up. Closing GAP-SEC-06 (an
  auth-tier freshness check) is a pre-production security item, tracked for the owner.

## What the pilot must still do (operational, not code)

- Use the **local/test IdP** for pilot logins (the `no-test-idp-in-production` guardrail keeps it out of
  production code); the production IdP + MFA is deferred (OA-4).
- Leave every dangerous entitlement OFF; turn on only what a given UAT case needs, and turn it back off.
- Keep `MIGRATION_TARGET_KIND=rehearsal` (pinned in `infra/compose/.env.pilot.example`).

## Maturity

**Integration tested** — the default-safe controls are asserted end-to-end against the real surface for a
fresh tenant. Re-verify on the stood-up pilot environment (⛔ EX-01 / OA-5), and treat GAP-SEC-06 (API-tier
re-auth) as an open pre-production security item.
