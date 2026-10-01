# Screen spec — Inventory / Warehouse handheld (Stage 3)

- **Surface:** Inventory/Warehouse (§27) · **Modules:** M08, M09, M10, D05 · **Design bar:** rugged handheld use; blind counts; every move is a scan; works offline.

> Built on `../design-system.md`. Runs on a **rugged low-spec Android handheld**
> (§33) — large targets, glove-friendly, offline-first.

## Screens & states (§27 Inventory/Warehouse row)
Availability · Ledger · Bins · Put-away · Pick/pack · Transfer · Count ·
Adjustment · Expiry · Quarantine · Recall · Wastage. All handle §27.1 states.

## Core handheld flows
- **Put-away / move / pick:** scan item → scan bin → confirm; each is one appended ledger movement (M08-FR-01); bin capacity respected.
- **Interaction budget (≤3):** put away a line (≤3) · pick a line (≤3) · start a count (≤2) · record an adjustment with reason (≤3) · delivery complete (≤1, SP-6b).

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
handhelds on the same socket — connected in SP-3c-i (picker) and SP-3c-ii (driver); TLS on the shop-network leg (a staff-only wifi meanwhile) — Stage E;
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
(SP-4); pending requests reach the manager's screen only with the pack (SP-9); the picker and driver handhelds connected (SP-3c-i, SP-3c-ii);
TLS on the shop-network leg — Stage E; physical-device verification and staff UAT — PENDING.

## Measured (SP-5 / SP-5b — one stock truth for transfers and counts, owner's Option 2 directive of 30 September 2026)
Nothing on the handheld or the ERP screens changed shape in this slice; what changed is what the figures on them MEAN.
Until now a received transfer left availability and valuation at the source with no destination row, and an approved
count corrected only the counts view — every stock figure a screen showed (stock health, valuation, ageing, the next
blind count's expected number, the pack's `availableMinor`) was wrong by every transfer and every count. Now
(`tests/audit-observations/warehouse.test.ts` cases 1 and 3, `tests/integration/warehouse-transfers.test.ts`,
`tests/integration/warehouse-counts.test.ts`, `tests/integration/bin-counts-synced-route.test.ts`):
**a transfer** takes the stock off the source's on-hand at DISPATCH (it is on the van — the availability read lists it
under `inTransit` at the destination, where it is visible and deliberately not sellable), puts what ARRIVED on-hand at
the destination at receipt with the value that left the source (head office's own average there, never the proposer's
figure), and lists what did not arrive on the exceptions read with its value until a person owns it; a second transfer
cannot draw stock the first already took; a transfer to a place head office has no record of is refused by name.
**A count correction** — the handheld's bin count or the manager's store count, immaterial at once or material once a
separate person approves it — is ONE movement on the same ledger as a sale, entered by the counter and approved by the
decider (or, under the tenant's own threshold, by nobody, and the movement says so). A bin count corrects the bin's
occupancy AND the store's on-hand: one count, one correction, every reader. Nothing is layered twice; corrections
recorded before this slice, which posted no movement, still layer exactly as they did.
**Still recorded, not dropped:** no screen drives dispatch / receive — the floor-indent chain (SP-8) will; the counts
review screen and the stock-health screen do not yet show posted corrections or in-transit stock (SP-9); the picker and
driver handhelds connected (SP-3c-i, SP-3c-ii); TLS on the shop-network leg — Stage E; physical-device verification and staff UAT — PENDING.

## Measured (SP-6b — the delivery is one receipt, owner's Option 2 directive of 30 September 2026)
Since SP-3a the handheld's receiving scans reached head office one by one — each a `received` movement and a row on the
delivery's scan register — and stopped there: the delivery was a pile of scans, not a goods receipt, and nothing folded
into the purchase order. Now the footer carries **"Delivery complete — send the receipt"** (`#done-receiving`, EN/TA),
shown only once something has been received on this handheld for the delivery and gone once it has been sent (the
durable queue remembers across a reload). One tap queues ONE `ReceivingCompleted`, keyed on the GRN id, BEHIND the scans
on the same device queue → box → sync path; it carries no quantity — the scans are the truth, this only says they are all
in — and names the order the pack gave the handheld (`warehouse.poId`). It is listed under "Sent from this handheld" as
its own kind ("Receipt sent") with the same five state words. Head office assembles ONE receipt from the scans it already
holds, against the issued order, posts no stock twice, and folds it into the order — the rest is `docs/STATUS.md` SP-6b.
Refusals on the handheld: nothing received here yet (`nothing_received`), already sent (`duplicate_ignored`, a warning).
Measured in real Chromium on the real box (`tests/e2e/warehouse-handheld-syncs-through-the-box.e2e.ts`): receive → the
button appears → one tap → *with the store computer* within a moment → the button is gone → reload → still listed, still
gone; the box's log holds the completion behind the scan with no quantity on it. Head office delivery is proven on the
real box against the real kernel (`tests/integration/warehouse-handheld-reaches-the-cloud-through-the-edge.test.ts`).
**Still recorded, not dropped:** the review screen does not yet show an assembled receipt's scans or a late scan (SP-9);
physical-device verification PENDING.

## Measured (SP-8 — the floor's ask for stock is one record from the shelf to the shelf, owner's Option 2 directive of 30 September 2026)
No screen changed in this slice; what changed is that the chain the owner named now EXISTS at head office, as one record
per ask (audit finding F08). Until now a refill task was a calculation nobody kept, a transfer knew nothing of who asked,
and the merchandising screen's count save only changed the page. Now the floor RAISES an indent for products from the back
store to the shelf; a DIFFERENT person approves it, allocating against what the back store actually holds — a short back
store is said, not hidden; the back store ISSUES it as a transfer the ledger already understands, so stock leaves the back
store exactly once and sits on the trolley at the floor, visible and not sellable, and the same person can never ask and
issue to themselves; a THIRD person counts it in at the floor and it becomes shelf availability the till sells from — what
did not arrive is a valued exception with an owner, and a wrong item is not received against the issue; the unissued
remainder can be cancelled (the trolley must still be received); and stock sent back is accepted at the back store by a
second person. Requested, issued, received and outstanding are four figures, per line, never one. Proven on the real API
with real roles (`tests/integration/floor-indents.test.ts`) and in the pure engine (`tests/unit/floor-indents-engine.test.ts`).
**Still recorded, not dropped (SP-8b):** the floor screen, the handheld issue against the indent, the manager's
pending-indents / in-transit register on a screen, the refill task that raises an indent, the shelf-count save that reaches
the cloud; physical-device verification and UAT PENDING.

## Measured (SP-8b — the floor's screen for its ask, owner's Option 2 directive of 30 September 2026)
The floor side of the chain now has a screen the store computer serves (`/indents`, Inventory group), for the floor person,
the manager and the counter alike. It shows the register as head office keeps it — the asks awaiting a person first, then
what is on the trolley or still owed, closed ones last; seven figures a line (asked · allocated · issued · on the trolley ·
on the shelf · short · still owed) — and it does three things: RAISE an indent (product from the box's own catalogue, a
whole-number quantity, an optional reason), COUNT IN an issue that somebody else sent (only what was seen; the issuer is
never offered their own issue and is refused if they try), and APPROVE somebody else's ask with a reason (the requester is
never offered their own and is refused before anything is sent). The ask and the count go to the SAME durable device queue
as the manager's decisions before the screen says "saved", so they survive a reload and a dead store computer, reach head
office once (a lost reply settles to one record), and are shown with the five shared state words — "posted" only when the
store computer says so; a refusal comes back with head office's reason. Head office re-checks who asked or counted from
its own records and flags a breach rather than trusting the relay. Measured in real Chromium on the REAL box
(`tests/e2e/indents-delivery.e2e.ts`) and box → cloud on the real API (`tests/integration/floor-indents-synced.test.ts`).
**Still recorded, not dropped (SP-8c):** the back-store ISSUE on this handheld against the indent (scan bin → scan item →
confirm), the register on the handheld, the refill task that raises an indent, the shelf-count save that reaches the cloud,
the "products nobody can sell" screen; physical-device verification and UAT PENDING.

## Measured (SP-8c-i — the back store issues against the indent on this handheld, owner's directive of 1 October 2026)
This handheld now shows **To issue to the floor**: every floor indent head office has approved that this back store still
owes — the indent, the item, who asked, what is still owed, and the bins here that hold it (the row's biggest words, because
the bin is where the worker walks). The list is head office's own register, pulled by the store computer under its own
login and kept on its disk, so it is there with the cable out and a closed indent drops off it. The worker taps the line,
scans the bin they take from (any bin holding the item — the floor does not know the racking), scans the item and confirms
the quantity (what is still owed, capped at what the bin holds): three steps after the tap. The handheld refuses, before
anything is confirmed, a bin holding none of that item, an unknown bin, the wrong item, a line already issued, a draw the
bin cannot cover — and the person who raised the indent, who may never issue it to themselves. An accepted issue lowers
this handheld's own bin figure, is listed under "Sent from this handheld" with the five shared state words, and reaches head
office through the store computer as ONE fact; head office dispatches the transfer once, lowers the same bin in the same
write, and says so if its bin disagrees rather than forcing it. On the floor's count-in, units that arrived DAMAGED are
counted separately: off the trolley, never on the shelf, written off at the price they left with, and shown on the indent.
Measured in real Chromium on the REAL box (`tests/e2e/warehouse-handheld-issues-to-floor.e2e.ts`; the interaction budget
and WCAG audit in `tests/e2e/the-handhelds-meet-the-spec.e2e.ts`) and box → cloud on the real API and on real PostgreSQL
(`tests/integration/floor-indents-handheld-issue.test.ts`), where the back store, the floor, the trolley and the write-off
add up to what was ever received — in units and in rupees — at every step.
**Closed at SP-8c-ii (1 October 2026):** the refill task that raises an indent and the shelf-count save that reaches the
cloud (both on the merchandising screen — see `product-merchandising.md`, Measured SP-8c-ii), and the "products nobody can
sell" screen. **Still recorded, not dropped:** physical-device verification and staff UAT (SP-10) PENDING.
