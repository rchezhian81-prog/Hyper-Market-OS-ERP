# SRE Retail OS — Readiness to go live (the honest map)

_Owner-facing. Written 14 September 2026. This is the plain-English answer to "how close are we to a
finished, 10/10 product, and what stands between here and there?" It is grounded in
`docs/completion-status.json` and `scripts/completion-report.mjs`, not opinion._

---

## 1. Where we are today

**Product completion: 48.0%** (the weighted "technical implementation" headline). The completion model
(`docs/COMPLETION-MODEL.md`) scores each of the **104 controlling items** on a maturity ladder and weights it:
NOT_STARTED 0 · ENGINE_ONLY 20 · PARTIALLY_WIRED 40 · WIRED 60 · INTEGRATION_TESTED 75 · E2E_VERIFIED 85 ·
UAT_VERIFIED 95 · PRODUCTION_VERIFIED 100.

Six separate honesty scores:

| Score | Value | Plain meaning |
|---|---|---|
| Requirements / design | 99.0% | We know what to build. |
| **Technical implementation (headline)** | **48.0%** | How much is actually built and how mature. |
| Wired-and-integrated (≥ WIRED) | 30.8% | Live on the real API, not just an engine in a test. |
| End-to-end verified | 2.9% | Proven in a real browser through the whole path. |
| UAT readiness | 0.0% | Signed off by you and the staff **in the shop**. |
| Production readiness | 0.0% | Running **live on real hardware**. |

Where every item sits: 1 NOT_STARTED · 4 ENGINE_ONLY · 67 PARTIALLY_WIRED · 13 WIRED · 16 INTEGRATION_TESTED ·
3 E2E_VERIFIED · 0 UAT · 0 PROD.

## 2. What "100% / 10 out of 10" honestly means

This is the most important sentence in this document, and it is **not an excuse — it is the definition in our
own model**: the top two rungs, **UAT_VERIFIED (95)** and **PRODUCTION_VERIFIED (100)**, are *real-world*
verification. They cannot be earned by writing code or tests. UAT means you and your staff use each part in the
store and sign it off; PRODUCTION means it is running live on the shop's real tills, scanners and cloud with
real money going through it.

**Therefore no amount of autonomous development can reach 100% on its own.** The realistic ceiling for
"software built and machine-verified, before the store is involved" is around **E2E_VERIFIED (85)** for the
parts that have a screen — and even that needs a headless browser, which most items do not yet have. The last
15–50 points per item are earned **with you, in the shop.** Any tool that tells you it hit 100% without a real
store go-live is lying to you.

## 3. What was completed autonomously in this work stream

All merged to `main`, each backed by tests + docs, each merged only on green CI:

- **A08 Data Quality agent** — full remit (duplicates, missing attributes, suspicious mappings from import
  history) + a steward inbox screen that shows all of it. Rated **INTEGRATION_TESTED**.
- **A06 Operations agent** — explains live operational incidents (sync lag, dead letters, stale catalogue,
  missing backup, silent integration) and recommends the reviewed runbook. Rated **WIRED**.
- **A07 Security/Fraud agent** — prioritises the open loss-prevention investigations by exposure, citing the
  case (never a name). Rated **WIRED**.

Every one of these is **draft-only** — the AI recommends; a named human commits through the ordinary screen
(hard rule #5). Headline moved 47.3% → **48.0%** across these increments, each re-rate genuine.

## 4. What is still buildable without you (the queue)

These have real, persisted data and tested engines; they need engineering, not a decision. Rough order:

- **A03 Inventory agent** and **A02 Purchase agent** — stockout/overstock/expiry → transfer & markdown
  suggestions (A03); reorder & draft purchase order (A02). Draft-only. These are **bigger** than A06/A07: they
  orchestrate several inputs (sales history + on-hand stock + lead times + supplier terms), so they are proper
  builds, not quick wirings — and some parameters (forecast horizon, default lead time) may want your steer.
- **PARTIALLY_WIRED module legs** with a concrete remaining piece and real data — e.g. M01 org-hierarchy
  extras, M07 goods-receipt edges, M36 per-route entitlement enforcement, M18 multi-line amendment batching.
  Each is one PR, ~+0.2% headline, taken to WIRED/INTEGRATION_TESTED.
- **Browser (headless) end-to-end tests** for screens already at INTEGRATION_TESTED (e.g. the Data Quality
  inbox), to lift them toward E2E_VERIFIED. Adds real coverage; modest headline effect.

I can keep working this queue autonomously. It raises the headline steadily but, per §2, it **cannot** reach
100% — it tops out in the E2E band for screen-backed items.

## 5. What needs a decision from you (owner-gated)

- **Choose the AI model provider (OB-02).** Three agents are blocked on this and cannot be honestly built
  until a provider is chosen and connected: **A05 Service** (drafting case replies), and the *drafting* legs of
  **A09 Marketing** (draft campaign/offer) and **A10 Workforce** (task guidance). Their deterministic guards are
  already built; only the model-written text is missing.
- **Deferred features you asked to hold** — surface them again when you want them built: **M21 exchanges &
  no-receipt returns** (deferred to R5), **M04 persisted planogram/shelf-map store** (deferred to R6). These are
  the honest reason those modules sit at PARTIALLY_WIRED.
- **A persisted workforce store (HR data).** **A10 Workforce** cannot read rosters/SOPs until employee, roster
  and SOP data is stored per tenant (today those routes are stateless). This is a sizeable data-model addition —
  worth a short scoping conversation.

## 6. What needs a real-world step (nobody can self-certify these)

- **UAT — you and the staff sign off each module in the store.** This is the single biggest locked score (0%).
- **Production go-live on real hardware** — tills, scanners, the store computer, the cloud, with real money.
- **Live GST-return filing + e-invoice/e-way-bill (M23)** — needs the government portal **production
  credentials** and a **CA/tax sign-off**. Built and sandbox-tested; cannot go live without those.
- **Independent penetration test (QG-06)** — an external security vendor.
- **Full disaster-recovery rehearsal (QG-08)** and **certified-hardware performance sign-off (QG-05)**.
- **Migration parallel-run (MG-10)** — running the old and new systems side by side in the shop for a period.

## 7. The shortest honest path to a real go-live

1. **You:** pick the AI model provider (unblocks A05/A09/A10), and confirm which deferred features (exchanges,
   planogram) you want now vs later.
2. **Me:** keep clearing the buildable queue (§4) to lift everything I can to INTEGRATION_TESTED / E2E_VERIFIED.
3. **Together, in the shop:** a UAT pass module by module, a migration parallel-run, then the production
   cutover — with the CA on the GST piece and an external pen-test booked.

That sequence is what turns 48% built into a shop actually running on this system. Steps 1 and 3 are yours to
start; step 2 I will keep doing autonomously.
