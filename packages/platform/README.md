# `packages/platform/`

The commercial multi-tenant layer — **M36-FR-01…04** (ADR-0003 / OB-01 / §35 / P-06 / hard
rules #6, #7).

`packages/tenant` has answered *"is this feature on for this tenant?"* since Stage 5. This
package answers the commercial questions on top: **what did they buy, what are they using,
what do they see, and what happens when they want to leave.**

- **`src/plans.ts`** — plans, entitlements and metering (FR-01).
  - `checkEntitlement(…)` — default-deny, and the **`source` matters as much as the answer**.
    "No" because the plan does not include it is a sales conversation; "no" because billing
    suspended it is an accounts conversation; a support engineer who cannot tell them apart
    wastes an afternoon on the wrong one.
  - `meterUsage(…)` — **`mayContinueTrading` is typed as `true`.** Not a boolean that happens
    to be true — the type itself. There is no code path here, and no future edit to this file,
    that can return false and stop a shop trading. A vendor may withdraw a service; a vendor's
    software may not close a hypermarket on the Saturday before Diwali. Exceeding a limit is
    reported, invoiced and escalated, never enforced at the lane (P-01, hard rule #1).
    - A **peak** dimension (lanes, branches, users) meters at its highest point; a **volume**
      dimension (transactions, API calls, tokens) meters at its sum. Metering a peak as a sum
      bills a shop thirty times for the same four tills.
  - `assessPlanChange(…)` — a downgrade is **always allowed**, because trapping a struggling
    tenant on a plan they cannot pay for helps nobody. What it does instead is say exactly
    what goes dark and which limits they are already over — and **no feature loss deletes
    data**, so a tenant who drops loyalty in January and takes it back in March finds every
    point balance intact.
  - `assertTenantIsolation(…)` — the last line of defence behind `tenant_id` scoping and
    session-scoped portals. A cross-tenant row **refuses the whole result set** and is reported
    as a critical defect (§35), not filtered out: the silently-trimmed version is the one
    nobody ever investigates.

- **`src/branding.ts`** — white-label without code forks (FR-02). The moment a customer gets
  their branding through a fork, the product is finished: every fix applies N times, one
  tenant's urgent patch waits behind another's release, and within eighteen months nobody can
  say which customer runs which version.
  - `resolveBrand(…)` — **an unset brand falls back to neutral, never to another tenant's.** A
    missing logo showing the *previous* tenant's mark is a retailer invoicing under a
    competitor's name. Branding belonging to another tenant is treated as **absent**, and the
    neutral default is built fresh from `neutralBranding()` each call so there is no shared
    object for anything to leak through.
  - `validateBranding(…)` — contrast is **blocking**, not a note: a cashier who cannot read the
    total under checkout lighting at 8pm is a support call every day for a year, and by then
    the colours have been signed off by somebody senior. And `PROTECTED_TERMS` cannot be
    renamed — a tenant may call a branch a showroom; a tenant may **not** rename "tax invoice",
    "GST" or "credit note", because a document that calls a tax invoice something else is not
    a tax invoice.
  - `applyTerminology(…)` — whole-word, case-preserving, and it refuses a protected term a
    second time at render. Validation and rendering are separated by a database and a year.

- **`src/lifecycle.ts`** — export, closure and upgrade compatibility (FR-03). This module
  answers one question honestly: **what happens when a customer wants to leave?**
  - `buildTenantExport(…)` — an export is **complete or it is not an export**. The check runs
    against the platform's declared domain list, so adding a domain to the product without
    adding it to the exporter turns every subsequent export into a **failure** rather than a
    quietly smaller file. That pressure is intended. A domain with no rows must be **present**
    and zero — absence and emptiness are different facts, and only one is reassuring.
  - `closeTenant(…)` — access is revoked immediately; deletion is a different event and mostly
    does not happen, because Indian tax retention outlives the commercial relationship.
    **Audit evidence is never in scope** (hard rule #6). Closure is refused before the tenant
    has taken its export — not lock-in, but the last moment at which taking it is easy.
  - `assessCompatibility(…)` — **an announced-but-unelapsed deprecation is still breaking.**
    The announcement is not the mitigation; the elapsed time is, and only if somebody checked
    who is still calling. Affected tenants are named, not counted: *"3 tenants affected"* gets
    deployed on a Friday and *"Sri Lakshmi Stores and two others"* does not. Making an optional
    field **required** is breaking — it looks additive on a diff and is the change that most
    often takes a partner integration down.

- **`src/partner.ts`** — the developer ecosystem (FR-04). An ecosystem is a set of people we do
  not employ, holding credentials to systems we are responsible for.
  - `checkPartnerAccess(…)` — a **sandbox credential presented against production is refused
    and recorded as a security event**, whether it was a mistake or not (hard rule #7). A
    production credential in the sandbox is stopped but deliberately **not** called an attack —
    calling every mix-up an attack trains people to ignore the alerts. A partner is scoped to
    the tenants that engaged them, and an empty scope list means **none**, never all. An
    unversioned call is **refused, not defaulted to latest**, because defaulting is what
    silently breaks a partner on the morning we ship.
  - `certificationStatus(…)` — a connector certified against v1 and running on v4 is **old with
    a badge**, not certified. It keeps running (pulling a working integration out of a live
    shop over paperwork is worse than the risk) but it is visible and dated. Never-certified is
    the one that cannot reach production.
  - `seedSandbox(…)` — **production data is refused outright.** The temptation always arrives
    with a good reason — *"the partner needs realistic data"* — and the result is a retailer's
    customer list on a developer's laptop. Realistic data is generated, not copied.

> Pure and deterministic: the clock is injected, no I/O. Builds on `packages/tenant`
> (entitlements, settings) and `packages/config` (versioned per-tenant configuration). Tested
> in `tests/unit/platform-plans.test.ts` (20), `platform-branding.test.ts` (16),
> `platform-lifecycle.test.ts` (19) and `platform-partner.test.ts` (17), and proven end to end
> in `tests/integration/two-shops-one-system.test.ts` (Stage 18 gate). Part of the repository
> layout in `CLAUDE.md`.
