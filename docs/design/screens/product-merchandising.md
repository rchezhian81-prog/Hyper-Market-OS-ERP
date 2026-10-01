# Screen spec — Product / Merchandising (Stage 3)

- **Surface:** Product/Merchandising (§27) · **Modules:** M03, M04, M05, D01, D02 · **Design bar:** a clean product master; a price or promotion change is deliberate, approved and traceable — never a silent overwrite.

> Built on `../design-system.md`.

## Screens & states (§27 Product/Merchandising row)
Product master · Barcode & pack hierarchy · Attributes/allergens · Assortment/range ·
Planogram/space · Price change · Promotion · Clearance/markdown · Completeness score.
All handle the §27.1 states.

## Product master (M03 / D01)
- Create/edit with GS1/GTIN/EAN/UPC and internal barcodes, alternate/embedded
  weight-price barcodes, unit-inner-case-pallet hierarchy and pack breaking,
  ingredients/allergens/nutrition/origin/storage, regulated-item flags and recall block.
- A **completeness score** (D01) shows what is missing before an item can sell online.

## Price & promotion (M05) — the control priority
- A price change is **draft → approved → effective-dated**; the maker **cannot approve
  their own change** (§28); the change is versioned, never an in-place overwrite.
- Promotions have clear rules, guardrails against stacking abuse, and a start/end;
  approved effective dates drive the shelf-edge price task on the manager surface.
- **Interaction budget (≤3):** edit a price (≤3: open → new price → submit for approval) ·
  start a promotion (≤3) · set a recall block on an item (≤2).

## Merchandising & space (M04 / D02)
- Assortment/range review, planogram and shelf-capacity, sales per sq ft, and
  supplier-funded display space.

## Offline / state (§31)
- Authoring is generally online; **approved** price/promotion changes propagate to the
  store edge so POS prices are correct offline. Nothing half-approved reaches a lane.

## Acceptance (QG-02)
- A price change cannot take effect without a separate approver.
- An item missing mandatory fields shows a low completeness score and cannot be published.
- A recall block set here stops sale at POS and on the customer app.

## Measured (SP-8c-ii — the shelf's two saves leave the page; the products nobody can sell, owner's directive of 1 October 2026)
On **Shelves and space**, a count typed at a facing is kept on this device before the screen says "Count saved — kept on this
device", listed under "Saved on this screen" with the five shared state words (saved on this device · trying again · with the
store computer · posted at head office · refused), carried by the store computer to head office once, and still listed after a
reload with nothing sent twice. Head office re-checks who counted from its own records and judges the shelf against the shelf
map it published, flagging rather than trusting the relay; a count it refuses comes back as a visible refusal with the reason.
The counting field still shows nothing about what the facing should hold. On **Refills**, once somebody has looked and a
shelf needs filling, one button — "Ask the back store for these" — turns the tasks into ONE indent for the back store (one
line per product, the catalogue's unit), kept on the same queue, approved by a different person on the Floor indents screen;
the same shelves asked once a day, so the button then says "Already asked today". With nobody named at the screen a count
is refused in words and nothing is saved; the gap is listed. The new **Products nobody can sell** page lists every product the
till refuses or was never given — recall first, then no tax rate, no status, a unit the till cannot price, not on sale —
each with what to do, in English and Tamil, from the same judgement the till's catalogue is built with, so the two can
never disagree. Measured in real Chromium against a stub store computer and on the REAL box
(`tests/e2e/merchandising-count-and-refill.e2e.ts`, `tests/e2e/unsellable-screen.e2e.ts`) and box → cloud on the real API
(`tests/integration/shelf-count.test.ts`). **Still recorded, not dropped:** physical-device verification and staff UAT
(SP-10) PENDING.
