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
5. **`exceptions.json`** in the same folder — the cleaning report with every blocking exception decided
   in writing (step 4).

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
blocking exception and the load refuses. No file at all and the load refuses — cleaning is not optional.

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

## Step 7 — reconcile before anybody signs

Check the new tenant against the sealed extract (MG-06): product count, barcode count, stock quantity
and value per department, customer count and points total. On the screens: Stock health for on-hand
and valuation; the catalogue for products. Nothing is signed until the figures agree
(docs/pilot/STEP-1-REAL-DATA-PLAN.md, steps 7–8).

---

## When it says no

| Message | What it means | What to do |
|---|---|---|
| `REFUSED (production_target)` | `MIGRATION_TARGET_KIND=production` on this box | You are on the wrong machine. Stop. |
| `REFUSED (demo_tenant)` | the manifest names the demo tenant | Use the real tenant from step 1. |
| `SEAL BROKEN — <file>` | the file changed after it was sealed | Find out why; re-export and re-seal. |
| `<file> is short` | fewer rows than you read off the screen | The export was cut (a page, a filter). Re-export the whole thing. |
| `exceptions.json is missing` / `blocking_exceptions_open` | cleaning not done, or a blocking exception undecided | Step 4. |
| `row(s) could not be read` | each named by file and line | Fix the file once, re-seal, re-run. |
| `cannot read tenant … (HTTP 403)` | the operator has no role in this tenant | Step 1 / step 2. |
| `target_not_empty` | the tenant holds products this extract does not name | Rehearse on a fresh tenant, or run the delta (MG-09). |
| `✗ price P-… price_below_cost` | the route's own rule | Get a second person's approval on that price, or correct the cost. |

## Exit codes

`0` done (or dry run done) · `1` refused, or not everything landed · `2` could not read what it was given.
