# Cross-cutting evidence — the deny path

**Covers:** **SEC-02** (zero-trust identities), **SEC-03** (least privilege, separation of
duties), **SEC-12** (PCI scope), **PRV-03** (collection minimisation), **PRV-05** (erasure),
**PRV-08** (retention). Hard rules **#3, #5, #6**. §28, §35.

**Executed:** 7 August 2026. `tests/security/` — 39 assertions, all green, full suite 2,356.

---

## The premise

**A test that proves a manager can approve proves nothing about whether a cashier cannot.**

That is the shape of every access-control bug. The allow path is exercised constantly — by every
feature test, and by every person using the product all day — and it is correct. The deny path is
exercised by an attacker, once, in production. So the tests in this folder sweep the
**complement**: not a handful of allows, but every combination outside them.

Two defects were found by writing them, and both had survived because the existing tests checked
the reachable path rather than the refused one.

---

## Defect 1 — `minimisePii` was a blocklist wearing an allowlist's name

**Severity: high.** `packages/ai/src/safety.ts` claimed, in its own doc-comment and in
`packages/ai/README.md`, to minimise *"by purpose, against an allowlist, so a field invented later
is minimised by default"*. It did not. The implementation held a fixed set of seven known PII
fields and checked each key against it:

```ts
const known = new Set(['name', 'phone', 'email', 'address', 'customer_id', 'loyalty_id', 'dob']);
if (known.has(key) && !permitted.has(key)) { removed.push(key); continue; }
record[key] = value;      // ← anything NOT in `known` passed straight through
```

So `aadhaar_number`, `pan`, `gstin`, `bank_account` and `passport_number` — none of them on that
list — reached the model untouched. Aadhaar is the single most sensitive identifier in India, and
this is the path by which it would have entered a third party's logs.

The existing unit test was titled *"is an ALLOWLIST, so a field invented later is minimised by
default"* and asserted only that `PII_BY_PURPOSE` held arrays. **It named the property and never
checked it**, which is exactly how the blocklist underneath survived review.

**Fixed** by inverting to a genuine default-deny: business fields are **opt-in** via an explicit
`businessFields` parameter, and everything not permitted by the purpose and not declared as
business data is removed. That is real friction on callers, and it is the point — a caller who
forgets to declare a field now loses it, which is a visible bug in their own feature. Under the
old behaviour a caller who forgot leaked PII, which is invisible until it is a breach.

The test that named the property now checks it, against `aadhaar_number`, `pan` and
`bank_account`.

## Defect 2 — role permission lists were held live by reference

**Severity: low (defence in depth), but an inconsistency worth removing.** `AccessControl` copied
the *assignments* array at construction — so a caller who kept a reference could not grant
themselves a role by pushing to it — but held the *roles* by reference, so mutating a role's
permission list afterwards did widen access.

`readonly Permission[]` stops that in TypeScript and stops nothing at a JSON boundary, which is
where role configuration actually arrives from. Two structures where one is defended and the
other is not is worse than either, because a reader reasonably assumes the defence is uniform.
Both are now copied and frozen.

---

## Part 1 — the full deny matrix (SEC-02, SEC-03)

5 users × 12 permissions × 4 scopes = **240 decisions**, checked against an oracle computed from
the role tables **independently of the implementation**. An oracle that asks the thing under test
is a tautology, and a sweep built on one is 240 assertions that the code agrees with itself.

| # | The escalation attempt | Result |
|---|---|---|
| 1 | All 240 combinations against the independent oracle | **Exact agreement.** Denials outnumber allows more than 3:1 — if that ratio collapses, the sweep has stopped sweeping |
| 2 | A cashier reaching for every privileged permission in every branch | **All refused** |
| 3 | An unknown user | **Refused everything** — absence is not a grant |
| 4 | An assignment naming a **deleted role** | **Grants nothing.** The realistic version: the role is removed, the assignment row survives, and the dangerous reading of that row is "unconstrained" |
| 5 | An **empty** branch scope `[]` | **No branches, never all of them.** `[]` and `'all'` are one keystroke apart in a config file, and the failure is silent |
| 6 | A branch-scoped grant reaching a **company-wide** action | **Refused** — otherwise one shop's supervisor closes the group |
| 7 | A permission leaking across branches within one user | **Refused** |
| 8 | Near-miss permission strings (`Sale.Commit`, `sale.commit `, `SALE.COMMIT`) | **All refused** — exact and case-sensitive |
| 9 | Prefix matching (`price` satisfying `price.change`) | **Refused** — otherwise the naming scheme becomes a hierarchy nobody designed |
| 10 | Branch names that *contain* a granted one (`br-main-2`) | **Refused** |
| 11 | Pushing to the assignments array after construction | **No effect** |
| 12 | Mutating a role's permission list after construction | **No effect** *(defect 2, now fixed)* |

`assertCan` names the user, the permission and the place — *"company-wide"* rather than `null`.
A denial nobody can diagnose is a denial somebody eventually bypasses.

## Part 2 — separation of duties, swept product-wide (SEC-03, §28)

Every module has its own maker-cannot-be-checker test, and each proves the rule holds in **one
place**. None proves it holds everywhere, and "everywhere" is the only interesting claim: a
control enforced in eight of nine places is a control an attacker finds the ninth of. The ninth
is never the obvious one — it is the module written last, where the check reads as bureaucracy
because the maker is the owner and there is nobody else in the building at nine at night.

So every point in the product where one person could otherwise authorise their own act is
collected in **one list**, and each is run **twice**:

| The act | Two people | One person |
|---|---|---|
| Approving your own approval request (§28) | allowed | **refused** |
| Signing a migration control total you loaded (MG-06/QG-07) | allowed | **refused** |
| Approving a migration exclusion you proposed (MG-07/OD-05) | allowed | **refused** |
| Lifting an AI kill switch you pulled (Stage 17) | allowed | **refused** |
| Granting yourself a delegation of authority (§28) | allowed | **refused** |

**Both halves matter.** Without the two-people half, a module that simply refuses everything would
pass — and a control that blocks the legitimate path gets switched off within a fortnight.

Three harder cases, each the one somebody argues about:

- **The owner approving their own delegation** — refused. On a single-owner business the
  temptation to collapse the two roles is constant and the argument is always reasonable. The
  refusal has to hold precisely there, or it holds nowhere.
- **The owner signing a tax total** — refused. Finance and tax are the CA's (M23 / C-01), however
  senior anybody else is.
- **A delegation used to launder a self-approval** — the maker delegates their authority to a
  colleague, who approves the maker's request with it. Two names appear in the record and it is
  still one decision. **Refused.**

And the cheapest bypass of all — a second "identity" that is not a person: an **agent cannot
approve its own proposal** (hard rule #5, AI-NFR-12). Two independent barriers, so that forgetting
the optional agent-identity list still leaves the role check refusing it.

## Part 3 — data protection (SEC-12, PRV-03/05/08)

**Card data** is refused by a closed allowlist rather than chased by a blocklist, and the tender
surface has nowhere to put a card number — hard rule #3 is not *"we validate it out"*, it is
*"there is nowhere to put it"*.

**Erasure** resolves what looks like a contradiction and is not. PRV-05 gives the customer a
right; hard rule #6 and PRV-08 say audit evidence and statutory records are never deleted. Both
wrong resolutions are common: delete everything and the shop cannot answer a GST assessment;
refuse everything and the right is a dead letter. The answer is **per category, with the actual
statute named, in words the customer can read**:

- Marketing preferences and delivery addresses — **erased**.
- Sales invoices — **minimised**: the lines and totals survive, the name becomes a pseudonym.
  That satisfies both obligations at once, and it is the option people forget exists.
- Audit trail — **retained**, stated without hedging: *"can never be deleted by anyone, including
  us."*
- The plan states plainly that it is **partial** — almost always true, and a fact to state rather
  than a failure to hide. And where nothing is legally held, **everything is erased**: the right
  is real, not theatre.
- `planErasure` **deletes nothing itself.** It produces the answer; a person acts on it.

---

## What still needs procurement

**EX-13 — an independent penetration test (QG-06).** Nothing in this folder substitutes for it,
and the boundary is the same as everywhere else in this repository: these tests prove the
controls the code implements behave as designed. They cannot find a class of attack nobody here
thought of, which is the entire reason an outside tester is engaged. Scheduled at Stage 14, before
customer launch, and not procured before a testable release candidate exists.

## What the owner should check in the store

1. **Ask somebody to approve their own request.** It must be refused, and the refusal must name
   who and what. If it works "because they're senior", that is the failure this stage exists to
   make impossible.
2. **Ask what a cashier can see.** Sales and cash declarations at their own till. Not prices, not
   refunds, not other branches, not staff records.
3. **Ask what happens when a customer says "delete everything about me."** The right answer names
   the law for anything kept — *"invoices for eight years, because income-tax law says so"* — and
   says plainly which parts were deleted. If the answer is a flat "we can't", that is wrong too.
4. **Ask where card numbers are stored.** The right answer is *"nowhere — there is no field for
   one."* Not *"they're encrypted."*
5. **Ask who can turn the AI off, and who can turn it back on.** Two different people.
