# ADR 0003 — Multi-tenant, configuration-driven product

- **Status:** Accepted — owner instruction, 2 August 2026.
- **Deciders:** Owner (Mr Elanchezhian), with the developer/implementation lead.

## Context
The owner has clarified that **SRE Retail OS is built as a commercial product to be sold to
other retailers, not only for SRE Hyper Market's own use** ("we are planning this software
for commercial purpose not only for own purpose … make everything choose-able").

This is not a new requirement invented outside the roadmap — the roadmap already carries
**tenant / white-label / subscription readiness** (M33, D12) and a full multi-tenant module
**M36** at release R8. The owner is **elevating that readiness to a first-class, from-the-
start architectural concern**, and making explicit that **no store-specific value is
hard-coded**. SRE Hyper Market becomes the **first tenant** (the pilot), not the definition
of the product.

The Stage-5 foundation was, fortunately, already built this way: the trading-day rule takes
the cut-off as a **parameter** (`packages/calendar`), tax is a **`Rate` parameter**
(`packages/pricing`), configuration is **versioned per key** (`packages/config`), and roles,
document-number formats and currencies are all **configurable**, not constants. So this ADR
mostly formalises the posture and adds the tenant boundary.

## Decision
1. **No store-specific facts are hard-coded.** Every store-specific value — trading-day
   cut-off, GST/tax rates and classes, departments and module toggles, currencies,
   languages, document-number formats, roles/permissions, delivery radius/slots, payment
   providers, branding — is **per-tenant configuration read at runtime**, never a product
   constant.
2. **Tenant is the top isolation boundary.** A `tenant` sits above company/branch/warehouse
   in the data model; **tenant data is isolated** (M36-FR-01) and every record and query is
   **tenant-scoped** (extends the existing company/branch scoping — §data-model rules).
3. **Configuration- and entitlement-driven behaviour.** Per-tenant settings + **feature
   entitlements** (M33/D12/M36) decide which modules and departments are active — e.g. the
   "conditional departments" (bakery/pharmacy/concession, `AVR-12`) become **per-tenant
   feature toggles**, not build-time choices.
4. **Onboarding is configuration, not code.** A new retailer is onboarded by creating a
   tenant and filling its configuration profile — **no code fork** (M36-FR-02, "white label
   / configuration without code forks"). The former "store-facts questionnaire" is reframed
   as the **tenant onboarding profile**; SRE fills it first.
5. **Build tenant-ready now; full commercial-SaaS features at their release.** The
   architecture is multi-tenant and fully configurable **from the start**. The heavier
   SaaS features — subscription plans / metering / billing, self-serve signup, per-tenant
   white-label theming, tenant export/closure — remain **M36 (R8)** on this tenant-ready
   base, unless the owner prioritises them sooner.

## Consequences
- **Positive:** sellable to many retailers; SRE proven as tenant #1; no per-customer code
  forks; aligns with OD-01/OD-09 (independently owned product) and P-06 (portable,
  configurable, documented).
- The **data model gains a tenant layer** and every query a tenant filter; **tenant
  isolation is a security boundary** — the threat & privacy model (§35) is updated to treat
  cross-tenant access as a critical threat.
- Slightly more configuration surface up front, offset by the foundation already being
  parameterised (little rework).
- **Existing Stage-3/4 design is largely unaffected** — it describes roles and surfaces, not
  SRE-specific constants. The store-fact `⟳ AVR-##` fields become **per-tenant
  configuration**; SRE is simply the first tenant to supply them.

## Follow-up work
- Add the `Tenant` entity and tenant scoping to `db/data-dictionary/` and the data model.
- Add a per-tenant settings/entitlements catalogue (drives the config engine).
- Reframe `docs/discovery/store-facts-questionnaire.md` → tenant onboarding profile (done).
- Update the architecture overview, threat model and STATUS to the multi-tenant posture.
