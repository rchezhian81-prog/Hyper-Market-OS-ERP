# `packages/import/`

Template-driven import — **M30-FR-01/03/04**. This module carries the store's **#1 daily pain**
(audit **A-03**): the 80+ line supplier invoice that is typed by hand today.

## The pipeline: validate → preview → approve → commit

**Nothing changes until a human has seen exactly what would change.**

1. **Validate** — every row is checked against the template (mandatory fields, types, allowed
   values, referential integrity) and against the file itself (duplicate keys). A bad row is
   reported **with its line number and a plain reason** — never silently skipped or coerced.
2. **Preview** — the caller sees the counts, the errors and the duplicates **before** anything
   happens, plus a **reconciliation check** for financial imports.
3. **Approve** — a maker-checker approval by a **different person** than the uploader (§28).
4. **Commit** — **atomic**: every valid row is applied, or **none** is.

## What it refuses

- **A file that would corrupt silently.** `parseDelimited` is a proper RFC 4180 parser —
  quoted fields, escaped quotes, **commas and newlines inside values**, CRLF, BOM, TSV. A naive
  `split(',')` mangles real supplier files; this one **reports** a malformed file (wrong column
  count, unclosed quote) rather than shifting cells.
- **Bad data.** Missing mandatory field, non-numeric quantity or amount, a value outside the
  allowed list, an **orphan reference** (unknown supplier) — each with the exact line.
- **Duplicates.** The same key twice **in the file** is a blocking error that names the other
  line. A key that **already exists** is queued **for review, never auto-merged** (M03-FR-04).
- **An invoice that doesn't add up.** For a financial import, the declared control total must
  equal the sum of the lines, or the import is refused (M30-FR-03).
- **Any import that isn't properly approved.** No approval, an approval for a different job, or
  one **approved by the person who uploaded it** (§28) — all refused, and **nothing is applied**.
- **Partial application.** One bad row means the good rows are **not** applied either, so a
  half-imported invoice can never exist.

## Proven acceptance (audit A-03)

A generated **80-line supplier invoice** — with commas inside product names — parses, validates
and reconciles against its declared total **in one go**, with zero errors and `commitReady`.
Change the declared total by ₹1 and the import is refused.

Tested in `tests/unit/import.test.ts` (22 tests). Part of the repository layout in `CLAUDE.md`.
