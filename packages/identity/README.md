# `packages/identity/`

Named accounts, sessions and the access lifecycle — **M02-FR-01 / M02-FR-04 / SEC-03 /
SEC-11 / hard rule #4**. With `rbac` (authorisation) and `approvals` (maker-checker), this
completes **M02**.

## It holds no credentials, by design

There is no password field here, no hash, no token. Credential storage belongs to the
identity provider chosen at deployment — and **a password that never enters this codebase
can never be logged by it** (SEC-04, hard rule #4). What lives here is the *policy*: who
exists, what state they are in, and when a session must end.

## A generic account cannot be created (`src/account.ts`)

Shared logins are the top audit finding in retail (A-17), and they never arrive as a
decision. They arrive as a convenience: one account for the evening shift, one for the new
starter until IT gets round to it, one called "manager" that nobody wants to be the one to
remove. So it is refused at creation, not discouraged:

- an account must name a **real person** with **their own** contact;
- usernames that are job titles — `cashier`, `manager`, `admin`, `till2`, `temp` — are
  refused with the reason (a tenant can add its own);
- **two accounts cannot share one contact** — that is a shared login wearing two names.

A **privileged account cannot go active without a second factor** (SEC-03). Sessions expire
on **inactivity** and again on an **absolute limit**, are **bound to their terminal** where
the tenant requires it (§28), and a session established from a **cached offline identity**
is trusted only for a bounded window — which is what keeps the lane trading with the cable
out (§31) without leaving a permanent hole.

The **access review** flags the two things that actually get exploited: **privileged
accounts with no second factor**, and **dormant accounts** nobody has closed.

## Access must track employment reality (`src/lifecycle.ts`)

Two failures cause most access fraud, and both are rules here rather than reminders:

| Failure | The rule |
|---|---|
| **The mover who accumulates.** Someone transfers from the Fresh counter to the cash office and keeps both. Six months later they can raise a stock adjustment *and* settle the till it hides in — a combination nobody granted; it assembled itself. | A move **replaces** scope, never adds to it, and closes their sessions so the new scope applies at once rather than whenever they happen to log out. |
| **The leaver who lingers.** The account is disabled "later", sessions stay open, and the items they owned belong to nobody. | Revocation and session closure are **one act**, and it is **blocked until owned open items are reassigned** — naming them. An unapproved purchase order owned by nobody never gets approved. |

Revocation is a **priority sync item**: an ex-employee's access must not wait behind a
queue of sales to reach the store (§31).

**Emergency access** is real and necessary, and it is the one that quietly becomes
permanent. So it is **time-bound at the moment it is granted**, expires by itself with
nobody needing to remember, needs a specific reason (the review has to mean something) and
an approver who is not the requester. It **cannot be extended in place** — an extension is
a new grant with a new approval, which is exactly what stops "temporary" access becoming
permanent through a series of quiet nudges (SEC-11: no perpetual support access).

Pure and deterministic — the timestamp is injected, there is no clock, no I/O. Tested in
`tests/unit/identity-account.test.ts` (18) and `tests/unit/identity-lifecycle.test.ts`
(16). Part of the repository layout in `CLAUDE.md`.
