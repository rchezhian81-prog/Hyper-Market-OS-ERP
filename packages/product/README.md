# `packages/product/`

The product master — **M03**. The single trusted product truth every channel shares
(P-02). This is the write side; `packages/catalogue` is the read side the till holds
offline.

A wrong product record does not stay wrong in one place. It multiplies into every sale,
every order, every report and every tax return, and it is found months later at
stock-take. So this package is built to be **hard to publish something wrong through**.

## An incomplete product is a draft, not an error

You can always save what you know. `validateProduct` returns **what is still missing, in
plain English**, and `publishProduct` refuses until it is there — naming every reason at
once, not one per attempt.

**Never publishable** (`src/product.ts`, M03-FR-01/03):

| Missing | Why it blocks |
|---|---|
| Category | Nothing to report, replenish or analyse it under. |
| HSN / tax class | The bill would charge the wrong tax. |
| Allergens on a food item | An **empty list is a declaration of "none"**; `undefined` means nobody has said. Silence is not a declaration. |
| Country of origin on a food item | Required by law. |
| Net quantity / packer details on packed or weighed goods | Legal Metrology label fields (§9.3). |
| Minimum age on an age-restricted item | The till must know when to ask for proof. |
| A category attribute of the wrong type or outside its allowed values | The attribute schema belongs to the **tenant's own department**, not to us. |

**Never sellable**, published or not: a **recall-blocked** item (which also blocks
purchasing), a discontinued item, and an unpublished draft — the same answer online,
offline and in every channel (§31). MRP is **effective-dated**: `mrpOn(product, date)`
answers what was in force then, so last month's bill can still be explained.

## A case of 24 must become exactly 24 (`src/pack.ts`, M03-FR-02)

If the pack conversion is ever approximate, the stock figure is wrong from the first
delivery and every count afterwards inherits the error. Conversions are **exact integers
and reversible** — a pack that could never be exact is refused at definition time rather
than corrupting stock at receiving time. Converting down returns **whole packs and a
remainder**, because half a case is not something you can shelve or return.

And the rule the whole till depends on: **a barcode maps to exactly one sellable item**.
`BarcodeRegistry` refuses the second claim and names the product that already owns the
code. Re-registering the same code to the *same* product is a harmless no-op, so an
import can be re-run.

## Duplicates are reviewed, never auto-merged (`src/duplicates.ts`, M03-FR-04)

The same item entered twice — "Aashirvaad Atta 5kg" and "AASHIRVAAD ATTA 5 KG" — splits
the stock across two records, neither of them right. Detection produces a **review list
with the evidence for each pair**, graded:

- **near-certain** — a shared barcode. One code means one item, so either they are the
  same thing or one of them is wrong.
- **likely / possible** — same name and brand, graded down when the pack size differs
  (probably a genuine variant).

Automatic merging is worse than the duplicate: a wrong merge destroys the history and
leaves nothing to compare against. So a merge needs a **second person's approval** (§28)
and is recorded as a **reversible link**, never a deletion. `resolveProductId` follows
the links to the surviving record — and stops following once a merge is reversed.

Pure and deterministic — no clock, no I/O. Tested in `tests/unit/product-master.test.ts`
(19), `tests/unit/product-pack.test.ts` (9) and `tests/unit/product-duplicates.test.ts`
(13). Part of the repository layout in `CLAUDE.md`.

## Category policy — the rules per category, as effective-dated configuration (`src/category-policy.ts`)

A hypermarket is not one shop. Milk, a ring of gold, a strip of paracetamol and a phone
obey different rules for how each unit is traced, how it is valued, whether it may be sold
at all, how it is returned, and who must approve a price. Those rules are **dated
configuration the owner can change, not code**: every category carries a `CategoryPolicy`
— a dated history of `CategoryPolicyRules` — and `resolvePolicy(history, onDate)` returns
the rules in force on a date (the same filter/sort/last shape as `mrpOn`, so a decision
made last month can still be explained; nothing is overwritten).

`CategoryPolicyRules` covers **traceability** (none / batch / serial), **quantityMode**
(each / weighed / catch-weight), **valuation** (retail MRP / rate-per-unit-weight /
weighted-average cost / cost-plus), **shelf life** (perishable, block-sale-after-use-by,
near-expiry alert days), **returns** (returnable, window, approval), **controlled sale**
(hard block, minimum age, and required controls — age / KYC / PAN / prescription / serial
capture), **approvals**, and **enabledByDefault** — a controlled vertical (gold,
pharmacy-lite) ships **off** and will not sell until the store switches it on.

The decisions are pure. `categorySaleDecision` names every refusal at once and **composes
with** the till's age gate (`packages/restricted-sales`) rather than duplicating it — a
blocked category short-circuits, a not-yet-enabled vertical is refused by name, an expired
unit is refused only where the category says so. `categoryReturnDecision`, `needsApproval`
and `describePolicy` (a plain-English one-liner for the owner) round it out. Wired
read-only for preview at `POST /v1/catalogue/category-policy/resolve`. Tested in
`tests/unit/product-category-policy.test.ts` (14) and
`tests/integration/catalogue-category-policy.test.ts` (4). Foundation for the per-category
presets (grocery, fresh produce, gold, pharmacy-lite, cosmetics, electronics, apparel).

### Category presets — a correct starting point per aisle (`src/category-presets.ts`)

Each of the owner's categories A–G ships a **default** `CategoryPolicyRules` — grocery/FMCG,
fresh produce, packaged perishables, gold/jewellery, OTC pharmacy-lite, prescription-blocked,
cosmetics, electronics, apparel/footwear. A preset is a starting point the store dates and
overrides (`presetFor(kind)` returns a fresh copy; `presetPolicy(categoryId, kind, effectiveFrom)`
wraps it in an effective-dated `CategoryPolicy`), **never a hard-coded law**. The two controlled
verticals — **gold** and **OTC pharmacy-lite** — ship `enabledByDefault: false` (off until the
owner switches them on with CA/legal sign-off), and **prescription / Schedule-H·H1·X** items are a
`controlledSale.blocked` preset so they are refused outright until a separately-approved
regulated-pharmacy extension replaces it. The preview route accepts `kind` as an alternative to a
full `history`. Tested in `tests/unit/product-category-presets.test.ts` (11).
