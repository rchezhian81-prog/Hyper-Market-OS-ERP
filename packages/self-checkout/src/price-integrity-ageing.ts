// D-7 (roadmap v2.1 addendum, ratified R2; pairs with B25) — the automated price-integrity audit.
//
// Acceptance, in the addendum's words: "Price-of-record vs shelf vs POS vs app are reconciled into an ageing exception
// report; asserted (pairs with B25)".
//
// B25's audit (`price-integrity.ts`) is a verdict on prices a caller hands it, at one moment. D-7 needs two things it could
// not give: it must read the prices ITSELF (nobody types them in), and an exception must have an AGE — "the shelf has been
// wrong since Tuesday" is a different problem from "the shelf changed an hour ago". Both come from facts head office
// already keeps, so the report is DERIVED on every read — no job to run, no exception store to drift:
//
//   • the PRICE OF RECORD — the effective-dated price list (M05-FR-01), resolved for the store at every moment;
//   • the SHELF / ESL / APP — the price each surface was SEEN showing (an observation: a shelf walk, an ESL echo, the app
//     reporting what it displayed), assumed to keep showing it until seen again — a label nobody re-checked after a price
//     change is still showing the old price;
//   • the POS — what the till actually CHARGED, read from the banked sale lines (never the till's code). A line lowered at
//     the till with a manager's approval (PF-07) is an approved override, not a mismatch.
//
// For each (product, surface) the surface's price is a step function of time, and so is the price of record; an exception
// is OPEN when they differ now, and it is open SINCE the earliest moment from which they have differed without a break.
// The age is measured from there. Nothing is dropped: a product with a price of record whose shelf was never seen is its
// own exception ("never observed") aged from when that price took effect.
//
// The kinds keep B25's asymmetry: a shelf or app showing LESS than the price of record is `shown_below_record` (the shown
// price is what the customer was offered — a legal exposure, ranked first), a till charging MORE than the price of record
// is `charged_above_record` (the customer paid more than the shop's own price — ranked with it).
//
// Pure and deterministic: the clock is injected; no I/O.

import { resolvePrice, type PriceEntry } from '../../price-list/src/price-list';

export type ObservedSurface = 'shelf_label' | 'esl' | 'app' | 'kiosk' | 'website';
export const OBSERVED_SURFACES: readonly ObservedSurface[] = Object.freeze(['shelf_label', 'esl', 'app', 'kiosk', 'website']);
export type ReconciledSurface = ObservedSurface | 'pos';

/** A price a surface was SEEN showing. */
export interface PriceObservation {
  readonly observationId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly surface: ObservedSurface;
  readonly priceMinor: number;
  readonly observedAt: string;
  readonly observedBy: string;
  readonly shelfAddress?: string;
  readonly deviceId?: string;
}

/** What the till charged for one unit on one banked sale line. */
export interface ChargedLine {
  readonly saleId: string;
  readonly productId: string;
  readonly unitPriceMinor: number;
  readonly committedAt: string;
  /** Lowered at the till with a manager's approval (PF-07) — not a mismatch. */
  readonly approvedOverride: boolean;
}

export type PriceExceptionKind =
  | 'shown_below_record' | 'shown_above_record'
  | 'charged_above_record' | 'charged_below_record'
  | 'never_observed';

export interface AgeingBand { readonly band: string; readonly fromDays: number }

/** The default ageing bands (days open). An owner decision; the route can be told others. */
export const DEFAULT_AGEING_BANDS: readonly AgeingBand[] = Object.freeze([
  { band: 'under 1 day', fromDays: 0 }, { band: '1-3 days', fromDays: 1 }, { band: '3-7 days', fromDays: 3 }, { band: 'over 7 days', fromDays: 7 },
]);

export interface PriceException {
  readonly productId: string;
  readonly surface: ReconciledSurface;
  readonly kind: PriceExceptionKind;
  readonly recordMinor: number;
  /** What the surface shows / the till charged (absent on `never_observed`). */
  readonly surfaceMinor?: number;
  readonly differenceMinor: number;
  readonly openSince: string;
  readonly ageMinutes: number;
  readonly ageDays: number;
  readonly band: string;
  /** The evidence the surface's price rests on: the last observation or the last sale line. */
  readonly evidence: string;
  readonly shelfAddress?: string;
  readonly deviceId?: string;
  readonly detail: string;
}

export interface PriceIntegrityAgeingReport {
  readonly branchId: string;
  readonly asAt: string;
  readonly productsChecked: number;
  /** Legal exposure first (shown below record, charged above record), then oldest first. */
  readonly exceptions: readonly PriceException[];
  readonly byBand: readonly { readonly band: string; readonly count: number }[];
  readonly oldestOpenSince: string | null;
  readonly detail: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const rupees = (m: number): string => `₹${(m / 100).toFixed(2)}`;
const WORDS: Readonly<Record<ReconciledSurface, string>> = { shelf_label: 'shelf label', esl: 'electronic shelf label', app: 'app', kiosk: 'kiosk', website: 'website', pos: 'till' };

/** One evidence point: from `at`, the surface showed / charged `priceMinor`. */
interface Point { readonly at: number; readonly priceMinor: number; readonly evidence: string; readonly shelfAddress?: string; readonly deviceId?: string }

function bandOf(ageDays: number, bands: readonly AgeingBand[]): string {
  let out = bands[0]?.band ?? '';
  for (const b of [...bands].sort((a, c) => a.fromDays - c.fromDays)) if (ageDays >= b.fromDays) out = b.band;
  return out;
}

/**
 * Reconcile every product's price of record against each surface seen at this store, and the till's charges, into an
 * AGEING exception report as at `asAt`.
 */
export function reconcilePriceIntegrity(input: {
  readonly branchId: string;
  readonly asAt: string;
  /** Every price-list entry of the products to check (any scope; resolved for this store). */
  readonly entries: readonly PriceEntry[];
  readonly observations: readonly PriceObservation[];
  readonly charged: readonly ChargedLine[];
  /** Surfaces every priced product must have been seen on (default: the shelf label). */
  readonly requiredSurfaces?: readonly ObservedSurface[];
  readonly bands?: readonly AgeingBand[];
}): PriceIntegrityAgeingReport {
  const asAtMs = Date.parse(input.asAt);
  const bands = input.bands ?? DEFAULT_AGEING_BANDS;
  const required = input.requiredSurfaces ?? ['shelf_label'];
  const recordAt = (productId: string, atMs: number): number | null =>
    resolvePrice(input.entries, { productId, storeId: input.branchId, at: new Date(atMs).toISOString() })?.price.minor ?? null;

  const products = [...new Set([
    ...input.entries.map((e) => e.productId),
    ...input.observations.filter((o) => o.branchId === input.branchId).map((o) => o.productId),
    ...input.charged.map((c) => c.productId),
  ])].sort();

  const exceptions: PriceException[] = [];
  for (const productId of products) {
    const recordNow = recordAt(productId, asAtMs);
    if (recordNow === null) continue; // no price of record here: nothing to reconcile against (B25's audit covers the till)
    // The moments the price of record can change: each entry's start and end, for this product.
    const recordChanges = input.entries.filter((e) => e.productId === productId)
      .flatMap((e) => [Date.parse(e.effectiveFrom), ...(e.effectiveTo === undefined || e.effectiveTo === null ? [] : [Date.parse(e.effectiveTo) + 1])])
      .filter((t) => Number.isFinite(t) && t <= asAtMs);

    const surfaces = new Map<ReconciledSurface, Point[]>();
    for (const o of input.observations) {
      if (o.branchId !== input.branchId || o.productId !== productId || Date.parse(o.observedAt) > asAtMs) continue;
      const pts = surfaces.get(o.surface) ?? [];
      pts.push({ at: Date.parse(o.observedAt), priceMinor: o.priceMinor, evidence: `seen ${rupees(o.priceMinor)} by ${o.observedBy} at ${o.observedAt}`, ...(o.shelfAddress === undefined ? {} : { shelfAddress: o.shelfAddress }), ...(o.deviceId === undefined ? {} : { deviceId: o.deviceId }) });
      surfaces.set(o.surface, pts);
    }
    for (const c of input.charged) {
      if (c.productId !== productId || c.approvedOverride || Date.parse(c.committedAt) > asAtMs) continue;
      const pts = surfaces.get('pos') ?? [];
      pts.push({ at: Date.parse(c.committedAt), priceMinor: c.unitPriceMinor, evidence: `charged ${rupees(c.unitPriceMinor)} on sale ${c.saleId} at ${c.committedAt}` });
      surfaces.set('pos', pts);
    }

    for (const surface of required) {
      if (surfaces.has(surface)) continue;
      // Never seen: open since the price of record that applies now took effect.
      const entry = resolvePrice(input.entries, { productId, storeId: input.branchId, at: input.asAt })!;
      const since = Math.min(Date.parse(entry.effectiveFrom), asAtMs);
      const ageMinutes = Math.floor((asAtMs - since) / MINUTE_MS);
      const ageDays = Math.floor((asAtMs - since) / DAY_MS);
      exceptions.push({
        productId, surface, kind: 'never_observed', recordMinor: recordNow, differenceMinor: 0,
        openSince: new Date(since).toISOString(), ageMinutes, ageDays, band: bandOf(ageDays, bands), evidence: 'no observation on file',
        detail: `${productId}: nobody has seen its ${WORDS[surface]} since its price of record ${rupees(recordNow)} took effect — a price nobody has checked is not a price that agrees`,
      });
    }

    for (const [surface, raw] of surfaces) {
      const pts = [...raw].sort((a, b) => a.at - b.at);
      const latest = pts[pts.length - 1]!;
      if (latest.priceMinor === recordNow) continue;
      // Walk back over every moment the state could change; the exception is open since the earliest moment from which
      // the surface's price (its latest evidence at that moment) has differed from the price of record without a break.
      const moments = [...new Set([...pts.map((p) => p.at), ...recordChanges])].filter((t) => t >= pts[0]!.at).sort((a, b) => b - a);
      let since = asAtMs;
      for (const t of moments) {
        const shown = [...pts].reverse().find((p) => p.at <= t)!.priceMinor;
        const rec = recordAt(productId, t);
        if (rec !== null && shown !== rec) since = t; else break;
      }
      const diff = latest.priceMinor - recordNow;
      const kind: PriceExceptionKind = surface === 'pos'
        ? (diff > 0 ? 'charged_above_record' : 'charged_below_record')
        : (diff < 0 ? 'shown_below_record' : 'shown_above_record');
      const ageMinutes = Math.floor((asAtMs - since) / MINUTE_MS);
      const ageDays = Math.floor((asAtMs - since) / DAY_MS);
      exceptions.push({
        productId, surface, kind, recordMinor: recordNow, surfaceMinor: latest.priceMinor, differenceMinor: diff,
        openSince: new Date(since).toISOString(), ageMinutes, ageDays, band: bandOf(ageDays, bands), evidence: latest.evidence,
        ...(latest.shelfAddress === undefined ? {} : { shelfAddress: latest.shelfAddress }),
        ...(latest.deviceId === undefined ? {} : { deviceId: latest.deviceId }),
        detail: kind === 'shown_below_record'
          ? `${productId}: the ${WORDS[surface]} shows ${rupees(latest.priceMinor)} and the price of record is ${rupees(recordNow)} — the shown price is what the customer was offered; honour it and fix the ${WORDS[surface]}`
          : kind === 'charged_above_record'
            ? `${productId}: the till charged ${rupees(latest.priceMinor)} and the price of record is ${rupees(recordNow)} — customers paid more than the shop's own price`
            : kind === 'charged_below_record'
              ? `${productId}: the till charged ${rupees(latest.priceMinor)} and the price of record is ${rupees(recordNow)} — margin lost at the till`
              : `${productId}: the ${WORDS[surface]} shows ${rupees(latest.priceMinor)} and the price of record is ${rupees(recordNow)}`,
      });
    }
  }

  const legal = (k: PriceExceptionKind): number => (k === 'shown_below_record' || k === 'charged_above_record' ? 0 : 1);
  exceptions.sort((a, b) => legal(a.kind) - legal(b.kind) || b.ageMinutes - a.ageMinutes || a.productId.localeCompare(b.productId) || a.surface.localeCompare(b.surface));
  const byBand = [...bands].sort((a, b) => a.fromDays - b.fromDays).map((b) => ({ band: b.band, count: exceptions.filter((e) => e.band === b.band).length }));
  const oldest = exceptions.reduce<string | null>((o, e) => (o === null || e.openSince < o ? e.openSince : o), null);
  return {
    branchId: input.branchId, asAt: input.asAt, productsChecked: products.length, exceptions, byBand, oldestOpenSince: oldest,
    detail: exceptions.length === 0
      ? `all ${products.length} product(s) agree with their price of record on every surface seen and at the till`
      : `${exceptions.length} price exception(s) open; the oldest since ${oldest}`,
  };
}
