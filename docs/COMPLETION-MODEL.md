# Product Completion Model

_One reproducible model for "how complete is the product?" — no estimates, no judgement ranges._
_Owner-mandated (reporting correction, 13 Aug 2026). Computed by `pnpm run completion`._

This document defines exactly how the product-completion percentage is calculated, so the number is
**reproducible** (same ledger → same number), **auditable** (the inputs are a checked-in file) and
**governed** (the denominator and weights cannot drift silently).

## The formula

```
Product completion % = Σ (maturity weight of every controlling requirement) ÷ (total controlling requirements × 100) × 100
```

Equivalently, since each requirement's weight is 0–100, it is the **average maturity weight** across the
controlling requirement set.

## The fixed maturity weights

Every controlling requirement is assigned exactly one maturity, worth a fixed weight:

| Maturity | Weight |
|---|---|
| `NOT_STARTED` | 0% |
| `ENGINE_ONLY` | 20% |
| `PARTIALLY_WIRED` | 40% |
| `WIRED` | 60% |
| `INTEGRATION_TESTED` | 75% |
| `E2E_VERIFIED` | 85% |
| `UAT_VERIFIED` | 95% |
| `PRODUCTION_VERIFIED` | 100% |
| `EXTERNALLY_BLOCKED` | _retains the achieved technical-maturity weight; the blocker is reported separately_ |

`EXTERNALLY_BLOCKED` is **not** a weight. A requirement whose only remaining step is an external
dependency (production credentials, a certified provider, CA/legal sign-off, lawful data access) **keeps
the weight of the technical maturity it actually reached** and is listed separately with its blocker, so
an external gate never silently deflates the technical score. In the ledger this is modelled as the item's
normal `label` (the achieved maturity, e.g. `INTEGRATION_TESTED`) plus an `externalBlocker` string.

The weights live in one place — `scripts/completion-report.mjs` — and are re-asserted by the guardrail
`tests/guardrails/completion-model-integrity.test.ts`, so they cannot be edited in only one location.

## The denominator — the controlling requirement set

The **fixed denominator** is the controlling roadmap's top-level requirement structure (roadmap v2.0 /
v2.1, per `CLAUDE.md`):

| Group | IDs | Count |
|---|---|---|
| Modules | `M01`–`M36` | 36 |
| Extensions | `D01`–`D14` | 14 |
| AI agents | `A01`–`A10` | 10 |
| Workflows | `WF-01`–`WF-20` | 20 |
| Quality gates | `QG-01`–`QG-12` | 12 |
| Migration controls | `MG-01`–`MG-12` | 12 |
| **Total** | | **104** |

**Why this granularity.** The roadmap's functional requirements (144 M-FRs + D/A sub-requirements) are the
finest grain, but their statuses are tracked in prose in `docs/traceability.md`, not as a per-FR ledger.
The top-level controlling items above are a fixed, enumerable, non-overlapping set that the RTM assigns
statuses to directly. The R2 compliance annexes (`A1`–`A29`) and the net-new owner-directive work packages
(WP1 category policy, WP2 e-invoice/e-way-bill, WP3 payroll, WP4 GST-return submission) are **refinements
that map onto these controlling items** (e.g. WP4 → `M23` finance / GST) and are tracked in the RTM — they
are deliberately **not** separate denominator entries, to prevent double-counting and denominator drift.
This is baseline **v1**; a finer per-FR denominator is a future baseline revision (see governance below).

## The six separate scores

The single ledger yields six distinct, reproducible views (all computed in `computeReport`):

1. **Requirements / design completeness** — % of controlling requirements that are past `NOT_STARTED`
   (designed and realised at least as far as a tested engine). Everything in the roadmap is _specified_;
   this measures what has been _brought into the codebase_.
2. **Technical implementation completeness** — the weighted headline above (`Σ weights ÷ max`). This **is**
   the product-completion %.
3. **Wired-and-integrated completeness** — % of requirements at maturity ≥ `WIRED` (live on the API).
4. **E2E verification** — % at ≥ `E2E_VERIFIED`.
5. **UAT readiness** — % at ≥ `UAT_VERIFIED`.
6. **Production readiness** — % at `PRODUCTION_VERIFIED`.

Scores 3–6 are monotone "at least" thresholds, so they never exceed score 2 and degrade gracefully.

## The ledger

`docs/completion-status.json` holds the baseline metadata and one entry per controlling requirement:

```json
{ "id": "M23", "label": "PARTIALLY_WIRED", "externalBlocker": "live GST filing needs prod creds + CA sign-off", "evidence": "RTM: credit notes wired; close totals refuse" }
```

Each item's `label` is sourced **conservatively** from `docs/traceability.md` — when the evidence is
ambiguous, the **lower** maturity is chosen. `evidence` cites the RTM.

## Governance — no silent drift

- **The denominator (104) and the weights are fixed.** They may only change through a **documented,
  approved baseline revision**: bump `baseline.version`, record the change and its rationale here and in
  `docs/STATUS.md`, and get owner approval. The guardrail test fails if the ledger's id set drifts from the
  fixed 104, so a denominator change cannot land silently.
- **`previousProductCompletionPct`** in the ledger baseline records the prior run's headline, so every
  report shows the change and (in `docs/STATUS.md`) the requirement IDs responsible for it.
- Reports are produced by `pnpm run completion` (human-readable) or `node scripts/completion-report.mjs
  --json`. The numbers in `docs/STATUS.md` are copied from that command's output — never hand-estimated.
