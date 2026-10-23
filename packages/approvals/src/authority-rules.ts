// The owner's approval rules, held centrally (M02-FR-02 value-limit authorization · M02-FR-03 escalation · M05-FR-01 price
// changes · §28 · owner decisions OB-290, OB-291, OB-292 of 23 Oct 2026). Pure domain logic: no storage, no I/O.
//
// Three rules, each a versioned value the owner may change — never through one person (the routes take every change
// through the maker-checker engine):
//
//   1. MONEY LIMITS (OB-290 "suggested ladder"). How much each role may approve, per kind of decision: a refund, a purchase
//      order, a stock adjustment. Cashier ₹0; store manager ₹5,000 refund / ₹25,000 purchase order / ₹2,000 adjustment;
//      owner unlimited. Anything above a person's limit goes to the owner. A role with no figure for a kind is "not set" —
//      shown as not set, never invented, and it approves no money until the owner sets it (default deny, P-04).
//   2. ESCALATION WAITS (OB-292 "per kind"). How long an approval may wait before it goes to the owner: refund 1 hour,
//      purchase order 24 hours, stock adjustment 48 hours.
//   3. PRICE-CHECK SIZE (OB-291). A price change needs a second person when it moves the price by more than 10% OR more
//      than ₹50 a unit (or is below the margin floor, which the price guard already judges). Smaller changes commit with one.
//
// The limit a person holds is the SERVER's answer from their grants — never a figure in a request body (the audit found
// `/v1/access/approvals/decide` taking the decider's own limit from the body; this is what replaces it).

/** The kinds of decision a money limit governs (OB-290). */
export const LIMITED_SUBJECTS = Object.freeze(['refund', 'purchase_order', 'stock_adjustment'] as const);
export type LimitedSubject = (typeof LIMITED_SUBJECTS)[number];
export const isLimitedSubject = (v: unknown): v is LimitedSubject => typeof v === 'string' && (LIMITED_SUBJECTS as readonly string[]).includes(v);

/**
 * Which money limit a decision falls under — the engine's kinds and the store screens' subject types both map here. A kind
 * not listed is not money-limited (its permission alone decides who may approve it, as before).
 */
const SUBJECT_OF: Readonly<Record<string, LimitedSubject>> = Object.freeze({
  refund: 'refund',
  order_refund: 'refund',
  exchange_refund: 'refund',
  no_receipt_return: 'refund',
  out_of_window: 'refund',
  tender_exception: 'refund',
  purchase_order: 'purchase_order',
  stock_adjustment: 'stock_adjustment',
  stock_adjustment_up: 'stock_adjustment',
  stock_write_off: 'stock_adjustment',
  write_off: 'stock_adjustment',
  stock_count: 'stock_adjustment',
});
export function limitedSubjectOf(kindOrSubject: string): LimitedSubject | undefined {
  return SUBJECT_OF[kindOrSubject];
}

/** One role's (or one person's) limits, in paise. `null` = unlimited; a kind left out = not set. */
export type LimitRow = Readonly<Partial<Record<LimitedSubject, number | null>>>;

export interface AuthorityLimits {
  readonly byRole: Readonly<Record<string, LimitRow>>;
}

export type EscalationWaits = Readonly<Record<LimitedSubject, number>>;

export interface PriceCheckThresholds {
  /** A change of MORE than this share of the current price needs a second person, in basis points (1000 = 10%). */
  readonly percentBps: number;
  /** A change of MORE than this, per unit, in paise, needs a second person (5000 = ₹50). */
  readonly amountMinor: number;
}

/** OB-290 (owner, 23 Oct 2026): the suggested ladder, in paise. */
export const DECIDED_AUTHORITY_LIMITS: AuthorityLimits = Object.freeze({
  byRole: Object.freeze({
    cashier: Object.freeze({ refund: 0, purchase_order: 0, stock_adjustment: 0 }),
    store_manager: Object.freeze({ refund: 500_000, purchase_order: 2_500_000, stock_adjustment: 200_000 }),
    owner: Object.freeze({ refund: null, purchase_order: null, stock_adjustment: null }),
  }),
});

/** OB-292 (owner, 23 Oct 2026): minutes an approval may wait before it goes to the owner. */
export const DECIDED_ESCALATION_WAITS: EscalationWaits = Object.freeze({ refund: 60, purchase_order: 24 * 60, stock_adjustment: 48 * 60 });

/** OB-291 (owner, 23 Oct 2026): more than 10% or more than ₹50 a unit. */
export const DECIDED_PRICE_CHECK: PriceCheckThresholds = Object.freeze({ percentBps: 1_000, amountMinor: 5_000 });

/** The three rules, by the name the routes and screens use. */
export const AUTHORITY_RULES = Object.freeze(['limits', 'escalation-waits', 'price-check'] as const);
export type AuthorityRule = (typeof AUTHORITY_RULES)[number];
export const isAuthorityRule = (v: unknown): v is AuthorityRule => typeof v === 'string' && (AUTHORITY_RULES as readonly string[]).includes(v);

// ── reading a rule safely (a value is judged before it is believed) ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ID = /^[a-z][a-z0-9_]{0,63}$/;

export type RuleRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

function readRow(v: unknown, who: string): RuleRead<LimitRow> {
  if (!isObj(v)) return { ok: false, why: `${who}: a row of limits is { refund?, purchase_order?, stock_adjustment? }` };
  const out: Partial<Record<LimitedSubject, number | null>> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!isLimitedSubject(k)) return { ok: false, why: `${who}: "${k}" is not a kind of decision a limit governs (${LIMITED_SUBJECTS.join(', ')})` };
    if (x === undefined) continue;
    if (x !== null && !isPaise(x)) return { ok: false, why: `${who}: the ${k} limit must be whole paise of 0 or more, or null for unlimited` };
    out[k] = x;
  }
  return { ok: true, value: Object.freeze(out) };
}

export function readAuthorityLimits(v: unknown, knownRoles?: readonly string[]): RuleRead<AuthorityLimits> {
  if (!isObj(v) || !isObj(v['byRole'])) return { ok: false, why: 'Money limits are { byRole: { <role>: { refund?, purchase_order?, stock_adjustment? } } } in paise.' };
  const byRole: Record<string, LimitRow> = {};
  for (const [roleId, row] of Object.entries(v['byRole'])) {
    if (!ID.test(roleId)) return { ok: false, why: `"${roleId}" is not a role id.` };
    if (knownRoles !== undefined && !knownRoles.includes(roleId)) return { ok: false, why: `There is no role "${roleId}" in this product's catalogue.` };
    const r = readRow(row, roleId);
    if (!r.ok) return r;
    byRole[roleId] = r.value;
  }
  // The owner is the top of every escalation (M02-FR-03): a figure for the owner would leave decisions with nobody to go to.
  const owner = byRole['owner'];
  if (owner !== undefined && LIMITED_SUBJECTS.some((s) => owner[s] !== undefined && owner[s] !== null)) {
    return { ok: false, why: 'The owner is the top of every escalation, so the owner\'s limit stays unlimited — a figure there would leave larger decisions with nobody to approve them.' };
  }
  return { ok: true, value: Object.freeze({ byRole: Object.freeze(byRole) }) };
}

/** Longest wait accepted: 30 days. A longer one is an approval nobody chases. */
export const MAX_WAIT_MINUTES = 30 * 24 * 60;

export function readEscalationWaits(v: unknown): RuleRead<EscalationWaits> {
  if (!isObj(v)) return { ok: false, why: 'Escalation waits are { refund, purchase_order, stock_adjustment } in whole minutes.' };
  const out: Partial<Record<LimitedSubject, number>> = {};
  for (const s of LIMITED_SUBJECTS) {
    const x = v[s];
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > MAX_WAIT_MINUTES) {
      return { ok: false, why: `The ${s} wait must be a whole number of minutes from 1 to ${MAX_WAIT_MINUTES} (30 days).` };
    }
    out[s] = x;
  }
  for (const k of Object.keys(v)) if (!isLimitedSubject(k)) return { ok: false, why: `"${k}" is not a kind of approval that escalates by age.` };
  return { ok: true, value: Object.freeze(out as EscalationWaits) };
}

export function readPriceCheck(v: unknown): RuleRead<PriceCheckThresholds> {
  if (!isObj(v)) return { ok: false, why: 'The price check is { percentBps, amountMinor }.' };
  const p = v['percentBps']; const a = v['amountMinor'];
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 10_000) return { ok: false, why: 'percentBps must be a whole number from 1 to 10000 (0.01% to 100%).' };
  if (!isPaise(a) || a < 1) return { ok: false, why: 'amountMinor must be whole paise of 1 or more.' };
  for (const k of Object.keys(v)) if (k !== 'percentBps' && k !== 'amountMinor') return { ok: false, why: `"${k}" is not part of the price check.` };
  return { ok: true, value: Object.freeze({ percentBps: p, amountMinor: a }) };
}

export function readRule(rule: AuthorityRule, v: unknown, knownRoles?: readonly string[]): RuleRead<unknown> {
  return rule === 'limits' ? readAuthorityLimits(v, knownRoles) : rule === 'escalation-waits' ? readEscalationWaits(v) : readPriceCheck(v);
}

export const DECIDED_VALUES: Readonly<Record<AuthorityRule, unknown>> = Object.freeze({
  limits: DECIDED_AUTHORITY_LIMITS, 'escalation-waits': DECIDED_ESCALATION_WAITS, 'price-check': DECIDED_PRICE_CHECK,
});

/** The roles whose rows a change touches — added, removed or changed (§28: "cannot modify … own approval limits"). */
export function rolesTouched(before: AuthorityLimits, after: AuthorityLimits): readonly string[] {
  const ids = new Set([...Object.keys(before.byRole), ...Object.keys(after.byRole)]);
  return [...ids].filter((id) => JSON.stringify(normalRow(before.byRole[id])) !== JSON.stringify(normalRow(after.byRole[id]))).sort();
}
const normalRow = (r: LimitRow | undefined): Record<string, number | null | 'unset'> =>
  Object.fromEntries(LIMITED_SUBJECTS.map((s) => [s, r === undefined || r[s] === undefined ? 'unset' : r[s]!]));

// ── whose limit, for what ───────────────────────────────────────────────────────────────────────────────────────────

export type AuthorityState = 'not_value_limited' | 'unlimited' | 'limit' | 'not_set';

/** A person's money authority for one kind of decision, as the server works it out. */
export interface Authority {
  readonly userId: string;
  readonly subjectType: string;
  /** The money limit this decision falls under; null when it is not money-limited. */
  readonly limitedAs: LimitedSubject | null;
  readonly state: AuthorityState;
  /** The limit in paise when `state` is `limit`; null otherwise. */
  readonly limitMinor: number | null;
  /** Which role gave it (the most generous of the person's roles), when one did. */
  readonly fromRole: string | null;
  /** The version of the limits table this was read from (0 = the owner's decided ladder, never changed since). */
  readonly rulesVersion: number;
}

/**
 * The authority a person holds for a kind of decision: across their roles, the most generous figure any role has for it
 * (a person holds what any of their roles grants); unlimited when any of those roles is; not set when none has a figure.
 */
export function authorityFrom(input: {
  readonly limits: AuthorityLimits;
  readonly rulesVersion: number;
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly subjectType: string;
}): Authority {
  const limitedAs = limitedSubjectOf(input.subjectType) ?? null;
  const base = { userId: input.userId, subjectType: input.subjectType, limitedAs, rulesVersion: input.rulesVersion };
  if (limitedAs === null) return { ...base, state: 'not_value_limited', limitMinor: null, fromRole: null };
  let best: { minor: number | null; role: string } | undefined;
  for (const roleId of [...new Set(input.roleIds)].sort()) {
    const row = input.limits.byRole[roleId];
    if (row === undefined || row[limitedAs] === undefined) continue;
    const minor = row[limitedAs]!;
    if (best === undefined || minor === null || (best.minor !== null && minor > best.minor)) best = { minor, role: roleId };
    if (best.minor === null) break;
  }
  if (best === undefined) return { ...base, state: 'not_set', limitMinor: null, fromRole: null };
  return best.minor === null
    ? { ...base, state: 'unlimited', limitMinor: null, fromRole: best.role }
    : { ...base, state: 'limit', limitMinor: best.minor, fromRole: best.role };
}

/** May this authority approve this amount? A decision with no amount, or one not money-limited, is not limited here. */
export function mayApproveValue(a: Authority, valueMinor: number | null): boolean {
  if (valueMinor === null) return true;
  if (a.state === 'not_value_limited' || a.state === 'unlimited') return true;
  if (a.state === 'not_set') return false;
  return valueMinor <= (a.limitMinor ?? 0);
}

/** The words for an authority, for a refusal or a screen. */
export function authorityWords(a: Authority): string {
  const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  switch (a.state) {
    case 'not_value_limited': return `${a.subjectType} is not limited by amount`;
    case 'unlimited': return `unlimited (${a.fromRole ?? 'role'})`;
    case 'not_set': return 'not set — the owner has not given a limit for this';
    case 'limit': return `up to ${rupees(a.limitMinor ?? 0)} (${a.fromRole ?? 'role'})`;
  }
}

// ── escalation by age (OB-292) ──────────────────────────────────────────────────────────────────────────────────────

/** Is a pending approval past its wait? Judged on the server's clock, from when it was asked. */
export function escalationDue(input: { readonly requestedAt: string; readonly waitMinutes: number; readonly now: string }): { readonly due: boolean; readonly waitedMinutes: number; readonly dueAt: string } {
  const asked = Date.parse(input.requestedAt);
  const now = Date.parse(input.now);
  const dueAtMs = asked + input.waitMinutes * 60_000;
  return {
    due: Number.isFinite(asked) && Number.isFinite(now) && now >= dueAtMs,
    waitedMinutes: Number.isFinite(asked) && Number.isFinite(now) ? Math.max(0, Math.floor((now - asked) / 60_000)) : 0,
    dueAt: Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : input.requestedAt,
  };
}

// ── price-change size (OB-291) ──────────────────────────────────────────────────────────────────────────────────────

export interface PriceChangeSize {
  /** True when the change is larger than either threshold — a second person must approve it. */
  readonly needsSecondPerson: boolean;
  /** Which thresholds it passed. */
  readonly because: readonly ('percent' | 'amount')[];
  readonly changeMinor: number;
  /** The change as a share of the current price, in basis points (rounded up). */
  readonly changeBps: number;
}

/**
 * Judge a price change's size against the thresholds. Strictly MORE than either is "large": exactly 10% or exactly ₹50
 * commits with one person. Up or down both count — a large rise and a large cut are both changes a second person checks.
 */
export function priceChangeSize(currentMinor: number, proposedMinor: number, t: PriceCheckThresholds): PriceChangeSize {
  const changeMinor = Math.abs(proposedMinor - currentMinor);
  const because: ('percent' | 'amount')[] = [];
  // Integer arithmetic: change/current > bps/10000  ⇔  change·10000 > bps·current.
  if (currentMinor > 0 ? changeMinor * 10_000 > t.percentBps * currentMinor : changeMinor > 0) because.push('percent');
  if (changeMinor > t.amountMinor) because.push('amount');
  const changeBps = currentMinor > 0 ? Math.ceil((changeMinor * 10_000) / currentMinor) : changeMinor > 0 ? 10_000 : 0;
  return { needsSecondPerson: because.length > 0, because, changeMinor, changeBps };
}
