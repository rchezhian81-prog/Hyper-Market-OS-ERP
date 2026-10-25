// The B2B contract register (M22-FR-01 "hold per-B2B-customer price lists, credit limits, payment terms and contracts …
// an expired contract falls back or blocks per policy"). Pure and deterministic: no storage, no clock of its own.
//
// Before this, "the contract" was a flag the caller sent (`contractExpired: true`) and a quotation took whatever price the
// person typed. Here a contract is a RECORD:
//   • its own dates (valid from / valid to, inclusive) — whether it is in force is WORKED OUT from them on the day, never
//     told to the system;
//   • its price list (one price per product), its payment terms and its credit limit;
//   • its policy on expiry — `block` (no new quotation or order until it is renewed, unless a second person approves the
//     one order) or `fallback` (the shop's ordinary price applies again);
//   • proposed by one person and APPROVED by another (maker-checker, ADR-0024): a proposed contract prices nothing.
// A contract once approved is never rewritten (hard rule #2): new terms are a NEW contract (a renewal), which takes over
// from its own start date.
//
// A quotation line is priced from the record, in this order: the contract in force (for a product on it) → the shop's
// price list (`resolvePrice`: customer > channel > zone > store, the one price truth, P-02). A typed price that differs
// from the price on record is REFUSED by name, never silently replaced (P-08). Only a product with no price on record at
// all keeps the typed price, and the line says so (`priceSource: 'typed'`).

export type ContractExpiryPolicy = 'block' | 'fallback';
export const EXPIRY_POLICIES: readonly ContractExpiryPolicy[] = Object.freeze(['block', 'fallback']);

export interface ContractPriceLine {
  readonly productId: string;
  /** The contract price per unit, in paise (whole, ≥ 0). */
  readonly priceMinor: number;
}

/** The terms a contract is proposed (and approved) with — exactly what the second person sees. */
export interface B2BContractTerms {
  readonly contractId: string;
  readonly customerId: string;
  /** First day in force, YYYY-MM-DD. */
  readonly validFrom: string;
  /** Last day in force (inclusive), YYYY-MM-DD. */
  readonly validTo: string;
  readonly onExpiry: ContractExpiryPolicy;
  readonly prices: readonly ContractPriceLine[];
  /** Days from a tax invoice to when it is due (0–365). Absent → the account's terms are not changed by this contract. */
  readonly paymentTermsDays?: number;
  /** The credit limit this contract sets, in paise. Absent → the account's limit is not changed by this contract. */
  readonly creditLimitMinor?: number;
  readonly note?: string;
}

/** A contract as it is recorded: proposed by one person, approved (or not yet) by another. */
export interface StoredB2BContract extends B2BContractTerms {
  readonly state: 'proposed' | 'approved';
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly approvalId?: string;
}

/** Where a contract stands on a day. */
export type ContractStanding = 'awaiting_approval' | 'not_started' | 'in_force' | 'expired';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

/** Read proposed terms from a request (the ids come from the path, never the body). */
export function readContractTerms(body: unknown, ids: { readonly customerId: string; readonly contractId: string }): Read<B2BContractTerms> {
  if (!ID.test(ids.customerId) || !ID.test(ids.contractId)) return { ok: false, why: 'The customer and contract ids are letters, digits, dot, dash or underscore (up to 64).' };
  if (!isObj(body)) return { ok: false, why: 'A contract is { validFrom, validTo, onExpiry, prices: [{ productId, priceMinor }], paymentTermsDays?, creditLimitMinor?, note? }.' };
  const b = body;
  if (!isDate(b['validFrom']) || !isDate(b['validTo'])) return { ok: false, why: 'validFrom and validTo are dates, YYYY-MM-DD.' };
  if ((b['validTo'] as string) < (b['validFrom'] as string)) return { ok: false, why: 'validTo is before validFrom — a contract must be in force for at least one day.' };
  if (typeof b['onExpiry'] !== 'string' || !(EXPIRY_POLICIES as readonly string[]).includes(b['onExpiry'])) return { ok: false, why: 'onExpiry is "block" (no new sale until renewed) or "fallback" (the shop\'s ordinary price applies).' };
  const raw = b['prices'];
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, why: 'A contract needs its price list: at least one { productId, priceMinor }.' };
  const prices: ContractPriceLine[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!isObj(p) || !isStr(p['productId']) || !isPaise(p['priceMinor'])) return { ok: false, why: 'Each price is { productId, priceMinor } with a whole price in paise of 0 or more.' };
    const productId = (p['productId'] as string).trim();
    if (seen.has(productId)) return { ok: false, why: `${productId} is on the price list twice — one contract, one price per product.` };
    seen.add(productId);
    prices.push({ productId, priceMinor: p['priceMinor'] as number });
  }
  const terms = b['paymentTermsDays'];
  if (terms !== undefined && !(Number.isInteger(terms) && (terms as number) >= 0 && (terms as number) <= 365)) return { ok: false, why: 'paymentTermsDays, when given, is whole days from 0 to 365.' };
  const limit = b['creditLimitMinor'];
  if (limit !== undefined && !isPaise(limit)) return { ok: false, why: 'creditLimitMinor, when given, is whole paise of 0 or more.' };
  const note = b['note'];
  if (note !== undefined && !(typeof note === 'string' && note.length <= 500)) return { ok: false, why: 'note, when given, is text of up to 500 characters.' };
  return {
    ok: true,
    value: Object.freeze({
      contractId: ids.contractId, customerId: ids.customerId,
      validFrom: b['validFrom'] as string, validTo: b['validTo'] as string, onExpiry: b['onExpiry'] as ContractExpiryPolicy,
      prices: Object.freeze(prices.sort((x, y) => (x.productId < y.productId ? -1 : x.productId > y.productId ? 1 : 0))),
      ...(terms === undefined ? {} : { paymentTermsDays: terms as number }),
      ...(limit === undefined ? {} : { creditLimitMinor: limit as number }),
      ...(typeof note === 'string' && note.trim() !== '' ? { note: note.trim() } : {}),
    }),
  };
}

/** Do two sets of terms say the same thing? (A re-sent proposal collapses; a change is a different contract.) */
export function sameTerms(a: B2BContractTerms, b: B2BContractTerms): boolean {
  return a.contractId === b.contractId && a.customerId === b.customerId && a.validFrom === b.validFrom && a.validTo === b.validTo
    && a.onExpiry === b.onExpiry && (a.paymentTermsDays ?? null) === (b.paymentTermsDays ?? null)
    && (a.creditLimitMinor ?? null) === (b.creditLimitMinor ?? null) && (a.note ?? null) === (b.note ?? null)
    && a.prices.length === b.prices.length && a.prices.every((p, i) => p.productId === b.prices[i]?.productId && p.priceMinor === b.prices[i]?.priceMinor);
}

/** Whole days from `today` to `day` (both YYYY-MM-DD; negative when `day` is past). */
export function daysBetween(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000);
}

/** Where one contract stands on `today` — from its own dates and approval, never from a flag. */
export function standingOf(c: StoredB2BContract, today: string): ContractStanding {
  if (c.state !== 'approved') return 'awaiting_approval';
  if (today < c.validFrom) return 'not_started';
  if (today > c.validTo) return 'expired';
  return 'in_force';
}

/** The customer's contract position on a day: what is in force, the latest that lapsed, what is coming. */
export interface ContractPosition {
  /** The approved contract in force today (the latest-starting one when two overlap). */
  readonly inForce?: StoredB2BContract;
  /** With nothing in force: the approved contract that lapsed most recently — its `onExpiry` decides. */
  readonly lapsed?: StoredB2BContract;
  /** An approved contract that starts later. */
  readonly upcoming?: StoredB2BContract;
  /** Days until the one in force ends (0 = its last day). */
  readonly daysToExpiry?: number;
  /** True when nothing is in force and the latest lapsed contract says `block`. */
  readonly blocked: boolean;
}

const byStartThenApproval = (a: StoredB2BContract, b: StoredB2BContract): number =>
  a.validFrom !== b.validFrom ? (a.validFrom < b.validFrom ? 1 : -1) : (a.approvedAt ?? '') < (b.approvedAt ?? '') ? 1 : -1;

export function contractPosition(contracts: readonly StoredB2BContract[], customerId: string, today: string): ContractPosition {
  const approved = contracts.filter((c) => c.customerId === customerId && c.state === 'approved');
  const inForce = approved.filter((c) => standingOf(c, today) === 'in_force').sort(byStartThenApproval)[0];
  const upcoming = approved.filter((c) => standingOf(c, today) === 'not_started').sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))[0];
  if (inForce !== undefined) {
    return { inForce, ...(upcoming === undefined ? {} : { upcoming }), daysToExpiry: daysBetween(today, inForce.validTo), blocked: false };
  }
  const lapsed = approved.filter((c) => standingOf(c, today) === 'expired').sort((a, b) => (a.validTo !== b.validTo ? (a.validTo < b.validTo ? 1 : -1) : byStartThenApproval(a, b)))[0];
  return { ...(lapsed === undefined ? {} : { lapsed }), ...(upcoming === undefined ? {} : { upcoming }), blocked: lapsed !== undefined && lapsed.onExpiry === 'block' };
}

/** Approved contracts in force that end within `days` (the 30- and 7-day warnings, P-03). */
export function contractsEndingWithin(contracts: readonly StoredB2BContract[], today: string, days: number): readonly { readonly contract: StoredB2BContract; readonly daysLeft: number }[] {
  return contracts
    .filter((c) => standingOf(c, today) === 'in_force')
    .map((contract) => ({ contract, daysLeft: daysBetween(today, contract.validTo) }))
    .filter((x) => x.daysLeft <= days)
    // A renewal already approved and starting by then covers it — no warning for a contract that is being replaced.
    .filter((x) => !contracts.some((r) => r.customerId === x.contract.customerId && r.contractId !== x.contract.contractId && r.state === 'approved'
      && r.validFrom <= addDays(x.contract.validTo, 1) && r.validTo > x.contract.validTo))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ── pricing a quotation from the record ──────────────────────────────────────────────────────────────────────────

export type PriceSource = 'contract' | 'price_list' | 'typed';

export interface LineToPrice {
  readonly lineId: string;
  readonly productId: string;
  /** What the person typed, if anything. */
  readonly typedPriceMinor?: number;
}

export interface PricedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly unitPriceMinor: number;
  readonly priceSource: PriceSource;
  /** The contract that priced it, when `priceSource` is `contract`. */
  readonly contractId?: string;
}

export type PricingResult =
  | { readonly ok: true; readonly lines: readonly PricedLine[] }
  | { readonly ok: false; readonly code: 'contract_expired' | 'not_the_contract_price' | 'not_the_price_on_record' | 'no_price_on_record'; readonly detail: string; readonly lineId?: string };

/**
 * Price each line from the record (M22-FR-01 "orders price against it"): the contract in force for a product on it, else
 * the shop's price list (`listPriceOf`, the price-list engine's answer for this customer at this store), else the typed
 * price — said as such. A lapsed contract with `block` refuses the whole quotation; with `fallback` the price list applies.
 */
export function priceFromRecord(input: {
  readonly position: ContractPosition;
  readonly lines: readonly LineToPrice[];
  readonly listPriceOf: (productId: string) => number | undefined;
}): PricingResult {
  const { position } = input;
  if (position.blocked && position.lapsed !== undefined) {
    return {
      ok: false, code: 'contract_expired',
      detail: `Contract ${position.lapsed.contractId} ended on ${position.lapsed.validTo} and says "block": no new quotation until it is renewed (a new contract, approved by a second person).`,
    };
  }
  const contract = position.inForce;
  const out: PricedLine[] = [];
  for (const l of input.lines) {
    const onContract = contract?.prices.find((p) => p.productId === l.productId);
    if (contract !== undefined && onContract !== undefined) {
      if (l.typedPriceMinor !== undefined && l.typedPriceMinor !== onContract.priceMinor) {
        return { ok: false, code: 'not_the_contract_price', lineId: l.lineId, detail: `${l.productId} is on contract ${contract.contractId} at ${onContract.priceMinor} paise; ${l.typedPriceMinor} was typed. A different price is a new contract, approved by a second person.` };
      }
      out.push({ lineId: l.lineId, productId: l.productId, unitPriceMinor: onContract.priceMinor, priceSource: 'contract', contractId: contract.contractId });
      continue;
    }
    const list = input.listPriceOf(l.productId);
    if (list !== undefined) {
      if (l.typedPriceMinor !== undefined && l.typedPriceMinor !== list) {
        return { ok: false, code: 'not_the_price_on_record', lineId: l.lineId, detail: `${l.productId} is ${list} paise on the shop's price list; ${l.typedPriceMinor} was typed. Put a different price on the customer's contract (approved by a second person) rather than typing it.` };
      }
      out.push({ lineId: l.lineId, productId: l.productId, unitPriceMinor: list, priceSource: 'price_list' });
      continue;
    }
    if (l.typedPriceMinor === undefined) {
      return { ok: false, code: 'no_price_on_record', lineId: l.lineId, detail: `${l.productId} has no contract price and no price on the shop's price list, so it cannot be priced. Put it on the contract or the price list first.` };
    }
    out.push({ lineId: l.lineId, productId: l.productId, unitPriceMinor: l.typedPriceMinor, priceSource: 'typed' });
  }
  return { ok: true, lines: out };
}
