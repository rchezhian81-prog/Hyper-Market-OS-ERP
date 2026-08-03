# `apps/web-erp/`

The back-office ERP/Admin web application — the surface every non-till role works in (store
manager, purchase, inventory, finance, security, admin). Built to the §27 role surfaces and
**P-07** ("the simplest interface each role needs").

## What's built (tested, framework-agnostic)

- **`src/navigation.ts` — role-scoped navigation.** The menu is **derived from the user's actual
  permissions** (`packages/rbac`), not hand-maintained per role. So:
  - a user **never sees a section they'd be refused on** — the screen and the server apply the
    same default-deny check (`canOpen` is that check);
  - **branch scope is honoured** — the same manager sees their branch and nothing in another;
  - an unknown user sees **nothing** (default-deny), and an unknown path is **denied**, never a
    blank allow;
  - **adding a role is configuration, not code** (choose-able per tenant, ADR-0003).

  `ERP_NAVIGATION` is the catalogue of sections, each declaring the permission it requires;
  `landingPath` sends each user to their first permitted page.
- **`src/approvals-workbench.ts` — the approvals queue.** Makes **separation of duties visible
  on screen** rather than a surprise at submit time (§28):
  - a request the user **made** is shown but **never actionable by them**;
  - a request **above their limit** or **outside their branch** is shown and marked *escalate* /
    *out of scope* with the reason — **never a button that will fail**;
  - the queue is **ordered by value**, biggest exposure first;
  - a **reason is mandatory** before the engine is even called (audit);
  - every real decision is **delegated to `packages/approvals`**, which stays the single place
    the rules live — proven by a test that the engine still refuses a self-approval even if the
    screen were bypassed.

## The one decision this shell defers

§19 sets the baseline for this app as *"TypeScript + modern SSR web framework"*. **Which** SSR
framework (and its runtime) is **coupled to the hosting decision the owner deferred** (OB-02):
server-side rendering needs a server, and the framework's deployment shape (Node server, edge
runtime, container) is part of choosing one. Installing one now would bake in a runtime
assumption before there is anything to run it on.

So this shell is deliberately **framework-agnostic**: the model above is pure TypeScript with no
view library, and any SSR choice renders it unchanged. When hosting is settled, the remaining
work is the view layer plus session/auth wiring — the access rules, menu and workbench logic are
already built and tested.

Tested in `tests/unit/web-erp-shell.test.ts` (14 tests). Part of the repository layout in
`CLAUDE.md`.
