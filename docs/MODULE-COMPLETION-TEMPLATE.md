# Module Completion Template (mandatory)

Adopted 7 August 2026 (recovery Phase 2). Copy this checklist into every module-assembly PR. A module
may be moved up the completion ladder (`docs/traceability.md`) **only** to the highest rung whose
every box below is ticked with evidence. "Engine implemented and unit-tested" is `ENGINE ONLY`, never
"complete."

## Module: `M__` — <name>   ·   Target status this PR: `<WIRED | INTEGRATION TESTED | E2E VERIFIED | …>`

### 1. The connected chain (all must be true for `WIRED` or higher)
- [ ] **Requirement** — every `M__-FR-__` (and linked `D__`/`WF`/`API`) this PR closes is named.
- [ ] **Domain engine** — the ONE authoritative `packages/…` engine is used (no second copy in the service).
- [ ] **Application/service** — a `services/…` route or `apps/…`/`edge/…` surface calls that engine.
- [ ] **API / event contract** — request/response and any emitted event conform to a declared contract.
- [ ] **Persistence** — state is written to the append-only ledger / durable store, tenant-scoped.
- [ ] **Authorization** — every route declares a permission; least-privilege + SoD enforced (real RBAC).
- [ ] **UI / channel** — where the roadmap requires a screen, it exists and is wired to the surface.

### 2. Every increment carries (non-negotiable)
- [ ] Authorization checked on each route (default-deny).
- [ ] Tenant isolation (data and authority scoped to the signed tenant).
- [ ] Idempotency on writes (safe retry).
- [ ] Persistence via append-only events; corrections are compensating events (hard rule #2).
- [ ] Audit trail: writes and refusals recorded (hard rule #6).
- [ ] Offline/sync behaviour where roadmap §31 requires it.
- [ ] API/event contracts declared and contract-tested.
- [ ] UI states: loading, empty, error/refusal, offline, queued, conflict, stale, recovery.
- [ ] English **and** Tamil coverage for any user-facing text.

### 3. Tests & evidence (the rung is only as high as its proof)
- [ ] **Unit** — domain rules and error paths (`ENGINE ONLY` needs this).
- [ ] **Integration** — the service against a real store (`INTEGRATION TESTED` needs this; DB-gated in CI).
- [ ] **E2E** — through the shared harness (`tests/support/api-harness`), authenticated + authorized,
      app→API→authorization→persistence (`E2E VERIFIED` needs this). Use `tests/support/local-idp` to
      mint tokens; never mint in production.
- [ ] **Negative** — unauthorized (403), unauthenticated (401), cross-tenant (403), invalid input (422).
- [ ] **Operational evidence** — for gate-bearing modules, a `docs/evidence/…` record stating a verdict.

### 4. Records
- [ ] `docs/traceability.md` — the module's ladder row moved, with the new status and the evidence.
- [ ] `docs/STATUS.md` — the PROJECT RECOVERY section updated (what is now wired and working).
- [ ] Owner-only blockers, if any, added to `docs/OWNER-ACTION-REGISTER.md` (status `EXTERNALLY BLOCKED`).
- [ ] Plain-English summary for the owner (what they can now do in the store, and how to check it).

### Rung meanings (from `docs/traceability.md`)
`NOT STARTED` → `ENGINE ONLY` → `PARTIALLY WIRED` → `WIRED` → `INTEGRATION TESTED` → `E2E VERIFIED` →
`UAT VERIFIED` → `PRODUCTION VERIFIED`. `EXTERNALLY BLOCKED` marks a rung that cannot advance until an
owner/vendor action (see the Owner Action Register) clears — never reported as completion.
