# `packages/migration/`

The migration pipeline — **MG-01…MG-12, §34, WF-19, QG-07**, owner decisions **OD-05 / OD-06**,
hard rules **#2, #6, #7, #10**.

Fifteen years of an incumbent standalone ERP have to become trustworthy opening truth in one
evening, and the store has to open the next morning either way. Everything below exists because
that sentence has two halves and the second one is the harder promise.

**Built and proven against a synthetic legacy dataset.** EX-02 — lawful export access to the
incumbent ERP — is owner action pending; by the owner's instruction of 4 August 2026 it blocks
real-data extraction and does **not** block synthetic migration testing. So `synthetic.ts`
generates a legacy dataset with **ten kinds of realistic damage planted in it**, and the Stage 11
rehearsal asserts that every planted fault is found **by identity, in exactly the planted
quantity, with nothing found on clean data**. A migration rehearsal that only handles good data
rehearses nothing.

- **`src/synthetic.ts`** — the fixture the whole rehearsal stands on. Deterministic: the same
  seed gives the same dataset on every machine, which is what lets a reconciliation figure be
  asserted *exactly* rather than approximately. The damage is drawn from what a fifteen-year-old
  retail ERP actually contains — the same product entered three times, a barcode on two
  products, negative stock from sales against goods never received, tax struck under a
  superseded rate table, batches predating a mandatory expiry field, customers duplicated by a
  phone typed with and without +91, one firm under three names sharing a GSTIN, header totals
  drifting a paisa from their lines, and order lines whose header was deleted years ago.
  - `plantedIds` records **which** records were broken, not merely how many. Counts let a
    rehearsal claim *"found 14 duplicates"* while having found fourteen different ones.
  - Base product names are **distinct by construction**, so every duplicate in the dataset is a
    planted one. Without that a finding might be a fault or might be the generator's own
    accident, and the detector could not be measured at all.

- **`src/discovery.ts`** — MG-01, MG-02. Discovery is not a technical task: the incumbent
  database is the least dangerous source, because everyone knows it exists. The migration that
  goes wrong is the one where, three weeks after cutover, somebody mentions the loyalty points
  were on a spreadsheet on the manager's laptop.
  - **A source nobody claims is still a source** — it stays named and unowned rather than
    dropping off the inventory, and discovery is not complete while one stands.
  - `sealExtract(…)` refuses without a **verified backup restore**. A backup job that reports
    success and a backup that restores are different things, and the difference is only ever
    discovered at the moment it matters.
  - `verifyExtract(…)` checks the digest **and** the row count, because they fail differently: a
    changed digest means the content moved, a changed count means part of it never arrived — and
    a truncated extract loads perfectly and reconciles a smaller, entirely self-consistent shop.

- **`src/mapping.ts`** — MG-03, the step where a migration quietly acquires a tax bill. Legacy
  code `TX` is on nine products and meant something in 2014 to somebody who has left. The
  convenient line is `taxCode ?? 'T0'`; it works, no error appears, and nine products are now
  zero-rated until an assessment.
  - **`mapValue` has no fallback parameter, deliberately.** A caller who wants a default must
    write it themselves, in the open, where a reviewer can see it.
  - One legacy value mapping to two targets is refused at **approval**, not resolved at load —
    it means two people disagree about what the code meant, and picking one silently makes that
    disagreement permanent and invisible.
  - Coverage is measured against the **values in the extract**. *"142 mappings approved"* answers
    a question nobody asked; *"9 products carry a code no mapping covers"* is the fact.

- **`src/cleaning.ts`** — MG-04, and the module defined mostly by what it may not do.
  - **Cleaning proposes; it never decides.** Nothing merges, nothing is corrected, nothing is
    dropped. Two products that look identical are sometimes two products, and an auto-merge
    loses one of them silently at 3am with nobody watching.
  - **A merge is a redirection, not a delete.** The retired id keeps a row pointing at its
    survivor, because six months later somebody asks why a barcode scans to a different product.
  - **Every finding is kept, resolved or not** (hard rule #6). There is no `discardException`
    and no `clearExceptions` — asserted by test rather than promised here.
  - **Severity is money and law, not tidiness.** A duplicate name is untidy; a negative quantity
    is a valuation error and an unmappable tax code is an assessment. A blocking exception is
    cleared by a **decision** — including a decision to migrate it as it is. The owner may
    knowingly accept a valuation error; nobody may accidentally inherit one.
  - `certain` and `probable` are kept apart. A shared GSTIN cannot legitimately collide; the same
    name in two departments can, in a hypermarket with a cafe.

- **`src/trial.ts`** — MG-05, MG-09. `assertNonProduction` is deliberately a **separate,
  callable, testable function** rather than an `if` inside the loader: it is the one control here
  whose failure is unrecoverable, and the realistic accident is not malice but a copied
  connection string in a terminal at eleven at night. It is checked **first**, ahead of the
  operator's name and everything else — every other refusal costs an evening, this one costs the
  shop. It decides on the target's *kind*; a reassuring label is not evidence.
  - Full volume, or it rehearsed nothing — and **timing is an output**, because the cutover
    window is a real evening and *"about an hour"* is how a shop opens late.
  - A delta duplicate is `already_applied`, a **success**: a delta that fails on a re-send cannot
    be resumed at midnight, and the recovery from that is somebody deciding by hand which half
    went in. A change dated before the extract cutoff is refused — it is already loaded.

- **`src/reconcile.ts`** — MG-06, MG-08, **QG-07**. One check here matters more than all the
  others: **a total that reconciles because both sides were computed the same way reconciles
  nothing.** If the "legacy" figure and the "new" figure both come out of the loaded table, the
  report is green, the CA signs it, and it proves that addition is commutative. Each total names
  where each side came from, and identical derivations are refused. It is the only check in this
  package that catches a mistake nobody would ever notice.
  - `explained` is a real third state, not a softer `reconciled`: the arithmetic must close to
    the rupee, because an unexplained remainder is where a real error hides behind an approved one.
  - **The person who ran the load does not sign the totals** — not because they would lie, but
    because they already believe it worked, which is the whole reason a second pair of eyes
    exists. Finance and tax are the CA's (M23 / C-01), however senior anybody else is.
  - **There is no provisional signature.** An open total cannot be signed, and that is the point
    most likely to be argued about on the night.
  - **Opening balances are events** (hard rule #2). The migration is the one moment when writing
    a balance directly would be defensible — the figures are known and the ledger is empty. Which
    is exactly why it must not: an opening quantity with no event behind it is the one number in
    the shop that can never be explained, and it sits under every count and valuation afterwards.

- **`src/history.ts`** — MG-07, MG-12, two steps about the same question: what is kept, and who
  said so. MG-07 is where a migration silently becomes smaller than promised, and the pressure is
  practical rather than dishonest.
  - **Age alone is refused as a reason** — the reason offered ninety per cent of the time and the
    one that is never true. A warranty claim in year four is exactly the record somebody needs.
  - **An unapproved exclusion is not a smaller migration, it is an open item.** Only an
    owner-approved figure may explain a control-total difference; an undecided one leaves the
    total open, which is what forces the decision before cutover rather than after.
  - **Retiring the legacy system and destroying the legacy data are different acts.** The licence
    renewal is the pressure, switching the server off is the action, and deleting the archive is
    what quietly happens alongside it. `dataIsNeverDeleted` is typed as the literal `true`, and
    retention is computed from the **latest record**, not from how confident anybody feels.

- **`src/cutover.ts`** — MG-10, MG-11. The parallel run is the only step that tests the new
  system against **reality** rather than against itself: every control total compares a load to
  an extract; a parallel run compares a day's trading to a day's trading.
  - A difference is **owned and valued the same day** (§34.1), and is never resolved by preferring
    the newer figure — that is last-write-wins with a sentence in front of it (hard rule #10), and
    the stock error it hides surfaces at a count six weeks later. The phrasings are refused by name.
  - **Clean days are consecutive.** Clean-bad-clean-clean-clean is three days of evidence, because
    whatever caused the bad day is what the run was looking for.
  - **The rollback is the deliverable, not the cutover.** Anyone can migrate on a good night. GO
    is refused until a rollback has been *demonstrated* — the decision to use it gets made at 6am
    by a tired person, so it must be one clearly-labelled action needing no committee. Every
    failed check is reported at once; a cutover blocked five ways and reported one way produces
    five separate evenings.
  - `shopKeepsTrading` is typed as the literal `true` on both the decision and the rollback (P-01).

> Pure and deterministic: the clock, the hasher and every identifier are injected; no I/O and no
> secret material at any point. Tested in `tests/unit/migration-synthetic.test.ts` (10),
> `migration-discovery.test.ts` (10), `migration-mapping.test.ts` (13),
> `migration-cleaning.test.ts` (19), `migration-trial.test.ts` (14),
> `migration-reconcile.test.ts` (23), `migration-history.test.ts` (18) and
> `migration-cutover.test.ts` (20), and proven end to end against real PostgreSQL in
> `tests/integration/the-old-shop-arrives-whole.test.ts` (Stage 11 rehearsal gate, 23 assertions).
> Part of the repository layout in `CLAUDE.md`.
