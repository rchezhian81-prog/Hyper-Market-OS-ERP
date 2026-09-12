# ADR 0014 — Recurring subscription billing: Razorpay via the connector SDK, mandates not card data

- **Status:** Accepted (owner-directed commercialization, 12 September 2026). The *provider* choice is a
  research-backed recommendation the owner may substitute; the *architecture* (a provider-agnostic billing
  domain behind one adapter interface) stands regardless of provider.
- **Date:** 12 September 2026
- **Context:** The owner directed that the product must be able to **earn money as a subscription from day
  one** — a marketing landing page, a tenant login, subscription plans, and an **automatic monthly debit**.
  This is the customer-facing commercialization of the existing M36 commercial layer.

  The code as it stands:
  - `packages/platform/src/plans.ts` (M36-FR-01 / ADR-0003) already models **plans, entitlements, metering
    and plan changes** — `Plan` (`monthlyPriceMinor`, `grants`, `limits`, `overageMinor`),
    `TenantSubscription` (with `suspendedGrants`), `checkEntitlement`, `meterUsage`, `assessPlanChange`. It is
    a pure, tested engine. It has **no notion of a payment instrument, a mandate, a charge schedule, an
    invoice, or dunning**, and it is **not on the API surface** (only entitlement on/off is routed, API-11).
  - There is **no payment provider anywhere** (`grep` for razorpay/stripe/cashfree → nothing). The only
    payment code is POS tender settlement (`packages/tender/src/tender.ts`) and gateway-settlement
    reconciliation (`services/finance/src/settlement.ts`).
  - Card data is forbidden in the repository by guardrail `tests/guardrails/card-data.test.ts` (hard rule #3).
  - The API surface is **fixed at 13 ids** (`services/kernel/src/router.ts`, guardrail
    `tests/integration/thirteen-apis-one-surface.test.ts`) — a billing domain cannot get an API-14.
  - Authentication is **deliberately credential-free**: `services/identity/src/token.ts` *verifies* an
    external IdP's token and stores no password (hard rule #4).

  The constraint that governs the money path itself: **recurring auto-debit in India is regulated by the
  RBI Digital Payments — e-Mandate Framework, 2026** (in force since April 2026). It unifies UPI, cards and
  e-NACH under one routine; a mandate is registered once with additional-factor authentication (AFA), after
  which charges **up to ₹15,000** run without a per-charge OTP; a pre-debit notification is owed to the payer
  ahead of each debit. (Sources are cited in the WP5 design doc.)

## Decision

**1. Provider.** Recurring subscription billing uses **Razorpay Subscriptions** — the most mature Indian
recurring-billing provider, with a single integration across **UPI Autopay** (primary rail; cheapest, and a
monthly SaaS fee sits under the ₹15,000 no-AFA ceiling), **card e-mandate** and **e-NACH** (alternates), plus
built-in dunning/retries and pause/upgrade/downgrade.

**2. Never card data — mandates and provider references only.** We store the Razorpay **customer id,
subscription id, mandate / token reference (UMN), plan id and event ids** — never a card number, CVV or
expiry (hard rule #3). Secrets (API keys, webhook secret) are held as **references** through the connector
secret store (`services/platform/src/secrets.ts` / `packages/integration/src/secrets.ts`), never as values in
code, config, images or logs (hard rule #4).

**3. Provider-agnostic by construction.** All billing domain logic is written against a
`RecurringBillingProvider` **interface** (create customer, create subscription+mandate, fetch/charge status,
cancel, verify webhook signature). A **deterministic fake** drives every test; the **Razorpay adapter** is one
implementation, built and integrated through the **connector SDK** (M32 — the documented plug-in point for
payment providers) with idempotent calls, retry and dead-letter.

**4. Sandbox until the owner is a live merchant (external blocker).** The Razorpay adapter runs in
**TEST / sandbox mode only**. **No real money can move** until the owner supplies a live Razorpay merchant
account and completes KYC. That final switch is an **owner action**, recorded in
`docs/OWNER-ACTION-REGISTER.md`, exactly like the production IdP choice — everything up to it is built and
tested.

**5. It lives under API-11 (Platform).** Subscription/billing routes are added to the Platform service under
**API-11**, with `platform.*` permissions held by `platform_admin` (and `owner`). It **extends** the M36
`plans.ts` engine (adding `Mandate`, a recurring `BillingSchedule`, `Invoice`, and a dunning state machine)
— it is **not** a new service and **not** a new denominator/ledger item (it advances M36 and is tracked as
work package WP5; see `docs/COMPLETION-MODEL.md`).

**6. A failed charge never stops the shop trading.** Dunning on a missed debit may **suspend optional feature
grants** (`TenantSubscription.suspendedGrants`) and escalate to a person — it **never** stops a POS sale
(P-01, hard rule #1). This is the same invariant `meterUsage` already encodes with `mayContinueTrading: true`.

**7. No AI agent ever creates a mandate or moves money** (hard rule #5). AI may draft a dunning message; a
deterministic rule plus an authorised human commit every billing action.

**8. RBI e-Mandate 2026 is honoured in the flow, not just the provider.** The mandate is created with AFA; the
payer is shown a **pre-debit notification** (what will be charged, and when) before each monthly debit; the
monthly plan price is kept **under ₹15,000** (or the mandate is set up to require AFA) so no debit is
declined for exceeding the no-AFA ceiling.

We will **NOT** build an in-house card vault, an in-house mandate registry with the banks, or a background
service identity that can charge a tenant unattended.

## §19-substitution impact

Roadmap §19 names "a connector SDK … wraps … **payment providers** … behind versioned, idempotent adapters
with retry + dead-letter." Adding Razorpay as a recurring-billing provider is a substitution/addition on that
baseline, so the six axes:

- **Offline (P-01):** **No impact on the shop floor.** Billing is a cloud-plane, back-office concern between
  the vendor and the tenant. A payment-provider outage cannot touch a POS sale — the billing path is never in
  the sale path, and dunning cannot stop trading (decision #6). This is the whole reason it is safe.
- **Support:** Razorpay is a managed, widely-used Indian provider; we run no card infrastructure. Failure
  modes are charge-failed and webhook-missed — both handled by idempotent webhook ingest, provider-side
  retries, our dunning state machine, and the connector dead-letter (no silent failure, P-08).
- **Security:** Attack surface is a signed inbound webhook and outbound API calls with a referenced secret.
  No card data is stored (guardrail-enforced); webhook signatures are verified; the routes are least-privilege
  `platform_admin`; the platform admin cannot post a business transaction (existing guardrail).
- **Cost:** Per-transaction pricing, no fixed infra. UPI Autopay is the lowest-cost recurring rail under
  ₹15,000, which is where a monthly SaaS fee sits.
- **Portability (P-06):** The domain never imports Razorpay. A `RecurringBillingProvider` interface plus a
  provider-neutral data model (mandate ref, subscription ref, event ids) means a switch to Cashfree/Stripe is
  a second adapter, not a rewrite. Provider ids are exportable.
- **Maintainability:** One small adapter, idempotent, covered by a fake in tests; the regulated logic
  (schedule, dunning, invoice, GST) is pure and lives in `packages/platform`, tested without a network.

## Consequences

- The product can take a paying subscriber end-to-end **in sandbox today**, and go live the day the owner's
  merchant account exists — no code change on the critical path, only a credential reference.
- The commercial model gains a real money path while every existing invariant (no card data, never stop
  trading, AI cannot commit money, tenant isolation, least privilege) is preserved and, where possible,
  type-enforced.
- Billing is bounded to API-11 and the `platform.*` namespace, so the 13-API contract and the
  platform-admin separation hold.

## Reconsider-when

The owner selects a different provider or an in-house mandate capability; Razorpay pricing or availability
changes materially; the RBI e-mandate framework is revised; or a second billing provider becomes a real
requirement (at which point the interface pays off and a second adapter is added).
