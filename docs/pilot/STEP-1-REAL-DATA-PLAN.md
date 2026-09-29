# Step 1: getting your real data in (preparation for the Option 2 decision)

**Date:** 28 September 2026
**For:** the owner of SRE Hyper Market first; his developer second (appendix at the end)
**Status:** a plan. Nothing in it has been started. Items marked "pending merge" are reported, not yet verified in the repository.

## Purpose

You said on 28 September 2026 (in that day's owner session; recorded in the 28 Sep 2026 entry of docs/STATUS.md, not yet in the decisions register) that you want to use the new system day to day in the real hypermarket, running **alongside** the existing ERP (your current billing and back-office software), without retiring that ERP. Before that can happen, the new system needs your **real** products, prices, suppliers, customers and stock. This document is the plain-English plan for getting that data out of the old ERP, checking it, loading it into a separate, walled-off copy of the new system, and proving every figure before anybody trusts it. It ends with the decisions only you can make.

## If you read nothing else

1. **Nothing loads until you write "Option 2 GO"** — silence is not a yes.
2. **You export the data; our software never touches the old system.**
3. **Real data goes into a separate, sealed-off rehearsal copy** — never the demo, never production. Where that copy lives is your Decision D0 in section 5.
4. **The bulk loader now exists** (29 Sep: `pnpm run migration:load`, with `pnpm run tenant:bootstrap` for the second tenant and docs/runbooks/real-data-load.md to follow). A GO today still does not mean a load this week: the export, the sealing, the cleaning decisions and the outside evidence come first.
5. **Decide now (Decision D3):** A (everything), B (one department's catalogue and prices — my recommendation), or C (wait). Details in section 5.

> ### Read this first — the guardrails this plan lives inside
>
> **(a) This plan prepares. It loads nothing, and it reads nothing real either.** Only Step 2.1 — you exporting your own data from your own system onto your own drive — may happen before your **written "Option 2 GO"**. Every step from 2.2 onward puts real rows into our software (the checker, then the discovery, mapping and cleaning routes, then the load), so **none of them starts before the written GO**, and none of them is ever run against the hosted demo server or its API (API = the software's own back door that programs call, as opposed to the screens) — only against the separate real-data environment named in the GO (Decision D0, section 5). "Option 2" is the name the project papers give to *loading a controlled copy of real product and price data*; as of 26 September 2026 it "remains unapproved" (docs/STATUS.md:53-54), and the 27 September stand-up runbook repeats "Option 2, unapproved" (docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md:9). Silence is not approval. A verbal "go ahead" is not approval. It must be in writing, dated, with your name.
>
> **(b) Real data never goes into the demo server's demo tenant.** The hosted demo holds only the demo tenant called `pilot-demo` (a tenant is one shop's own sealed compartment inside the system; two tenants never see each other's data; the demo one holds only made-up data). Gate G4 of the pilot gates reads: *"A demo-marked, non-real dataset exists and cannot mix with real data"* (docs/pilot/PILOT-GATES.md). The seed document says *"demo data cannot mix with a real tenant's data or exports"* (docs/pilot/PILOT-SEED-DATASET.md). Real data therefore needs its **own, separate environment** — its own database, storage and secrets — never a second tenant inside the demo's database. Which environment is Decision D0 in section 5. The mechanism for creating a tenant is documented — a tenant is created by seeding its first owner with `BOOTSTRAP_OWNER_TENANT_ID` and `BOOTSTRAP_OWNER_USER_ID` at boot (docs/pilot/ENV-VAR-INVENTORY.md:28-29; docs/pilot/SAFE-PILOT-ENVIRONMENT.md:27; docs/pilot/DEPLOYMENT-CHECKLIST.md:25) — but **no procedure exists for a second, real tenant beside `pilot-demo`**: those variables and `EDGE_TENANT_ID` each name one tenant, and no runbook covers adding another (see section 5).
>
> **(c) Our tools never touch the live legacy ERP database.** Under your decision OB-06 (7 August 2026: *"We migrate ourselves. Do not wait for the vendor"*), **you or your operator export** the data from the old system. Our software works **only on the exported files**. This is hard rule #7 of the project: never touch production data from development or test. The old ERP keeps trading throughout.
>
> **(d) Every trial load runs with `MIGRATION_TARGET_KIND=rehearsal`.** This is a setting that tells the migration software which kind of environment it is pointed at. Every migration command checks this setting before doing anything else, and refuses with the message `target_is_production` if it says "production". The pilot server's start-up file fixes it to `rehearsal` (details in appendix 7.1).
>
> **(e) Exceptions are kept, never deleted.** An "exception" is a record the checks could not accept (a duplicate product, a barcode shared by two items, negative stock, a tax code we cannot map). Hard rule #6 says audit evidence and migration exceptions are never deleted. The code has no delete function for them — a test asserts that no `discardException`, `clearExceptions`, `purgeExceptions` or `deleteException` exists (tests/unit/migration-cleaning.test.ts:95; packages/migration/src/cleaning.ts:15-18).
>
> **(f) Control totals are signed, and a CA signs the money.** A "control total" is one figure (for example, total stock value, or total owed to suppliers) computed in the old system and in the new one and compared. Quality gate **QG-07** passes only when every total has been reconciled and **signed by a named person**. Finance and tax totals can be signed **only by someone holding the chartered accountant role** — your **CA (chartered accountant)** — and whoever ran the load can never sign (packages/migration/src/reconcile.ts).
>
> **(g) Every loading step is run by a named human.** The AI prepares files, scripts and checklists and checks results. It does **not** export, load, sign, publish or approve anything. Each step below names who does it.
>
> **(h) Two things stay switched OFF, and releasing prices is a human act.** Payroll approval, payroll lock and bank-file release, and any bulk product publish or publish of a sensitive category (alcohol, tobacco, medicines), stay switched **OFF** until the server-side "step-up" check (a fresh re-login, backed by a second check such as a one-time code, demanded within the last five minutes before a dangerous action) is built and tested for them (docs/pilot/PILOT-FEATURE-MATRIX.md). Releasing prices to tills is done by a named person, never by the software on its own. On the demo, a price-list publish command was written but deliberately **not** run by the AI — the owner runs it (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge).

---

## 1. What this step delivers

When Step 1 is finished you will have:

1. **Your real master data** — products with barcodes, MRPs and selling prices, tax classes, suppliers, customers with loyalty points, and opening stock — loaded into a **separate, isolated pilot environment** that is clearly marked as a rehearsal and can never be mistaken for production.
2. **Every opening figure reconciled and signed**: one page, titled in the software *"Opening figures — what proved each one"*, showing each figure, what outside evidence proved it (a physical count, a bank statement, a filed tax return, a supplier statement, a customer's own word), and the names of the two people who signed — you and your CA (packages/migration/src/verification-report.ts).
3. **A written exception register** listing every record that could not be accepted, with a value in rupees, a named owner and your decision on each (docs/registers/migration-exceptions.md, today empty).
4. **Staff able to practise** on the real catalogue and real prices in the isolated environment, under their own named logins.
5. **A named person, a daily reconciliation routine, a maximum duration and a rollback trigger** written down, so the **parallel run** (old and new side by side) can start the day you say so.

What it does **not** deliver: the parallel run itself, the switch-over from the old ERP, or the retirement of the old ERP. Those are later steps with their own GO decisions.

---

## 2. The steps, in order

A note on effort: **no project document gives time estimates for these steps.** Where I write "rough effort" below, it is my own estimate, marked as such, and you should treat it as a guess until the first real attempt tells us better.

### Step 2.1 — Export from the existing ERP

**Who:** you, or a back-office person you name; a technical person if the database route is used. **Not** the AI and **not** the vendor.

**What they do, in plain words:**
1. **Copy first.** Before anyone reads anything, take an untouched copy of the old system's data onto a separate drive. Nobody opens it. This is the "preservation copy" (control MG-02; MG = the roadmap's migration controls). Do it after hours or with the program closed on every machine (docs/runbooks/extraction-work-plan.md).
2. **Two phone calls beforehand:** find *whoever installed* the current system (not the vendor's support desk) to learn where its database sits; and ask your CA for the *"journals-only" list* — balances in your accounts that came from the CA's journals rather than from the system (depreciation, provisions, accruals, drawings). That list exists nowhere in the old system (docs/runbooks/extraction-work-plan.md; docs/requirements/data-requirements.md B6).
3. **Count everything on the screen.** For each list you will export — products, customers, suppliers, stock lines — read the row count shown on the screen and **write it on paper** before exporting.
4. **Export by the best route available.** The runbook ranks four routes: **A** read the database directly (best), **B** the system's own "Export to Excel", **C** print a report to a file, **D** type it in by hand. Route D is *"Not a migration source"* except for tiny tables, and then two people must type it separately so the software can compare them (docs/runbooks/legacy-self-extraction.md). A printed stock report (Route C) **cannot** give batch codes, expiry dates or stock locations — that limit is known and accepted up front (docs/evidence/ob-06-we-get-it-out-ourselves.md).

**"Done" looks like:** one file per data set in section 3's checklist, the preservation copy sealed and stored, and a sheet of paper with a row count against every file.

**Rough effort (my estimate, not from any document):** one closed evening for the copy and the counts; the exports depend entirely on which route the old system allows, which is unknown until the back-office machine is examined.

**Tools that exist today:** none needed from us — this is the old system's own export. The AI can prepare the checklist and the paper count sheet.

### Step 2.2 — Check the export (`extract:check`)

**Who:** the person who exported, or the developer, at a computer with the repository. Named. Only after your written Option 2 GO, and only against the real-data environment it names — never the hosted demo API.

**What they do:** run each exported file through the checker, one at a time. The command, exactly as the runbook gives it:

```
node --experimental-strip-types scripts/extract-check.mts <file> --column "Item Code" --rows <the number you wrote down>
```

(`pnpm extract:check <file> ...` is the same tool by its short name. Add `--sep "\t"` for a tab-separated file. Replace `"Item Code"` with any column name you can see in the file; the tool uses it to find the real header under the shop name and report title.)

The checker does two things. First, **"Is the whole file here?"** — it looks for four signs of a complete file (your written row count, "Page N of M", an end marker, and gaps in the item-number sequence) and **refuses** a file that fails any of them. A file it cannot verify is also refused. Second, it reads the file and tells you the header line, how many product rows it found, how many subtotal lines it set aside, every line it dropped and why, and whether the report's own printed total agrees with the sum of its rows. It prints one of three verdicts:

| Verdict | Meaning | What to do |
|---|---|---|
| **USABLE** | whole and readable | move on to the next file |
| **REFUSED** | short — usually one page of many | export again with **no filter and no page limit** |
| **COULD NOT READ** | header or separator not found | try a different `--column` or `--sep` |

The tool is honest about its limits: agreement between a report's printed total and its own rows *"proves only that the file is consistent with ITSELF"*, not that the number is right (scripts/extract-check.mts:187-189).

**"Done" looks like:** every file says USABLE — *"Not 'most of them'"* (docs/runbooks/cutover-weekend.md) — and each file's row count matches the paper.

**Rough effort (my estimate):** minutes per file once the export route is right; expect to re-export more than once.

**Tools that exist today:** the checker is built and has been tested by running it as a real program against sample files (appendix 7.1, `extract:check`).

### Step 2.3 — Profile and map

**Who:** the developer prepares; **you** approve (the Owner role holds the mapping-approval permission). Named. Only after your written Option 2 GO, and only against the real-data environment it names — never the hosted demo API.

**What they do:** the developer lists every source and its gaps (an unowned source, an estimated volume, a source that cannot be extracted) and then builds a **mapping table** — "old system code X means new system value Y" — for tax codes, units of measure, departments, accounts, branches, identities and document kinds. The rule is *"AN UNMAPPED VALUE IS AN EXCEPTION, NEVER A DEFAULT"*: a code we cannot map is written up, never guessed (packages/migration/src/mapping.ts). One old value mapping to two new values is refused at approval. You approve the table by name and date, with a written rationale.

**"Done" looks like:** the approved mapping table (returned to the operator to keep — the server does not store it) and a coverage report showing every value actually present in your files is mapped or listed as an exception.

**Rough effort (my estimate):** a working session with you, more if the tax-code list is long.

**Tools that exist today:** the discovery and mapping tools are built and tested. They hand the approved table back to the operator to keep; the server does not store it (appendix 7.1, MG-01 and MG-03).

### Step 2.4 — Clean (the exceptions register)

**Who:** the developer runs the detection; **you** read the problem list and decide each item (checklist items UAT-51, UAT-50, UAT-55 — "UAT" is *user acceptance testing*: your own staff testing it and signing off). Named. Only after your written Option 2 GO, and only against the real-data environment it names — never the hosted demo API.

**What they do:** the cleaning check reads the data and **changes nothing** — its response even carries `nothingWasModified: true`. It looks for ten kinds of problem: duplicate product, shared barcode, negative stock, batch without expiry, duplicate customer, duplicate supplier GSTIN (GST — Goods and Services Tax — registration number), document total mismatch, an invoice line whose invoice is missing, a tax code we cannot match to a GST rate, a tax document from before a GST rate change (packages/migration/src/cleaning.ts). Two kinds are **blocking** — an unmatched tax code and negative stock (packages/migration/src/cleaning.ts:94-96) — and a blocking exception left undecided stops the trial load (packages/migration/src/trial.ts:121-123). Each exception is then recorded in the register with a value in rupees and one of four decisions — in the register's own words, *"Migrate as-is · Correct at source · Transform with approval · Exclude with owner approval"* (docs/registers/migration-exceptions.md:22); in plain English: load as-is, fix it in the old system first, change it with your approval, or leave it out with your approval. Exclusion of old history (MG-07) needs your approval **in writing**; a reason like "too old" alone is refused by the software, and the person who proposed the exclusion can never approve it (packages/migration/src/history.ts).

**"Done" looks like:** every blocking exception either fixed at source or accepted by you in writing, and the register no longer empty.

**Rough effort (my estimate):** unknown until the first run — this is where the "real fault profile" of your data shows itself for the first time (docs/evidence/ob-06-we-get-it-out-ourselves.md).

**Tools that exist today:** the cleaning check and the history-exclusion tool are built and tested, and the cleaning tab on the web screen has been proven end to end. The exclusion decisions and your written acceptances are the only migration records the server keeps (appendix 7.1, MG-04, MG-07 and "Verification report"; services/migration/src/index.ts:843-868). **Caution:** the register file today still says extraction "needs AVR-03 (export method and lawful extraction rights)" and opens only at Stage 11. OB-06 decided we extract ourselves without waiting (EX-02 CLOSED — EX-02 is the external-dependency item for the legacy export), so that precondition is stale — but AVR-03 itself is still Open (docs/discovery/avr-closure.md:25) and its licence-terms question stands (docs/runbooks/legacy-self-extraction.md:28-30). Update the register to say extraction proceeds under OB-06, with AVR-03's licence question noted, before it is used.

### Step 2.5 — Master-data workshop (UAT-02)

**Who:** **you**, with your CA present for the tax items; the developer takes notes. Named.

**What they do:** work through the *Pilot Setup Workbook* (docs/runbooks/pilot-setup-workbook.md), which is the master-data workshop turned into a form. The decisions captured there that this data plan depends on:

- **OC-21 — default GST (Goods and Services Tax) rate and HSN per category** (OC = an item in the Owner Configuration Register; HSN is the tax classification code for goods). *"A product cannot go on sale without a tax class. Do this with your CA."* HSN is probably missing from the old system; every product without a confirmed HSN becomes an exception you sign — never a default (docs/requirements/data-requirements.md).
- **OC-06 / OA-7 — trading-day cut-off** (when one trading day ends and the next begins). Default 00:00. The workbook asks you to confirm it now (Part 1, "facts to give now"); the Owner Action Register lists "leave default 00:00 for the pilot" as the alternative to confirming it (docs/OWNER-ACTION-REGISTER.md:140).
- **OC-27 — scale barcode layout** for in-store weighed items (the barcodes starting 02 or 20–29).
- **OC-39 — loyalty tiers.**
- **OC-43 / OC-47 / OC-46 — shelf addresses, shelf layout plan, and who gets refill tasks.**
- **OC-05, OC-15, OC-20 — wastage reason codes, receipt header and footer, document number formats.**
- **OC-19 — licences with a named person** (FSSAI — the food-safety licence — Legal Metrology and local licences).
- Defaults to accept or change: approval limits (OC-10), supervisor override (OC-11), how much a delivery or an invoice may differ from the order before someone must approve it (OC-12/13), how long a till keeps accepting staff logins with no internet — 12 hours (OC-24), emergency access 4 hours (OC-25), languages English + Tamil (OC-22).
- **Deferred to the CA at the migration gate** (Part 4 of the workbook): unexplained-difference thresholds (OC-30/32/37/40, default ₹0), card commission and settlement lag from the merchant agreement (OC-31), GST slabs, rounding and periods (OC-33/34/35), CA-only accounts (OC-36), loyalty point cost (OC-38).
- Sheets A (licences), B (one named login per staff member — no shared logins), C (incident quick-card).

**"Done" looks like:** the workbook filled in and signed, and Sheet B (staff logins) complete so no one has to share a login.

**Rough effort:** the pilot plan schedules this as *Set-up Day 1* (docs/runbooks/pilot-plan-narrow-deep.md).

**Tools that exist today:** the workbook (a text version and a spreadsheet version). Note one inconsistency: the UAT calendar says the register has "28 items" while the workbook covers OC-01…OC-47; the workbook is the fuller list.

### Step 2.6 — Trial load (rehearsal, isolated)

**Who:** the developer, under your written Option 2 GO, into the isolated pilot environment. The operator's name is taken from their login. Named.

**What they do, in plain words:** stand up a fresh, empty, isolated environment (separate database, separate storage, separate secrets, `MIGRATION_TARGET_KIND=rehearsal` — docs/pilot/SAFE-PILOT-ENVIRONMENT.md), create a **real tenant that is not `pilot-demo`** with its first owner identity (owner action OA-6: an unprovisioned tenant can do nothing, by design), then load the checked files into it. The software's own order of refusals before any load: production target → no operator named → extract not verified against its seal (MG-02) → blocking exceptions still open (MG-04) → target not prepared empty (packages/migration/src/trial.ts). The cutover runbook requires the rehearsal to be run **at least twice** end to end, with the second exception list shorter than the first (docs/runbooks/cutover-weekend.md).

**"Done" looks like:** every file loaded into the isolated tenant, row counts in equal to row counts out per table, a new exception list, and the run repeated at least once more with fewer exceptions.

**Rough effort (my estimate):** cannot be estimated until the loader exists (next paragraph).

**Tools that exist today — and the honest gap:** none that actually loads. The current trial-load tool only estimates how long a load would take. **There is no program anywhere in the repository that reads a legacy export and writes products, barcodes, prices, stock, suppliers or customers into the new system.** The "Import & export" screen has a proper two-person approval, but its final step only writes a note in the audit log — the rows never reach the product, price, supplier, customer or stock records. Today the only way a record gets in is one record at a time, using the same commands a shop clerk would use on the screens (create tax class, create product, add barcode, set price, add supplier, receive goods, add customer). That is how the made-up demo data was loaded. A real loader must be **built and tested first** (hard rule #9) — see section 4, item 1, and appendix 7.1 (MG-05, M30 import screen, per-record routes) for the technical detail. Do not give an Option 2 GO expecting a load the same week.

### Step 2.7 — Reconcile and control totals ("every figure has a witness")

**Who:** the developer prepares the comparisons; **you** and your **CA** review; **two different signers, neither of whom ran the load** (UAT-52). Named.

**What they do:** every opening figure is proved against evidence from **outside** the old system — never against another report from the same system (the software refuses a total whose two sides are computed the same way: `same_derivation_both_sides`). The six witnesses (docs/runbooks/extraction-work-plan.md):

| Figure | Witness |
|---|---|
| Stock (products, barcodes, prices, batches) | the shelves — a **physical count**, planned by someone other than the extractor, high-value lines counted in full, counter never shown the expected quantity |
| Suppliers and purchases | **their own statements**, matched invoice by invoice, never netted |
| Sales | **the bank** — daily takings per tender against bank credits, using the card commission from your merchant agreement (the check refuses to run without it) |
| Tax | the **filed GST returns** (GSTR-1 and GSTR-3B, with acknowledgement number — ARN) |
| Books | your **CA's signed accounts** (signed with membership number; drafts refused; a "Suspense" or balancing figure refused) |
| Loyalty | a **sample of customers**, asked *"How many points do you think you have?"* without being told the balance |

Five kinds of control total exist: migration, stock, financial, tax, loyalty. **QG-07** passes only when there is at least one total, none is open, and all are signed. A difference against a filed return goes to the CA **in writing** before the opening books are signed (docs/runbooks/legacy-self-extraction.md).

**"Done" looks like:** every total signed; every unproved area accepted by you, by name, with a reason of your own (the software refuses "ok", "approved", "as discussed" or anything under 20 characters).

**Rough effort:** governed by outside parties — supplier statements, bank statements and return downloads have their own lead times; the count needs one closed evening.

**Tools that exist today:** the comparison and signing tools are built, and the reconciliation tab on the web screen has been proven end to end; the server does not keep the totals between runs (appendix 7.1, MG-06). The six witness checks exist inside the software but have no screen or command to reach them. Today the only way to give them a bank statement or a GST return is for the developer to type the figures into a test file by hand.

### Step 2.8 — Sign-off

**Who:** **you** and **your CA** (UAT-09: the control-total sign-off is yours and the CA's). Whoever ran the extraction may not prepare or sign the page — the software refuses it (packages/migration/src/verification-report.ts:211-217, 275-280); whoever ran the load may not sign the control totals behind it (UAT-52; packages/migration/src/reconcile.ts:225-230, `signer_ran_the_load`).

**What they do:** sign the page *"Opening figures — what proved each one"*, which shows each of twelve areas (products, barcodes, prices, stock, batches, suppliers, purchases, customers, loyalty, sales, tax, ledgers), its verdict, what proved it, what the proofs do **not** show, what still needs doing, and the exceptions you accepted (docs/evidence/example-verification-report.md — an illustration, not your figures). The page will not render until all twelve areas have an answer.

**"Done" looks like:** two signatures on that page; the CA's signature covering the finance and tax totals.

**Tools that exist today:** the signing page is designed, but it cannot yet be produced for real: the software never saves the three kinds of fact the page displays (what was extracted, what problems were found, who signed), and there is no button or command to sign it. Today it can be produced only inside a test. Your developer must build these first — see section 4, item 4 (technical detail in appendix 7.1, "Verification report").

### Step 2.9 — Refresh / delta

**Who:** the developer, after each fresh export by your operator. Named.

**What they do:** the shop keeps trading on the old ERP between the export and the parallel run, so prices, products and stock change. A "delta" is the list of changes since the export cut-off, applied **exactly once**: a change sent twice is reported as `already_applied` (a success, not an error); a change dated before the cut-off is refused as a double-count (packages/migration/src/trial.ts). Master data would also need to be **republished to the tills** as a signed catalogue pack — a human step (`POST /v1/catalogue/pack`, per store).

**"Done" looks like:** every change since the cut-off visibly listed with its outcome, and the applied-keys list carried to the next run.

**Tools that exist today:** the delta tool is built and tested, but somebody has to hand it the list of changes — **how changes are captured from the old ERP is undefined** — and the server does not remember which changes were already applied (appendix 7.1, MG-09). The in-store catalogue file is read once when the store computer starts; nothing fetches a new one automatically, so refreshing it means a person placing the new file by hand (docs/audit/OFFLINE_SYNC_AND_CONFLICT_STRATEGY.md).

### Step 2.10 — Hand-over to the parallel run

**Who:** **you** name the people; store staff ring both systems; a named person reconciles daily; the CA handles tax or finance differences.

**What they do:** agree in writing, before day one: (1) the **named person who reconciles every day** — today nobody is named, which is open risk **R-05 (HIGH)**: *"Nobody allocated to run the parallel period; the most common cutover-failure point ..."* (docs/registers/risks.md:18); (2) the **named incident owner** — gate G10 (the demo monitoring's incident owner was named as Chezhian — reported from the 28 Sep 2026 hosted stand-up, pending merge; docs/pilot/PILOT-GATES.md:23 still shows G10 as "⛔ live — owner names the person", so the pilot gate needs your written naming); (3) the **maximum duration** of the parallel run before escalation — no figure exists in any document; the software asks for the number of clean days required before switching over, and nobody has set that number; (4) the **rollback trigger** (when we go back to the old system) — the pilot papers already define it: *"a pre-agreed condition (a P0/P1 that cannot be fixed same-day, or a reconciliation difference that cannot be explained) means fall back to legacy — which is safe because legacy never stopped ..."* (docs/pilot/PILOT-READINESS-PACKAGE.md:37-39). In plain words: a fault that stops trading or corrupts money or stock (P0/P1 are the two most serious fault grades) and cannot be fixed the same day, or a daily difference that cannot be explained. Every difference is owned and valued the same day; explaining a difference by "the new system is probably right" is refused by the software (hard rule #10); clean days are counted in a row, and one bad day restarts the count from zero.

**"Done" looks like:** a one-page agreement with those four items signed by you, and the daily reconciliation sheet designed.

**Tools that exist today:** the day-by-day comparison logic exists and a web screen can display parallel days, but **nothing on the server records a day or a difference** — control **MG-10 is NOT STARTED** in the traceability, the cut-over folder is an empty placeholder, and no daily reconciliation sheet exists (appendix 7.1, MG-10). One more item before stock figures can be compared: on the demo, a till sale did not reduce on-hand stock on the stock screen (logged as H-13, a hosted-demo finding number, flagged for a roadmap check before any change) (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge).

---

## 3. What to export — checklist for whoever operates the old ERP

**Format:** no document fixes file names or a column order. The only requirement the checker enforces is a plain text file, comma-separated (or another separator given with `--sep`), quoted fields allowed, with a header row somewhere that contains a column name you can point to. Export every screen **with no filter and no page limit**, and write the on-screen row count on paper first. Every file must pass `extract:check` before anything else reads it (docs/requirements/data-requirements.md).

| Data set (data-requirements.md Part B) | Blocking? | Required fields | Preferred fields |
|---|---|---|---|
| **B1 Products** — "the single most important export" | **Yes** | Item code · Description · Barcode(s) · Category/department · Unit of measure · MRP (maximum retail price printed on the pack) · Selling price · Cost price · Tax rate · HSN code · Shelf life / expiry tracked · Age-restricted · Active/discontinued | Brand/manufacturer · Pack size / net quantity · Supplier code · Reorder level/quantity |
| **B2 Suppliers** | **Yes** | Name · Code · GSTIN · Address · Contact · Payment terms · Bank details · Opening balance | — |
| **B3 Customers and loyalty** | Yes if loyalty is carried | Customer code · Name · Phone · Address · Loyalty points balance · Tier · Consent state · Join date | — |
| **B4 Stock** | **Yes** | Item code · Location · Quantity on hand · Cost · Batch/lot · Expiry date · Last counted date | — |
| **B5 Open transactions** | **Yes** | Open purchase orders · Goods received not invoiced · Unpaid supplier invoices (with ageing) · Unpaid customer invoices · Open customer orders · Supplier credit notes · Customer deposits | — |
| **B6 Financial opening balances** | **Yes** | Trial balance as at cut-over · Chart of accounts · Bank balances · Cash in hand · **the CA's journals-only list** | — |
| **B7 History** (sales, purchases, stock movements, price history) | Deferrable | — | 24 months of sales history *"if it can be extracted, and no more"*; its absence is not a reason to delay |

**Barcodes** come in three kinds and all matter: the normal printed 13-digit manufacturer barcode (EAN-13; several per product is normal), the in-store weighed-item barcodes printed by your scales (starting 02 or 20–29), and the short price look-up numbers keyed in for loose fruit and vegetables (PLU codes).

**Missing-field policy** (data-requirements.md): say *"we do not know"* rather than substitute a number — cost price loaded as unknown (never zero, never the selling price); expiry loaded as unknown and kept out of first-expiry-first-out; consent = none (migrated customers arrive with **no** marketing consent; re-consent is a campaign, not a field); supplier bank details **verified by phone to a number already held** before the first payment run.

**The witnesses to gather alongside the export** (these are outside documents, not legacy reports — the documents deliberately name **no** legacy report as verification, and refuse checking one legacy report against another):

Who gathers these: **you** — bank statements and the card-machine agreement; **your CA** — the GST returns and the signed accounts with the journals-only list; **your back-office person** — the supplier statements, requested in writing on one date; **a counting team you name, none of whom did the export** — the physical count.

- Bank statements for the whole period and a week or two past the end
- GST returns (GSTR-1 and GSTR-3B PDFs, each with its acknowledgement number) for every month migrated
- Supplier statements from **every** supplier, all as at one date
- Your CA's **signed** (not draft) accounts for the last completed year, plus the journals-only list
- The card commission percentage, from the paper of your card-machine agreement
- A physical stock count on one closed evening

---

## 4. What is not yet built or is manual

Honest list, from the research on the repository as the code stood on 28 September (code version e72b4ae):

1. **No real data loader** *(as at 28 Sep; partly closed 29 Sep — see below)*. Nothing read a legacy export and wrote products, barcodes, prices, stock, batches, suppliers, customers, loyalty, sales, tax or ledger records into the new system. The trial-load tool estimated timing only; the import screen's final step recorded an audit entry only; the only working path was one record at a time. **Update 29 Sep 2026 (B1a):** the load engine now exists and is tested — `planLoad` checks the extract (every bad row named, including the food/label safety rules) and refuses on the MG-05 preconditions (production target, the demo tenant, wrong tenant, no named operator, target not empty, unsealed extract, open blocking exceptions), then `executeLoad` sends tax rates, products, barcodes, prices, suppliers, customers (consent recorded as not given; opening points) and ONE opening goods receipt through the same routes a person uses, as the named operator, and reports every line (`packages/migration/src/load.ts`, `load-csv.ts`; `tests/integration/migration-load.test.ts`). Sales history, batches without expiry dates and ledger records are still outside it (B7 history is deferrable; a batch needs its expiry to be a batch). **B1b, 29 Sep 2026:** the operator's command exists — `pnpm run migration:load -- --dir <folder> [--dry-run]` reads the six CSV files, `manifest.json` (the seal of every file, MG-02) and `exceptions.json` (the cleaning report, MG-04), re-verifies the seals and the screen row counts, refuses on every MG-05 precondition, mints the operator's short-lived token from the box's `.env`, and loads over HTTP, writing an evidence file (`scripts/migration-load.ts`; runbook docs/runbooks/real-data-load.md; proven as a real subprocess over a real HTTP hop in `tests/integration/the-load-command-runs.test.ts`).
2. **No import templates shipped.** The import screen's template list comes from the store pack; no template for products, prices, suppliers, customers or stock exists outside test files. The screen accepts pasted text only (no file picker, no spreadsheet), one paste is limited to about 1 MB of text, and one bad row rejects the whole file.
3. **No procedure for a second, real tenant beside `pilot-demo`** *(closed 29 Sep 2026 — `pnpm run tenant:bootstrap -- --tenant <uuid> --owner <login> --admin <login>:chartered_accountant --operator <name>` lays down a new tenant's initial admin set once, atomically, refusing a production box, a non-UUID id, the demo tenant and an unknown role; runbook docs/runbooks/real-data-load.md step 1)*. The mechanism was documented — a tenant is created by seeding its first owner with `BOOTSTRAP_OWNER_TENANT_ID` and `BOOTSTRAP_OWNER_USER_ID` at boot (docs/pilot/ENV-VAR-INVENTORY.md:28-29; docs/pilot/SAFE-PILOT-ENVIRONMENT.md:27; docs/pilot/DEPLOYMENT-CHECKLIST.md:25) — but those variables and `EDGE_TENANT_ID` each name one tenant, no runbook covers adding another, and the stand-up runbook hard-codes the store computer's tenant to `pilot-demo`. Tenant ids must be UUIDs (a fixed-format unique identifier, not a readable name) — the event ledger declares `tenant_id uuid NOT NULL` (db/migrations/0001_event_ledger.sql:20; also 0002, 0003, 0007, 0009), so a non-UUID tenant such as `pilot-demo` cannot be written to the real PostgreSQL ledger (a bug found and fixed in the demo seed) (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge). Note: an earlier draft cited ADR-0003 for the UUID rule (ADR = a recorded architecture decision); that ADR contains no such rule — the database schema does.
4. **The signed verification page cannot be produced for real** — the software never saves the three kinds of fact it displays (what was extracted, what problems were found, who signed), and there is no command to sign it (technical detail in appendix 7.1).
5. **The six witness checks have no screen or command to reach them**; feeding them a bank statement or GST return means the developer typing the figures by hand into a test file. Attributing each bank credit to cash/card/UPI (Unified Payments Interface — phone payments) is *"read off the narrative by a person"*.
6. **MG-10 parallel run: NOT STARTED.** No route records a parallel day or a difference; docs/cutover/ is empty; no daily reconciliation sheet; no maximum duration; nobody named (R-05).
7. **Rollback of a real cut-over is runbook-only** and has never been rehearsed on real data (UAT-53 open). The demo's code rollback and backup-restore drills did pass (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge) — that is a different, smaller thing.
8. **Delta capture is undefined** — how changes since the export cut-off are obtained from the old ERP.
9. **Signing separation is partly self-declared**: "who ran the load" is a field in the sign request, not read from a stored load record.
10. **Stale documents:** the exceptions register still makes extraction wait on AVR-03 (the item itself is still Open; only the waiting is stale — see Step 2.4); the Owner Action Register row OA-2 still lists EX-02 (the external-dependency item for the legacy export) as blocking although it is CLOSED; db/seed/README.md says the folder is "intentionally empty".
11. **All rehearsal evidence is synthetic** (KL-09 — KL = an entry in the Known Limitations list: *"Real legacy-data migration not performed"*). Real volume, real fault profile, real totals and the CA's signature are outstanding.
12. **Manual by nature:** HSN mapping with the CA; the physical count; asking loyalty customers; supplier statement requests and bank-detail call-backs; whether the old system can be put into read-only (fallback: a paper sign on the screen).
13. **Prerequisites on whichever server hosts the real-data environment (Decision D0) before any real data:** the switch to a safer way for the developer to log in to the server (a digital key instead of the master password) was prepared but put **ON HOLD** by your decision and is recorded as a must-do before any real data; the test of the store trading with the internet cut and catching up afterwards has not yet been run; the results document exists only on the server branch, not yet in main (all three reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge).

---

## 5. Decisions needed from you now

The decisions here are numbered D0, D3 and D4 so they cannot be confused with "Decision P — how to run in parallel" and "Decision L — start preparing real data now?" in the Owner gap summary (docs/pilot/OWNER-GAP-SUMMARY.md, section 7), which you receive the same day. D0 comes first because D3 depends on it.

### Decision D0 — where the real-data environment lives

| Option | What it means | Consequences |
|---|---|---|
| **i. A second, separate server** | A new host for real data only; the demo server stays demo-only. | Cleanest separation (its own machine, database, storage, secrets). It is a **purchase** — nothing is bought without your approval (EX-01 / OA-5), and it adds a second monthly hosting cost inside your ₹15,000/month ceiling (D3 in the decisions register). |
| **ii. A second isolated stack on the existing demo server** | A separate compose project (`sre-real`-style: own database, own storage volumes, own secrets) beside the demo stack on the same machine (docs/pilot/SAFE-PILOT-ENVIRONMENT.md isolation checklist). | No new purchase. Real data shares the machine with the demo, so a fault, resource exhaustion or compromise of the machine affects both; the demo can no longer be freely rebuilt without a check that the real stack is untouched. |
| **iii. A computer inside the store** | The isolated stack runs on a store machine, offline-first. | No hosting cost and the data never leaves the shop; needs that machine to exist (H-11: store-floor screens are sample-only until an in-store computer exists — reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge), plus your own backup drive and a named custodian. |

A second **tenant inside the demo database is not an option**: the pilot gate G4 promise is that demo data cannot mix with real data, and the demo's isolation is per environment, not per tenant.

### Decision D3 — the shape of the first real-data load

| Option | What it means | Consequences |
|---|---|---|
| **A. Full-catalogue rehearsal on a fresh, isolated pilot environment** | The six blocking data sets (B1–B6; B7 history is deferrable) exported, checked and trial-loaded into a new real tenant on a separate environment, then reconciled and signed. | Gives the real fault profile and real volume in one go and satisfies the "rehearsal twice" rule sooner. Needs the bulk loader, tenant creation, verification-report wiring and witness routes built and tested first — the longest lead time. Needs all outside evidence gathered (suppliers, bank, returns, CA, count). If Decision D0 is a new server, that is a purchase needing your approval first. **Note:** this is wider than Option 2 as the project papers define it (products and prices). If you choose A, your written GO must say so in words, listing all the data sets it covers. |
| **B. Catalogue-and-prices-only first slice** | Only the chosen pilot department's products, barcodes, tax classes and prices (B1 plus OC-21), matching the "narrow and deep" pilot plan, into the isolated real tenant. Stock arrives by goods receipt on Set-up Day 2. | Smallest thing that lets staff practise on real prices. Still needs the loader — or a scripted per-record load, which is itself a build item under 7.2 item 1 and needs its own tests before a named person runs it (hard rule #9) — and the real tenant, but not the bank/tax/supplier witnesses yet. Finance, suppliers and customers come later as a second slice, so the CA's signature is deferred, not skipped. Bulk product publish stays OFF, so publishing to tills is per-store pack publish by a named person. |
| **C. Wait** | Keep the hosted demo synthetic; build the missing pieces; revisit. | No risk to real data; staff practise on made-up data only; the 1 April 2027 pilot milestone (readiness map) gets no closer on the data side. |

Choosing B here is the same as choosing A under Decision L in the Owner gap summary (docs/pilot/OWNER-GAP-SUMMARY.md, Decision L option A — one department's products and prices into a separate, walled-off practice area).

My view, stated plainly: **B** is the smallest honest step and matches the pilot plan you already confirmed on 24 September; **A** should follow it, not replace it. Whichever you choose, the GO is written, dated and names the tenant and the environment.

### Decision D4 — the Option 2 GO itself

| Option | Consequence |
|---|---|
| **Give the written GO now, naming Decision D0's environment, the tenant, the load operator and the signers.** | Steps 2.2 onward may begin as the build items in 7.2 are finished and tested; the GO does not make the loader exist any sooner. |
| **Withhold it until 7.2 items 1–3 are built and tested.** | No real data leaves your machine; you sign once, against a working loader, instead of twice. This is the safer sequence and my recommendation. |

Either way the GO says: which Decision D3 option; which environment and tenant name; who is the named load operator; who signs (you, and the CA for finance/tax); and that the demo tenant `pilot-demo` and the demo server's database are untouched.

### Smaller decisions (each: pick one)

| Decision | Option 1 | Option 2 | Option 3 |
|---|---|---|---|
| **OA-7 trading-day cut-off** | Keep 00:00 (the default; the alternative offered in the Owner Action Register — the workbook asks you to confirm it). *Consequence:* safe for the pilot; late-night sales after midnight date to the next day. Needed before finance go-live either way. | Set a small-hours time (e.g. 02:00). *Consequence:* late-night sales stay with the trading day, but it must be fixed before finance go-live and never changed afterwards. | — |
| **OA-11 store map coordinates** | Give latitude/longitude now. *Consequence:* delivery can be switched on later without a further step. | Defer in writing to a named release. *Consequence:* delivery stays fail-safe OFF; nothing in this data step is blocked. | — |
| **Daily reconciler + incident owner (R-05 / G10) and maximum parallel duration** | Name a staff member and a number of weeks now. *Consequence:* the parallel run can start the day you give the GO. | Name yourself as both for the first weeks and set the duration then. *Consequence:* your own time (D2 in the decisions register: 30 hours/week) is spent on reconciliation; escalation is to yourself. | Leave unnamed. *Consequence:* the parallel run must not start (R-05 HIGH stays open). |
| **Server login switch-over (ON HOLD by you)** — the safer server login (a digital key instead of the master password). Before it can be switched on, please confirm with the hosting company that their emergency console (a back-door way in if the new key ever fails) works for your account (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge). | Confirm the emergency console and let it be done before any real data. *Consequence:* a stronger login on the server; one confirmation step from you. | Keep it on hold. *Consequence:* no real data may go onto that server (recorded must-do), so Decision D0 must be a different machine. | — |
| **Who holds the chartered-accountant role** | Your CA gets a named login with that role. *Consequence:* finance and tax totals can be signed. | Nobody yet. *Consequence:* Step 2.7/2.8 cannot complete; only stock and loyalty totals can be signed. | — |

---

## 6. What you should check, and how

1. **That nothing real has been loaded.** Ask your developer to sign in to the hosted demo and show you that the only tenant is `pilot-demo` and every screen carries the DEMO / PILOT — NOT PRODUCTION banner (English and Tamil). If real data appears anywhere on the demo server — a second tenant, a second database, a file — before your written GO names that server under Decision D0, stop.
2. **That the migration setting is "rehearsal".** Ask your developer to show you the line `MIGRATION_TARGET_KIND: rehearsal` in the pilot server's start-up file, and then to run the automated test that pretends the setting is "production" — the software must refuse with the message `target_is_production`.
3. **That the old ERP was never touched.** Ask the exporting person: "Which files did we work on?" The answer must be the exported files and the sealed copy — never the live database. Ask to see the preservation copy on its separate drive.
4. **That every export was checked.** Ask to see the checker's output for each file — every one must say USABLE, and the row count must match the paper count you wrote.
5. **That exceptions exist and none was deleted.** Ask for the exceptions register: every row valued in rupees, with a named owner and your decision. If the list got shorter without a decision beside each removed item, ask why.
6. **That the stock figure was proved by a count, not a report.** Ask "What was the stock figure checked against?" The only acceptable answer is *"a physical count"* (docs/runbooks/legacy-self-extraction.md).
7. **That suppliers confirmed.** Ask for two lists by name: suppliers who confirmed, and suppliers who never replied.
8. **That the money was signed by the CA.** On the page *"Opening figures — what proved each one"*, the finance and tax rows must carry your CA's signature, not the developer's and not the load operator's.
9. **That prices reached the tills by a human hand.** Ask who ran the pack publish, and when; it must be a named person.
10. **That payroll bank-file release and bulk product publish are still off.** Ask to see the feature-matrix line (docs/pilot/PILOT-FEATURE-MATRIX.md:48-52) and ask the developer to show you two things on the API surface: (i) the one bank-file route that does exist, `POST /v1/hr/payroll/bank-file`, only **builds** the salary file from a locked pay run and returns it — there is no route and no bank connection that **sends** it to a bank (services/finance/src/payroll.ts:179-200; docs/pilot/FEATURE-SAFETY.md:28-30: "build-only ... transmits nothing — no bank connector on the surface"); and (ii) no bulk-publish route exists at all — products are published one at a time. FEATURE-SAFETY.md's heading describes this state as gated, but not "disabled by default" (docs/pilot/FEATURE-SAFETY.md:26-31, 50-54) — a paraphrase, not a quotation. Note the two documents describe the same state in different words. There is no refusal to demonstrate, because the sending and bulk actions do not exist to be refused. Do not be alarmed when a bank-file route shows up in the list: building the file is not paying anyone.

---

## 7. Developer appendix

### 7.1 IDs → routes / packages / scripts → source docs

| ID | Meaning | Where it lives today | Status | Source |
|---|---|---|---|---|
| Hard rule #7 | Never touch production data from dev/test | `assertNonProduction` in packages/migration/src/trial.ts; `assertSafeTarget` at top of every handler in services/migration/src/index.ts → `403 target_is_production` | Built, tested | CLAUDE.md; services/migration/src/index.ts:225-241 |
| `MIGRATION_TARGET_KIND` | Target kind: rehearsal / staging / local / production, fallback rehearsal | services/kernel/src/config.ts:163; infra/compose/docker-compose.pilot.yml:34; services/api/src/main.ts:1044 | Built | docs/pilot/MIGRATION-AND-ROLLBACK.md:14-15 |
| OB-06 | Owner decision 7 Aug 2026: self-extraction; EX-02 CLOSED | docs/registers/decisions.md:33; docs/registers/external-dependencies.md:23 | Decided | docs/runbooks/legacy-self-extraction.md |
| Option 2 | Loading a controlled copy of real product/price data — **unapproved** | docs/STATUS.md:53-54, 102-103; docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md:8-15 | Open owner decision | as cited |
| G4 | Controlled data gate — demo dataset cannot mix with real | docs/pilot/PILOT-GATES.md:17; docs/pilot/PILOT-SEED-DATASET.md:3-7, 26-31; tests/integration/pilot-seed.test.ts | ✅ for synthetic | as cited |
| G10 / R-05 | Named incident owner + daily reconciliation; nobody allocated to the parallel period | docs/pilot/PILOT-GATES.md:23-27; docs/registers/risks.md:18 | ⛔ live / Open | as cited |
| OA-6 / OA-7 / OA-8 / OA-11 | Genesis owner identity per tenant / trading-day cut-off / pilot and production GO / delivery coordinates | docs/OWNER-ACTION-REGISTER.md:139-141, 144 | Open | as cited |
| MG-01 Discovery | `POST /v1/migration/discovery` (read-only) | services/migration/src/index.ts:273-299; packages/migration/src/discovery.ts | INTEGRATION TESTED | docs/traceability.md:328-339 |
| MG-02 Preservation | `POST /v1/migration/extracts/:extractId/seal` (refused without verified backup restore); `POST /v1/migration/extracts/verify` | services/migration/src/index.ts:300-379 | INTEGRATION TESTED; stateless; no `ExtractionRun` writer | as cited |
| `extract:check` | `node --experimental-strip-types scripts/extract-check.mts <file> --rows N --column NAME [--sep C]`; exit 0/1/2 | scripts/extract-check.mts:7-15; package.json:41; packages/migration/src/completeness.ts; report-parser.ts | BUILT, run as subprocess in tests/integration/the-extraction-tool-runs.test.ts | docs/runbooks/extraction-work-plan.md:57-71 |
| MG-03 Mapping | `POST /v1/migration/mapping/approve`, `/mapping/coverage` | services/migration/src/index.ts:380-451; packages/migration/src/mapping.ts | INTEGRATION TESTED; stateless | as cited |
| MG-04 Cleaning | `POST /v1/migration/cleaning/exceptions` (`nothingWasModified: true`); web-erp MG-04 tab | services/migration/src/index.ts:452-519; packages/migration/src/cleaning.ts:32-42; apps/web-erp/src/migration-session.ts | E2E VERIFIED; no delete functions (tests/unit/migration-cleaning.test.ts:95) | docs/registers/migration-exceptions.md:7-9 (stale: makes extraction wait on AVR-03, which is Open — docs/discovery/avr-closure.md:25 — and opens only at Stage 11) |
| MG-05 Trial load | `POST /v1/migration/trial-loads` — declared `rowsToLoad`/`elapsedMs`; **no loader** | services/migration/src/index.ts:520-572; packages/migration/src/trial.ts:100-144 | INTEGRATION TESTED (traceability) — but a timing projection only; no data is loaded | docs/traceability.md:332 |
| MG-06 / QG-07 | `POST /v1/migration/reconciliation`; `POST /v1/migration/control-totals/sign` (CA only for financial/tax; `signer_ran_the_load`; `total_is_open`; `same_derivation_both_sides`); web-erp MG-06 tab | services/migration/src/index.ts:573-658; packages/migration/src/reconcile.ts:96-101, 167, 198, 225-244 | MG-06 E2E VERIFIED; QG-07 PARTIALLY WIRED; `loadOperator` is a body field (index.ts:626) | as cited |
| Six witness checks | count-, supplier-, banking-, tax-, books-, loyalty-verification | packages/migration/src/*.ts; not imported by services/migration/src/index.ts:13-42 | Engines only, no routes | docs/evidence/ob-06-every-figure-has-a-witness.md |
| Verification report | `GET /v1/migration/verification`, `/verification/page`; `POST /v1/migration/acceptances` | services/migration/src/index.ts:791-868; packages/migration/src/verification-report.ts; services/api/src/adapters.ts:7340-7403 | Routes exist; unreachable (no writer for `ExtractionRun`, `MigrationFindingRaised`, `MigrationReportSigned`); `signVerificationReport` unrouted | as cited |
| MG-07 Exclusions | `POST /v1/migration/history/exclusions`, `.../:exclusionId/decision`, `GET` | services/migration/src/index.ts:869-981; packages/migration/src/history.ts:67, 145-159 | BUILT, persisted (only persisted MG step besides acceptances) | as cited |
| MG-08 Opening events | `POST /v1/migration/opening-events` — returns events, does not append | services/migration/src/index.ts:659-693; packages/migration/src/reconcile.ts:312-329; tests/integration/the-old-shop-arrives-whole.test.ts:452-495 | INTEGRATION TESTED (traceability:335); plan assessment: partial — events returned, not appended | docs/traceability.md:335 |
| MG-09 Delta | `POST /v1/migration/deltas` — `already_applied` is success; pre-cutoff refused; `appliedKeys` returned | services/migration/src/index.ts:694-725; packages/migration/src/trial.ts:176-256 | INTEGRATION TESTED (traceability:336); plan assessment: partial — capture undefined, appliedKeys not stored | docs/traceability.md:336 |
| MG-10 Parallel run | `compareParallelDay`, `ownDifference` (refuses "new system is probably right"), `parallelRunPosition`; `requiredCleanDays` input | packages/migration/src/cutover.ts:67-212, 116; apps/web-erp/src/migration-session.ts:74-77 | NOT STARTED (no route, no persistence) | docs/traceability.md:337; docs/cutover/README.md:9-10 |
| MG-11 Cutover / rollback | `POST /v1/migration/cutover/decision` — eight checks, "not known" fails; `performRollback` unrouted; web-erp "Can we switch over" tab | services/migration/src/index.ts:726-790; packages/migration/src/cutover.ts:216-224, 316-347; cutover-checklist.ts | E2E VERIFIED (decision); rollback runbook-only | docs/runbooks/cutover-weekend.md |
| MG-12 Retirement | `POST /v1/migration/retirement/assessment`; `readOnly: true`; no `deleteArchive` | services/migration/src/index.ts:982-1013; packages/migration/src/history.ts:27-30, 269-274 | BUILT (what-if) | as cited |
| `chartered_accountant` role | `migration.reconciliation.read`, `migration.verification.read`, `migration.controltotal.sign` | services/api/src/roles.ts:241-255 | Defined | docs/STATUS.md:5885-5889 |
| M30 import screen | `/data-io`; `POST /v1/import/validate`, `POST /v1/import/commit` (apply callback no-op; `ImportCommitted` audit record only); `GET /v1/import/commits`; templates from pack `dataIoPolicy.importTemplates` (none shipped) | apps/web-erp/web/data-io.html; services/purchase/src/data-import.ts:170, 176-183; packages/import/src/import-job.ts:24-45; edge/store-edge/src/store-pack.ts:596-617; services/kernel/src/http-server.ts:23 (`MAX_BODY_BYTES = 1_048_576`) | WIRED; audit-only effect | docs/requirements/M30.md; docs/traceability.md M30 rows |
| Per-record domain routes | `POST /v1/catalogue/tax-classes/:hsnCode/rates/:effectiveFrom`; `POST /v1/catalogue/products/:productId/publish`; `.../barcodes/:code`; `.../pack`; `POST /v1/prices/changes`; `POST /v1/supplier-portal/partners/:partnerId`; `POST /v1/warehouse/bins/:binId`; `POST /v1/inventory/goods-receipt/:grnId`; `POST /v1/customers/:customerId/consent`; `.../points`; `POST /v1/catalogue/pack` | db/seed/pilot/apply.ts:188-341; services/catalogue/src/product-master.ts:62, 102-117; services/pricing/src/index.ts:64-119; services/catalogue/src/index.ts:91 | Built individually; bulk/sensitive publish DISABLED | docs/pilot/PILOT-FEATURE-MATRIX.md:48-52 |
| Pilot environment scripts | `pnpm db:migrate` (schema only), `pnpm db:backup`, `pnpm db:restore`, `pnpm verify:audit`, `pnpm run standup:check` | package.json:24-42; scripts/migrate.mjs; docs/pilot/SAFE-PILOT-ENVIRONMENT.md:47-49 | Built | docs/pilot/MIGRATION-AND-ROLLBACK.md:41-63 |
| UAT-02 workshop | Owner Configuration Register OC-01…OC-47 | docs/runbooks/pilot-setup-workbook.md; docs/registers/owner-configuration.md | Scheduled; date TBC | docs/registers/uat-calendar.md:19 (says 28 items — inconsistent) |
| UAT-50/51/52/53/55/09/11/54 | Duplicates · problem list · two-person + CA signatures · rollback watched · approve what is left behind · reconciliation sign-off · formal GO · legacy read-only | docs/runbooks/store-go-live-checklist.md:200-232; docs/runbooks/pilot-plan-narrow-deep.md:178-189 | Open | as cited |
| KL-09 | Real legacy-data migration not performed | docs/pilot/KNOWN-LIMITATIONS.md:16 | Open | as cited |
| H-11 / H-13 / ADR 0016 | Store-floor screens sample-only until in-store computer; till sale not reducing on-hand stock; demo store-edge design note | Server branch claude/pilot-hosted-standup only | Pending merge | 28 Sep 2026 hosted stand-up notes |

### 7.2 Build items implied by this plan (each needs tests before use, hard rule #9; none is authorised by this document)

1. A bulk loader from checked extract files into a named non-demo tenant, run under `MIGRATION_TARGET_KIND=rehearsal` by a named operator, refusing on the MG-05 preconditions. A scripted per-record load (Decision D3 option B) is the same build item with the same test obligation, not a shortcut around it. **Done 29 Sep 2026 — B1a engine (`planLoad` / `executeLoad` / `bundleFromFiles`) + B1b operator command (`pnpm run migration:load`, `scripts/migration-load.ts`) and runbook docs/runbooks/real-data-load.md.**
2. A documented procedure to create a second, real pilot tenant beside `pilot-demo` (UUID id — db/migrations/0001_event_ledger.sql:20 and the other `tenant_id uuid` columns in 0002, 0003, 0007, 0009) with its genesis owner (OA-6, `BOOTSTRAP_OWNER_*`, which today names one tenant only) and a `chartered_accountant` grant. **Done 29 Sep 2026 — `pnpm run tenant:bootstrap` (`scripts/bootstrap-tenant.ts`, `seedInitialAdmins`), runbook step 1.**
3. Writers for `ExtractionRun`, `MigrationFindingRaised`, `MigrationReportSigned`; a route for `signVerificationReport`.
4. Routes (or a checked CLI) to feed the six witness engines from transcribed evidence.
5. MG-10 routes and persistence for parallel days and differences; a daily reconciliation sheet; `requiredCleanDays` and maximum duration as owner-set values.
6. Register hygiene: docs/registers/migration-exceptions.md (re-word the AVR-03 precondition — extraction proceeds under OB-06, AVR-03's licence question noted, AVR-03 itself stays Open; open the register), docs/OWNER-ACTION-REGISTER.md OA-2, db/seed/README.md.
7. Reconcile branch claude/pilot-hosted-standup into main so HOSTED-DEMO-RESULTS.md, ADR 0016 and H-11/H-13 are in the repository.

### 7.3 Sources

Repository documents (commit e72b4ae, main):
docs/architecture/migration-design.md · docs/pilot/MIGRATION-AND-ROLLBACK.md · docs/pilot/SAFE-PILOT-ENVIRONMENT.md · docs/pilot/PILOT-SEED-DATASET.md · docs/pilot/PILOT-GATES.md · docs/pilot/PILOT-READINESS-PACKAGE.md · docs/pilot/PILOT-FEATURE-MATRIX.md · docs/pilot/FEATURE-SAFETY.md · docs/pilot/KNOWN-LIMITATIONS.md · docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md · docs/runbooks/legacy-self-extraction.md · docs/runbooks/extraction-work-plan.md · docs/runbooks/cutover-weekend.md · docs/runbooks/store-go-live-checklist.md · docs/runbooks/pilot-plan-narrow-deep.md · docs/runbooks/pilot-setup-workbook.md · docs/runbooks/pilot-deployment.md · docs/runbooks/in-store-install.md · docs/requirements/data-requirements.md · docs/requirements/M30.md · docs/registers/decisions.md · docs/registers/external-dependencies.md · docs/registers/migration-exceptions.md · docs/registers/risks.md · docs/registers/uat-calendar.md · docs/OWNER-ACTION-REGISTER.md · docs/traceability.md · docs/STATUS.md · docs/readiness-to-go-live.md · docs/evidence/stage-11-the-old-shop-arrives-whole.md · docs/evidence/ob-06-we-get-it-out-ourselves.md · docs/evidence/ob-06-every-figure-has-a-witness.md · docs/evidence/example-verification-report.md · docs/cutover/README.md · docs/api/catalogue.md · docs/audit/OFFLINE_SYNC_AND_CONFLICT_STRATEGY.md · db/seed/README.md · docs/pilot/ENV-VAR-INVENTORY.md · docs/pilot/DEPLOYMENT-CHECKLIST.md · docs/pilot/OWNER-GAP-SUMMARY.md · docs/discovery/avr-closure.md · docs/adr/0003-multi-tenant-configurable-product.md (checked: contains no tenant-id format rule).

Code read by the research: db/migrations/{0001_event_ledger,0002_sync_outbox,0003_config_versions,0007_idempotency_keys,0008_audit_log,0009_number_series}.sql · tests/unit/migration-cleaning.test.ts · services/migration/src/index.ts · packages/migration/src/{trial,reconcile,cleaning,mapping,discovery,history,cutover,cutover-checklist,verification-report,completeness,report-parser,extraction,count-verification,supplier-reconciliation,banking-verification,tax-verification,books-verification,loyalty-verification,synthetic}.ts · scripts/extract-check.mts · scripts/migrate.mjs · package.json · services/kernel/src/config.ts · services/kernel/src/http-server.ts · infra/compose/docker-compose.pilot.yml · services/api/src/{roles,adapters,main}.ts · services/finance/src/payroll.ts · services/purchase/src/{data-import,data-export,import-quality}.ts · packages/import/src/{import-job,delimited}.ts · apps/web-erp/web/data-io.html · apps/web-erp/src/{data-io-session,browser-entry,migration-session}.ts · edge/store-edge/src/{store-pack,screen-data}.ts · db/seed/pilot/apply.ts · services/catalogue/src/{product-master,index}.ts · services/pricing/src/index.ts · tests/integration/{the-extraction-tool-runs,the-old-shop-arrives-whole,data-import,pilot-seed}.test.ts.

Session notes: the 28 September 2026 hosted stand-up (MilesWeb Managed VPS, Mumbai; main at e72b4ae plus branch claude/pilot-hosted-standup, pending merge). No server address, credential, key, token or monitoring URL is reproduced here. **As of this document, that branch is not in the repository or its remote (the working copy shows only main, claude/js-yaml-security-fix and claude/new-session-lw91i4); every statement above marked "evidence on branch claude/pilot-hosted-standup" is a session report that nothing in the repository yet verifies. Treat them as unconfirmed until the branch is merged (7.2 item 7).**

---

## In plain English

You have decided to run the new system next to your old one in the real shop. For that it needs your real products, prices, suppliers, customers and stock. This paper says how that happens: **you** export the data from the old system (our software never touches it), a checker confirms each file is whole, we map and clean it and write every problem into a register you decide on, a named person loads it into a **separate, sealed-off rehearsal copy** — never the demo, never production — and every opening figure is proved against something outside the old system (the shelves, the bank, the filed tax returns, your suppliers' statements, your CA's signed accounts, your customers) before you and your CA sign one page.

Three honest warnings. First, **nothing loads until you write "Option 2 GO"** — silence is not a yes. Second, **the bulk loader does not exist yet**, and neither do the pieces that produce the signed page or record the daily comparison during the parallel run; your developer must build and test those first, so a GO today does not mean a load this week. Third, **nobody is yet named** to reconcile the two systems every day, and no maximum length for the parallel run has been set — those two names and one number are yours to give.

What to decide now: where the real-data copy lives (Decision D0 — a second server, a sealed-off second copy on the demo machine, or a computer in the store); then Decision D3 — **A** (everything, into a fresh isolated environment), **B** (one department's catalogue and prices first — my recommendation), or **C** (wait); then whether to give the written GO now or after the loader is built (Decision D4); plus the small items in section 5. What to check is in section 6: it comes down to asking, at each step, *"who did this, what was it checked against, and where is the paper?"*
