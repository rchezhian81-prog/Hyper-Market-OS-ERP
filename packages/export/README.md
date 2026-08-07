# `packages/export/`

Domain export — **M30-FR-02 / NFR-12 / OD-09**. The promise that **your data is yours**: there
is **no proprietary-only route to retrieve business data**.

- **`src/export.ts`** — `exportDomain(spec, rows, access, context)` emits the data as **CSV**
  plus a **machine-readable schema**, so a file is self-describing and any spreadsheet or other
  system can read it.

## Three controls that make an export safe rather than a leak

| Control | What happens |
|---|---|
| **Permission** | Default-deny through the same RBAC engine that guards the action itself — a user without the domain's export permission gets **nothing** (`AccessDeniedError`, P-04). |
| **Scope** | Rows outside the user's branch are **filtered out** — a branch manager cannot export another branch's data (§28). |
| **Classification** | A column marked `sensitive` (PII / payment) is **redacted** unless the user also holds `export.sensitive` (PRV). **Redacted, not dropped** — the column stays, so the file's shape never lies about what exists. |

Every export returns an **audit record** — who, what, when, how many rows, and **which columns
were redacted** — because exports are logged (M30-FR-02).

## Proven: no lock-in

The acid test in `tests/unit/export.test.ts` runs an export **back through our own importer**
(`packages/import`) and checks it round-trips losslessly — headers, rows, and a value containing
a comma all intact. That is NFR-12/OD-09 demonstrated rather than asserted.

An empty result exports as a **header-only file**, not an error, so downstream tooling always
receives a valid document.

Pure and deterministic — no clock, no I/O. Tested in `tests/unit/export.test.ts` (8 tests).
Part of the repository layout in `CLAUDE.md`.
