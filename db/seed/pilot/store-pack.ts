// DEMO store pack for the demo store box (ADR-0016). Non-production, synthetic data only.
//
// A store edge's screens (the till, the manager's day, …) are fed from the STORE PACK it reads at boot
// (`EDGE_PACK_FILE`). The product has no delivery for it yet (the audit's "biggest gap": nothing fetches or
// builds it — docs/audit/OFFLINE_SYNC_AND_CONFLICT_STRATEGY.md). For the demo box only, this builds the
// PRODUCTS section — the part the till needs — from what the cloud has already published, so there is one
// commerce truth (P-02):
//   • name, price, tax, unit, status, recall flag, barcodes  ← the signed catalogue pack the owner published;
//   • category                                               ← the product master;
//   • on hand                                                ← the cloud stock ledger (summed across locations).
// Deliberately NOT invented:
//   • cost — the published pack does not carry it, so it is left out and the box reports those sales as
//     "uncostable" instead of a false 100 % margin;
//   • every other section (approvals, checklist, policies, …) — absent, so each screen says it has not been
//     told, which is true (store-pack.ts: "a pack that never arrived is not an empty pack").
// Pure: no clock, no I/O — the caller fetches and writes.

import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';

export interface DemoStorePackInput {
  /** The signed pack's snapshot, as `GET /v1/catalogue/pack` returns it (`body.snapshot`). */
  readonly snapshot: CatalogueSnapshot;
  /** Product master rows (`GET /v1/catalogue/products`): the category of each product. */
  readonly master: ReadonlyArray<{ readonly productId: string; readonly primaryCategoryId?: string | null; readonly nameTa?: string | null }>;
  /** Stock ledger rows (`GET /v1/inventory/availability`). */
  readonly availability: ReadonlyArray<{ readonly productId: string; readonly onHandMinor: number }>;
  /** Who ran it and when — recorded in the pack's comment, never used as data. */
  readonly builtBy: string;
  readonly builtAt: string;
}

export interface DemoStorePack {
  readonly _comment: string;
  readonly version: number;
  readonly products: ReadonlyArray<Record<string, unknown>>;
}

export function buildDemoStorePack(input: DemoStorePackInput): DemoStorePack {
  const category = new Map(input.master.map((m) => [m.productId, m] as const));
  const onHand = new Map<string, number>();
  for (const row of input.availability) onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.onHandMinor);
  const barcodes = new Map<string, string[]>();
  for (const b of input.snapshot.barcodes) barcodes.set(b.productId, [...(barcodes.get(b.productId) ?? []), b.code]);

  const products = input.snapshot.products.map((p) => {
    const m = category.get(p.productId);
    return {
      productId: p.productId,
      name: p.name,
      ...(typeof m?.nameTa === 'string' && m.nameTa !== '' ? { nameTa: m.nameTa } : {}),
      // A product with no category in the master is filed under an honest label, not a guessed category.
      categoryId: typeof m?.primaryCategoryId === 'string' && m.primaryCategoryId !== '' ? m.primaryCategoryId : 'uncategorised',
      unitPriceMinor: p.unitPriceMinor,
      uom: p.baseUom,
      taxBps: p.taxBps,
      status: p.status,
      recallBlock: p.recallBlock === true,
      barcodes: barcodes.get(p.productId) ?? [],
      // The cloud ledger's on-hand; a product with no movements has none on hand — that IS the ledger's answer.
      availableMinor: onHand.get(p.productId) ?? 0,
    };
  });

  return {
    _comment: `DEMO store pack (ADR-0016) — synthetic data only, not for production. Products section built from the published catalogue pack v${input.snapshot.version} by ${input.builtBy} at ${input.builtAt}. Cost and all other sections deliberately absent.`,
    version: input.snapshot.version,
    products,
  };
}
