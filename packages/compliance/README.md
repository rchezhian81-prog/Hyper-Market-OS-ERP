# `packages/compliance/`

Licence, risk, incident and attestation registers — **M34-FR-03/04 / §9.3**. Completes
M34 alongside `packages/audit`.

## The paper you did not write (`src/obligations.ts`)

A hypermarket runs on documents issued by somebody else: the food licence, the Legal
Metrology stamping certificate for every weighing scale, the trade licence, the fire NOC,
the shop-and-establishment registration. Any one of them expiring quietly can close the
shop for a day. And the way they expire is always the same — **nobody owned the date**.

So two rules are enforced, not suggested:

1. **Every obligation names a person.** Not "compliance", not "the manager" — a person,
   with a name. `registerObligation` refuses one that names nobody, because an alert that
   reaches a role reaches nobody.
2. **Alerts escalate, and an expired licence keeps shouting.** Notice → warning →
   critical as the date approaches, escalation to a named deputy inside the final window,
   and an expired obligation **stays at the top of the list** rather than dropping off —
   which is exactly when most systems go quiet.

Alerts are ordered worst-first and every message names the person: *"FSSAI food licence
(FSSAI) EXPIRED 33 days ago — Priya must renew it now."* Every threshold is per-tenant.

An obligation with **no evidence on file** is flagged separately from its expiry date —
having a valid licence and being able to produce it are different things.

**Nothing is ever deleted.** An obligation that no longer applies is **closed with a
reason** and keeps its whole record, because an inspector's question is usually about the
period you no longer operate in (hard rule #6).

## Why registers, not paperwork (`src/risk.ts`)

The registers exist so that when something goes wrong you can answer three questions
immediately:

- **Which control was supposed to stop this?** An incident must name the control it
  defeated — an incident that links to nothing teaches nothing.
- **Who is fixing it, by when?** Remediation must have a named owner and a due date, or
  it is a wish, not a plan.
- **Did anyone ever check the control works?** Attestations are dated and immutable, and
  a control **nobody has ever attested** is reported as such — an untested control is an
  assumption.

**An open critical risk blocks its quality gate** (QG-06, QG-08). Accepting a risk
unblocks the gate, but only in **someone's name with a written rationale** — accepting a
risk is a decision, and decisions have authors.

Pure and deterministic — the date is passed in, there is no clock, no I/O. Tested in
`tests/unit/compliance-obligations.test.ts` (16) and `tests/unit/compliance-risk.test.ts`
(12). Part of the repository layout in `CLAUDE.md`.
