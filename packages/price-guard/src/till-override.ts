// A PRICE CUT AT THE TILL, judged by the shop's own rules — offline (OB-500 · M02-FR-02 value limits · M05-FR-02 "the check
// also holds offline" · P-01 · P-04 · hard rule #1).
//
// Two rules, each carried to the store in the SIGNED store pack (`tillControls`), so the till and the store computer judge
// a price cut with no network:
//
//   • THE FLOOR — the lowest price a product may be sold at: the price whose gross margin over the store's average buying
//     cost is exactly the store's margin floor (the same rule head office's price guard applies, `price-guard.ts`), rounded
//     UP to the paisa. Head office works it out and sends only the floor — never the buying cost. A price below it is
//     refused at the till; no approval can make it lawful there (a lower price is a head-office price change).
//   • THE MANAGER'S LIMIT — how much one manager's approval may take off a line, from the owner's money limits (the
//     `price_override` kind of the authority-limits engine, OB-290). Unlimited for the owner; "not set" until the owner sets
//     a figure — then a cut above ₹0 needs the owner (default deny). OB-519: a store manager's figure is ₹100 a line.
//   • NO KNOWN FLOOR (OB-520) — a product never received at a cost has no floor; only the OWNER may approve a cut on it
//     (the pack names the people who hold the owner role at this store, `ownerApprovers`), whatever another person's limit.
//
// Pure: no clock, no I/O. The till, the store computer and head office's intake all call these same functions.

import { isUom, normaliseUom, precisionOf } from '../../contracts/src/quantity';

/** A manager's price-cut authority as the pack carries it. */
export interface OverrideLimit {
  readonly state: 'limit' | 'unlimited' | 'not_set';
  /** Paise, when `state` is `limit`; otherwise null. */
  readonly limitMinor: number | null;
}

/** The `tillControls` section of the signed store pack (OB-500). */
export interface TillControls {
  /** Each product's floor price per WHOLE unit, in paise. A product left out has no known floor (never received at a cost). */
  readonly floors: Readonly<Record<string, number>>;
  /** The products head office could not give a floor for — named, never a fake zero (P-08). */
  readonly floorsNotKnown: readonly string[];
  /** Each person's price-cut limit; a person left out is "not set". */
  readonly overrideLimits: Readonly<Record<string, OverrideLimit>>;
  /** The version of the owner's limits table the figures were read from (0 = his decided ladder). */
  readonly limitsVersion: number;
  /** OB-520: the people who hold the OWNER role at this store — the only ones who may approve a cut on a product with no
   *  known floor. Empty when the pack names nobody (then nobody may cut such a product: default deny). */
  readonly ownerApprovers: readonly string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The floor price per whole unit: the smallest whole-paise price whose margin over `costMinor` is at least `marginFloorBps`
 * (`price-guard.ts`: below the floor ⇔ price·(10000 − bps) < cost·10000). Exact (BigInt), rounded UP. With no margin floor
 * set (0 bps) the floor is the cost itself — a price below landed cost is the price guard's own `below_cost` rule.
 */
export function floorPriceMinor(costMinor: number, marginFloorBps: number): number {
  if (!isPaise(costMinor)) throw new RangeError(`A buying cost must be whole paise of 0 or more, got ${costMinor}.`);
  if (!Number.isInteger(marginFloorBps) || marginFloorBps < 0 || marginFloorBps > 9999) throw new RangeError(`A margin floor must be 0–9999 basis points, got ${marginFloorBps}.`);
  const num = BigInt(costMinor) * 10_000n;
  const den = BigInt(10_000 - marginFloorBps);
  return Number((num + den - 1n) / den);
}

/** Read the pack's `tillControls` section, or undefined when it is not one (then the store was not told — never "no rules"). */
export function readTillControls(v: unknown): TillControls | undefined {
  if (!isObj(v) || !isObj(v['floors']) || !isObj(v['overrideLimits'])) return undefined;
  const floors: Record<string, number> = {};
  for (const [productId, f] of Object.entries(v['floors'])) if (isPaise(f)) floors[productId] = f;
  const overrideLimits: Record<string, OverrideLimit> = {};
  for (const [userId, l] of Object.entries(v['overrideLimits'])) {
    if (!isObj(l)) continue;
    if (l['state'] === 'unlimited') overrideLimits[userId] = { state: 'unlimited', limitMinor: null };
    else if (l['state'] === 'limit' && isPaise(l['limitMinor'])) overrideLimits[userId] = { state: 'limit', limitMinor: l['limitMinor'] };
    else overrideLimits[userId] = { state: 'not_set', limitMinor: null };
  }
  const notKnown = Array.isArray(v['floorsNotKnown']) ? v['floorsNotKnown'].filter((p): p is string => typeof p === 'string') : [];
  const ownerApprovers = Array.isArray(v['ownerApprovers']) ? v['ownerApprovers'].filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  return { floors, floorsNotKnown: notKnown, overrideLimits, limitsVersion: isPaise(v['limitsVersion']) ? v['limitsVersion'] : 0, ownerApprovers };
}

/** What lowering a line from `fromUnitMinor` to `toUnitMinor` takes off it — priced as the till prices (a weighed line's
 *  amount rounded down, B5), so head office reaches the same figure the manager approved. */
export function overrideReductionMinor(fromUnitMinor: number, toUnitMinor: number, quantityMinor: number, uom: string): number {
  const unit = normaliseUom(uom) ?? uom;
  const denominator = isUom(unit) ? 10 ** precisionOf(unit) : 1;
  const amount = (unitMinor: number): bigint => (BigInt(Math.max(0, Math.trunc(unitMinor))) * BigInt(Math.max(0, Math.trunc(quantityMinor)))) / BigInt(denominator);
  return Number(amount(fromUnitMinor) - amount(toUnitMinor));
}

export type TillOverrideRefusal = 'below_floor' | 'above_limit' | 'limit_not_set' | 'limits_not_known' | 'floor_not_known_owner_only';

export interface TillOverrideWords { readonly en: string; readonly ta: string }

export type TillOverrideVerdict =
  | { readonly ok: true; readonly floorMinor: number | null; readonly limit: OverrideLimit }
  | { readonly ok: false; readonly refusedBecause: TillOverrideRefusal; readonly words: TillOverrideWords; readonly floorMinor: number | null };

const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/** OB-520: the words for a cut on a product with no known lowest price — only the owner may approve it. */
export function ownerOnlyWords(cut?: string): TillOverrideWords {
  const amount = cut === undefined ? '' : ` of ${cut}`;
  const amountTa = cut === undefined ? '' : ` (${cut})`;
  return {
    en: `This item has no known lowest price yet (it has never been received at a cost), so only the owner can approve a price cut${amount} on it. Nothing was changed — the price stays as it was.`,
    ta: `இந்தப் பொருளுக்கு இன்னும் குறைந்தபட்ச விலை தெரியவில்லை (இது விலையுடன் ஒருமுறை கூட பெறப்படவில்லை), எனவே இதன் விலைக் குறைப்புக்கு${amountTa} உரிமையாளர் மட்டுமே ஒப்புதல் தர முடியும். எதுவும் மாற்றப்படவில்லை — விலை முன்பு இருந்தபடியே உள்ளது.`,
  };
}

/** The till's own check, before a manager is even asked: is the new price below this product's floor? */
export function floorRefusal(input: { readonly toUnitMinor: number; readonly floorMinor: number | undefined }): TillOverrideWords | undefined {
  if (input.floorMinor === undefined || input.toUnitMinor >= input.floorMinor) return undefined;
  const to = rupees(input.toUnitMinor);
  const floor = rupees(input.floorMinor);
  return {
    en: `${to} is below the lowest price this item may be sold at (${floor}). Nothing was changed — the price stays as it was.`,
    ta: `${to} இந்தப் பொருளை விற்கக்கூடிய குறைந்தபட்ச விலைக்கு (${floor}) கீழே உள்ளது. எதுவும் மாற்றப்படவில்லை — விலை முன்பு இருந்தபடியே உள்ளது.`,
  };
}

/**
 * The whole judgement, as the store computer makes it when a manager approves (and head office re-makes it when the sale
 * arrives): the floor first, then the approving manager's limit for what the cut takes off the line. `controls` absent →
 * the store was not told the rules, and no price cut is approved (never "no rules, so anything goes").
 */
export function judgeTillOverride(input: {
  readonly controls: TillControls | undefined;
  readonly productId: string;
  readonly toUnitMinor: number;
  readonly reductionMinor: number;
  readonly approverId: string;
  readonly approverName?: string;
}): TillOverrideVerdict {
  const c = input.controls;
  if (c === undefined) {
    return {
      ok: false, refusedBecause: 'limits_not_known', floorMinor: null,
      words: {
        en: 'This store computer has not been told the lowest prices and the managers\' price-cut limits by head office, so it cannot approve a price cut. Nothing was changed — the price stays as it was.',
        ta: 'குறைந்தபட்ச விலைகளையும் மேலாளர்களின் விலைக் குறைப்பு வரம்புகளையும் தலைமை அலுவலகம் இந்தக் கடைக் கணினிக்குத் தெரிவிக்கவில்லை, எனவே விலைக் குறைப்புக்கு ஒப்புதல் தர முடியாது. எதுவும் மாற்றப்படவில்லை — விலை முன்பு இருந்தபடியே உள்ளது.',
      },
    };
  }
  const floorMinor = c.floors[input.productId] ?? null;
  const below = floorRefusal({ toUnitMinor: input.toUnitMinor, floorMinor: floorMinor ?? undefined });
  if (below !== undefined) return { ok: false, refusedBecause: 'below_floor', words: below, floorMinor };
  const limit = c.overrideLimits[input.approverId] ?? { state: 'not_set', limitMinor: null };
  const who = input.approverName?.trim() || input.approverId;
  const cut = rupees(input.reductionMinor);
  if (input.reductionMinor <= 0) return { ok: true, floorMinor, limit };
  // OB-520: no known floor (never received at a cost) — only the owner may approve a cut, whatever anyone else's limit.
  if (floorMinor === null) {
    if (c.ownerApprovers.includes(input.approverId)) return { ok: true, floorMinor, limit };
    return { ok: false, refusedBecause: 'floor_not_known_owner_only', floorMinor, words: ownerOnlyWords(cut) };
  }
  if (limit.state === 'unlimited') return { ok: true, floorMinor, limit };
  if (limit.state === 'not_set') {
    return {
      ok: false, refusedBecause: 'limit_not_set', floorMinor,
      words: {
        en: `The owner has not set a price-cut limit for ${who}, so only the owner can approve this cut of ${cut}. Nothing was changed — the price stays as it was.`,
        ta: `${who} அவர்களுக்கு விலைக் குறைப்பு வரம்பை உரிமையாளர் அமைக்கவில்லை, எனவே ${cut} குறைப்புக்கு உரிமையாளர் மட்டுமே ஒப்புதல் தர முடியும். எதுவும் மாற்றப்படவில்லை — விலை முன்பு இருந்தபடியே உள்ளது.`,
      },
    };
  }
  if (input.reductionMinor > (limit.limitMinor ?? 0)) {
    const lim = rupees(limit.limitMinor ?? 0);
    return {
      ok: false, refusedBecause: 'above_limit', floorMinor,
      words: {
        en: `This price cut takes ${cut} off the line — more than ${who}'s limit of ${lim}. Nothing was changed — ask the owner, or a manager whose limit covers it.`,
        ta: `இந்த விலைக் குறைப்பு வரியிலிருந்து ${cut} குறைக்கிறது — இது ${who} அவர்களின் ${lim} வரம்பை விட அதிகம். எதுவும் மாற்றப்படவில்லை — உரிமையாளரிடம், அல்லது இதற்குப் போதுமான வரம்புள்ள மேலாளரிடம் கேளுங்கள்.`,
      },
    };
  }
  return { ok: true, floorMinor, limit };
}
