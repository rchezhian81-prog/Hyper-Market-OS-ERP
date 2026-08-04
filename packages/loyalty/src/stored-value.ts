// Gift cards, store credit and household pooling (M17-FR-03 / M17-FR-04 / §31.1 / M23).
//
// A gift card is **the shop's money held on the customer's behalf**. That single sentence
// is the whole design, and it is why this file is stricter than points:
//
//   • **A BALANCE IS A LIABILITY, NOT A FIGURE.** Every issued rupee is owed, appears on
//     the balance sheet, and must reconcile to what finance has posted (M23). A gift-card
//     balance that drifts is not a reporting bug; it is unrecorded debt.
//   • **BALANCES ARE PROJECTED FROM APPEND-ONLY MOVEMENTS**, never stored and decremented
//     (hard rule #2). A stored balance is a number two lanes can race on; a projection
//     cannot be raced, only reconciled.
//   • **OFFLINE REDEMPTION IS CAPPED, NOT FORBIDDEN.** Forbid it and the shop cannot
//     honour its own gift cards when the internet is down — which is when a customer is
//     most annoyed. Allow it unbounded and one card is spent on four lanes at once. So an
//     offline lane may redeem up to a per-tenant cap, and anything above it waits.
//   • **A DOUBLE-SPEND ACROSS CHANNELS IS AN EXCEPTION, NEVER A LAST-WRITE-WINS**
//     (§31.1, hard rule #10). When the app and the till both spend the last ₹200, the
//     shop finds out with both movements on file and a valued exception naming them —
//     not by one silently overwriting the other.
//
// **Household pooling (M17-FR-04)** puts one balance behind several people, which makes
// the double-spend a normal Tuesday rather than a rare race: a mother at the till and a
// son on the app, both spending the same ₹500. The projection handles it the same way —
// both movements are real, the balance goes negative, and that negative is surfaced as an
// exception with both parties named.
//
// Pure and deterministic: movements in, balance out, clock injected.

export type ValueKind = 'gift_card' | 'store_credit';

export type MovementKind = 'issue' | 'load' | 'redeem' | 'refund_to_credit' | 'expire' | 'adjust';

/** One append-only movement. Never edited; a correction is a compensating movement. */
export interface ValueMovement {
  readonly movementId: string;
  readonly instrumentId: string;
  readonly kind: MovementKind;
  /** Signed minor units: positive adds value, negative spends it. */
  readonly deltaMinor: number;
  readonly at: string;
  /** The channel it happened on — the double-spend is only visible across channels. */
  readonly channel: 'store' | 'app' | 'web' | 'phone';
  readonly customerRef?: string;
  readonly saleId?: string;
  /** True when captured on a lane that could not reach the cloud (§31). */
  readonly capturedOffline?: boolean;
  readonly reason?: string;
}

export interface Instrument {
  readonly instrumentId: string;
  readonly kind: ValueKind;
  /** The household or customer the value belongs to (M17-FR-04). */
  readonly ownerRef: string;
  readonly issuedAt: string;
  readonly expiresOn?: string;
  /** Provider token where a physical card is involved — never a card number (#3). */
  readonly providerRef?: string;
}

/** Balance is PROJECTED from movements. There is deliberately no stored balance field. */
export function balanceOf(movements: readonly ValueMovement[], instrumentId: string): number {
  return movements
    .filter((m) => m.instrumentId === instrumentId)
    .reduce((sum, m) => sum + m.deltaMinor, 0);
}

/** One balance across every instrument a household holds (M17-FR-04 pooling). */
export function householdBalance(
  movements: readonly ValueMovement[],
  instruments: readonly Instrument[],
  householdRef: string,
): number {
  const mine = new Set(instruments.filter((i) => i.ownerRef === householdRef).map((i) => i.instrumentId));
  return movements.filter((m) => mine.has(m.instrumentId)).reduce((s, m) => s + m.deltaMinor, 0);
}

export type RedeemRefusal =
  | 'redeemed'
  | 'insufficient_balance'
  | 'expired'
  | 'offline_cap_exceeded'
  | 'duplicate_movement'
  | 'invalid_amount';

export interface ValueRedeemResult {
  readonly instrumentId: string;
  readonly redeemed: boolean;
  readonly outcome: RedeemRefusal;
  readonly amountMinor: number;
  readonly balanceAfterMinor: number;
  readonly detail: string;
  readonly movement?: ValueMovement;
}

export interface StoredValuePolicy {
  /** Most one offline lane may take from an instrument before syncing. Default 50000 (₹500). */
  readonly offlineCapMinor?: number;
  /** Velocity limit: redemptions in the window before it is flagged. Default 5. */
  readonly velocityCount?: number;
  readonly velocityWindowMinutes?: number;
}

/**
 * Redeem against a gift card or store credit.
 *
 * Idempotent on the movement id. Offline redemption is **capped, not forbidden** — the
 * shop must be able to honour its own gift cards with the internet down, which is exactly
 * when refusing looks worst to a customer.
 */
export function redeemValue(input: {
  readonly instrument: Instrument;
  readonly movements: readonly ValueMovement[];
  readonly movement: ValueMovement;
  readonly policy?: StoredValuePolicy;
}): ValueRedeemResult {
  const { instrument: inst, movement: m } = input;
  const cap = input.policy?.offlineCapMinor ?? 50_000;
  const balance = balanceOf(input.movements, inst.instrumentId);
  const base = { instrumentId: inst.instrumentId, amountMinor: Math.abs(m.deltaMinor), balanceAfterMinor: balance };

  if (input.movements.some((x) => x.movementId === m.movementId)) {
    return { ...base, redeemed: false, outcome: 'duplicate_movement', detail: 'this redemption has already been recorded' };
  }
  if (m.deltaMinor >= 0 || !Number.isSafeInteger(m.deltaMinor)) {
    return { ...base, redeemed: false, outcome: 'invalid_amount', detail: 'a redemption must take a positive amount off the balance' };
  }
  if (inst.expiresOn !== undefined && m.at.slice(0, 10) > inst.expiresOn) {
    return { ...base, redeemed: false, outcome: 'expired', detail: `this ${inst.kind.replace('_', ' ')} expired on ${inst.expiresOn}` };
  }

  const amount = -m.deltaMinor;
  if (m.capturedOffline === true && amount > cap) {
    return {
      ...base,
      redeemed: false,
      outcome: 'offline_cap_exceeded',
      detail: `this lane is offline and can take at most ${cap} from a card without checking — ${amount} needs the connection back`,
    };
  }
  if (amount > balance) {
    return {
      ...base,
      redeemed: false,
      outcome: 'insufficient_balance',
      detail: `the balance is ${balance}, not ${amount} — a gift card cannot be overdrawn`,
    };
  }

  return {
    instrumentId: inst.instrumentId,
    redeemed: true,
    outcome: 'redeemed',
    amountMinor: amount,
    balanceAfterMinor: balance - amount,
    movement: m,
    detail: `${amount} redeemed, ${balance - amount} left`,
  };
}

export interface DoubleSpend {
  readonly instrumentId: string;
  readonly ownerRef: string;
  /** How far past zero the instrument went — real money the shop gave away twice. */
  readonly overspentMinor: number;
  /** Both sides, named, on both channels. Never one silently discarded. */
  readonly movements: readonly ValueMovement[];
  readonly channels: readonly string[];
  readonly detail: string;
}

/**
 * Find instruments that went negative once every channel's movements arrived — the
 * double-spend that only becomes visible after sync (§31.1).
 *
 * **Neither movement is discarded.** Both are real: two people genuinely received goods.
 * The shop is told what it gave away, on which channels, and to whom — and decides. A
 * last-write-wins would delete one of the two and the shop would never know it happened
 * (hard rule #10).
 */
export function findDoubleSpends(
  movements: readonly ValueMovement[],
  instruments: readonly Instrument[],
): readonly DoubleSpend[] {
  const byInstrument = new Map(instruments.map((i) => [i.instrumentId, i]));
  const found: DoubleSpend[] = [];

  for (const inst of instruments) {
    const mine = movements
      .filter((m) => m.instrumentId === inst.instrumentId)
      .sort((a, b) => a.at.localeCompare(b.at));
    const balance = mine.reduce((s, m) => s + m.deltaMinor, 0);
    if (balance >= 0) continue;

    // The spends that took it under, in arrival order — all of them, not the "loser".
    const spends = mine.filter((m) => m.deltaMinor < 0);
    found.push({
      instrumentId: inst.instrumentId,
      ownerRef: byInstrument.get(inst.instrumentId)?.ownerRef ?? inst.ownerRef,
      overspentMinor: -balance,
      movements: spends,
      channels: [...new Set(spends.map((m) => m.channel))].sort(),
      detail: `${inst.instrumentId} is ${-balance} overspent across ${[...new Set(spends.map((m) => m.channel))].join(' and ')} — both redemptions are real and both are kept; the shop decides what to do, nothing is silently reversed`,
    });
  }

  return found.sort((a, b) => b.overspentMinor - a.overspentMinor || a.instrumentId.localeCompare(b.instrumentId));
}

export interface LiabilityReconciliation {
  readonly outstandingMinor: number;
  readonly issuedMinor: number;
  readonly redeemedMinor: number;
  readonly expiredMinor: number;
  readonly postedLiabilityMinor: number;
  readonly differenceMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
}

/**
 * Reconcile outstanding stored value against what finance has posted as a liability
 * (M23). **Every unspent rupee on a gift card is money the shop owes**, and a balance
 * that drifts from the posted liability is unrecorded debt — so this is compared exactly,
 * the same discipline as a period-close control total.
 */
export function reconcileLiability(input: {
  readonly movements: readonly ValueMovement[];
  readonly postedLiabilityMinor: number;
}): LiabilityReconciliation {
  const sum = (f: (m: ValueMovement) => boolean): number =>
    input.movements.filter(f).reduce((s, m) => s + m.deltaMinor, 0);

  const issued = sum((m) => m.kind === 'issue' || m.kind === 'load' || m.kind === 'refund_to_credit');
  const redeemed = -sum((m) => m.kind === 'redeem');
  const expired = -sum((m) => m.kind === 'expire');
  const adjusted = sum((m) => m.kind === 'adjust');
  const outstanding = issued - redeemed - expired + adjusted;
  const difference = input.postedLiabilityMinor - outstanding;

  return {
    outstandingMinor: outstanding,
    issuedMinor: issued,
    redeemedMinor: redeemed,
    expiredMinor: expired,
    postedLiabilityMinor: input.postedLiabilityMinor,
    differenceMinor: difference,
    reconciles: difference === 0,
    detail:
      difference === 0
        ? `${outstanding} outstanding on both sides — the liability is correctly stated`
        : `the movements say ${outstanding} is owed to customers and the accounts carry ${input.postedLiabilityMinor} — a difference of ${difference}, which is unrecorded debt until it is explained`,
  };
}

export interface VelocityFlag {
  readonly instrumentId: string;
  readonly count: number;
  readonly valueMinor: number;
  readonly windowMinutes: number;
  readonly detail: string;
}

/**
 * Flag suspicious redemption velocity (M17-FR-03 fraud limits). **Detect-only** — it
 * raises a signal for a person, and blocks nothing: a genuine customer spending a large
 * gift card across a big shop looks exactly the same, and blocking them at the counter
 * over a heuristic is a worse outcome than a delayed investigation.
 */
export function flagVelocity(input: {
  readonly movements: readonly ValueMovement[];
  readonly at: string;
  readonly policy?: StoredValuePolicy;
}): readonly VelocityFlag[] {
  const count = input.policy?.velocityCount ?? 5;
  const windowMinutes = input.policy?.velocityWindowMinutes ?? 60;
  const cutoff = Date.parse(input.at) - windowMinutes * 60_000;

  const byInstrument = new Map<string, ValueMovement[]>();
  for (const m of input.movements) {
    if (m.kind !== 'redeem') continue;
    if (Date.parse(m.at) < cutoff) continue;
    byInstrument.set(m.instrumentId, [...(byInstrument.get(m.instrumentId) ?? []), m]);
  }

  return [...byInstrument]
    .filter(([, rows]) => rows.length >= count)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([instrumentId, rows]) => ({
      instrumentId,
      count: rows.length,
      valueMinor: -rows.reduce((s, m) => s + m.deltaMinor, 0),
      windowMinutes,
      detail: `${rows.length} redemptions in ${windowMinutes} minutes — worth a look, and nothing is blocked: a large gift card spent across a big shop looks the same`,
    }));
}
