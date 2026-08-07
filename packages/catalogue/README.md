# `packages/catalogue/`

The lane's **local catalogue cache and barcode lookup** — **M03** (product master) / **M12**
(scan) / **§31** (offline cache) / **§32** (sub-second scan). This is what turns a scan into a
priced line, with no network.

- **`src/catalogue.ts`** — `CatalogueCache`, built once from a **versioned snapshot** the lane
  holds locally:
  - **Fast** — the barcode index is a `Map`, so `scan(code)` is **O(1)** regardless of catalogue
    size (backs the ≤300 ms p95 scan target, §32). Indexing happens once at boot.
  - **Offline truth** — the snapshot carries `version` and `builtAt`; `ageSeconds(asOf)` and
    `isStale(asOf, maxAge)` make staleness **visible** rather than hidden (P-08 / §31
    "retain last-known-good").
  - **Safe at the scan** — a **recall-blocked** item is refused **even offline**
    (`RecalledItemError`, M10-FR-04); a `draft`/`discontinued` status is refused
    (`ItemNotSellableError`); an unknown code is refused (`UnknownBarcodeError`). Nothing
    reaches the bill on refusal.
  - **Age-restricted items** are flagged (`requiresAgeCheck`) so the lane prompts (M12-FR-04).
  - **Variable-weight / price-embedded barcodes** (M03-FR-02) are decoded per
    **`EmbeddedBarcodeRule`s that are per-tenant configuration** — prefix, item-code and value
    positions, and whether the embedded value is a **weight** (becomes the quantity) or a
    **price** (becomes the line price). Never hard-coded.
  - `findBySku` supports manual keyed entry when a barcode won't scan.

- **`src/snapshot-builder.ts`** — `buildCatalogueSnapshot(input)` produces that snapshot from the
  master data, closing the loop **M03 → M05 → the lane**:
  - Resolves each product's price through the **same effective-dated precedence engine** the rest
    of the system uses (`packages/price-list`: customer > channel > zone > store) at `asOf`, so a
    **future price never ships early** and the lane charges what the ERP says.
  - Attaches the **tax-class rate**, and carries **status**, **recall block** and **age
    restriction** through so the lane can refuse a scan safely offline.
  - **Never ships a product it cannot price safely** (P-08): one with **no effective price**, an
    **unknown tax class**, or a **price above its MRP** (M05-FR-02) is **excluded and reported
    with a reason** — never zero-priced or guessed. Barcodes for excluded products are **dropped**,
    so a lane can't scan into a product it doesn't hold.
  - **Draft/discontinued products are included (marked)**, so scanning one says *"not sellable"*
    rather than the misleading *"unknown barcode"*.
  - **Deterministic** — the caller supplies `version` and `asOf`, so the same inputs always build
    the same snapshot (rebuildable and auditable).

> The cache is a **read model, not a source of truth**. Wired into the POS via
> `apps/pos/src/view-adapter.ts` (`scanBarcode`). Tested in `tests/unit/catalogue.test.ts`,
> `tests/unit/catalogue-snapshot-builder.test.ts` and `tests/unit/pos-barcode-scan.test.ts`.
> Part of the repository layout in `CLAUDE.md`.
