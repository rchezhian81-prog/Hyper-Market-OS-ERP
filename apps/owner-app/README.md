# `apps/owner-app/`

The owner's control app — daily brief, KPIs, exception alerts and the approvals inbox
(**M29 / D13**). Built to the Stage 3 spec in `docs/design/screens/owner-command-centre.md`.

The owner's job is to **decide, check and approve**, so this is **control by exception**
(P-03): the screen surfaces risks and decisions, not raw noise.

## Two parts

- **`src/brief.ts` — the model (tested).** `buildBrief(input)` composes the tested engines
  (`packages/reporting` for KPIs and freshness, `packages/loss-prevention` for exceptions,
  the maker-checker approvals) into one glanceable brief:
  - **A plain-sentence headline** with the numbers beside the words — bills, takings, margin
    (amount **and** %), average basket.
  - **The three things needing attention**, ranked — **risks outrank approvals**, urgent
    escalations outrank ordinary flags, and the biggest-value approval comes first.
  - **Grouped alerts** — six voided bills become **one line with a count**, not six alerts (no
    alert storm), while **every underlying transaction id is kept** so any number drills to its
    source (M29-FR-02).
  - **Freshness, always** — the brief carries `fresh` / `stale` / `missing`, and a stale feed is
    spelled out in the headline (*"These numbers are NOT live…"*). Nothing stale is shown as
    live (P-08 / §31).
  - **Deterministic** — pure code over committed facts, so the brief renders **with the AI
    narrative off** (spec acceptance) and is identical for every viewer.
- **`web/` — the shell (PWA).** Phone-first and framework-free: the headline, the three
  attention cards, a KPI grid and grouped alerts, with a persistent freshness dot; a service
  worker pre-caches the shell so **the brief opens with no signal**, showing the last-synced
  numbers clearly labelled as such. `app.js` is the view layer only — it holds **no** KPI maths,
  alert grouping or priority rules, and if the bundle is missing it says *"brief unavailable"*
  rather than inventing numbers.

## Build

```
pnpm build:owner            # bundle the tested model into web/owner-app.bundle.js
pnpm build:owner --watch    # rebuild on change while designing the screen
```

Verified on the built bundle with an 8-hour-old feed: the headline reads *"2 bills today,
₹413.00 taken, margin ₹100.00 (28.6%), average basket ₹206.50. These numbers are NOT live…"*,
and the three attention items come back ranked — urgent refunds (₹900.00 across 2 transactions),
then voided bills (6 transactions), then a ₹50,000.00 price-change approval.

## Status

Model complete and tested (9 tests). Remaining: wiring the phone to real last-synced data
(needs the cloud read API), the drill-through and approval-action screens, and the optional AI
narrative (A01, read-only) — the brief already works without it.

Tested in `tests/unit/owner-brief.test.ts`. Part of the repository layout in `CLAUDE.md`.
