# WP5 — Commercialization: the commercial surface (design)

_Net-new owner directive, 12 September 2026: "I want to live commercially from the beginning. Plan and design
a landing page, a login page, a subscription plan, and an auto-debit payment method every month."_

This document is the design of record for **selling SRE Retail OS as a subscription SaaS**. It sits on top of
the existing M36 commercial layer (`packages/platform/src/plans.ts`, ADR-0003) and the recurring-billing
decision in **ADR-0014**. It changes no headline maturity by itself; it plans the work.

## 1. What this is (and what it is not)

**Is:** the customer-facing funnel that lets *another retailer* discover the product, sign in, choose a plan,
and pay automatically every month — so the product earns revenue, not just runs our own shop.

**Is not:** a shopper-loyalty/membership scheme for SRE Hyper Market's own customers. (If that was the intent,
this design is wrong and the owner should say so — it is a different product.)

**Roadmap honesty.** The *subscription model* is a real roadmap requirement (M36 / ADR-0003) and is partly
built (the `plans.ts` engine). The *marketing site + self-service signup + online recurring auto-debit
collection* is **net-new** and is tracked as work package **WP5** — a refinement mapping onto M36 (billing),
M01/M02 (signup/login/identity) and API-11 (Platform). Per `docs/COMPLETION-MODEL.md`, WP5 is **not** a new
denominator item and does **not** move the 41.5% headline on its own; each slice advances the maturity of the
controlling items it touches.

## 2. The funnel

```
 (public)                      (authenticated tenant)                        (cloud / provider)
  Landing  ──▶  Sign up  ──▶  Log in  ──▶  Choose plan  ──▶  Set up auto-debit  ──▶  Active
  page          (provision     (IdP        (plans from        (UPI Autopay /          subscription
                 a tenant,      token)      plans.ts)          e-mandate mandate,       │
                 trial state)                                  Razorpay sandbox)        │
                                                                                        ▼
                                                          every month: pre-debit notice ▶ auto-charge
                                                          ▶ GST tax invoice ▶ (on failure) dunning:
                                                          retry ▶ suspend OPTIONAL features ▶ escalate
                                                          — never stop the shop trading (P-01)
```

## 3. Architecture — reuse first

| Concern | What exists (reuse) | What is net-new (WP5) |
|---|---|---|
| Plans / entitlements / metering / plan-change | `packages/platform/src/plans.ts` (M36) | — |
| Tenant + feature flags | `packages/tenant/src/tenant.ts`, `setup.ts` | tenant **provisioning** at signup (only genesis bootstrap exists today) |
| Identity | `services/identity/src/token.ts` verifies IdP tokens; `packages/rbac`, `services/api/src/roles.ts`, `access.ts` | a **login UI** + a pluggable **auth broker**; production IdP is an owner action |
| Billing money path | nothing | `Mandate`, `BillingSchedule`/recurring charge, `Invoice` (+GST), **dunning** — extend `plans.ts`; a `RecurringBillingProvider` interface + **Razorpay adapter** (sandbox) via the connector SDK |
| API surface | 13-id cap; Platform = **API-11**, `platform.*` | billing/subscription routes under **API-11** |
| Web apps | static-HTML PWAs bundled by `scripts/build-app.mjs` | a **public marketing app** + login + subscribe pages, same static pattern |

**Everything money-related is provider-agnostic domain logic in `packages/platform`, tested with a fake.** The
only Razorpay-specific code is one adapter behind the connector SDK (ADR-0014).

## 4. Data model additions (extend `packages/platform`)

Provider-neutral, no card data (hard rule #3), append-only events (hard rule #2):

- **`Mandate`** — `mandateId`, `tenantId`, `rail` (`upi_autopay | card_emandate | enach`), `providerRef`
  (Razorpay mandate/UMN + subscription id), `status` (`pending | active | paused | revoked | failed`),
  `maxAmountMinor`, `createdWithAfa: true`, timestamps. No instrument details — references only.
- **`BillingSchedule`** — next charge date, cadence (monthly), the `planId` and `amountMinor` to charge, and
  the **pre-debit notification** due date (RBI). Pure `nextCharge(now)` computation.
- **`Invoice`** — a GST **tax invoice** for each successful charge: seller GSTIN, buyer GSTIN, **SAC code**
  for SaaS, taxable value, **CGST/SGST or IGST split** (intra- vs inter-state), invoice number series,
  total. Integer minor units. Computed purely; numbers configurable, never invented.
- **Dunning state machine** — `current | retrying(n) | past_due | suspended` where `suspended` only ever sets
  `suspendedGrants` (optional features), and the machine has **no state that stops trading** (typed like
  `meterUsage.mayContinueTrading: true`).

Prices, GSTINs and SAC code are **configuration the owner sets** (proposed defaults in the plan catalogue,
never hardcoded facts).

## 5. Login without storing credentials

The codebase deliberately holds **no passwords** — `services/identity/src/token.ts` verifies an external
IdP's signed token; a guardrail bans the test IdP from production. WP5 keeps that architecture:

- The **login page** collects credentials and exchanges them, through a thin **auth-broker interface**, for a
  token the API already verifies. Tests use the existing `tests/support/local-idp.ts` fake.
- The **production IdP** (e.g. a hosted identity provider) is an **owner action / external blocker**, recorded
  in `docs/OWNER-ACTION-REGISTER.md` — the same shape as the merchant account. We do not build a password
  vault in this repository (hard rule #4).
- Signup **provisions a tenant** in a trial state; a real production login is refused until the IdP exists.
  Re-validate the operator's *current* session, tenant and permission on every privileged action (the pattern
  ADR-0013 already established).

## 6. Slices (each its own tested PR, merged on green)

1. **WP5-A** — billing domain engine in `packages/platform` (Mandate, BillingSchedule, Invoice+GST, dunning), pure + tested.
2. **WP5-C** — subscription/billing routes under **API-11** + `RecurringBillingProvider` interface + fake; `platform.*` permissions.
3. **Razorpay adapter** (sandbox) via the connector SDK.
4. **WP5-D** — marketing landing page (public static app) + an owner-viewable preview.
5. **WP5-B/E** — auth broker + login page (test IdP).
6. **WP5-F** — signup → choose plan → set up auto-debit mandate → confirmation (sandbox).

Woven in alongside: migration **MG-03** (mapping) and **MG-04** (cleaning).

## 7. External blockers (owner actions, recorded in the register)

- **Razorpay live merchant account + KYC** — required before any real debit. Built and tested in sandbox meanwhile.
- **Production identity provider** — required before a real tenant can log in. Built and tested against the local IdP meanwhile.
- **Final prices, seller GSTIN and SAC code** — business facts only the owner sets. Proposed defaults provided; nothing invented.

## 8. Compliance references (web sources, retrieved 12 Sep 2026)

- RBI Digital Payments — e-Mandate Framework, 2026 (unifies UPI/card/e-NACH; ₹15,000 no-AFA ceiling; pre-debit
  notification): AMLEGALS compliance checklist; Economic Laws Practice guide; Outlook Business summary.
- Razorpay Subscriptions / UPI Autopay as the mature Indian recurring-billing rail; UPI Autopay cheapest under
  ₹15,000: Razorpay documentation and "cheapest payment gateway for recurring billing" comparison.

## 9. For the owner — in plain words

We are building the shop-front for selling your software: a page that explains it, a way for a customer to
sign in, the monthly plans, and automatic monthly collection through India's approved auto-debit
(UPI Autopay, via Razorpay). We will build and **test all of it with fake money first**. Real money cannot
move, and no real customer can log in, until you give us two things: a **Razorpay merchant account** (with
KYC) and your choice of **login provider** — plus the **prices** you want to charge. Until then, nothing you
see can accidentally bill anyone. Your own shop's tills are never affected by any of this.
