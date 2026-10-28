// QUEUE-BUSTING — a basket scanned on a staff handheld in the queue, handed to a till by a short code (D04-FR-05 · OB-288 ·
// OB-316 · P-01 · P-02 · hard rules #1, #2, #6, #10).
//
// A member of staff walks the queue with a handheld, scans each customer's basket, and hands it to a fixed till. The
// customer reaches the till, the cashier keys the four digits the handheld showed, and the till rings every line through
// ITS OWN signed pack — the price, the offers, the bundles, the tobacco, liquor, BIS and expiry gates are the till's, never
// the handheld's (P-02: one commerce truth). This is the held-bill pattern (`suspended-bill.ts`) with the phone-basket
// hand-over (scan-and-go, OB-350): the basket is a note of intent, it holds no stock, and the record of what the
// handheld scanned is what the till re-rings.
//
// The rules that have to be right, pure:
//   • A HAND-OVER IS ONE BASKET. Re-sent after a lost reply (the same basket id), it is the SAME hand-over with the SAME
//     code — never a second code for one customer.
//   • A RECALL IS A CLAIM, ONCE. The first till that keys the code gets the lines; every later try is refused naming the
//     till that has it — two tills ringing one basket is a double charge.
//   • A HANDHELD NEVER RECALLS. Only a till (a lane that is not a phone) can bring a basket up; a handheld's own lane is
//     refused, so a phone cannot "recall" a basket into a sale of its own.
//   • NOTHING IS DELETED (hard rule #6). A basket nobody came for is given up with who and why, and stays on the record.
//   • A CODE IS NEVER SHARED by two baskets waiting at the same time; once a basket is recalled or given up its code may
//     be used again (four digits are for keying at a till with a customer watching, not a secret: the customer is there).
//
// Synchronous and pure: no clock (times are passed in), no I/O, no randomness (the caller passes the candidate codes).

/**
 * THE ROLLOUT SWITCHES (OB-316: per branch and per till lane, from the signed store pack, OFF until somebody sets them):
 *   • `pos.queue_busting` — the store computer serves the queue handheld, and its till accepts handed-over baskets;
 *   • `payments.mobile_pos` — on top of that, the handheld may take a card or UPI payment itself. Named under `payments.`
 *     so head office treats it as high-impact: the owner approves it before it is switched on (governed-config.ts).
 * Both are judged for the lane of the store computer the handheld is enrolled on (its `EDGE_LANE_ID`).
 */
import type { HandheldBuild } from '../../platform-admin/src/handheld-build';

export const QUEUE_BUSTING_SWITCH = 'pos.queue_busting';
export const MOBILE_POS_PAYMENT_SWITCH = 'payments.mobile_pos';

/** The code the cashier keys at the till: four digits, as the handheld shows them. */
export const QUEUE_CODE = /^\d{4}$/;

/** A phone lane — the store computer names a handheld's session `device:<deviceId>` (edge/store-edge/src/till-operators.ts). */
export const HANDHELD_LANE_PREFIX = 'device:';

/** One line the handheld scanned: what the till re-rings by its barcode, and how many. Never a price. */
export interface QueueBasketLine {
  readonly productId: string;
  readonly name: string;
  /** The code the handheld scanned — a scale label's carries its weight, so its quantity is 1. */
  readonly barcode: string;
  readonly quantityMinor: number;
}

export type QueueBasketState = 'waiting' | 'recalled' | 'given_up';

export interface QueueBasket {
  readonly basketId: string;
  readonly code: string;
  /** The handheld's lane (`device:<id>`) and the person signed in on it, as the store computer verified them. */
  readonly handheldLane: string;
  readonly handedOverBy: string;
  readonly handedOverAt: string;
  readonly lines: readonly QueueBasketLine[];
  /** What the handheld showed the customer, in paise — for the cashier to compare; the till's own total is the bill. */
  readonly handheldTotalMinor: number;
  readonly state: QueueBasketState;
  readonly recalledOnLane?: string;
  readonly recalledBy?: string;
  readonly recalledAt?: string;
  readonly givenUpBy?: string;
  readonly givenUpAt?: string;
  readonly giveUpReason?: string;
  /** Round 9 · OB-537: the build that made the basket and the store computer's mark on it, kept with the basket. */
  readonly handheldBuild?: HandheldBuild;
}

/** The most lines one hand-over carries — a body cap the till's own basket never comes near. */
export const QUEUE_BASKET_MAX_LINES = 500;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/**
 * The lines a handheld sent, read strictly. A line the till could not re-ring (no barcode, no product, a quantity that is
 * not a whole positive number) makes the whole basket unreadable — never a basket quietly handed over short.
 */
export function readQueueBasketLines(raw: unknown): { readonly ok: true; readonly lines: readonly QueueBasketLine[] } | { readonly ok: false; readonly reason: 'empty_basket' | 'basket_not_readable' | 'too_many_lines' } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: Array.isArray(raw) ? 'empty_basket' : 'basket_not_readable' };
  if (raw.length > QUEUE_BASKET_MAX_LINES) return { ok: false, reason: 'too_many_lines' };
  const lines: QueueBasketLine[] = [];
  for (const l of raw) {
    if (!isObj(l) || !isText(l['productId'], 120) || !isText(l['barcode'], 64) || typeof l['name'] !== 'string' || l['name'].length > 200
      || !Number.isSafeInteger(l['quantityMinor']) || (l['quantityMinor'] as number) < 1 || (l['quantityMinor'] as number) > 1_000_000) {
      return { ok: false, reason: 'basket_not_readable' };
    }
    lines.push({ productId: l['productId'].trim(), name: l['name'], barcode: l['barcode'].trim(), quantityMinor: l['quantityMinor'] as number });
  }
  return { ok: true, lines };
}

export const isHandheldLane = (laneId: string): boolean => laneId.startsWith(HANDHELD_LANE_PREFIX);

export type HandOverOutcome =
  | { readonly handedOver: true; readonly basket: QueueBasket; readonly again: boolean }
  | { readonly handedOver: false; readonly refusedBecause: 'empty_basket' | 'basket_not_readable' | 'too_many_lines' | 'basket_id_missing' | 'not_a_handheld' | 'no_free_code' | 'basket_id_reused' };

/**
 * Hand a scanned basket over. `candidates` are codes to try in order (the caller draws them at random); the first one no
 * waiting basket holds is used. The SAME basket id re-sent by the same handheld is the same hand-over, code and all.
 */
export function handOverBasket(
  existing: readonly QueueBasket[],
  input: {
    readonly basketId: unknown; readonly handheldLane: string; readonly handedOverBy: string; readonly lines: unknown;
    readonly handheldTotalMinor: unknown; readonly at: string; readonly candidates: readonly string[];
    /** OB-537: what the store computer makes of the build that made it (kept on the basket; never a reason to refuse). */
    readonly handheldBuild?: HandheldBuild;
  },
): HandOverOutcome {
  if (!isText(input.basketId, 120)) return { handedOver: false, refusedBecause: 'basket_id_missing' };
  if (!isHandheldLane(input.handheldLane)) return { handedOver: false, refusedBecause: 'not_a_handheld' };
  const basketId = input.basketId.trim();
  const before = existing.find((b) => b.basketId === basketId);
  if (before !== undefined) {
    // A lost reply re-sent: the same hand-over. Another handheld (or person) re-using the id is refused, never merged.
    if (before.handheldLane === input.handheldLane && before.handedOverBy === input.handedOverBy) return { handedOver: true, basket: before, again: true };
    return { handedOver: false, refusedBecause: 'basket_id_reused' };
  }
  const read = readQueueBasketLines(input.lines);
  if (!read.ok) return { handedOver: false, refusedBecause: read.reason };
  const inUse = new Set(existing.filter((b) => b.state === 'waiting').map((b) => b.code));
  const code = input.candidates.find((c) => QUEUE_CODE.test(c) && !inUse.has(c));
  if (code === undefined) return { handedOver: false, refusedBecause: 'no_free_code' };
  const total = Number.isSafeInteger(input.handheldTotalMinor) && (input.handheldTotalMinor as number) >= 0 ? input.handheldTotalMinor as number : 0;
  return {
    handedOver: true, again: false,
    basket: {
      basketId, code, handheldLane: input.handheldLane, handedOverBy: input.handedOverBy, handedOverAt: input.at, lines: read.lines, handheldTotalMinor: total, state: 'waiting',
      ...(input.handheldBuild === undefined ? {} : { handheldBuild: input.handheldBuild }),
    },
  };
}

export type RecallQueueOutcome =
  | { readonly recalled: true; readonly basket: QueueBasket }
  | { readonly recalled: false; readonly refusedBecause: 'not_a_queue_code' | 'no_such_queue_basket' | 'already_recalled' | 'given_up' | 'handheld_cannot_recall' | 'no_lane'; readonly recalledOnLane?: string };

/** The waiting (or most recent) basket a code names. */
function byCode(existing: readonly QueueBasket[], code: string): QueueBasket | undefined {
  const waiting = existing.find((b) => b.code === code && b.state === 'waiting');
  if (waiting !== undefined) return waiting;
  // No basket waits under it: the latest one that did, so the till is told it was taken (or given up), not "unknown".
  return [...existing].filter((b) => b.code === code).sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1))[0];
}

/** A till brings a basket up by its code — a claim, once. */
export function recallQueueBasket(existing: readonly QueueBasket[], input: { readonly code: unknown; readonly laneId: string; readonly by: string; readonly at: string }): RecallQueueOutcome {
  if (input.laneId.trim() === '') return { recalled: false, refusedBecause: 'no_lane' };
  if (isHandheldLane(input.laneId)) return { recalled: false, refusedBecause: 'handheld_cannot_recall' };
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!QUEUE_CODE.test(code)) return { recalled: false, refusedBecause: 'not_a_queue_code' };
  const basket = byCode(existing, code);
  if (basket === undefined) return { recalled: false, refusedBecause: 'no_such_queue_basket' };
  if (basket.state === 'recalled') return { recalled: false, refusedBecause: 'already_recalled', ...(basket.recalledOnLane === undefined ? {} : { recalledOnLane: basket.recalledOnLane }) };
  if (basket.state === 'given_up') return { recalled: false, refusedBecause: 'given_up' };
  return { recalled: true, basket: { ...basket, state: 'recalled', recalledOnLane: input.laneId, recalledBy: input.by, recalledAt: input.at } };
}

export type GiveUpQueueOutcome =
  | { readonly givenUp: true; readonly basket: QueueBasket }
  | { readonly givenUp: false; readonly refusedBecause: 'no_such_queue_basket' | 'already_recalled' | 'already_given_up' | 'reason_required' | 'not_this_handheld' };

/** The handheld that handed a basket over gives it up (the customer left) — kept with who and why, never deleted. */
export function giveUpQueueBasket(existing: readonly QueueBasket[], input: { readonly code: unknown; readonly handheldLane: string; readonly by: string; readonly reason: unknown; readonly at: string }): GiveUpQueueOutcome {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const basket = QUEUE_CODE.test(code) ? byCode(existing, code) : undefined;
  if (basket === undefined) return { givenUp: false, refusedBecause: 'no_such_queue_basket' };
  if (basket.handheldLane !== input.handheldLane) return { givenUp: false, refusedBecause: 'not_this_handheld' };
  if (basket.state === 'recalled') return { givenUp: false, refusedBecause: 'already_recalled' };
  if (basket.state === 'given_up') return { givenUp: false, refusedBecause: 'already_given_up' };
  if (!isText(input.reason, 300)) return { givenUp: false, refusedBecause: 'reason_required' };
  return { givenUp: true, basket: { ...basket, state: 'given_up', givenUpBy: input.by, givenUpAt: input.at, giveUpReason: (input.reason as string).trim() } };
}

/** The baskets one handheld handed over that are still waiting for a till, oldest first. */
export function waitingFrom(existing: readonly QueueBasket[], handheldLane: string): readonly QueueBasket[] {
  return existing.filter((b) => b.handheldLane === handheldLane && b.state === 'waiting').sort((a, b) => (a.handedOverAt < b.handedOverAt ? -1 : 1));
}

/** The words the handheld and the till show, per refusal — English and Tamil, icons beside them on the screen. */
export const QUEUE_BASKET_WORDS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  empty_basket: { en: 'There is nothing in the basket to hand over.', ta: 'ஒப்படைக்க கூடையில் எதுவும் இல்லை.' },
  basket_not_readable: { en: 'The store computer could not read this basket. Nothing was handed over — try again.', ta: 'இந்தக் கூடையைக் கடை கணினியால் படிக்க முடியவில்லை. எதுவும் ஒப்படைக்கப்படவில்லை — மீண்டும் முயலவும்.' },
  too_many_lines: { en: 'This basket has more lines than one hand-over carries. Hand it over in two parts.', ta: 'ஒரு ஒப்படைப்பில் அடங்குவதை விட அதிக வரிகள் உள்ளன. இரண்டு பகுதிகளாக ஒப்படைக்கவும்.' },
  basket_id_missing: { en: 'The handheld did not say which basket this is. Nothing was handed over — try again.', ta: 'இது எந்தக் கூடை என்று கருவி சொல்லவில்லை. மீண்டும் முயலவும்.' },
  basket_id_reused: { en: 'Another handheld already handed a basket over under this name. Nothing was handed over — start a new basket.', ta: 'இதே பெயரில் வேறு கருவி ஏற்கனவே ஒப்படைத்துள்ளது. புதிய கூடையைத் தொடங்கவும்.' },
  not_a_handheld: { en: 'Only a queue handheld hands a basket over to a till.', ta: 'வரிசைக் கருவி மட்டுமே கூடையை பில்லிங் இடத்துக்கு ஒப்படைக்கும்.' },
  no_free_code: { en: 'Every hand-over code is in use. Ask a till to bring up the waiting baskets, or give up the ones nobody came for.', ta: 'எல்லா ஒப்படைப்புக் குறியீடுகளும் பயன்பாட்டில் உள்ளன. காத்திருக்கும் கூடைகளை பில்லிங்கில் எடுக்கவும்.' },
  not_a_queue_code: { en: 'A handheld basket code is four digits, as the handheld shows it.', ta: 'கருவிக் கூடைக் குறியீடு நான்கு இலக்கங்கள் — கருவியில் காட்டுவது போல.' },
  no_such_queue_basket: { en: 'No handheld basket is waiting under that code on this store computer. Check the code on the handheld, or scan the items.', ta: 'அந்தக் குறியீட்டில் கருவிக் கூடை எதுவும் காத்திருக்கவில்லை. கருவியில் உள்ள குறியீட்டைச் சரிபார்க்கவும் அல்லது பொருட்களை ஸ்கேன் செய்யவும்.' },
  already_recalled: { en: 'This basket was already brought up at another till — ringing it again would charge the customer twice.', ta: 'இந்தக் கூடை ஏற்கனவே வேறு பில்லிங்கில் எடுக்கப்பட்டது — மீண்டும் பில் செய்தால் வாடிக்கையாளருக்கு இருமுறை கட்டணம்.' },
  given_up: { en: 'This basket was given up on the handheld. Scan the items.', ta: 'இந்தக் கூடை கருவியில் கைவிடப்பட்டது. பொருட்களை ஸ்கேன் செய்யவும்.' },
  already_given_up: { en: 'This basket was already given up. It stays on the record.', ta: 'இந்தக் கூடை ஏற்கனவே கைவிடப்பட்டது. அது பதிவில் இருக்கும்.' },
  handheld_cannot_recall: { en: 'A handheld cannot bring a basket up — only a till can.', ta: 'கருவி கூடையை எடுக்க முடியாது — பில்லிங் இடம் மட்டுமே.' },
  reason_required: { en: 'Say why the basket is given up. Nothing was changed.', ta: 'கூடை ஏன் கைவிடப்படுகிறது என்று சொல்லவும். எதுவும் மாற்றப்படவில்லை.' },
  not_this_handheld: { en: 'That basket was handed over by another handheld. Only that handheld may give it up.', ta: 'அந்தக் கூடையை வேறு கருவி ஒப்படைத்தது. அதுவே கைவிட முடியும்.' },
  no_lane: { en: 'This store computer has not been told which till it is. Nothing was done — tell the manager.', ta: 'இந்தக் கடை கணினிக்கு அது எந்த பில்லிங் இடம் என்று சொல்லப்படவில்லை. மேலாளரிடம் சொல்லவும்.' },
});
