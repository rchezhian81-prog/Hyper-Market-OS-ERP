# `packages/production/`

In-store production — **M11**. **Every** department the roadmap names is built — cafe,
bakery, deli, meat/fish, central kitchen — and each tenant **enables** the ones it operates.
SRE Hyper Market enables the cafe (**OB-04**, closing **AVR-12**); that configures SRE, it
does not trim the product (**OB-05**).

## Built for everyone, shown to no one who does not need it (`src/departments.ts`, M11-FR-04)

The roadmap's rule — *do not build a module for a department you do not have* — governs
**what a tenant is shown**, not **what the product contains**. Both halves matter:

- A meat-counter screen in a shop with no meat counter is not harmless. It is a menu item
  staff learn to ignore, a form nobody fills in, a report with a permanently empty section,
  and a compliance obligation (cold chain, metrology) the system believes applies and the
  shop does not. So `requireDepartment` refuses anything not switched on, and says what the
  store *does* operate.
- But a tenant that runs a butcher's counter must not be told to wait for a release. So the
  **weighed path is fully built** — catch-weight costing, yield against a standard, scale
  labels with an embedded weight or price barcode — even though SRE runs none of it.

## A production run is exactly two things (`src/recipe.ts`, M11-FR-01/02)

```
inputs consumed (stock out)  →  a finished batch created (stock in)
```

Both are movements on the **same ledger** the till and the goods-in door use, which is what
keeps one stock truth (P-02) instead of a production spreadsheet that disagrees with the
shelf. Otherwise the system believes you still have twelve litres of milk that were drunk as
coffee this morning.

| Rule | Why |
|---|---|
| **You cannot issue more than you have** | Every ingredient is checked *before* anything is consumed, so a half-finished run can never leave the shelf and the system disagreeing. |
| **The output lands in quarantine, not on the shelf** | Freshly made food is not sellable until released. Because `packages/stock` treats quarantine as never-sellable, the stock model enforces this rather than anyone remembering. |
| **Cost follows the food that survived** | Trim, spillage and evaporation are carried by the output, not quietly written off — the only way a cafe's real margin is visible. Lose 6 cups of 40 and the cup cost moves ₹21.50 → ₹25.29. |
| **Yield drift is a valued exception** | Beyond the recipe's tolerance it is raised with the money attached, high *or* low: too many cups means the recipe or the portioning is wrong, which costs just as much. |
| **Inputs in, nothing out** | Always an exception. Someone explains it. |

## Two gates before it can be sold (`src/packing.ts`, M11-FR-03)

1. **The label must be complete** — refused before it prints if it lacks a use-by date, the
   net quantity or the packer's details (§9.3), or an **allergen declaration** where the
   department makes food. As in the product master, an **empty list means "declared: none"**
   and passes; saying nothing does not. What is mandatory follows the *department*: a cafe
   needs allergens and net quantity, only a weighed counter needs a weight.
2. **The stock must be released** — `releaseForSale` moves the batch out of quarantine, and
   refuses a failed check, an unnamed releaser ("it was checked" is not evidence), or an
   **expired batch**: you cannot release your way past a use-by date.

**Repacking** inherits the source batch's expiry — a fresh wrapper does not make food
younger — and records where it came from, so a recall on the source reaches everything made
out of it (M10-FR-03). Repacking an already-expired batch is refused outright.

## Weighed counters: the bin was paid for too (`src/catch-weight.ts`, M11-FR-02)

A butcher does not make "40 cups". They take in 12.4 kg, throw away bone, skin and trim, and
put out 8.9 kg. Every part of that is money, and the important number is invisible without
recording both weights:

> ₹600/kg of carcass becomes **₹835.96/kg** of curry cut. Price the shelf off the input
> figure and the counter loses money on every kilo it sells.

Cost lands only on what can be sold — loading it onto bone would understate the meat — and a
carcass can be split between prime and secondary cuts **by value**, with the remainder
distributed so the parts sum to the whole, not "about" the whole (§29.1). Yield is measured
against the department's own standard: too low means a poor delivery, a heavy hand, or stock
leaving another way; **too high** means the standard or the scale is wrong, which costs just
as much. More coming out than went in is flagged as what it is — not physics. All weights
are exact integer grams.

## The sticker and the till agree by construction (`src/scale-label.ts`, M11-FR-03)

The counter prints a label; the till scans it four minutes later. If the two disagree about
where the weight sits in the barcode, the customer is charged for the wrong thing and nobody
finds out until the count is wrong at month end.

So labels are generated from the **same per-tenant `EmbeddedBarcodeRule` the catalogue
parses with** — one definition, both directions. The acceptance test prints a label and then
**scans it through the real `CatalogueCache`**, in both weight-embedded and price-embedded
form, rather than asserting the format twice. The EAN-13 check digit is computed (verified
against a published barcode), and a value that will not fit the format is **refused rather
than truncated** — truncating charges the wrong amount.

Permission to release belongs to `packages/rbac`; this module enforces the *rules*, not who
may invoke them — the same split used throughout. Pure and deterministic: timestamps and
batch ids are injected, there is no clock. Tested in `tests/unit/production.test.ts` (23)
and `tests/unit/production-weighed.test.ts` (15). Part of the repository layout in
`CLAUDE.md`.
