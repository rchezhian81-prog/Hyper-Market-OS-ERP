# `packages/config/`

Versioned configuration with rollback — **M01-FR-03**. Configuration changes far more often
than code, and an unversioned change is a common cause of outages. So every change is a
**new immutable version** with author, reason and effective date; **rollback restores a
prior version's value as a new version** (append-only, never destructive); full history is
retained.

- **`src/config.ts`** — `ConfigStore.set` (record the next version), `current` (latest),
  `history` (all versions, oldest first), and `rollback(key, toVersion, …)` (append a new
  version restoring an earlier value, tagged `rolledBackFrom`). Timestamps are injected so
  it stays deterministic. Tested in `tests/unit/config.test.ts`.

> High-impact flags (payments, pricing, offline limits) additionally require approval — see
> `packages/approvals`. Part of the repository layout in `CLAUDE.md`.
