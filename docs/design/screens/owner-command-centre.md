# Screen spec — Owner command centre (Stage 3)

- **Surface:** Owner (§27) · **Modules:** M29, D13, A01 (read-only) · **Design bar:** control by exception (P-03); glanceable on a phone; honest about freshness.

> Built on `../design-system.md`. The owner's job is to decide, check and approve —
> the screens surface risks and approvals, not raw noise.

## Screens & states (§27 Owner row)
Executive brief · Sales/margin/cash/stock · Branch comparison · Exceptions ·
Approvals · Audit · AI query · Data freshness / system health. Each handles the
§27.1 universal states.

## Executive brief (home)
- **Layout:** the daily brief in plain sentences with the numbers beside the words; the **three things needing attention** dominant; a persistent **data-freshness indicator** per branch/domain.
- **Primary action:** open the item that needs a decision (or the approval inbox).
- **Interaction budget (≤3):** open brief (1) · drill a KPI to its detail (≤3) · approve a pending item (≤3: open → review → approve) · switch branch (≤2).
- **AI narrative (A01, read-only):** plain-language explanation with **evidence and confidence shown** (AI-NFR-04); if AI/model/internet is down, the deterministic numbers still show.

## Exceptions & alerts
- Large discount, voided bill, price override, after-hours login, cash short (M15/M29-FR-03) — each links straight to the underlying transaction.
- Alerts are grouped to avoid a storm; each has a clear next action.

## Approvals inbox
- One-tap approve/reject with reason; shows request, value, requester; a pending item invalidated by a change is flagged (§31.1).

## Offline / freshness (§31)
- Owner dashboard shows **last-synced data only**, with prominent per-branch/domain freshness — nothing stale shown as live (P-08).

## Accessibility & language
Phone-first, large numbers, high contrast; English/Tamil toggle.

## Acceptance (QG-02)
- The daily brief is readable in seconds and states the three priorities.
- Any KPI drills to its source in ≤3 taps.
- A real exception (e.g. a void) reaches the owner and links to the transaction.
- Freshness is always visible; the brief still works with AI off.
