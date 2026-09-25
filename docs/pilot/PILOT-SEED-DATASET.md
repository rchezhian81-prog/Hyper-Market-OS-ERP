# Controlled pilot seed dataset (Phase 4)

_Release candidate `pilot-rc-1`. Non-production pilot/UAT only. **Synthetic data — never real.**_

The pilot and the 12-role UAT need something realistic to exercise, but nothing real may be used
(hard rule #7, and the owner's authorisation is non-production only). This is the single, reproducible,
clearly-non-real dataset for that purpose.

## Where it lives

| File | What it is |
|---|---|
| `db/seed/pilot/dataset.ts` | the data + types — the source of truth for what gets seeded |
| `db/seed/pilot/apply.ts` | the applier — lays the data down by driving the REAL cloud routes |
| `db/seed/pilot/index.ts` | the barrel |
| `tests/integration/pilot-seed.test.ts` | the proof — applies the seed against the real surface and asserts it landed |

## Two principles that make this safe

1. **It is applied through the real routes, not written to the database.** The applier calls the same
   API routes a human operator would, as an authorised demo user, so every record passes the real
   validation, permission and idempotency guards. A seed can only create states the live system would
   accept — no back-door rows. (The one exception is identity provisioning — the tenant's first owner
   and the additional role logins — which use the same guarded provisioning path tenant onboarding uses,
   because a brand-new tenant has no one who could yet authorise a grant.)

2. **The demo marker is structural, not a flag.** Every record is scoped to one demo tenant,
   `pilot-demo`. Because the whole platform is tenant-isolated (P-02 — truth is per-tenant), demo data
   **cannot** mix with a real tenant's data or exports. Names are obviously non-real ("… (demo)") and the
   GSTIN is a synthetic, checksum-valid Tamil-Nadu number (`33AABCS1429B1Z1`) that belongs to no real
   business. The seed also carries a `SEED_MARKER` (`syntheticDataOnly: true`) for any operator output.

## What Slice 4a seeds (the foundation)

- **Genesis owner** (`pilot-owner`) via the guarded once-only genesis path.
- **Five more role logins:** store manager, cashier, accountant, chartered accountant, platform admin —
  each carrying its real role permissions (asserted in the test).
- **Entitlements:** `loyalty`, `delivery`, `dept.concession` (turned on so the routes gated on them
  become reachable in later slices).
- **Org skeleton:** a GST registration → a company → an active branch (filed under the demo GSTIN) → a
  warehouse. Each node is created as a draft and then activated through the real activation guard.

## What Slice 4b adds (the catalogue)

- **Tax/HSN:** four HSN rate schedules (rice 5%, edible oil 5%, toiletries 18%, biscuits 18%),
  effective-dated and append-only.
- **Categories:** a non-regulated household category and a **regulated food** category — so the
  food-safety publish gate (allergen declaration + country of origin) is genuinely exercised.
- **Products:** five, each **published through the real compliance gate** (mandatory name/SKU/UOM/
  category/HSN, plus safety content for the food items), carrying a barcode and, for two, a pack
  hierarchy (base + case, exact conversions enforced).
- **Prices:** a governed price for every product — below MRP and above cost, so no separate approval is
  needed (the price guard still runs).

## What Slice 4c adds (trading partners + stock)

- **Suppliers:** two supplier partners with portal grants; the food supplier's portal login is
  provisioned the `supplier` role (completing the login deferred from 4a).
- **Warehouse bins:** an ambient and a chilled bin in the demo warehouse.
- **Stock:** one goods receipt run **through the real receiving gate** — five lines received into the
  warehouse; the three food lines are batch-tracked with a batch id and a future expiry, all in good
  condition, so they become **sellable on-hand** (the gate refuses expired/undocumented batches).
- **Customers:** two demo customers, each with a consent record (with evidence); one carries a loyalty
  points movement.

## What Slice 4d adds (trading transactions)

A representative set of live-shaped transactions, all demo-marked, each through its own real guard:
- **Till + shift:** a till float (opens the till) and a clean blind-count shift close (no variance).
- **Serviceability:** a delivery-zone period (radius, fee, minimum order, free-delivery threshold).
- **Concession:** a revenue-share concession contract for the demo bakery counter.
- **Coupons:** a percent-off and an amount-off coupon.
- **OMS order:** an order that **reserves against the stock seeded in 4c**.
- **Payroll:** a clearly **demo-marked draft** pay run (no approval).
- **Sandbox e-invoice:** a B2B invoice submitted through the real Rule-46 eligibility + field gate
  (turnover over ₹5 crore + registered buyer), landing in the e-invoice register as `submitted`.

## Roadmap — all slices complete ✅

- **4a** — framework + foundation (identity, entitlements, org). ✅ done.
- **4b** — catalogue (products + categories + barcodes + UOM), tax/HSN rate schedules, prices + MRP. ✅ done.
- **4c** — suppliers, stock via goods-receipt (batches + expiry), warehouse bins, customers. ✅ done.
- **4d** — trading transactions (tills/shifts, online orders, serviceability, concession, coupons,
  demo-marked payroll, sandbox e-invoice). ✅ done.

The full seed applies as `applyPilotFoundation` → `applyPilotCatalogue` → `applyPilotTradingPartners`
→ `applyPilotTransactions`, all proven end-to-end in `tests/integration/pilot-seed.test.ts`.

## Honest boundaries

- **Categories with no write route yet** are recorded here, not faked:
  - **Delivery slot definitions** — slots are passed inline to a dispatch plan; there is no seedable slot
    store. The seed will seed serviceability *zones* (which do have a route) and note slots as inline-only.
  - **Tender-type / payment-method configuration** — tender kinds are fixed enums; there is no
    per-tenant tender-config store to seed.
  - A **sandbox GSP credential** is registered only through the admin-only partner registry; the seed uses
    the built-in sandbox provider and the durable e-invoice submit route instead.
- **Operational packaging (a real stand-up run):** the applier is the reproducible seed mechanism, proven
  today against the real surface in the integration test. Wiring it to a *running* pilot API and the
  pilot's test IdP (to mint the demo users' tokens) is part of the **environment stand-up**, which is
  gated on the actual cloud host + managed PostgreSQL decision (⛔ EX-01 / OA-5). It is deliberately not
  built as a standalone script that imports the whole service graph, because the repo's script runtime
  (`node --experimental-strip-types`) cannot load it, and a real run needs the running API + IdP anyway.

## Maturity

**All four slices: integration tested** — the whole seed lays down through the real surface and every
step is asserted in `tests/integration/pilot-seed.test.ts`. It becomes **pilot verified** when it is run
against the stood-up pilot environment (⛔ EX-01 / OA-5).
