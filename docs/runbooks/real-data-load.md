# Runbook — loading the store's real master data into a rehearsal tenant (MG-05)

**Who this is for:** the named person doing the load (the "operator"), with the owner beside them for
the decisions. Comfortable following commands; not necessarily a programmer.
**What it does:** takes the six checked, sealed, cleaned files exported from the old ERP and puts them
into a **new, empty, real tenant** on a **rehearsal** box, through the same doors a person uses on the
screens — products, barcodes, tax rates, prices, suppliers, customers with their points, and ONE opening
goods receipt that becomes the opening stock ledger.
**How long:** minutes for a department; under an hour for the whole catalogue. The checks before it are
what take the days.

> **Three things this never does.** It never touches the old ERP (it only reads files you exported —
> OB-06). It never loads into the demo tenant or a production box (it refuses both by name). It never
> guesses: a bad row, a missing tax code, a batch without an expiry, a price above MRP — each is a line
> on your screen, not a default in your data.

> **Nothing here happens before the owner's written "Option 2 GO"** (docs/pilot/STEP-1-REAL-DATA-PLAN.md).
> Silence is not a yes.

---

## What you need

1. **A rehearsal box** — the pilot server or a separate machine — whose `infra/compose/.env` says
   `MIGRATION_TARGET_KIND=rehearsal` (or `staging` / `local`). The command reads this and refuses
   `production` outright. On the hosted demo box, also put the demo tenant's id in `DEMO_TENANT_IDS=`
   in the same file, so the demo tenant can never receive real data by accident.
2. **A real tenant of its own** — created by step 1 below. Never the demo tenant.
3. **The extract folder** — the files the old ERP exported, already through `extract:check`
   (docs/runbooks/legacy-self-extraction.md), named exactly:

   | File | Required? | Columns the loader reads (spelling, case, spaces and dashes do not matter) |
   |---|---|---|
   | `products.csv` | **yes** | item code · description · uom · category · hsn · mrp · selling price · cost price · barcodes (`\|`-separated) · allergens (`none` = declared none) · country of origin · net quantity · packer · status · brand · ingredients · storage |
   | `categories.csv` | if products name categories | category id · name · parent · regulated (`food`, `packed`, `weighed`, `age_restricted`, `drug`, `hazardous`, `\|`-separated) |
   | `tax-rates.csv` | **yes in practice** — every HSN a product names must have a rate | hsn code · effective from (YYYY-MM-DD) · rate % |
   | `suppliers.csv` | optional | supplier code · supplier name · gstin |
   | `customers.csv` | optional | customer code · loyalty points |
   | `opening-stock.csv` | optional | item code · qty (in the item's unit) · uom · cost · batch · expiry (YYYY-MM-DD) |

   Money is rupees with paise (`123.45`); the loader converts. A batch **without** an expiry is loaded
   as plain stock and the screen tells you so — supply the expiry if you want the batch tracked.
   A food item **must** say its allergens (`none` counts) and country of origin; a packed item its net
   quantity and packer — the same rules the product screen enforces.

4. **`manifest.json`** in the same folder — who, where, and the seal of every file (step 3).
5. **`exceptions.json`** in the same folder — the cleaning report (step 4). Needed only for a dry run with no
   `--api`; with an API the load reads the cleaning **decisions** from the cloud's register, and a decision that
   exists only in this file does not count (Stage C3c).

---

## Step 1 — create the real tenant (once)

A tenant is identified by a UUID (a fixed-format id such as `ab000000-0000-4000-8000-000000000042`,
not a readable name — the ledger will not accept a name). Generate one with `uuidgen` or any UUID tool
and **write it in the setup workbook** next to the store's name.

Then, on the box, with the owner's login name and the accountant's login name to hand:

```bash
pnpm run tenant:bootstrap -- --tenant <uuid> --owner <owner-login> \
  --admin <accountant-login>:chartered_accountant --operator <your-name> --dry-run
```

Read the list it prints. If it is right, run the same command **without** `--dry-run`. You should see
`SEEDED — 2 grant(s)`. Write down the date and the command.

What it refuses, on purpose: a production box · a tenant id that is not a UUID · the demo tenant ·
no owner · a role that does not exist · a tenant that already has anybody in it (a bootstrap never
widens an existing tenant — grants there are made person-to-person, requester and a *different*
approver, §28).

> Why an accountant now? Only a `chartered_accountant` can sign the finance and tax totals at
> reconciliation (MG-06). Adding them at birth means the sign-off can happen without a second
> bootstrap.

## Step 2 — the operator's login must exist in the new tenant

The `--owner` you named in step 1 is the operator for the load (or grant another person a role that can
publish products, set prices, receive stock and write customer consent — the owner role holds all of
these). The load command mints a short-lived token for that login from the box's identity-provider
settings (`IDP_*` in `.env`) — the same stand-in the pilot till uses. Nothing is printed or saved.

## Step 3 — seal every file and write the manifest

For **each** file in the folder, seal it through the API (the owner does this, with the API's URL and a
token from `pnpm run token:store -- --user <owner-login> --tenant <uuid>`):

```
POST /v1/migration/extracts/<extractId>/seal
{ "sourceId": "legacy-erp", "material": "<the whole file as text>", "rowCount": <data rows>,
  "extractedBy": "<who exported it>", "backupVerifiedAt": "<when the old ERP's backup was restored and checked>" }
```

The seal is refused without a **verified backup restore** of the old ERP (MG-02) — do that first, and
keep its evidence. The response is the seal. Put it in `manifest.json`:

```json
{
  "loadId": "load-2026-10-15",
  "tenantId": "<uuid>",
  "operator": "<owner-login>",
  "stockLocationId": "STORE-MAIN",
  "receivedOnDate": "2026-10-15",
  "currency": "INR",
  "files": {
    "products.csv":      { "seal": { ...the seal response... }, "declaredRows": 8412 },
    "categories.csv":    { "seal": { ... }, "declaredRows": 61 },
    "tax-rates.csv":     { "seal": { ... }, "declaredRows": 12 },
    "opening-stock.csv": { "seal": { ... }, "declaredRows": 8010 }
  }
}
```

`declaredRows` is the row count **you read off the old ERP's screen before exporting** — the one check
that does not depend on the file being honest about itself. `receivedOnDate` is the physical-count date
the opening stock is true at. `loadId` names the load; a re-run with the same id resumes and never
doubles anything.

## Step 4 — clean, decide, and put the report in the folder

Run the cleaning check on the dataset (`POST /v1/migration/cleaning/exceptions`, MG-04) and save its
response as `exceptions.json`. For every exception marked `blocking`, the **owner** decides in writing
(`merge` / `correct` / `exclude` / `migrate_as_is`, with a reason) and the decision is written onto that
exception as its `resolution` (`{ "action", "decidedBy", "decidedAt", "reason" }`). One undecided
blocking exception and the load refuses. No file at all and the load refuses — cleaning is not optional. **Since 29 Sep 2026 (Stage C3a) the same exceptions can also be RECORDED on the cloud** (`POST /v1/migration/exceptions` with the report's `exceptions` list) and each decided there by a named manager or owner (`POST /v1/migration/exceptions/<id>/resolution`) or from the migration screen at the store box — the register, what is still outstanding and any refused decision read back from `GET /v1/migration/exceptions`. **Since 29 Sep 2026 (Stage C3b) the migration screen at the store box shows this register from the cloud** — it pulls `GET /v1/migration/screen` on its sync loop (exceptions with the decisions folded in, totals, parallel-run terms and days, refused decisions) and keeps the last copy across a reboot, saying how old it is; nothing needs copying to the box. **Since 29 Sep 2026 (Stage C3c) the load command reads the cloud's register** (`GET /v1/migration/exceptions`) as the operator whenever it has an API: an exception the register knows is judged as the register has it; a decision written only into `exceptions.json` is **not** a decision — the command names it, counts it as undecided, and refuses if it is blocking, until a named person records it on the cloud. The file stays the cleaning pass's own report (and is all a no-API dry run has — the outcome then says the cloud was not consulted). With an API and a recorded register, the folder needs no `exceptions.json` at all.

## Step 5 — dry run

```bash
pnpm run migration:load -- --dir /path/to/extract --dry-run
```

Read every line. You should see `Seal verified —` for each file, the cleaning line, the `Read:` line
with the counts you expect, `Target tenant holds no products`, the `Plan:` line, and `DRY RUN —
nothing was sent`. Any `REFUSED` line names exactly one thing to fix. (Without `--api`, the dry run
says the target's emptiness was **NOT CHECKED**; give `--api http://127.0.0.1:8081` to check it too.)

## Step 6 — load

```bash
pnpm run migration:load -- --dir /path/to/extract --api http://127.0.0.1:8081 --out /path/to/extract/outcome-1.json
```

Expected ending: `LOADED — every step landed.` Keep `outcome-1.json` — it is the evidence of what went
in, and it holds no token. If some steps did **not** land, each is a `✗` line with the API's own
reason (a price below cost with no approver; a barcode already held by another item…). Fix the cause,
re-seal any file you changed, and run the **same** command again: it sends only what is missing.

## Step 6b — the later phases: history, open orders and the books' openings (GT-05)

The same folder may also hold these files (each sealed and listed in the manifest like the others):

| File | Columns | What it is |
|---|---|---|
| `opening-stock.csv` | add a `location` column | The store, back store, warehouse or cold room each count was taken at. Blank = the manifest's `stockLocationId`. |
| `history.csv` | kind, legacy_id, number, date, party, net, tax, gross, attachments | The old system's documents (sales invoices, returns, goods receipts, bills, payments, notes, journals), one row each, under their OLD id. |
| `history-lines.csv` | kind, legacy_id, item_code, qty, net, tax | Optional: the lines of those documents. |
| `history-control-totals.csv` | kind, count, gross, tax | Printed from the OLD system's own report — never worked out from the extract. |
| `attachments.csv` + an `attachments/` folder | legacy_id, file_name, content_type, sha256 | The scanned documents; each file is checked against its SHA-256. |
| `open-orders.csv` | po_id, number, supplier, deliver_to, item_code, ordered, received, unit_cost | Purchase orders still open on the old system, one row per line. |
| `trial-balance.csv` | account_code, account_name, debit, credit | The old trial balance at the opening date, one balance per ledger account, mapped to this system's accounts. |
| `trial-balance-totals.csv` | total_debit, total_credit, account_count | The totals PRINTED on the old trial balance. |

After the master data the same command reads the opening state back (stock per location and batch, value, points),
loads the history and reconciles it per kind, records the trial balance and raises the open orders. Two things it
never does itself, because they need a second person in their own session:

1. **The books open only when a second finance person signs the trial balance** (the accountant, the CA or the owner —
   not the operator): `POST /v1/finance/account-openings/<loadId>/sign-off` with the printed totals. A total that
   differs by a paisa is refused.
2. **The open orders are issued by a second person** who approves purchase orders: `POST /v1/purchase/orders/<poId>/approval`.
   (Their suppliers must first be approved by finance.)

Until then the command ends `NOT FINISHED — waiting on: …` (exit 1), naming each wait. Run the **same** command again
afterwards: it carries what the old system already received against each order, reads the ledger back account by account
against the old trial balance, and ends `FINISHED` (exit 0) only when every phase agrees. A re-run doubles nothing.

## Step 7 — reconcile before anybody signs

Check the new tenant against the sealed extract (MG-06): product count, barcode count, stock quantity
and value per department, customer count and points total. On the screens: Stock health for on-hand
and valuation; the catalogue for products. Nothing is signed until the figures agree
(docs/pilot/STEP-1-REAL-DATA-PLAN.md, steps 7–8).

**Every figure has a witness (the signed page).** With the same token the load used, the owner:

1. records who ran the extraction — `POST /v1/migration/extraction-runs/<runId>` `{ "operatorId": "<login>" }`
   (this person can then neither plan the count nor sign);
2. feeds each outside witness, transcribed from the document, to its route — `POST /v1/migration/witness/count`
   (the blind count sheet), `/suppliers` (their statements), `/bank` (the statement + your merchant terms),
   `/tax` (GSTR-1 and GSTR-3B with their acknowledgement numbers), `/books` (the CA's signed accounts),
   `/loyalty` (the customers' own answers). Each needs an `evidenceRef` naming the document. Evidence the check
   itself refuses — a count planned by the extractor, a commission "worked out from the difference", a return
   with no acknowledgement number, unsigned accounts — is refused and records **nothing**;
3. watches `GET /v1/migration/verification/progress` until all twelve domains have a finding;
4. reads `GET /v1/migration/verification/page` and, when it is ready, signs it —
   `POST /v1/migration/verification/signatures` `{ "statement": "<what you checked, in your own words>" }` — and
   the chartered accountant signs the same page. A signature belongs to the figures that were on the page;
   new evidence afterwards makes the page unsigned again (the old signature stays in the ledger).

---

## One department first (OB-241 · D3 option B) — `pnpm run migration:slice`

The owner decided (19 Oct 2026, OB-241) that the **first** real load is one pilot department's products, barcodes,
tax classes and prices — nothing else. Stock arrives afterwards by goods receipt; suppliers, customers and the books
come in a later slice. This is done with its own command, on the **store computer's real-data copy**
(`docs/runbooks/store-computer-real-data-environment.md`), and it differs from the full load above in three ways:

1. **Four published templates**, one row per line. Get them from the migration screen ("The figures" → "Templates for
   the first department" → Download) or with `pnpm run migration:slice -- --templates <folder>`:

   | File | Columns (in any order; the header must be exactly these names) | Must be filled |
   |---|---|---|
   | `tax-classes.csv` | hsn_code · effective_from · rate_percent | all three |
   | `products.csv` | item_code · sku · description · uom · category · hsn_code · brand · status · allergens · country_of_origin · net_quantity · packer · ingredients · storage · minimum_age | item_code, description, uom, category, hsn_code |
   | `prices.csv` | item_code · mrp · selling_price · cost_price · margin_floor_percent | item_code, mrp, selling_price, cost_price |
   | `barcodes.csv` | item_code · barcode · kind | item_code, barcode |

   Every product names the pilot department's category; a row from another department is set aside, not loaded.
   Money is rupees with paise (`123.45`); a blank price is never read as zero. Each file is read from disk — up to
   64 MB each, far beyond what a screen paste could carry.

2. **Row by row.** A bad row never stops the good ones. Each bad row is **quarantined** — set aside with its file,
   line, the old ERP's key (item code, HSN or barcode), the column and the reason — and a row that depends on it (the
   price or barcode of an item that was set aside) goes with it. The list is written to `slice-exceptions.csv` in the
   folder.

3. **A named person accepts the list before anything goes in.** Nothing is applied — not even the good rows — until a
   named person (the owner, or a store manager) has read the exception list and accepted it **by its digest**, in
   their own session. Change one byte of a file afterwards and the acceptance no longer matches: stage again.

### The folder

The four CSV files and `slice.json`:

```json
{
  "loadId": "slice-<department>-1",
  "tenantId": "<the real tenant's uuid>",
  "operator": "<the operator's login>",
  "storeId": "<the store whose tills the prices are for>",
  "department": { "categoryId": "<the pilot department's category id>", "name": "<its name>", "regulated": ["food", "packed"] },
  "files": {
    "tax-classes.csv": { "seal": { "...the seal route's response..." }, "declaredRows": 12 },
    "products.csv":    { "seal": { }, "declaredRows": 412 },
    "prices.csv":      { "seal": { }, "declaredRows": 412 },
    "barcodes.csv":    { "seal": { }, "declaredRows": 530 }
  }
}
```

Seal each file exactly as in Step 3 above (`POST /v1/migration/extracts/<extractId>/seal`, after the old ERP's backup
was restored and checked). `declaredRows` is the count read off the old ERP's screen. `operator` is only the login the
command signs in as — **the cloud records whoever that session is as the operator, never this field**, and that person
can then never sign the slice's control totals (MG-06).

### The three commands, by two different people

```bash
# 1. The operator stages it: every row judged, the load record kept on this copy under the operator's own session.
pnpm run migration:slice -- --dir /path/to/slice --stage --settings infra/compose/.env.real

# 2. A NAMED person reads slice-exceptions.csv and accepts it — in words, at least a full sentence.
pnpm run migration:slice -- --dir /path/to/slice --accept --as <their login> \
  --statement "read every quarantined row; the 4 items without allergen declarations wait for the next slice" \
  --settings infra/compose/.env.real

# 3. The operator applies it: only the staged rows, only if the files still give the accepted digest.
pnpm run migration:slice -- --dir /path/to/slice --apply --settings infra/compose/.env.real --out /path/to/slice/outcome-1.json
```

Expected endings: `RECORDED — load … is staged on the cloud by <operator>`, then `ACCEPTED — <person> accepted N
quarantined row(s)`, then `APPLIED — every staged row landed; N quarantined row(s) stayed behind, accepted by <person>`.

| Message | What it means | What to do |
|---|---|---|
| `REFUSED (production_target)` / `REFUSED (demo_tenant)` | wrong machine, or the demo tenant | Stop. Use the store computer's real-data copy and the real tenant |
| `SEAL BROKEN` / `SHORT` | the file changed after sealing, or is shorter than the old ERP's screen said | Re-export, re-seal |
| `the files do not follow the published templates` | a header is not the template's | Use the downloaded template |
| `REFUSED (not_accepted)` | nobody has accepted the list | Step 2, by a named person |
| `they changed after staging` | a file changed after the list was accepted | Stage again; have the NEW list accepted |
| `load_has_another_operator` | somebody else staged this load id | Use a new load id |
| `acceptance_explains_nothing` | the statement was too short ("ok") | Say what you read and decided |

The cloud keeps all of it (`GET /v1/migration/loads/<loadId>`): the staging, every quarantined row, who accepted the
list and when, and what landed. Nothing is deleted.

---

## Changes after the export — delta capture (MG-09)

Between the moment the old ERP's files are exported and the moment the slice is applied — and every day of the
parallel run after it — the shop keeps trading on the old ERP. Anything that changes there in the pilot department
(a new item, a new barcode, a price, a tax rate) must reach the new system **exactly once**, or the two systems drift
and every parallel-run day shows differences nobody can explain.

**What the software already does:** `POST /v1/migration/deltas` applies stock and sale changes exactly once, refuses
a change dated before the extract cut-off (it is already in the load), and records each one. It does **not** apply
product, barcode or price changes — those are refused by name, never counted as applied.

**The procedure, until the old ERP's export facts below are known:**

1. **Freeze.** From the export cut-off until the slice is applied, nobody changes items, barcodes, prices or tax
   rates of the pilot department in the old ERP. Put a paper sign on the old ERP's item screen. Write the cut-off time
   in the workbook.
2. **If a change cannot wait,** write it on the change sheet (time, item code, what changed, who) and key it into
   **both** systems: in the new system on its own screen (a price change goes through its approval), never by editing
   the files after sealing.
3. **During the parallel run,** every item, barcode and price change in the department is keyed into both systems the
   same day by the same named person, and initialled on the change sheet. The daily reconciliation (the migration
   screen, "Running both") shows any day the two disagree.
4. **Stock** arrives in the new system by goods receipt on the set-up day; stock and sales changes after the cut-off go
   through `POST /v1/migration/deltas` — once each, never twice.

**What we need to know from the old ERP before delta capture can be automated** (owner, with whoever supports the old
ERP — each answer goes in the workbook):

| # | Question | Why it matters |
|---|---|---|
| D-1 | Does the old ERP keep a change log, or a last-modified date and time, on items, barcodes and prices? | Without one, "what changed since the export" can only be found by comparing two full exports |
| D-2 | Can it export only the items changed since a given date and time? In what file format and columns? | That export is what a delta tool would read |
| D-3 | Does a price change carry its own effective date, or does it apply the moment it is keyed? | Decides which day a changed price belongs to |
| D-4 | Is an item code ever re-used for a different product? Can a barcode move from one item to another? | A re-used key would be loaded as a change to the wrong item |
| D-5 | Can the pilot department be made read-only in the old ERP (for the freeze), or is the paper sign the only lock? | The freeze's strength |
| D-6 | What time does the old ERP close its trading day, and is the export taken before or after it? | The cut-off must sit on a day boundary both systems agree on |
| D-7 | Who keys changes in the old ERP today, and can the same person key them in the new system the same day? | Dual keying during the parallel run needs a named person (OB-243) |

Until D-1 and D-2 are answered, there is no honest basis for a delta-capture tool: building one would mean guessing the
old ERP's export, which this project does not do.

---

## When it says no

| Message | What it means | What to do |
|---|---|---|
| `REFUSED (production_target)` | `MIGRATION_TARGET_KIND=production` on this box | You are on the wrong machine. Stop. |
| `REFUSED (demo_tenant)` | the manifest names the demo tenant | Use the real tenant from step 1. |
| `SEAL BROKEN — <file>` | the file changed after it was sealed | Find out why; re-export and re-seal. |
| `<file> is short` | fewer rows than you read off the screen | The export was cut (a page, a filter). Re-export the whole thing. |
| `exceptions.json is missing` / `no cleaning pass recorded on the cloud` / `blocking_exceptions_open` | cleaning not done, or a blocking exception undecided | Step 4. |
| `… is decided in exceptions.json only — not on the cloud` | a decision was typed into the file and never recorded | Record it: `POST /v1/migration/exceptions/<id>/resolution` (the owner or a manager), then run again. |
| `cannot read the cloud's exception register (HTTP 403)` | the operator's role does not read the cleaning register | Run as the owner or a store manager (step 2). |
| `row(s) could not be read` | each named by file and line | Fix the file once, re-seal, re-run. |
| `cannot read tenant … (HTTP 403)` | the operator has no role in this tenant | Step 1 / step 2. |
| `target_not_empty` | the tenant holds products this extract does not name | Rehearse on a fresh tenant, or run the delta (MG-09). |
| `✗ price P-… price_below_cost` | the route's own rule | Get a second person's approval on that price, or correct the cost. |

## Exit codes

`0` done (or dry run done) · `1` refused, not everything landed, or still waiting on a second person · `2` could not read what it was given.
