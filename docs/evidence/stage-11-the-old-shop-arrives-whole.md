# Stage 11 rehearsal evidence — the old shop arrives whole

**Gate:** roadmap §34 — the migration pipeline. Controls **MG-01…MG-12**, workflow **WF-19**,
quality gate **QG-07**, owner decisions **OD-05 / OD-06**.

**Executed:** 5 August 2026 against **PostgreSQL 16.13**, entirely on a **synthetic legacy
dataset**, by the owner's instruction of 4 August 2026 that EX-02 blocks real-data extraction and
does **not** block synthetic migration testing. Automated as
`tests/integration/the-old-shop-arrives-whole.test.ts` (23 assertions), run in CI against a real
PostgreSQL service container, and **verified repeatable** (run three times, green three times).

The claim on trial: **the old shop arrives whole, or it does not arrive — and the store opens
the next morning either way.**

---

## The premise

A migration rehearsal that only handles good data rehearses nothing. The entire cost and risk of
a migration lives in the mess, so the fixture is built to contain it: `synthetic.ts` generates a
legacy dataset with **ten kinds of realistic damage planted in it**, drawn from what a
fifteen-year-old standalone retail ERP actually holds.

Two properties make the rehearsal measurable rather than merely green:

1. **`plantedIds` records which records were broken, not how many.** A count lets a test claim
   *"found 14 duplicates"* while having found fourteen different ones.
2. **Base product names are distinct by construction**, so every duplicate in the dataset is a
   planted one. Without that, a finding might be a fault or might be the generator's own
   accident, and a detector cannot be measured at all.

---

## One migration, end to end

### 1. MG-01 — discovery is not a technical task

| # | What happens | Control proven |
|---|---|---|
| 1 | The ERP database and a loyalty **spreadsheet on a laptop** are inventoried | The spreadsheet stays in the inventory, **named and unowned** — a source nobody claims is still a source |
| 2 | Discovery is assessed | **Not complete.** Three gaps named at once: no owner, no retention period, unknown volume |
| 3 | A row count given as *"about 40,000"* | **Excluded from the counted total** — an estimate cannot reconcile against a load |

### 2. MG-02 — a hash taken after loading proves nothing

| # | What happens | Control proven |
|---|---|---|
| 4 | An extract is sealed with a backup job that *reported success* | **Refused** — *"a backup job that reported success is not a backup that restores"* |
| 5 | Sealed properly, then one price changed by ₹1 | **Digest mismatch.** *"This is not the extract that was taken"* |
| 6 | The same bytes, one row short | **Digest matches, row count does not** — the two fail differently, and *a truncated extract loads perfectly and reconciles a smaller, entirely self-consistent shop* |
| 7 | `deleteExtract` / `editExtract` / `unsealExtract` | **None exist**, asserted by test |

### 3. MG-03 — the step where a migration acquires a tax bill

| # | What happens | Control proven |
|---|---|---|
| 8 | Tax code `TX` on 14 products has no approved mapping | Coverage reports **the affected row count**, not the table size |
| 9 | `mapValue` is offered no default | **There is no fallback parameter.** A caller wanting `?? 'T0'` must write it in the open, where a reviewer sees it |
| 10 | Somebody maps `TX` to both `GST_0` and `GST_18` | **Refused at approval**, conflict named — *"two people disagree about what the code meant, and a load that picks one silently makes that disagreement permanent"* |

### 4. MG-04 — every planted fault, found by identity

| Fault planted | Found |
|---|---|
| Duplicate products (entered again, years later) | **exact** |
| A barcode on two products | **exact** |
| Negative stock (sold, never received) | **exact** |
| Batches with no expiry date | **exact** |
| Customers duplicated by phone format | **exact** |
| One firm under three names, sharing a GSTIN | **exact** |
| Header totals drifting a paisa from their lines | **exact** |
| Order lines whose header was deleted | **exact** |
| Tax codes nobody can map | **exact** |
| Documents struck under a superseded rate table | **exact** |

| # | What happens | Control proven |
|---|---|---|
| 11 | Every planted record checked **by id** | **Zero missed**, across all ten kinds — a right count over the wrong records is a lucky detector |
| 12 | The same pipeline run against **clean** data | **Zero findings.** The control that makes the rest mean anything: a detector that always fires detects nothing |
| 13 | The legacy data afterwards | **Unchanged.** `nothingWasModified` is a value, not a promise |
| 14 | `autoMerge` / `applyCleaning` / `discardException` / `clearExceptions` | **None exist**, asserted by test (hard rule #6) |
| 15 | Every exception resolved | **Nothing removed.** The list is the same length, and each entry now carries a name and a reason |
| 16 | A merge | **A redirection, not a delete** — the retired id still resolves to its survivor, with the decider and the reason |
| 17 | Blocking exceptions before decisions | **Cutover blocked.** Cleared by a *decision* — including *"migrate as is"*. The owner may knowingly accept a valuation error; **nobody may accidentally inherit one** |

### 5. MG-05 — hard rule #7, ahead of everything

| # | What happens | Control proven |
|---|---|---|
| 18 | A load pointed at **production**, with no operator, an unverified extract, 22 blocking exceptions and a non-empty target | **Refused on the production target** — the first check, because every other refusal costs an evening and this one costs the shop |
| 19 | A production target labelled `staging-copy-safe-to-load` | **Still refused.** The *kind* decides; a reassuring name is not evidence |
| 20 | A load whose target was not prepared empty | **Refused** — *"a load that only works once is not a rehearsal, it is the cutover"* |
| 21 | A full-volume trial | Loads, and **projects the cutover window** — because that window is a real evening and *"about an hour"* is how a shop opens late |

### 6. MG-07 — an exclusion is the owner's, in writing

| # | What happens | Control proven |
|---|---|---|
| 22 | *"Too old"* offered as the reason | **Refused** — the reason given ninety per cent of the time and never true. *"A warranty claim in year four is exactly the record somebody needs"* (OD-05) |
| 23 | A manager approves the exclusion | **Refused: not the owner** |
| 24 | The proposer approves their own proposal, as the owner | **Refused** — *"the person who decided the data is not worth migrating is not the person to confirm it"* |
| 25 | An undecided exclusion | Explains **nothing**. The total it affects stays open, which is what forces the decision before cutover rather than after |

### 7. MG-06 / QG-07 — the total that proves nothing

| # | What happens | Control proven |
|---|---|---|
| 26 | Both sides of a control total derived the same way | **Refused.** *The one mistake in a migration nobody notices, because the report is green* |
| 27 | A stock value short by exactly the approved exclusion | **`explained`** — a real third state |
| 28 | The same, short by ₹1 more | **`open`** — *"an unexplained remainder is where a real error hides behind an approved one"* |
| 29 | The person who ran the load signs their own totals | **Refused (§28)** — *"not because they would lie, but because they already believe it worked"* |
| 30 | The **owner** signs the tax total | **Refused** — finance and tax are the CA's (M23 / C-01), however senior anybody else is |
| 31 | An open total signed *"close enough, it is late"* | **Refused.** There is no provisional signature — the last place a wrong opening balance can be stopped |
| 32 | Every total closed **and** signed | **QG-07 passed** |

### 8. MG-08 — opening balances are events

| # | What happens | Control proven |
|---|---|---|
| 33 | Opening state built before QG-07 | **Refused** — *"a compensating event on day one is a permanent scar on the ledger"* |
| 34 | 25 opening positions after QG-07 | **25 append-only events**, banked in real PostgreSQL. Not one balance written directly |
| 35 | An opening figure citing an unsigned total | **Refused, and the total named** |
| 36 | The whole opening state replayed | **Nothing banked twice** (§31.1) |
| 37 | `UPDATE` and `DELETE` on a banked opening event | **The database itself refuses**, by name (hard rule #2) |

### 9. MG-09 — the shop kept trading while we migrated

| # | What happens | Control proven |
|---|---|---|
| 38 | 40 changes, 5 of them dated before the extract cutoff | **35 applied, 5 refused** as already loaded — *"the double-count MG-09 exists to prevent"* |
| 39 | The entire delta re-sent | **35 already-applied, net movement zero.** A re-send is a **success** — one that errors cannot be resumed at midnight, and the recovery is somebody deciding by hand which half went in |
| 40 | The same delta against production | **Refused, nothing applied** |

### 10. MG-10 — the only step that tests against reality

| # | What happens | Control proven |
|---|---|---|
| 41 | Three days compared; day two is ₹4,500 out | A difference raised **open and unowned** — assigning an owner is a separate human act, because auto-assignment produces a list everybody assumes somebody else is on |
| 42 | *"The new system is probably right"* | **Refused** — last-write-wins with a sentence in front of it (hard rule #10). *"The stock error it hides surfaces at a count six weeks later"* |
| 43 | *"A ₹4,500 cash refund was keyed twice into the old system"* | **Accepted**, and which system was wrong is recorded — the pattern is the finding |
| 44 | Clean, bad, clean, clean, clean | **Three consecutive clean days, not four.** The counter resets, because whatever caused the bad day is what the run was looking for |

### 11. MG-11 — the rollback is the deliverable

| # | What happens | Control proven |
|---|---|---|
| 45 | Everything passes; the rollback is **designed** but never performed | **NO GO.** *"A designed rollback and a performed one differ on exactly the night it matters, and the decision gets made at 6am by a tired person"* |
| 46 | Eight checks failing | **All eight named at once** — one blocked five ways and reported one way produces five separate evenings |
| 47 | An unsynced till at the edge | **NO GO** — *"an unsynced till is an unmigrated sale, and it will not be found until the customer asks for the receipt"* (P-01) |
| 48 | GO and NO GO | **`shopKeepsTrading` is typed as the literal `true` on both** |
| 49 | A rollback at 5:40am | **One decision, by the person on the night.** No approval chain — *"a rollback that needs one gets performed an hour late, and the hour is the whole cost"* |
| 50 | The 25 opening events, after the rollback | **Still there.** Nothing is unwound; the second attempt is only cheaper if the first left its evidence behind (hard rule #6) |

### 12. MG-12 — retire the system, never the data

| # | What happens | Control proven |
|---|---|---|
| 51 | Retirement asked four months after cutover | **Refused.** Retention runs from the **latest record**, not the archive job or anybody's confidence |
| 52 | An archive whose restore was never demonstrated | **Blocked** — *"an untested archive is a hope, and it is tested when it is needed"* |
| 53 | Retention elapsed, everything settled | **The system may be retired.** `dataIsNeverDeleted` is typed as the literal `true`, and no delete function exists |

---

## What this settles, and what it does not

**Settled now, with no vendor letter and no real data:** the pipeline shape · discovery
completeness · seal and verification · mapping approval, conflict refusal and coverage · all ten
detectors, measured by identity against planted faults and against clean data · exception
retention and resolution · merge-as-redirection · the non-production guard · trial repeatability
and timing projection · exclusion approval by the owner alone · derivation independence ·
separation of duties on signing · CA-only finance and tax · QG-07 · opening state as append-only
events in a real database · delta idempotency · parallel-run discipline · the cutover checklist ·
rollback without a committee · retention arithmetic.

**Waiting on EX-02** (owner action pending — the vendor letter):

- The **real** legacy data, and therefore the real fault profile. The ten kinds planted here are
  drawn from what such systems contain; the incumbent will have its own proportions, and may have
  a kind nobody predicted. **The pipeline is built to surface an unknown kind as an exception
  rather than a silent default**, which is the property that matters — but the profile itself
  cannot be known until the extract exists.
- The **real volume**, and therefore the true cutover window. The projection arithmetic is proven;
  the input is not yet available.
- The real control-total figures, and the CA's signature against them.

**These do not block Stage 11.** The engine, the reconciliation and the exception handling are
proven. What remains is the data.

## A defect the rehearsal caught in itself

The first run of the duplicate detector reported **195 findings against 14 planted, and 182 on a
dataset generated clean.** Both numbers were wrong, for two separate reasons, and neither would
have been visible from a passing test:

1. **The generator was degenerate.** Product names were drawn from ten words and six sizes, so
   240 products collided constantly by construction. A finding could not be told from an
   accident. Fixed by building names distinct by construction — every duplicate in the dataset is
   now a planted one.
2. **The detector was under-specified.** An identical normalised name alone is not certainty in a
   hypermarket with a cafe: the same line legitimately exists as a grocery product and as a
   kitchen ingredient, on different costs and different tax treatment. `certain` now requires
   name **and** department; the same name across departments is reported as `probable`, for a
   person.

After both fixes: **every one of the ten detectors matches its planted count exactly, and a clean
dataset yields zero findings.** The second number is the one that matters — a detector that
always fires detects nothing.

Separately, three defects in the gate test itself: the append result field is `deduped`, not
`appended`; and the append-only assertions named a table that does not exist, so they were
**passing because a missing relation also throws**. Now asserted against `event_ledger` and
matched on the trigger's own message.

## Repeatability

Run-scoped prefix (`RUN = w<base36 timestamp>`) through every source, extract, exception, total,
event and difference id, so the suite repeats against an append-only database. The generator is
deterministic by construction and `datasetChecksum` is asserted stable across runs — which is
what allows a reconciliation figure to be asserted **exactly** rather than approximately. An
approximate migration test is a migration test that passes.

## Verdict

**Stage 11 rehearsal gate: PASSED.** MG-01…MG-12 exercised end to end, ten planted fault kinds
found by identity in exactly the planted quantity, zero findings on clean data, opening state
banked as append-only events in real PostgreSQL, and every refusal that matters demonstrated
rather than described. The real-data migration gate remains open pending EX-02.

## What the owner should check in the store

1. **Ask what happens to a product that exists twice in the old system.** The right answer is
   *"it is listed for somebody to decide, and nothing is merged automatically."* If anyone says
   the system merges them, that is the answer this stage was built to make impossible.
2. **Ask to see the list of problems found in the old data.** It should be ordered with money and
   tax first, not alphabetically, and every line should say what was seen in words you can check
   against the old system yourself.
3. **Ask who signs the stock and tax figures.** Two different people, and the one who ran the load
   is not one of them. Tax and finance must be your CA.
4. **Ask to see the rollback performed.** Not the plan — the actual thing, done, with a date. If
   the answer is *"it is documented"*, the cutover is not ready.
5. **Ask what happens to the old system after we switch over.** The right answer is *"it stays,
   read-only, until the retention period ends — and the data is never deleted."* Not *"we can
   cancel the licence next month."*
6. **Ask what data we are leaving behind.** Anything left behind should have your written approval
   and a number attached to it. If the reason is *"it is old"*, say no.
