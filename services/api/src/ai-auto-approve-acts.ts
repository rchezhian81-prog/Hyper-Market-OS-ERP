// CR-01 OI-12 step 6b — the assistants' drafts say EXACTLY what they would do (OB-761 A · OB-762 A), so an owner-set limit can
// measure them. Every number comes from something a PERSON already set or head office already holds — never invented:
//
//   • A02 REORDER (OB-761 A): up to the product's MAX LEVEL from its stored reorder settings (M09-FR-02, the Reorder tab),
//     worked out by the tested replenishment engine (`proposeReplenishment`: reorder point, pack rounding, supplier minimum) on
//     head office's own stock position for the store; at the supplier's LAST price (the newest issued purchase order with the
//     product on it); `supplierApproved` from the supplier master. No settings, no known supplier, no last price, or nothing
//     due → NO act, and the draft waits for a person as before.
//   • A03 MARKDOWN (OB-762 A): the D-4 expiry ladder (`proposeMarkdown`; the shop keeps no ladder of its own yet, so the D-4
//     ladder in packages/demand/src/markdown.ts is the shop's: 10% within 7 days, 25% within 3, 50% on the last day), and only
//     when a surplus will not sell before the date at the store's own rate of sale. The new price with the MRP and the cost
//     head office holds, as `POST /v1/prices/changes` takes them. The ladder says no markdown, or a figure is missing → NO act.
//   • A03 TRANSFER: how many is the DESTINATION's own reorder settings (the same engine, up to its max level), never more than
//     the source can spare above what it keeps for itself (its own reorder point or safety stock, or its forecast need);
//     valued at the source's own cost. Anything not known → NO act.
//
// Pure functions first (tests/unit/ai-auto-approve-exact-acts.test.ts), then `exactActsFor` reads the records they need.
// Nothing here writes anything (hard rule 5): the assistant drafts; a rule, or a person, decides.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DraftAct } from '../../../packages/ai/src/index';
import { proposeReplenishment } from '../../../packages/replenishment/src/replenishment';
import { proposeMarkdown, type MarkdownPolicy } from '../../../packages/demand/src/markdown';
import { salesHistory } from '../../../packages/demand/src/sales-history';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { parametersAt, type StoredParameters } from '../../inventory/src/replenishment-parameters';
import {
  inventoryAdapter, orgStructureAdapter, productMasterAdapter, purchaseOrdersAdapter, replenishmentFactsAdapter, replenishmentParametersAdapter,
} from './adapters';

/** An exact act, or why there is none (in plain words — the draft then waits for a person, as before). */
export type ActOrWhy = { readonly act: DraftAct; readonly why?: undefined } | { readonly act?: undefined; readonly why: string };

export interface Position { readonly onHand: number; readonly onOrder: number; readonly reserved: number }
export interface LastPrice { readonly supplierId: string; readonly poId: string; readonly unitCostMinor: number; readonly per?: number }

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const none = (why: string): ActOrWhy => ({ why });

/** OB-761 A: up to the max level from the stored settings, through the tested engine, at the supplier's last price. */
export function reorderActOf(input: {
  readonly productId: string; readonly storeId: string; readonly uom: string;
  readonly settings?: StoredParameters; readonly position: Position; readonly last?: LastPrice; readonly supplierStatus?: string;
  readonly blocked?: boolean;
}): ActOrWhy {
  const { productId, storeId, settings: s, last } = input;
  if (s === undefined) return none(`No reorder settings are stored for ${productId} at ${storeId}, so how many to order is a person's decision.`);
  if (last === undefined) return none(`There is no earlier purchase order for ${productId}, so no supplier or last price is known — a person decides.`);
  if (last.per !== undefined && last.per > 1) return none(`The last price for ${productId} was per pack of ${last.per}; the rule orders only at a per-unit last price — a person decides.`);
  const p = proposeReplenishment({
    productId, onHand: input.position.onHand, onOrder: input.position.onOrder, reserved: input.position.reserved, maxLevel: s.maxLevel,
    ...(s.reorderPoint === undefined ? {} : { reorderPoint: s.reorderPoint }), ...(s.safetyStock === undefined ? {} : { safetyStock: s.safetyStock }),
    ...(s.avgDailyDemand === undefined ? {} : { avgDailyDemand: s.avgDailyDemand }), ...(s.leadTimeDays === undefined ? {} : { leadTimeDays: s.leadTimeDays }),
    ...(s.minOrderQty === undefined ? {} : { minOrderQty: s.minOrderQty }), ...(s.orderMultiple === undefined ? {} : { orderMultiple: s.orderMultiple }),
    ...(input.blocked === true ? { blocked: true } : {}),
  });
  if (p === null || p.suggestedQty <= 0) return none(`${productId} at ${storeId} is above its reorder point under its reorder settings (version ${s.version}), so nothing is due.`);
  const valueMinor = valueAtCost(p.suggestedQty, input.uom, { minor: last.unitCostMinor });
  return {
    act: {
      kind: 'reorder_from_approved_supplier', supplierId: last.supplierId, supplierApproved: input.supplierStatus === 'active', valueMinor,
      lines: [{ productId, qty: p.suggestedQty, unitCostMinor: last.unitCostMinor, uom: input.uom }], deliverToLocationId: storeId,
      basis: `Reorder settings version ${s.version} for ${productId} at ${storeId}: up to the max level ${s.maxLevel} from a position of ${p.position}`
        + `${s.orderMultiple === undefined ? '' : `, in packs of ${s.orderMultiple}`}${s.minOrderQty === undefined ? '' : `, at least ${s.minOrderQty}`}`
        + ` → ${p.suggestedQty}; at ${last.supplierId}'s last price ${rupees(last.unitCostMinor)} a unit (purchase order ${last.poId}) = ${rupees(valueMinor)}.`,
    },
  };
}

/** OB-762 A: the D-4 ladder, only for the surplus that will not sell in time, at the price head office holds. */
export function markdownActOf(input: {
  readonly productId: string; readonly batchId: string; readonly storeId?: string; readonly daysToExpiry: number;
  readonly onHand: number; readonly avgDailyDemand: number;
  readonly shelfPriceMinor?: number; readonly mrpMinor?: number; readonly costMinor?: number; readonly policy?: MarkdownPolicy;
}): ActOrWhy {
  const { productId, batchId } = input;
  if (input.storeId === undefined) return none(`Batch ${batchId} is held at more than one store (or none), so no one shelf price can be cut — a person decides.`);
  if (input.shelfPriceMinor === undefined) return none(`${productId} has no shelf price at ${input.storeId}, so no markdown can be worked out — a person decides.`);
  if (input.mrpMinor === undefined) return none(`${productId} has no MRP on the product master — a person decides.`);
  if (input.costMinor === undefined) return none(`Head office holds no cost for ${productId} at ${input.storeId} — a person decides.`);
  const m = proposeMarkdown({
    productId, batchId, remainingShelfLifeDays: Math.max(0, input.daysToExpiry), onHandMinor: input.onHand,
    avgDailyDemandMinor: Math.max(0, Math.round(input.avgDailyDemand)), currentPriceMinor: input.shelfPriceMinor, ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
  if (m.reason === 'will_clear') return none(`At ${input.avgDailyDemand} a day, all ${input.onHand} of batch ${batchId} should sell before its date — no markdown.`);
  if (m.reason === 'too_early' || m.markdownBps === 0) return none(`Batch ${batchId} is not yet inside the markdown ladder — no markdown yet.`);
  return {
    act: {
      kind: 'markdown_short_dated', productId, batchId, percentOffBps: m.markdownBps, daysToExpiry: input.daysToExpiry, storeId: input.storeId,
      currentPriceMinor: input.shelfPriceMinor, newPriceMinor: m.newPriceMinor, mrpMinor: input.mrpMinor, costMinor: input.costMinor, surplusQty: m.surplusMinor,
      basis: `D-4 expiry ladder: ${m.surplusMinor} of ${input.onHand} will not sell in ${input.daysToExpiry} day(s) at about ${input.avgDailyDemand} a day → ${m.markdownBps / 100}% off, ${rupees(input.shelfPriceMinor)} → ${rupees(m.newPriceMinor)} at ${input.storeId}.`,
    },
  };
}

/** A transfer: the destination's own settings say how many; never more than the source can spare; at the source's cost. */
export function transferActOf(input: {
  readonly productId: string; readonly fromLocationId: string; readonly toLocationId: string; readonly uom: string;
  readonly destSettings?: StoredParameters; readonly destPosition: Position; readonly sourceHeld: number;
  /** What the source keeps for itself (its own reorder point or safety stock, or its forecast need). Unknown → no act. */
  readonly sourceKeeps?: number; readonly unitCostMinor?: number;
}): ActOrWhy {
  const { productId, fromLocationId: from, toLocationId: to, destSettings: s } = input;
  if (s === undefined) return none(`No reorder settings are stored for ${productId} at ${to}, so how many to move is a person's decision.`);
  if (input.sourceKeeps === undefined) return none(`It is not known how much ${from} keeps for itself (no reorder settings and no forecast there) — a person decides.`);
  if (input.unitCostMinor === undefined) return none(`Head office holds no cost for ${productId} at ${from} — a person decides.`);
  const p = proposeReplenishment({
    productId, onHand: input.destPosition.onHand, onOrder: input.destPosition.onOrder, reserved: input.destPosition.reserved, maxLevel: s.maxLevel,
    ...(s.reorderPoint === undefined ? {} : { reorderPoint: s.reorderPoint }), ...(s.safetyStock === undefined ? {} : { safetyStock: s.safetyStock }),
  });
  if (p === null || p.suggestedQty <= 0) return none(`${productId} at ${to} is above its reorder point — nothing to move.`);
  const spare = input.sourceHeld - input.sourceKeeps;
  if (spare <= 0) return none(`${from} holds ${input.sourceHeld} and keeps ${input.sourceKeeps} for itself — nothing to spare.`);
  const qty = Math.min(p.suggestedQty, spare);
  const valueMinor = valueAtCost(qty, input.uom, { minor: input.unitCostMinor });
  return {
    act: {
      kind: 'stock_transfer', productId, fromLocationId: from, toLocationId: to, qty, valueMinor, uom: input.uom,
      basis: `Reorder settings version ${s.version} for ${productId} at ${to}: up to the max level ${s.maxLevel} → ${p.suggestedQty}; ${from} keeps ${input.sourceKeeps} of its ${input.sourceHeld}, so ${qty} moves, at its cost ${rupees(input.unitCostMinor)} a unit = ${rupees(valueMinor)}.`,
    },
  };
}

/** What the A02/A03 legs ask for, per run (records read once per run and kept for its length). */
export interface ExactActs {
  readonly reorder: (productId: string, locationId: string) => Promise<ActOrWhy>;
  readonly markdown: (item: { readonly productId: string; readonly batchId: string; readonly qty: number; readonly daysToExpiry: number }) => Promise<ActOrWhy>;
  readonly transfer: (productId: string, fromLocationId: string, toLocationId: string, sourceForecastNeed?: number) => Promise<ActOrWhy>;
}

const once = <T>(f: () => Promise<T>): (() => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };
const DAY_MS = 86_400_000;

/** The records the pure functions need, read from head office's own ledger for one run. */
export function exactActsFor(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string) => ExactActs {
  const { store } = input;
  return (tenantId) => {
    const now = input.now();
    const branchOf = once(async () => branchOfLocationIn(await orgStructureAdapter({ store, now: () => now }).nodes(tenantId)));
    const versions = once(async () => replenishmentParametersAdapter({ store, now: () => now }).versions(tenantId));
    const settingsAt = async (place: string, productId: string): Promise<StoredParameters | undefined> =>
      parametersAt(await versions(), place).find((x) => x.current.productId === productId)?.current;
    const products = once(async () => new Map((await productMasterAdapter({ store, now: () => now }).products(tenantId)).map((p) => [p.productId, p] as const)));
    const uomOf = async (productId: string): Promise<string> => (await products()).get(productId)?.baseUom ?? 'ea';
    const pos = purchaseOrdersAdapter({ store, now: () => now });
    const orders = once(async () => [...await pos.all(tenantId)]);
    const facts = replenishmentFactsAdapter({ store, now: () => now, branchOf: async () => branchOf() });
    const availability = once(async () => inventoryAdapter({ store, now: () => now }).availability(tenantId));
    const heldAt = async (locationId: string, productId: string): Promise<number> =>
      (await availability()).filter((r) => r.locationId === locationId && r.productId === productId).reduce((t, r) => t + r.onHandMinor, 0);
    const unitCostAt = async (locationId: string, productId: string): Promise<number | undefined> => {
      const here = (await inventoryAdapter({ store, now: () => now }).valuation(tenantId, productId)).find((r) => r.locationId === locationId);
      return here === undefined || here.unitCostMinor === 'not_known' ? undefined : here.unitCostMinor;
    };
    const lastPrice = async (productId: string): Promise<LastPrice | undefined> => {
      const issued = (await orders()).filter((o) => o.status !== 'proposed' && o.issuedAt !== null && o.lines.some((l) => l.productId === productId));
      const newest = issued.sort((a, b) => ((a.issuedAt ?? '') < (b.issuedAt ?? '') ? 1 : -1))[0];
      const line = newest?.lines.find((l) => l.productId === productId);
      return newest === undefined || line === undefined ? undefined
        : { supplierId: newest.supplierId, poId: newest.poId, unitCostMinor: line.unitCost.minor, ...(line.unitCost.per === undefined ? {} : { per: line.unitCost.per }) };
    };
    const mrpOf = async (productId: string): Promise<number | undefined> => {
      const today = shopDateIn(now); // R1c: the shop's today, never the UTC date
      const h = [...((await products()).get(productId)?.mrpHistory ?? [])].filter((m) => m.effectiveFrom <= today).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
      return h[h.length - 1]?.value.minor;
    };
    return {
      reorder: async (productId, locationId) => {
        const storeId = (await branchOf())(locationId);
        const settings = await settingsAt(storeId, productId);
        const f = await facts.storeFacts(tenantId, storeId);
        const last = await lastPrice(productId);
        const lifecycle = (await products()).get(productId)?.lifecycle;
        return reorderActOf({
          productId, storeId, uom: await uomOf(productId), ...(settings === undefined ? {} : { settings }),
          position: { onHand: f.onHand[productId] ?? 0, onOrder: (f.onOrder[productId] ?? 0) + (f.inTransit[productId] ?? 0), reserved: f.reserved?.[productId] ?? 0 },
          ...(last === undefined ? {} : { last, supplierStatus: (await pos.supplierStatus?.(tenantId, last.supplierId)) ?? 'unknown' }),
          blocked: lifecycle === 'discontinued' || lifecycle === 'clearance',
        });
      },
      markdown: async (item) => {
        const of = await branchOf();
        const batches = (await inventoryAdapter({ store, now: () => now }).batches!(tenantId)).filter((b) => b.batchId === item.batchId && b.productId === item.productId && b.onHandMinor > 0);
        const stores = [...new Set(batches.map((b) => of(b.locationId)))];
        const storeId = stores.length === 1 ? stores[0]! : undefined;
        const at = batches.length === 1 ? batches[0]!.locationId : storeId;
        // The store's own rate of sale over the trailing 28 days (as D-4's markdown route and the clearance list use).
        // Loaded when asked, never at module load: r3-ops-adapters names its streams as it loads (adapters.ts may still be loading).
        const { shelfPriceAt, clearanceMarkdownAdapter } = await import('./r3-ops-adapters');
        let rate = 0;
        if (storeId !== undefined) {
          const to = shopDateIn(now); const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 27 * DAY_MS).toISOString().slice(0, 10); // R1c: the shop's today
          const sold = await clearanceMarkdownAdapter({ store, now: () => now, locationBranches: async () => of }).soldAtStore(tenantId, storeId, from, to);
          rate = salesHistory({ lines: sold, from, to }).products.find((p) => p.productId === item.productId)?.avgDailyDemandMinor ?? 0;
        }
        const price = storeId === undefined ? undefined : await shelfPriceAt({ store, now: () => now }, tenantId, item.productId, storeId, now);
        const mrp = await mrpOf(item.productId);
        const cost = at === undefined ? undefined : await unitCostAt(at, item.productId) ?? (storeId === undefined ? undefined : await unitCostAt(storeId, item.productId));
        return markdownActOf({
          productId: item.productId, batchId: item.batchId, daysToExpiry: item.daysToExpiry, onHand: item.qty, avgDailyDemand: rate,
          ...(storeId === undefined ? {} : { storeId }), ...(price === undefined ? {} : { shelfPriceMinor: price }),
          ...(mrp === undefined ? {} : { mrpMinor: mrp }), ...(cost === undefined ? {} : { costMinor: cost }),
        });
      },
      transfer: async (productId, from, to, sourceForecastNeed) => {
        const destSettings = await settingsAt(to, productId);
        const sourceSettings = await settingsAt(from, productId);
        const settingsKeep = sourceSettings === undefined ? undefined : sourceSettings.reorderPoint ?? sourceSettings.safetyStock;
        const keeps = settingsKeep === undefined && sourceForecastNeed === undefined ? undefined : Math.max(settingsKeep ?? 0, sourceForecastNeed ?? 0);
        const cost = await unitCostAt(from, productId);
        return transferActOf({
          productId, fromLocationId: from, toLocationId: to, uom: await uomOf(productId),
          ...(destSettings === undefined ? {} : { destSettings }),
          // The destination place's OWN shelf: what is on hand exactly there (a store's back store is not its shelf).
          destPosition: { onHand: await heldAt(to, productId), onOrder: 0, reserved: 0 },
          sourceHeld: await heldAt(from, productId), ...(keeps === undefined ? {} : { sourceKeeps: keeps }), ...(cost === undefined ? {} : { unitCostMinor: cost }),
        });
      },
    };
  };
}

/** Put the act on a draft, and say it exactly in the summary in place of "how many is a person's decision". */
export function withAct<D extends { readonly summary: string }>(draft: D, r: ActOrWhy): D & { readonly act?: DraftAct } {
  if (r.act === undefined) return draft;
  const said = draft.summary
    .replace(/\.? ?No reorder level is stored, so how many is the buyer's decision$/, '.')
    .replace(/\.? ?How many to order is the buyer's decision$/, '.')
    .replace(/ — how many is the manager's decision( \(no transfer level is stored\))?$/, '.')
    .replace(/ — how many is the manager's decision$/, '.');
  return { ...draft, act: r.act, summary: `${said.replace(/\.?$/, '.')} Exactly: ${r.act.basis ?? ''} Inside an owner-set limit a rule may approve it; otherwise a person decides.` };
}
