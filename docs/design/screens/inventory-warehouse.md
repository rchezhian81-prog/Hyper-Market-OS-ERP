# Screen spec — Inventory / Warehouse handheld (Stage 3)

- **Surface:** Inventory/Warehouse (§27) · **Modules:** M08, M09, M10, D05 · **Design bar:** rugged handheld use; blind counts; every move is a scan; works offline.

> Built on `../design-system.md`. Runs on a **rugged low-spec Android handheld**
> (§33) — large targets, glove-friendly, offline-first.

## Screens & states (§27 Inventory/Warehouse row)
Availability · Ledger · Bins · Put-away · Pick/pack · Transfer · Count ·
Adjustment · Expiry · Quarantine · Recall · Wastage. All handle §27.1 states.

## Core handheld flows
- **Put-away / move / pick:** scan item → scan bin → confirm; each is one appended ledger movement (M08-FR-01); bin capacity respected.
- **Interaction budget (≤3):** put away a line (≤3) · pick a line (≤3) · start a count (≤2) · record an adjustment with reason (≤3).

## Blind count (M09-FR-04)
- Counter **cannot see the expected quantity**; enter counted qty → recount variances → variance goes to reason-coded, approved adjustment (M08-FR-03). Counter ≠ sole approver (§28).

## Expiry / quarantine / recall
- **Expiry action list** first (M10-FR-01) — near-expiry items to act on; quarantine excludes stock from availability; a **recall block** stops sale/order and is honoured offline.

## Availability & ledger
- Availability = on-hand − reserved − quarantine − damaged − expired (M08-FR-02); reserved online stock isn't sellable to a walk-in (no oversell).

## Offline / state (§31)
- All movements/counts are **queue-capable offline**; each is a globally unique command; conflicts surface as exceptions on sync, never last-write-wins.

## Acceptance (QG-02)
- Every stock move is a scan and completes offline, appending exactly one ledger event on sync.
- The counter can't see the expected number; a variance produces a valued, approved adjustment.
- The expiry list matches the shelf; a recalled/quarantined item can't be picked or sold.
