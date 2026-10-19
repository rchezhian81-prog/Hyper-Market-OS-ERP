// E-waste handover and take-back register (R4 · B21) and battery take-back register (R4 · B22) · OB-212 · OB-227.
//
// B21: "An e-waste handover (old tills, scales, lights) is recorded with the weight and the recycler's registration
//       number. A handover with no registration number is refused ('recycler not registered'). An item a customer
//       brings back for disposal is recorded as a take-back, never as a sale return, and is kept out of saleable stock.
//       A disposed fixed asset with no e-waste handover is listed as an exception. Whether the shop must also register
//       as a brand owner is the CA's or consultant's answer; until then it shows 'not confirmed'."
// B22: "A used battery a customer returns is recorded as a take-back with its type and weight. It sits in a take-back
//       location that can never be sold from ('not saleable: take-back stock'). It leaves only on a handover to a
//       recycler with a recorded registration number; any other handover is refused ('recycler not registered').
//       Take-back stock on hand equals what was taken back less what was handed over; a difference is an exception.
//       Battery brand-owner duties show 'not confirmed' until the CA or consultant answers."
//
// Take-back stock lives in this register's own location, TAKE_BACK_LOCATION — never in the stock ledger, never on the
// catalogue pack, so no till can scan or sell it. The only way out is a handover to a recycler with a recorded
// registration number; any other way out is refused ("not saleable: take-back stock"). A fixed asset disposed of with
// no handover naming it is an exception until a handover names it or a person records, with a reason, that it was not
// electrical or electronic.
//
// Weights are whole grams. Pure and deterministic: no clock, no I/O.

export type TakeBackKind = 'e_waste' | 'battery';
export const TAKE_BACK_KINDS: readonly TakeBackKind[] = Object.freeze(['e_waste', 'battery']);

/** The register's own location for take-back stock — not a stock location; nothing sells from it. */
export const TAKE_BACK_LOCATION = 'epr-take-back';

export interface Recycler {
  readonly recyclerId: string;
  readonly name: string;
  /** The recycler's registration number with the pollution control board / CPCB; null while not recorded. */
  readonly registrationNumber: string | null;
  readonly by: string;
  readonly at: string;
}

export interface TakeBack {
  readonly takeBackId: string;
  readonly kind: TakeBackKind;
  readonly description: string;
  readonly weightGrams: number;
  /** Required for a battery (lead-acid, lithium-ion, …). */
  readonly batteryType?: string;
  readonly customerRef?: string;
  /** Store-local date YYYY-MM-DD. */
  readonly on: string;
  readonly location: typeof TAKE_BACK_LOCATION;
  readonly by: string;
  readonly at: string;
}

export interface HandoverLine {
  readonly description: string;
  readonly weightGrams: number;
  /** A fixed asset this line disposes of (B21: a disposed asset needs a handover naming it). */
  readonly assetId?: string;
  readonly batteryType?: string;
}

export interface Handover {
  readonly handoverId: string;
  readonly kind: TakeBackKind;
  /** 'take_back' — out of take-back stock; 'shop' — the shop's own items (old tills, scales, lights, UPS batteries). */
  readonly source: 'take_back' | 'shop';
  readonly recyclerId: string;
  /** Copied from the recycler at the handover, so the record shows the number it went under. */
  readonly registrationNumber: string;
  readonly lines: readonly HandoverLine[];
  readonly note: string;
  readonly on: string;
  readonly by: string;
  readonly at: string;
}

export interface TakeBackCount {
  readonly countId: string;
  readonly kind: TakeBackKind;
  readonly batteryType?: string;
  readonly countedGrams: number;
  readonly on: string;
  readonly by: string;
  readonly at: string;
}

export interface AssetNotEWaste { readonly assetId: string; readonly reason: string; readonly by: string; readonly at: string }

/** A refusal by name. */
export class EprRefusal extends Error {
  constructor(readonly code: 'recycler_not_registered' | 'not_saleable_take_back_stock' | 'more_than_take_back_stock', message: string) {
    super(message);
    this.name = 'EprRefusal';
  }
}

/** The stock a take-back sits in: e-waste as one, batteries by type. */
export const stockKeyOf = (kind: TakeBackKind, batteryType?: string): string =>
  kind === 'battery' ? `battery:${(batteryType ?? '').trim().toLowerCase()}` : 'e_waste';

/** The latest record per recycler. */
export function recyclersById(records: readonly Recycler[]): ReadonlyMap<string, Recycler> {
  const out = new Map<string, Recycler>();
  for (const r of records) out.set(r.recyclerId, r);
  return out;
}

/** The recycler a handover may go to — refused "recycler not registered" when unknown or without a registration number. */
export function registeredRecycler(recyclers: ReadonlyMap<string, Recycler>, recyclerId: string): Recycler & { readonly registrationNumber: string } {
  const r = recyclers.get(recyclerId);
  if (r === undefined) throw new EprRefusal('recycler_not_registered', `recycler not registered: "${recyclerId}" is not on the recycler list`);
  if (r.registrationNumber === null || r.registrationNumber.trim() === '') throw new EprRefusal('recycler_not_registered', `recycler not registered: ${r.name} has no registration number recorded`);
  return r as Recycler & { readonly registrationNumber: string };
}

/** Take-back stock may leave only to a recycler. Anything else — a sale, the shelf, a transfer — is refused. */
export function assertTakeBackLeavesOnlyToARecycler(to: { readonly kind: string }): void {
  if (to.kind !== 'recycler') {
    throw new EprRefusal('not_saleable_take_back_stock', `not saleable: take-back stock — it leaves only on a handover to a registered recycler, never by "${to.kind}"`);
  }
}

export interface TakeBackStockLine {
  readonly stockKey: string;
  readonly kind: TakeBackKind;
  readonly batteryType?: string;
  readonly takenBackGrams: number;
  readonly handedOverGrams: number;
  /** What was taken back less what was handed over. */
  readonly onHandGrams: number;
  readonly location: typeof TAKE_BACK_LOCATION;
  readonly saleable: false;
}

/** Take-back stock on hand per stock key: taken back less handed over from take-back stock. Pure. */
export function takeBackStock(takeBacks: readonly TakeBack[], handovers: readonly Handover[]): readonly TakeBackStockLine[] {
  const lines = new Map<string, { kind: TakeBackKind; batteryType?: string; inG: number; outG: number }>();
  const at = (kind: TakeBackKind, batteryType?: string) => {
    const k = stockKeyOf(kind, batteryType);
    const cur = lines.get(k) ?? { kind, ...(kind === 'battery' ? { batteryType: (batteryType ?? '').trim().toLowerCase() } : {}), inG: 0, outG: 0 };
    lines.set(k, cur);
    return cur;
  };
  for (const t of takeBacks) at(t.kind, t.batteryType).inG += t.weightGrams;
  for (const h of handovers) {
    if (h.source !== 'take_back') continue;
    for (const l of h.lines) at(h.kind, l.batteryType).outG += l.weightGrams;
  }
  return [...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([stockKey, v]) => ({
    stockKey, kind: v.kind, ...(v.batteryType === undefined ? {} : { batteryType: v.batteryType }),
    takenBackGrams: v.inG, handedOverGrams: v.outG, onHandGrams: v.inG - v.outG, location: TAKE_BACK_LOCATION, saleable: false as const,
  }));
}

/**
 * Refuse a handover out of take-back stock that is more than is held — per stock key, the lines may not exceed what is
 * on hand. Pure.
 */
export function assertWithinTakeBackStock(stock: readonly TakeBackStockLine[], kind: TakeBackKind, lines: readonly HandoverLine[]): void {
  const want = new Map<string, number>();
  for (const l of lines) want.set(stockKeyOf(kind, l.batteryType), (want.get(stockKeyOf(kind, l.batteryType)) ?? 0) + l.weightGrams);
  for (const [k, g] of want) {
    const held = stock.find((s) => s.stockKey === k)?.onHandGrams ?? 0;
    if (g > held) throw new EprRefusal('more_than_take_back_stock', `the handover takes ${g} g of ${k.replace('battery:', 'battery — ').replace('e_waste', 'e-waste')} out of take-back stock, but only ${held} g is held`);
  }
}

export interface TakeBackStockException {
  readonly stockKey: string;
  readonly countId: string;
  readonly countedGrams: number;
  readonly onHandGrams: number;
  readonly differenceGrams: number;
  readonly detail: string;
}

/**
 * The latest count of each stock key against what the register says is on hand: a difference is an exception. Pure.
 * (A count is judged against the register at read time; a later take-back or handover after the count is the
 * register's to explain, so a count should be taken with nothing in hand.)
 */
export function takeBackStockExceptions(stock: readonly TakeBackStockLine[], counts: readonly TakeBackCount[]): readonly TakeBackStockException[] {
  const latest = new Map<string, TakeBackCount>();
  for (const c of counts) latest.set(stockKeyOf(c.kind, c.batteryType), c);
  const out: TakeBackStockException[] = [];
  for (const [k, c] of latest) {
    const held = stock.find((s) => s.stockKey === k)?.onHandGrams ?? 0;
    if (c.countedGrams !== held) {
      out.push({ stockKey: k, countId: c.countId, countedGrams: c.countedGrams, onHandGrams: held, differenceGrams: c.countedGrams - held, detail: `take-back stock ${k.replace('battery:', 'battery — ')}: counted ${c.countedGrams} g on ${c.on}, the register says ${held} g (taken back less handed over) — a difference of ${Math.abs(c.countedGrams - held)} g` });
    }
  }
  return out.sort((a, b) => a.stockKey.localeCompare(b.stockKey));
}

/** A disposed fixed asset as the register reads it. */
export interface DisposedAsset { readonly assetId: string; readonly name: string; readonly category: string; readonly disposedOn: string }

export interface AssetException { readonly assetId: string; readonly name: string; readonly disposedOn: string; readonly detail: string }

/**
 * B21: every disposed fixed asset with no e-waste handover naming it is an exception — unless a person recorded, with a
 * reason, that it was not electrical or electronic. Pure.
 */
export function disposedAssetExceptions(assets: readonly DisposedAsset[], handovers: readonly Handover[], notEWaste: readonly AssetNotEWaste[]): readonly AssetException[] {
  const handed = new Set(handovers.flatMap((h) => h.lines.map((l) => l.assetId)).filter((a): a is string => a !== undefined));
  const cleared = new Set(notEWaste.map((n) => n.assetId));
  return assets.filter((a) => !handed.has(a.assetId) && !cleared.has(a.assetId))
    .map((a) => ({ assetId: a.assetId, name: a.name, disposedOn: a.disposedOn, detail: `${a.name} (${a.assetId}, ${a.category}) was disposed of on ${a.disposedOn} with no e-waste handover to a registered recycler` }))
    .sort((a, b) => a.disposedOn.localeCompare(b.disposedOn) || a.assetId.localeCompare(b.assetId));
}
