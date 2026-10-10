// Spending loyalty points and store credit at the till (Wave 5 · PF-09 step 3 · M17-FR-01, M17-FR-03, M17-FR-04,
// M12-FR-03, §31, hard rules #1 #2 #10, P-02, P-08). Pure and deterministic — no clock, no store, no network.
//
// The till trades with the cable out (hard rule #1), and head office holds the one true balance of every member's points
// and store credit (P-02). So the store computer keeps a COPY of the balances — the "wallet feed" head office publishes —
// and decides a spend against that copy minus every spend it has itself recorded that head office has not yet applied.
// The copy can be old, and another channel (another store computer, the app) can spend the same value meanwhile, so
// every spend at the till is also held under the owner's TILL SPEND CAP: the most one member may spend at this store
// computer in one trading day (M17-FR-01 "offline earn/burn follows caps to prevent double-spend"). The cap is the
// owner's setting; zero means spending at the till is off — this file never assumes one.
//
// Head office applies every spend when the sale reaches it, under its own guard (PF-01). A spend the copy allowed but the
// true balance cannot cover is never refused there (the goods are gone) and never taken below zero: what is short is a
// visible exception for a person (hard rule #10).
//
// A spend is a TENDER on the sale (`loyalty_points` or `store_credit`), so it is durable exactly when the sale is — there
// is no separate hold that could be orphaned. Its reference is the sale and the kind (`spendRefFor`), which is also the
// movement id head office records it under, so the same sale relayed twice spends once.

/** The two tenders that spend a member's value rather than take money. */
export const SPEND_TENDERS = ['loyalty_points', 'store_credit'] as const;
export type SpendTender = (typeof SPEND_TENDERS)[number];
export const isSpendTender = (v: unknown): v is SpendTender => v === 'loyalty_points' || v === 'store_credit';

/** The owner's loyalty rule as head office publishes it to the store computers. Every figure 0 = off. */
export interface WalletRule {
  readonly pointsPer100Inr: number;
  /** What one point takes off a bill, in paise. 0 → points cannot be spent. */
  readonly pointValuePaise: number;
  /** The most one member may spend (points value + store credit) at one store computer in one trading day. 0 → off. */
  readonly tillSpendCapPaise: number;
}

/** One member's balances as head office last knew them — a member CODE, never a phone number (P-04). */
export interface MemberWallet {
  readonly memberRef: string;
  readonly points: number;
  readonly storeCreditMinor: number;
  /** The till spends head office has already applied to these balances (their `spendRefFor` refs). */
  readonly appliedSpendRefs: readonly string[];
}

export interface WalletFeed {
  readonly tenantId: string;
  /** Head office's clock when it built the feed — how old the copy is, said on the till (P-08). */
  readonly generatedAt: string;
  readonly rule: WalletRule;
  readonly members: readonly MemberWallet[];
}

/** A spend this store computer recorded (a spend tender on a sale it saved). */
export interface LocalSpend {
  readonly ref: string;
  readonly saleId: string;
  readonly memberRef: string;
  readonly kind: SpendTender;
  readonly amountMinor: number;
  readonly tradingDay: string;
}

/** The movement id / reference a spend is known by everywhere: one per sale and kind. */
export const spendRefFor = (saleId: string, kind: SpendTender): string => `${saleId}:${kind}`;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const wholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMemberCode = (v: unknown): v is string => typeof v === 'string' && /^m-[0-9a-f]{24}$/.test(v);

/** Read an untrusted feed (off the wire or the disk). Anything malformed is refused whole — never half-served. */
export function readWalletFeed(raw: unknown): WalletFeed | undefined {
  if (!isObj(raw) || typeof raw['tenantId'] !== 'string' || raw['tenantId'] === '') return undefined;
  if (typeof raw['generatedAt'] !== 'string' || Number.isNaN(Date.parse(raw['generatedAt']))) return undefined;
  const r = raw['rule'];
  if (!isObj(r) || !wholeNonNeg(r['pointsPer100Inr']) || !wholeNonNeg(r['pointValuePaise']) || !wholeNonNeg(r['tillSpendCapPaise'])) return undefined;
  if (!Array.isArray(raw['members'])) return undefined;
  const members: MemberWallet[] = [];
  for (const m of raw['members'] as unknown[]) {
    if (!isObj(m) || !isMemberCode(m['memberRef']) || typeof m['points'] !== 'number' || !Number.isSafeInteger(m['points'])
      || typeof m['storeCreditMinor'] !== 'number' || !Number.isSafeInteger(m['storeCreditMinor'])
      || !Array.isArray(m['appliedSpendRefs']) || !(m['appliedSpendRefs'] as unknown[]).every((s) => typeof s === 'string')) {
      return undefined;
    }
    members.push({
      memberRef: m['memberRef'], points: m['points'], storeCreditMinor: m['storeCreditMinor'],
      appliedSpendRefs: [...(m['appliedSpendRefs'] as string[])],
    });
  }
  return {
    tenantId: raw['tenantId'], generatedAt: raw['generatedAt'],
    rule: { pointsPer100Inr: r['pointsPer100Inr'], pointValuePaise: r['pointValuePaise'], tillSpendCapPaise: r['tillSpendCapPaise'] },
    members,
  };
}

/** What a member may spend at this till now — the copy, less this box's unapplied spends, within today's cap. */
export interface WalletAvailability {
  readonly known: boolean;
  /** Points the member holds as far as this box can tell (never below zero). */
  readonly points: number;
  readonly pointValuePaise: number;
  /** The rupee value of those points at the owner's point value. */
  readonly pointsValueMinor: number;
  readonly storeCreditMinor: number;
  /** What this member has already spent at this box today, and what the cap still allows. */
  readonly spentTodayMinor: number;
  readonly capRemainingMinor: number;
  /** The age of the copy: head office's clock when it built it. */
  readonly asOf?: string;
}

export function walletAvailable(input: {
  readonly feed: WalletFeed | undefined;
  readonly memberRef: string;
  readonly localSpends: readonly LocalSpend[];
  readonly tradingDay: string;
}): WalletAvailability {
  const { feed } = input;
  const mine = input.localSpends.filter((s) => s.memberRef === input.memberRef);
  const spentTodayMinor = mine.filter((s) => s.tradingDay === input.tradingDay).reduce((n, s) => n + s.amountMinor, 0);
  if (feed === undefined) {
    return { known: false, points: 0, pointValuePaise: 0, pointsValueMinor: 0, storeCreditMinor: 0, spentTodayMinor, capRemainingMinor: 0 };
  }
  const value = feed.rule.pointValuePaise;
  const wallet = feed.members.find((m) => m.memberRef === input.memberRef);
  const applied = new Set(wallet?.appliedSpendRefs ?? []);
  const pending = mine.filter((s) => !applied.has(s.ref));
  const pendingPoints = value > 0
    ? pending.filter((s) => s.kind === 'loyalty_points').reduce((n, s) => n + Math.floor(s.amountMinor / value), 0)
    : 0;
  const pendingCredit = pending.filter((s) => s.kind === 'store_credit').reduce((n, s) => n + s.amountMinor, 0);
  const points = Math.max(0, (wallet?.points ?? 0) - pendingPoints);
  const storeCreditMinor = Math.max(0, (wallet?.storeCreditMinor ?? 0) - pendingCredit);
  return {
    known: true, points, pointValuePaise: value, pointsValueMinor: points * value, storeCreditMinor,
    spentTodayMinor, capRemainingMinor: Math.max(0, feed.rule.tillSpendCapPaise - spentTodayMinor), asOf: feed.generatedAt,
  };
}

export type TillSpendRefusal =
  | 'no_member_named' | 'wallets_not_known' | 'points_value_not_set' | 'till_spending_off' | 'not_whole_points'
  | 'not_enough_points' | 'not_enough_store_credit' | 'over_till_spend_cap' | 'spend_amount_invalid' | 'one_spend_of_each_kind';

export type TillSpendAssessment =
  | { readonly ok: true; readonly spends: readonly LocalSpend[] }
  | { readonly ok: false; readonly refusedBecause: TillSpendRefusal; readonly laneMessage: string };

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * Decide the spend tenders on one sale, before the sale reaches the disk. `tenders` is the sale's tenders as written
 * (`{ kind, amountMinor }`); those that are not spend tenders are ignored. A sale with no spend tender is always ok.
 * A re-sent sale whose spends are already recorded (same sale id) is assessed without counting itself twice.
 */
export function assessTillSpend(input: {
  readonly feed: WalletFeed | undefined;
  readonly saleId: string;
  readonly memberRef: string | undefined;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[];
  readonly localSpends: readonly LocalSpend[];
  readonly tradingDay: string;
}): TillSpendAssessment {
  const spendTenders = input.tenders.filter((t) => isSpendTender(t.kind));
  if (spendTenders.length === 0) return { ok: true, spends: [] };
  const refuse = (refusedBecause: TillSpendRefusal, laneMessage: string): TillSpendAssessment => ({ ok: false, refusedBecause, laneMessage });
  if (input.memberRef === undefined) {
    return refuse('no_member_named', 'Points and store credit belong to a loyalty member. Key the customer\'s mobile number first. Nothing was saved.');
  }
  const kinds = spendTenders.map((t) => t.kind);
  if (new Set(kinds).size !== kinds.length) {
    return refuse('one_spend_of_each_kind', 'A bill may use points once and store credit once. Nothing was saved — take the payment again.');
  }
  if (input.feed === undefined) {
    return refuse('wallets_not_known', 'This store computer has not yet received the members\' balances from head office, so points and store credit cannot be spent here now. Take another payment. Nothing was saved.');
  }
  const rule = input.feed.rule;
  if (rule.tillSpendCapPaise <= 0) {
    return refuse('till_spending_off', 'Spending points or store credit at the till is switched off: the owner has not set the till spend limit. Take another payment. Nothing was saved.');
  }
  // This sale's own earlier record (a re-send after a lost reply) does not count against itself.
  const others = input.localSpends.filter((s) => s.saleId !== input.saleId);
  const available = walletAvailable({ feed: input.feed, memberRef: input.memberRef, localSpends: others, tradingDay: input.tradingDay });
  const spends: LocalSpend[] = [];
  for (const t of spendTenders) {
    const kind = t.kind as SpendTender;
    if (!Number.isSafeInteger(t.amountMinor) || t.amountMinor <= 0) {
      return refuse('spend_amount_invalid', 'The amount to spend must be a positive amount. Nothing was saved.');
    }
    if (kind === 'loyalty_points') {
      if (rule.pointValuePaise <= 0) {
        return refuse('points_value_not_set', 'Points cannot be spent: the owner has not set what one point is worth. Take another payment. Nothing was saved.');
      }
      if (t.amountMinor % rule.pointValuePaise !== 0) {
        return refuse('not_whole_points', `Points are spent whole: one point is worth ${inr(rule.pointValuePaise)}. Nothing was saved.`);
      }
      if (t.amountMinor > available.pointsValueMinor) {
        return refuse('not_enough_points', `The member has ${available.points} point(s) here, worth ${inr(available.pointsValueMinor)}. Nothing was saved — spend less, or take another payment.`);
      }
    } else if (t.amountMinor > available.storeCreditMinor) {
      return refuse('not_enough_store_credit', `The member has ${inr(available.storeCreditMinor)} of store credit here. Nothing was saved — spend less, or take another payment.`);
    }
    spends.push({ ref: spendRefFor(input.saleId, kind), saleId: input.saleId, memberRef: input.memberRef, kind, amountMinor: t.amountMinor, tradingDay: input.tradingDay });
  }
  const total = spends.reduce((n, s) => n + s.amountMinor, 0);
  if (total > available.capRemainingMinor) {
    return refuse('over_till_spend_cap', `Today this member may spend ${inr(available.capRemainingMinor)} more at this till (the owner's limit is ${inr(rule.tillSpendCapPaise)} a day). Nothing was saved — spend less, or take another payment.`);
  }
  return { ok: true, spends };
}

/** The spends a saved sale record carries — read from the disk, so every field is checked. */
export function spendsOfSaleRecord(record: unknown, fallbackTradingDay = ''): readonly LocalSpend[] {
  if (!isObj(record)) return [];
  const saleId = typeof record['id'] === 'string' ? record['id'] : typeof record['saleId'] === 'string' ? record['saleId'] : undefined;
  const memberRef = record['customerRef'];
  if (saleId === undefined || !isMemberCode(memberRef) || !Array.isArray(record['tenders'])) return [];
  const tradingDay = typeof record['tradingDay'] === 'string' ? record['tradingDay'] : fallbackTradingDay;
  return (record['tenders'] as unknown[]).flatMap((t) => {
    if (!isObj(t) || !isSpendTender(t['kind'])) return [];
    const amountMinor = typeof t['amountMinor'] === 'number' ? t['amountMinor'] : isObj(t['amount']) && typeof t['amount']['minor'] === 'number' ? t['amount']['minor'] : undefined;
    if (amountMinor === undefined || amountMinor <= 0) return [];
    return [{ ref: spendRefFor(saleId, t['kind']), saleId, memberRef, kind: t['kind'], amountMinor, tradingDay }];
  });
}

/**
 * How much of a bill may still be refunded as money or store credit when part of it was paid with POINTS (PF-09 step 3).
 * Points are not money: refunding the points-paid part in cash or credit would turn points into rupees. So a refund
 * against such a bill is capped at the part not paid with points, less what was already refunded. Undefined when the
 * bill used no points (the ordinary refund rules apply unchanged). What happens to the points themselves on a return is
 * the owner's decision (recorded in the report); until then they are not given back at the till.
 */
export function refundRoomOutsidePoints(input: {
  readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[] | undefined;
  readonly priorRefundsMinor: number;
}): number | undefined {
  const points = (input.tenders ?? []).filter((t) => t.kind === 'loyalty_points').reduce((n, t) => n + t.amountMinor, 0);
  if (points <= 0) return undefined;
  return Math.max(0, input.totalMinor - points - input.priorRefundsMinor);
}
