# `tests/security/`

The **deny** path — SEC-02, SEC-03, SEC-12, PRV-03, PRV-05, PRV-08, §28, hard rules #3, #5, #6.

**A test that proves a manager can approve proves nothing about whether a cashier cannot.** That
is the shape of every access-control bug: the allow path is exercised constantly, by every
feature test and by every person using the product all day, and it is correct. The deny path is
exercised by an attacker, once, in production.

So these suites sweep the **complement** rather than sampling it.

- **`access-control-sweep.test.ts`** — 5 users × 12 permissions × 4 scopes = 240 decisions,
  checked against an oracle computed from the role tables **independently of the
  implementation**. An oracle that asks the thing under test is a tautology, and a sweep built on
  one is 240 assertions that the code agrees with itself. Plus the escalations somebody actually
  attempts: an assignment naming a deleted role, an empty `[]` scope that must never read as
  `'all'`, a branch grant reaching a company-wide action, near-miss and prefix-matched permission
  strings, and mutating the tables after construction.

- **`separation-of-duties.test.ts`** — every place in the product where one person could
  otherwise authorise their own act, in **one list**. Each module already has its own
  maker-cannot-be-checker test, and each proves the rule in one place; none proves it holds
  everywhere, which is the only interesting claim — a control enforced in eight of nine places is
  one an attacker finds the ninth of. Each entry runs **twice**: allowed with two people, refused
  with one. Without the first half, a module that simply refuses everything would pass, and a
  control that blocks the legitimate path gets switched off within a fortnight.

- **`data-protection.test.ts`** — the card-data allowlist (there is nowhere to put a card number,
  not "we validate it out"), PII minimisation by purpose, and erasure resolving the PRV-05 /
  hard-rule-#6 tension per category with the actual statute named.

Two defects were found by writing these, both of which had survived because the existing tests
checked the reachable path rather than the refused one — see
`docs/evidence/cross-cutting-security.md`. The serious one: `minimisePii` was a **blocklist
wearing an allowlist's name**, and passed `aadhaar_number` straight through to a model.

**These do not substitute for EX-13**, the independent penetration test at QG-06. They prove the
controls the code implements behave as designed; they cannot find a class of attack nobody here
thought of, which is the entire reason an outside tester is engaged.

> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
