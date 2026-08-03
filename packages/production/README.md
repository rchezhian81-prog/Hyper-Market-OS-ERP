# `packages/production/`

In-store production — **M11**. Built for the department this store actually operates:
**the cafe**, and nothing else (owner, 3 Aug 2026 — **OB-04**, closing **AVR-12**).

## Only the counters you have (`src/departments.ts`, M11-FR-04)

The roadmap's rule is blunt and worth keeping blunt: **do not build a module for a
department you do not have**. A meat-counter screen in a shop with no meat counter is not
harmless — it is a menu item staff learn to ignore, a form nobody fills in, a report with a
permanently empty section, and a compliance obligation the system believes applies and the
shop does not.

`requireDepartment` refuses anything not switched on, and says what the store *does*
operate. Other departments (bakery, deli, meat/fish, kitchen) exist in the catalogue only so
that **a different tenant** can enable one — this is a multi-tenant product (OB-01) and one
shop's answer is never hard-coded as everyone's. Adding a department later is a change
record, never a silent gap (OD-02).

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

Permission to release belongs to `packages/rbac`; this module enforces the *rules*, not who
may invoke them — the same split used throughout. Pure and deterministic: timestamps and
batch ids are injected, there is no clock. Tested in `tests/unit/production.test.ts`
(23 tests). Part of the repository layout in `CLAUDE.md`.
