// The Customer Shopping agent's (A04) deterministic leg (audit EA-08 · A04 · M20 "the customer always confirms the cart").
//
// A04 calls no model and spends nothing. It reads head office's GOVERNED records — the product master (the category a
// product belongs to), the latest published catalogue pack (what is sellable and at what price) and the stock ledger's
// availability at each store — and drafts, for every sellable product that has run out at a store where it is stocked,
// the in-stock alternatives in the SAME category at that store, closest in price first. Each is a DRAFT for the app to
// offer: the CUSTOMER confirms any change to their cart (A04's approver is the customer). Nothing here appends an event,
// adds to a cart or changes an order (hard rule #5).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Proposal } from '../../ai/src/index';
import type { SignedPack } from '../../catalogue/src/index';
import { STREAM, inventoryAdapter, productMasterAdapter } from './adapters';

type Draft = Omit<Proposal, 'committed'>;
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** At most this many alternatives are drafted per out-of-stock product — a shortlist, not the catalogue. */
const MAX_ALTERNATIVES = 3;

export async function shoppingAlternatives(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const packs = await store.readStream(tenantId, STREAM.catalogue, { type: 'CataloguePublished' });
  const pack = packs.length === 0 ? undefined : (packs[packs.length - 1]!.event.payload as SignedPack);
  if (pack === undefined) return [];
  const sellable = new Map(pack.snapshot.products.filter((p) => p.status === 'active' && p.recallBlock !== true).map((p) => [p.productId, p]));
  const categoryOf = new Map((await productMasterAdapter({ store, now: () => now }).products(tenantId)).map((p) => [p.productId, p.primaryCategoryId]));
  const rows = await inventoryAdapter({ store, now: () => now }).availability(tenantId);
  const onHand = new Map(rows.map((r) => [`${r.productId}@${r.locationId}`, r.onHandMinor]));
  const out: Draft[] = [];
  for (const r of rows) {
    const wanted = sellable.get(r.productId);
    const category = categoryOf.get(r.productId);
    if (wanted === undefined || r.onHandMinor > 0 || category === undefined || category === null) continue;
    const alternatives = [...sellable.values()]
      .filter((p) => p.productId !== r.productId && categoryOf.get(p.productId) === category && (onHand.get(`${p.productId}@${r.locationId}`) ?? 0) > 0)
      .sort((a, b) => Math.abs(a.unitPriceMinor - wanted.unitPriceMinor) - Math.abs(b.unitPriceMinor - wanted.unitPriceMinor) || a.productId.localeCompare(b.productId))
      .slice(0, MAX_ALTERNATIVES);
    if (alternatives.length === 0) continue;
    out.push({
      proposalId: `a04-alternatives-${r.productId}-${r.locationId}-${now.slice(0, 10)}`, agent: 'A04', createdAt: now,
      summary: `${wanted.name} is out of stock at ${r.locationId}. If a customer asks for it, the app may offer: ${alternatives.map((a) => `${a.name} (${rupees(a.unitPriceMinor)}, ${onHand.get(`${a.productId}@${r.locationId}`)} in stock)`).join('; ')}. The customer chooses — nothing is added to any cart`,
      wouldRequire: 'the CUSTOMER confirms any change to their cart in the app — A04 only drafts the shortlist',
      evidence: [
        { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${r.productId}`, summary: `${r.productId} at ${r.locationId}: on hand ${r.onHandMinor}` },
        { source: 'catalogue pack', reference: `catalogue pack v${pack.snapshot.version}`, summary: `${wanted.name} ${rupees(wanted.unitPriceMinor)}; alternatives priced ${alternatives.map((a) => rupees(a.unitPriceMinor)).join(', ')}` },
        { source: 'product master', reference: `/v1/catalogue/products?category=${category}`, summary: `all in category ${category}` },
        ...alternatives.map((a) => ({ source: 'inventory availability', reference: `/v1/inventory/availability?productId=${a.productId}`, summary: `${a.productId} at ${r.locationId}: on hand ${onHand.get(`${a.productId}@${r.locationId}`)}` })),
      ],
    });
  }
  return out;
}
