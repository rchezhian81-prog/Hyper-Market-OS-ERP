# `packages/approvals/`

The maker-checker approval engine — **§28 separation of duties** and **M02** (maker-checker,
value-limit routing, escalation). The core invariant: **the maker can never decide their
own request** (also the spirit of hard rule #5 — a critical action needs an authorised
human, not the requester).

- **`src/approvals.ts`** — `requestApproval` (build a pending request) and `decide`
  (validate and produce a terminal, immutable decision). `decide` enforces, in order:
  separation of duties, a mandatory reason (audit), branch scope, and — for an approval —
  the approver's value authority (M02-FR-03). Business rejections come back as a typed
  `RefusalReason` (`self_approval_forbidden` / `reason_required` / `out_of_scope` /
  `exceeds_authority`); rejecting needs scope but not spending authority. Tested in
  `tests/unit/approvals.test.ts`.

> Used by pricing (M05), purchasing (M06/M07), refunds (M13), inventory adjustments
> (M08-FR-03) and privilege changes (M01/M02). The AI-agent-DB-write and shared-login
> guardrails cover related hard rules; this engine covers the human approval path. Part of
> the repository layout in `CLAUDE.md`.
