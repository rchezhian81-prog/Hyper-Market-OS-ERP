// The store computer's half of the till's legal gates (roadmap v2.1 B6 · B14 · B19 · hard rule #1).
//
// Two jobs, both from what this box already holds — never a call off the shop:
//
//   • **Which scales a lane weighs on** (B6). Head office's store pack carries the store's weighing scales on the Legal
//     Metrology register (`weighingScales`), each naming the lanes it weighs for and the last day its stamp is valid.
//     `laneScalesFor` picks this lane's out for the served till. Never told (no section) is NOT "no scales": it is said,
//     and the till then sells nothing by weight, because no stamp can be shown to be current.
//
//   • **The second gate, before the disk** (B6 · B14 · B19). A sale record reaching the lane socket is judged line by
//     line against the SAME rules the till ran (`packages/restricted-sales/src/till-gate.ts`), from this box's own
//     catalogue and scales — so a till page that skipped its gate (an old page, a hand-made request) still cannot put a
//     banned plastic, a thin or free carry bag, a loose cigarette or a weight from a lapsed scale on a bill. Refused
//     before the disk, in the cashier's words. There is no override: each rule is a legal prohibition.

import { tillLineRefusals, type LaneScale, type LaneScales, type TillRefusalReason } from '../../../packages/restricted-sales/src/till-gate';
import type { StorePack } from './store-pack';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** One scale as head office's store pack carries it. */
export interface PackWeighingScale extends LaneScale {
  readonly laneIds: readonly string[];
}

/** Read the pack's scale register; an entry that cannot be read is left out and counted, never guessed. */
export function readWeighingScales(raw: readonly unknown[]): { readonly scales: readonly PackWeighingScale[]; readonly unreadable: number } {
  const scales: PackWeighingScale[] = [];
  let unreadable = 0;
  for (const r of raw) {
    const o = (r !== null && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const assetId = text(o['assetId']);
    const due = text(o['reverificationDueOn']);
    const lanes = Array.isArray(o['laneIds']) ? (o['laneIds'] as unknown[]).flatMap((l) => (text(l) === undefined ? [] : [text(l) as string])) : undefined;
    if (assetId === undefined || due === undefined || !DATE.test(due) || lanes === undefined) { unreadable += 1; continue; }
    const approvalNo = text(o['approvalNo']);
    const stamped = text(o['lastStampedOn']);
    const capacity = o['capacityGrams'];
    scales.push({
      assetId, reverificationDueOn: due, laneIds: lanes,
      ...(approvalNo === undefined ? {} : { approvalNo }),
      ...(stamped === undefined ? {} : { lastStampedOn: stamped }),
      ...(typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0 ? { capacityGrams: capacity } : {}),
    });
  }
  return { scales, unreadable };
}

/** The scales THIS lane weighs on, as the served till is told them (B6). */
export function laneScalesFor(pack: StorePack, laneId: string | undefined): LaneScales {
  const register = pack.weighingScales;
  if (register === undefined || !register.known) {
    return { known: false, why: register?.known === false ? register.why : 'the store setup from head office carried no weighing-scale register' };
  }
  if (laneId === undefined || laneId === '') return { known: false, why: 'this store computer was never told which lane it is' };
  const { scales } = readWeighingScales(Array.isArray(register.value) ? register.value : []);
  return {
    known: true,
    scales: scales.filter((s) => s.laneIds.includes(laneId)).map(({ laneIds: _laneIds, ...scale }) => { void _laneIds; return scale; }),
  };
}

/** What the box knows about a product it may judge a sale line by. */
export interface GateProduct {
  readonly name: string;
  /** NEW-2 (B6): the product's base unit in THIS box's catalogue — whether its line is weighed is decided from it. */
  readonly baseUom?: string;
  /** OB-173: the product's price in THIS box's catalogue — a carry bag is never charged below it. */
  readonly unitPriceMinor?: number;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
}

export type TillRulesAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusedBecause: TillRefusalReason; readonly productId: string; readonly laneMessage: string };

/**
 * Judge a sale record the till sent, before the disk (B6 · B14 · B19). `products` is this box's catalogue as the till was
 * given it; `scales` this lane's; `today` the shop's local calendar date. A line for a product the box does not know is
 * left to head office's intake (it is a catalogue question, not a legal gate the box can decide).
 */
export function checkTillRules(
  record: Record<string, unknown>,
  ctx: { readonly products: ReadonlyMap<string, GateProduct>; readonly scales: LaneScales; readonly today: string; readonly soldHuids?: ReadonlySet<string> },
): TillRulesAnswer {
  const lines = Array.isArray(record['lines']) ? (record['lines'] as unknown[]) : [];
  // B13: a HUID this box has sold, or one an earlier line of THIS bill already carries, is sold — refused before the disk.
  const sold = new Set<string>(ctx.soldHuids ?? []);
  for (const raw of lines) {
    const l = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const productId = text(l['productId']);
    if (productId === undefined) continue;
    const product = ctx.products.get(productId);
    const quantityMinor = typeof l['quantityMinor'] === 'number' ? l['quantityMinor'] : 0;
    const unitPriceMinor = typeof l['unitPriceMinor'] === 'number' ? l['unitPriceMinor'] : 0;
    const uom = text(l['uom']) ?? 'ea';
    // NEW-1 (B19): the line as CHARGED, after the promotion the till attributed to it — a free bag is refused here too.
    const chargedMinor = typeof l['lineTotalMinor'] === 'number' && Number.isFinite(l['lineTotalMinor']) ? l['lineTotalMinor'] : undefined;
    // OB-173: a carry bag is charged its full list price — the higher of this box's catalogue price and the line's price
    // before any change at the till.
    const override = (l['priceOverride'] !== null && typeof l['priceOverride'] === 'object' ? l['priceOverride'] : {}) as Record<string, unknown>;
    const fromUnit = typeof override['fromUnitPriceMinor'] === 'number' && Number.isFinite(override['fromUnitPriceMinor']) ? override['fromUnitPriceMinor'] : undefined;
    const listUnit = Math.max(product?.unitPriceMinor ?? 0, fromUnit ?? 0, unitPriceMinor);
    const refusals = tillLineRefusals({
      productId, description: product?.name ?? productId, quantityMinor, uom, unitPriceMinor, listUnitPriceMinor: listUnit,
      ...(chargedMinor === undefined ? {} : { chargedMinor }),
      // NEW-2 (B6): weighed or not is THIS box's catalogue's answer, whatever unit the record wrote (or left out).
      ...(product?.baseUom === undefined ? {} : { catalogueUom: product.baseUom }),
      ...(product?.regulatedFlags === undefined ? {} : { regulatedFlags: product.regulatedFlags }),
    }, { scales: ctx.scales, today: ctx.today, soldHuids: sold });
    const first = refusals[0];
    if (first !== undefined) {
      return { ok: false, refusedBecause: first.reason, productId, laneMessage: `Do not take payment. ${first.laneMessage} Nothing was saved.` };
    }
    const huid = product?.regulatedFlags?.['gold'] === true ? product.regulatedFlags['huid'] : undefined;
    if (typeof huid === 'string') sold.add(huid);
  }
  return { ok: true };
}
