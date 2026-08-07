# `packages/org/`

The organisational hierarchy and branch lifecycle — **M01-FR-01 / M01-FR-04**. With
`calendar`, `numbering`, `config` and `tenant`, this completes **M01**.

## The skeleton everything else hangs on (`src/hierarchy.ts`)

```
company → GST registration → branch/store → warehouse → department
```

Get this wrong and the symptoms appear everywhere at once: GST filed against the wrong
registration, a manager able to see another branch's takings, a report that quietly
double-counts a warehouse. So the structure is validated **as a whole**, not node by
node.

| Rule | Why |
|---|---|
| A **GSTIN is unique**, and a duplicate is rejected **naming who already holds it** | The second entry is almost always a typo of the first. |
| The **checksum** is verified, not just the shape | A single mistyped digit is caught when it is typed, not at the first return. |
| Every store belongs to **exactly one company and one GST registration** | That is what makes the tax attribution unambiguous. |
| A branch **cannot be activated** without a company and a valid registration | Its sales would be unattributable. It can still be **saved as a draft** — incomplete is not invalid. |
| A node whose parent is in **another tenant** is refused outright | Cross-tenant structure is a critical defect, not a configuration option (ADR-0003). |

`descendantsOf` gives the scope a report or permission actually covers; `ancestryOf` and
`gstinFor` answer which registration a department's sales are filed under. Both terminate
on a cyclic link set rather than hanging.

## Opening and closing a branch (`src/branch-lifecycle.ts`)

Opening or closing a branch touches **stock, cash, staff access and reporting** at once.
Done ad-hoc it leaks all four. So each transition has preconditions that are **checked,
not remembered**, and **every blocking reason is returned together** — the manager needs
the whole list to plan the day, not a door that opens one inch per attempt.

- **Open** — needs configuration, an assigned till, and the owner's approval.
- **Temporary close** — deliberately **not** blocked on stock or cash. It preserves
  state: stock, cash, reservations and unsent sync items all survive and resume on
  reopen. Reopening needs no fresh approval.
- **Permanent close** — blocked while **any** of these is true: stock remains (valued,
  in the message), cash remains, documents are open, the edge has **unsent sync items**
  (closing over them would destroy sales that were legitimately made, §31), or exceptions
  are unresolved.

Every closure is **owner-approved and the person executing is never the person
approving** (§28).

Closure **never deletes anything**. Access is revoked, trading stops, the branch leaves
the *live* reports but stays in history — the distinction that keeps last year's
comparison honest — and the audit trail and closure evidence pack are retained in full
(hard rule #6). "Closed" is a state, not an erasure.

Pure and deterministic — the timestamp is injected, there is no clock, no I/O.
`evaluateTransition` decides and returns; it mutates nothing, which is what makes the
decision testable and auditable on its own. Tested in `tests/unit/org-hierarchy.test.ts`
(17) and `tests/unit/org-branch-lifecycle.test.ts` (13). Part of the repository layout in
`CLAUDE.md`.
