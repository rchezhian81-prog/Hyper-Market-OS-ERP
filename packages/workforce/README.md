# `packages/workforce/`

Rosters, gated tasks, checklists, incentives and SOPs — **M25-FR-01…04** (§28, §29.1, P-04).

This module governs people, which changes what "correct" means. A stock figure that is wrong
costs money. A roster that is wrong means somebody's childcare falls through, or the shop
opens with nobody who can legally slice meat.

- **`src/workforce.ts`**
  - `rosterGaps({ shifts, assignments, employees })` — reports **what is missing, named, with
    the hour**. *"Sunday 06:00 has NOBODY rostered as opener"*, not "14 of 16 shifts covered".
    A coverage percentage is a number nobody acts on; the sentence is one a manager can act on
    from a phone at six in the morning.
    - **A leaver still in the grid is not cover.** An inactive employee counts as zero, which
      is the gap nobody sees until the morning, because the name is still on the rota.
    - Someone rostered in a different role is not cover for this one, and gaps are ordered by
      when they bite.
  - `canPerformTask({ employee, task, requiresCertification?, requiresRole?, … })` — the gate
    is on the **task, never the person**. Someone whose food-handling certificate lapsed
    cannot work the deli counter and can absolutely still stack shelves; the decision carries
    `stillAllowed` saying so.
    - Blocking the person outright is how a shop ends up working around the system on a busy
      Saturday, and **a control people route around is not a control**.
    - An unverified certificate is not a certificate. The **latest** certificate wins when one
      has been renewed. The last valid day still counts.
  - `assessChecklist({ checklistId, kind, items, signedBy })` — **blocking and non-blocking
    items are separated on purpose.** A checklist where everything blocks is a checklist people
    tick without reading, and then the one item that mattered — the chiller temperature, the
    safe — is ticked with the rest. Only what genuinely stops the shop blocks it; the
    remainder is carried, visible, into the next shift's handover. A checklist with nobody's
    name on it is a list, not a record.
  - `computeIncentive(target)` — exact integer arithmetic (§29.1), BigInt accelerator, and **a
    missed target pays nothing** rather than a proportion. Paying 96% of a bonus for 96% of a
    target has quietly redefined the target, and next quarter everybody aims at 96%. "Nearly"
    is a conversation a manager can have; it is not a formula. A zero target reports
    `not_meaningful` rather than dividing by it.
  - `labourCost({ branchId, hours, employees, salesMinor, guideBps? })` — the deliberate
    exception: **reported, never enforced.** A system that refuses to roster a fourth cashier
    because the ratio looks bad is a system that creates queues at Diwali and loses more than
    it saved. It states the number, names the guide, and a manager decides — *"a queue costs
    more than a cashier"*. There is no function in this module that could refuse a roster on
    cost, and `tests/unit/workforce.test.ts` asserts that absence.
  - `sopStatus({ employee, sops, acknowledgements })` — **acknowledging v3 is not
    acknowledging v5.** A shop that treats an old acknowledgement as current has a signature
    against a procedure nobody has read, which is worse than no signature because it looks
    like compliance. Only SOPs matching the person's roles are shown, and what is outstanding
    is listed first.

> Pure and deterministic: the clock is injected, no I/O. Feeds the facilities schedules in
> `packages/facilities` (which route work to a role) and composes with `packages/rbac`.
> Tested in `tests/unit/workforce.test.ts` (31) and proven end to end in
> `tests/integration/beyond-the-till.test.ts` (Stage 16 gate). Part of the repository layout
> in `CLAUDE.md`.
