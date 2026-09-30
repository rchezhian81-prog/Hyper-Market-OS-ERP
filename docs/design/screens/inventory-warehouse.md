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

## Measured (Stage G slice 4)
Counted in a real browser at a handheld's size (`tests/e2e/the-handhelds-meet-the-spec.e2e.ts`): put away a line **3**
(tap the item → Put away → scan the bin). **Not yet on the handheld, recorded rather than dropped:** pick a line ·
start a count · record an adjustment with reason — the blind count is reconciled on the ERP `counts` review screen
over `packages/counts` and the adjustment through the M08-FR-03 approval path; a replenishment pick has no handheld
surface. Giving the handheld those flows is M09 functional scope and awaits the owner's written call (docs/STATUS.md).

## Measured (W1 — pick a line, owner's written call of 30 Sep 2026)
Pick a line **3**: scan the bin → scan the item → confirm. The pick list (`warehouse.pickLines` in the store pack:
line, order reference, product, batch, **the bin the stock is in**, quantity, unit) is the top section of the handheld,
the bin the biggest thing on each row because the bin is where the worker walks to. **A bin label scanned from the list
is step 1** — it chooses the line that names that bin, exactly as on the picker handheld — then the item is scanned, then
the model's remaining quantity is confirmed with one tap (no typed number: a short pick is the supervisor's call on the
ERP, never a figure adjusted up a ladder). Tapping a line and pressing *Pick — scan the bin* is the same flow at 4.
The tested session (`WarehouseSession.checkPick` / `pick`) refuses the **wrong bin at the racking** and the **wrong
item at the shelf**, before the confirm step; the movement itself is the authoritative `applyMovement` kind `pick`
(out of the named bin, to nowhere), so an unknown bin, a draw the bin cannot cover (no negative bins) and a repeated
command are the engine's refusals. One `WarehouseMovementApplied` per pick, keyed `wh-move:<commandId>` for the cloud's
idempotent movement ledger (`POST /v1/warehouse/movements/:commandId`, `inventory.movement.append`); a refusal queues
nothing. Words in both languages for every outcome (`picked` · `wrong_bin` · `wrong_item` · `not_on_pick_list` ·
`line_done`), bound by the bilingual guardrail. Audited in real Chromium: the pick list, the item panel, the confirm
step, the green banner, and the list in Tamil — zero findings. **Still recorded, not dropped:** start a count (W2) ·
record an adjustment with reason (W3) · the device's queue drains to nothing yet (S1) · physical-device verification
PENDING.

## Measured (SP-3a — the handheld reaches the store computer, owner's Option 2 directive of 30 September 2026)
The handheld's queue drained to nothing (S1, audit finding F11): its shell was served on the box's loopback address and
its write base was the box's loopback lane, so no phone in the shop could load it or hand anything over. Now the box
opens a separate **device socket** for the handhelds (ADR-0019, `EDGE_DEVICE_PORT` / `EDGE_DEVICE_HOST`): it serves only
the handheld screens and the three device routes, and nothing at all to a device that has not **enrolled** — once, on an
enrolment page, with the one-time code head office issued for that registered handheld. The box keeps only hashes; a
handheld head office blocks is refused at its next request. After enrolment the shell opens as the named worker with
the served assignment, and every accepted scan — a receipt, a put-away, a pick — is queued on the device, handed to the
store computer after the scan and every ten seconds, and listed under **"Sent from this handheld"** with one of the five
shared state words (saved on this handheld · trying again · with the store computer · posted at head office · refused,
with the reason), in English and Tamil; the badge's first line counts them by state. At head office the put-away and the
pick re-run the same bin engine over head office's bins with the worker re-verified; a receiving scan becomes one
`received` movement at the store and is kept on the delivery's scan register. Measured in a real browser at a handheld's
size against a real box (`tests/e2e/warehouse-handheld-syncs-through-the-box.e2e.ts`): no credential → the enrolment
page, the wrong code → refused with a reason and no shell, the right code → the shell; receive + put away → *with the
store computer* within a moment, both records on the box's fsync'd log; reload → both still listed. Head office delivery
is proven on the real box against the real kernel (`tests/integration/warehouse-handheld-reaches-the-cloud-through-the-edge.test.ts`).
**Still recorded, not dropped:** start a count (W2) · record an adjustment with reason (W3) — SP-3b; the picker and driver
handhelds on the same socket — SP-3c; TLS on the shop-network leg (a staff-only wifi meanwhile) — Stage E;
physical-device verification PENDING.

## Measured (SP-3b — start a count · record an adjustment with reason, owner's Option 2 directive of 30 September 2026)
The two remaining handheld flows in the interaction table now exist, on the same device socket and the same durable
queue as the rest (`tests/e2e/the-handhelds-meet-the-spec.e2e.ts`, real Chromium at a handheld's size):
**start a count — 2** (tap *Count a bin* → scan the bin); then each item is scan → keypad → OK, and *Done counting*
ends the bin. The count is BLIND by construction: the sheet says *"Enter what you see. The expected number is never
shown here."*, the shell has no expected figure to show (the assignment's bin projection is never rendered on the count
sheet — asserted against the served 40 of p-rice in BIN-A), the queued `StockCounted` carries only the counted figure
with the bin, and the handheld's own bin figure does not move. Head office compares it against ITS bin contents and
holds a material or unvalued variance for a separate person (`tests/integration/bin-counts-synced-route.test.ts`).
**record an adjustment with reason — 3** (tap *Adjust stock* → scan the item → tap the reason; the quantity defaults to
one and *missing / damaged*, both changeable on the sheet). It is a REQUEST: the banner says it waits for a supervisor,
the sent list says *Recorded at head office — waiting for a supervisor to approve it* once the box has posted it, and
nothing moves on the handheld or at head office until a supervisor who is not the raiser approves it — then one
compensating movement posts (`tests/integration/adjustment-requests.test.ts`,
`tests/integration/warehouse-handheld-reaches-the-cloud-through-the-edge.test.ts` case 6). Reasons: damaged · expired ·
miscount · found · theft suspected · other, in English and Tamil, guardrail-bound.
**Still recorded, not dropped:** the manager's own relayed approval decision does not yet post a held count or request
(SP-4); pending requests reach the manager's screen only with the pack (SP-9); the picker and driver handhelds — SP-3c;
TLS on the shop-network leg — Stage E; physical-device verification and staff UAT — PENDING.

