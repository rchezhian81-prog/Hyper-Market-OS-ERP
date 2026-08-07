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
