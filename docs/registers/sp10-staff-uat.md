# SP-10 — staff and device UAT register (the store practice sessions)

_The one place where what real people did on real devices is recorded. **Deployment and automated tests never
mark a row here as passed.** A row is filled in by the person who ran the session, on the day, with the software
version that was running. Until a session has been run, the register says so._

Rules (owner, 1 October 2026):

- Record the **software version** for every session: the commit on the demo box (`/opt/sre/releases.log`, last
  `result=deployed` line) and on the store PC (`git -C <repo> rev-parse HEAD` on that PC).
- Record **who** (role, person), **which device** (store PC, phone model, scanner), **what was done**, **what was
  seen**, **pass / fail / defect**. A defect follows `docs/pilot/PILOT-GATES.md` (P0/P1 block, P2 written
  acceptance, P3/P4 backlog; nothing closed without a retest; expected results are never edited to force a pass).
- Synthetic data only; the DEMO banner visible; live payments, tax filing, payroll bank files and customer
  messaging stay disabled. A session that saw any of these on is a P0 defect.
- Automated evidence stays in the completion ledger (`docs/completion-status.json`, `docs/traceability.md`).
  This register is the **human** column. The UAT readiness score moves only from rows here.

## Status

| Item | State |
|---|---|
| Sessions run | **0** — no staff or device session has been performed yet |
| Devices verified on real hardware | **none** — store PC, scanner, phones pending (physical installation steps in `docs/runbooks/demo-practice-environment.md` §4) |
| Software version on the demo box | not yet connected to the pipeline (see the runbook §2); last known: the 28 September stand-up at `e72b4ae` |

## Sessions

Copy the block below for each session. One block per session, newest last.

```
### UAT-S-<n> — <date> — store PC <commit> / demo box <commit>
Who: <name> as <role>            Device: <store PC / phone model / scanner>
Script followed: docs/runbooks/demo-practice-environment.md §7, row <#>, role "<role>"
| Step | Expected | Seen | Result (pass / fail / defect ref) |
|---|---|---|---|
| … | … | … | … |
Notes / defects raised:
Signed: <name>, <date>
```

_(No sessions yet.)_

## What a completed register would let us claim

When every role's script has at least one signed pass on real devices, with no open P0/P1 defect, the
store-management workflow moves from "browser-verified" to "staff-verified" (UAT_VERIFIED on the ladder) for the
modules those scripts cover. Until then the claim stays exactly where it is today: implemented, integration-tested
and browser-verified in software; staff UAT pending.
