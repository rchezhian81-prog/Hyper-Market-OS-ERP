# `packages/audit/`

Audit, risk and compliance evidence — **M34-FR-01/02 / NFR-15 / SEC-07 / hard rule #6**.
The tamper-evident memory of the system: the thing you reach for on the one evening it
matters.

- **`src/audit-trail.ts`** — `AuditTrail.record(entry)` seals a sensitive action:
  **who / what / when / where / before / after**, plus the reason, the approval that
  authorised it, and whether it was captured offline.
- **`src/retention.ts`** — `planRetention`, legal holds, and `buildEvidencePack`.

## Why it cannot be tampered with quietly

| Guarantee | How |
|---|---|
| **No user can edit the log** — not an admin, not the owner (M34-FR-01) | The API has no `update`, `delete`, `remove` or `clear`. The absence *is* the control, and a test asserts the absence. |
| **Tampering is detectable** (SEC-07) | Every record carries the hash of the one before it. Edit a record straight in the database and `verify()` names the exact sequence number where the chain breaks — and reports *every* break, not just the first. |
| **An action is reconstructable from evidence alone** (NFR-15) | `reconstruct(type, id)` replays the recorded before/after states — the answer to "how did this price get here?" never depends on a screen someone can change. |
| **Nothing unattributable is accepted** | A record with no actor, no action, no object, no timestamp, or no state change at all is refused — it would not stand up as evidence. |

The built-in hash is a pure-TypeScript FNV-1a (no dependency, works everywhere). It
catches corruption and casual editing; it is **not** a cryptographic seal, and the code
says so. A deployment injects a real SHA-256 through the `Hasher` port — the engine does
not change. Claiming more than we can back would be its own kind of failure (P-08).

## Retention vs. evidence — and why nothing here deletes

Privacy says do not keep personal data for ever (PRV-08). Evidence says never destroy
what an audit or a dispute may need (hard rule #6). Both are real, so:

**`planRetention` produces a plan, never a deletion.** It reports what is past its
period and *why every other record stays*. Deleting is then a separate, authorised,
audited act by a human. Three things are never even proposed:

- anything under a **legal hold** — a hold beats the retention date;
- anything in a **statutory** class (GST, company law);
- anything with **no policy** — silence means keep, never means discard.

A lifted hold is recorded as a new state; the original hold is never erased.

`buildEvidencePack` assembles a period for an auditor or inspector, names **who** took
it and **when**, carries the chain hash so the recipient can prove it matches the trail,
and states plainly whether the source verified at export time.

Pure and deterministic — no clock, no I/O; "now" is passed in. Storage-agnostic through
`AuditStore` (P-06), with an in-memory reference implementation. Tested in
`tests/unit/audit.test.ts` (19 tests). Part of the repository layout in `CLAUDE.md`.
