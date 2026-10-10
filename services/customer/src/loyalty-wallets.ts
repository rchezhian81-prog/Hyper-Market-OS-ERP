// API-06 Loyalty wallets — what the store computers may let a member spend, and what a spend does when the sale arrives
// (Wave 5 · PF-09 step 3 · owner decisions OB-28 "C and 1", M17-FR-01, M17-FR-03, M17-FR-04, M12-FR-03, P-02, P-08,
// hard rules #1 #2 #10).
//
//   • THE FEED. Each store computer pulls a copy of every member's points and store credit (member CODES only — P-04),
//     with the owner's rule and till spend cap, and the spends head office has already applied, so the box can tell its
//     own not-yet-applied spends apart. `packages/loyalty/src/wallet.ts` decides a spend against that copy.
//   • THE SPEND, WHEN THE SALE ARRIVES. A `loyalty_points` or `store_credit` tender on a banked sale is applied here,
//     once (keyed on the sale and the kind), under the member's write guards (PF-01): points leave the member's points;
//     store credit leaves their store-credit instruments oldest first. It NEVER refuses — the goods are already gone
//     (hard rule #1) — and never takes a balance below zero: a part the true balance cannot cover (another channel spent
//     it meanwhile) is recorded as a SHORTFALL and raised as a visible exception for a person (hard rule #10, P-08).

import type { Route } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import {
  isMemberRef, isSpendTender, spendRefFor, balanceOf,
  type SpendTender, type WalletFeed, type MemberWallet, type Instrument, type ValueMovement,
} from '../../../packages/loyalty/src/index';
import type { LoyaltyRule, MemberRecord } from './loyalty-members';

/** What one spend did at head office — one fact per sale and kind, on the member's own stream. */
export interface SpendApplied {
  readonly ref: string;
  readonly saleId: string;
  readonly memberRef: string;
  readonly kind: SpendTender;
  /** What the till took off the bill. */
  readonly requestedMinor: number;
  /** What the member's true balance covered. */
  readonly appliedMinor: number;
  /** What it could not cover — spent elsewhere first (said, never hidden). */
  readonly shortfallMinor: number;
  /** For points: how many the till spent and how many left the balance. */
  readonly points?: number;
  readonly pointsApplied?: number;
  readonly at: string;
}

/** A store-credit instrument a member holds, with its own history and write-guard version. */
export interface HeldCredit {
  readonly instrument: Instrument;
  readonly movements: readonly ValueMovement[];
  readonly version: number;
}

export interface LoyaltyWalletDeps {
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
  /** Every member fact in the tenant, oldest first (the latest per code is its state). */
  readonly allMembers: (tenantId: string) => Promise<readonly MemberRecord[]> | readonly MemberRecord[];
  readonly pointsBalance: (tenantId: string, memberRef: string) => Promise<number | undefined> | number | undefined;
  readonly pointsVersion: (tenantId: string, memberRef: string) => Promise<number> | number;
  /** The member's STORE-CREDIT instruments (not gift cards), oldest first. */
  readonly storeCredit: (tenantId: string, memberRef: string) => Promise<readonly HeldCredit[]>;
  readonly spendsApplied: (tenantId: string, memberRef: string) => Promise<readonly SpendApplied[]>;
  /** The points leaving, under the member's points guard. Idempotent on the movement id. */
  readonly recordPointsSpend: (tenantId: string, memberRef: string, m: { readonly movementId: string; readonly points: number; readonly sourceRef: string; readonly at: string }, expectedVersion: number) => Promise<void>;
  /** Value leaving one store-credit instrument, under that instrument's guard. Idempotent on the movement id. */
  readonly recordCreditSpend: (tenantId: string, instrumentId: string, m: ValueMovement, expectedVersion: number) => Promise<void>;
  /** The spend's own fact, once it is done. Idempotent on the ref. */
  readonly recordSpendApplied: (tenantId: string, fact: SpendApplied) => Promise<void>;
  readonly now: () => string;
}

/** The current state of every member code — the latest fact per code. */
function currentMembers(all: readonly MemberRecord[]): readonly MemberRecord[] {
  const latest = new Map<string, MemberRecord>();
  for (const r of all) latest.set(r.memberRef, r);
  return [...latest.values()].filter((r) => r.status === 'member');
}

/** The feed a store computer pulls: the rule, and every member's balances and applied spends. */
export async function buildWalletFeed(deps: LoyaltyWalletDeps, tenantId: string): Promise<WalletFeed> {
  const rule = await deps.rule(tenantId);
  const members = currentMembers(await deps.allMembers(tenantId));
  const wallets: MemberWallet[] = [];
  for (const m of members) {
    const [points, credit, spends] = await Promise.all([
      deps.pointsBalance(tenantId, m.memberRef), deps.storeCredit(tenantId, m.memberRef), deps.spendsApplied(tenantId, m.memberRef),
    ]);
    wallets.push({
      memberRef: m.memberRef,
      points: Math.max(0, points ?? 0),
      storeCreditMinor: credit.reduce((n, c) => n + Math.max(0, balanceOf(c.movements, c.instrument.instrumentId)), 0),
      appliedSpendRefs: spends.map((s) => s.ref),
    });
  }
  wallets.sort((a, b) => a.memberRef.localeCompare(b.memberRef));
  return {
    tenantId, generatedAt: deps.now(),
    rule: { pointsPer100Inr: rule.pointsPer100Inr, pointValuePaise: rule.pointValuePaise, tillSpendCapPaise: rule.tillSpendCapPaise ?? 0 },
    members: wallets,
  };
}

export interface SpendTenderIn {
  readonly kind: string;
  readonly amountMinor: number;
  /** For points: the whole points the store computer took for this amount (it stamps it before the disk). */
  readonly points?: number;
}

export interface SpendOutcome {
  readonly kind: SpendTender;
  readonly ref: string;
  readonly requestedMinor: number;
  readonly appliedMinor: number;
  readonly shortfallMinor: number;
  readonly alreadyApplied: boolean;
  readonly detail: string;
}

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

async function applyPoints(
  deps: LoyaltyWalletDeps, tenantId: string, saleId: string, memberRef: string, t: SpendTenderIn, at: string,
): Promise<SpendApplied> {
  const ref = spendRefFor(saleId, 'loyalty_points');
  // The points the store computer took; an older record without them is valued at the owner's point value now.
  const value = (await deps.rule(tenantId)).pointValuePaise;
  const points = t.points !== undefined && Number.isSafeInteger(t.points) && t.points > 0
    ? t.points
    : value > 0 ? Math.floor(t.amountMinor / value) : 0;
  for (let attempt = 0; ; attempt += 1) {
    const version = await deps.pointsVersion(tenantId, memberRef);
    const balance = Math.max(0, (await deps.pointsBalance(tenantId, memberRef)) ?? 0);
    const taken = Math.min(points, balance);
    try {
      if (taken > 0) await deps.recordPointsSpend(tenantId, memberRef, { movementId: `spend-${ref}`, points: taken, sourceRef: `sale:${saleId}`, at }, version);
    } catch (err) {
      if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
      throw err;
    }
    // The money value of what was covered, in proportion to the points (whole paise, rounded down for the shop).
    const appliedMinor = points === 0 ? 0 : taken === points ? t.amountMinor : Math.floor((t.amountMinor * taken) / points);
    return {
      ref, saleId, memberRef, kind: 'loyalty_points', requestedMinor: t.amountMinor, appliedMinor,
      shortfallMinor: t.amountMinor - appliedMinor, points, pointsApplied: taken, at,
    };
  }
}

async function applyStoreCredit(
  deps: LoyaltyWalletDeps, tenantId: string, saleId: string, memberRef: string, t: SpendTenderIn, at: string,
): Promise<SpendApplied> {
  const ref = spendRefFor(saleId, 'store_credit');
  const movementFor = (instrumentId: string): string => `spend-${ref}-${instrumentId}`;
  // Instrument by instrument, oldest first, each under its own guard. A movement already on an instrument (a crash
  // between two of them, then the till's resend) counts as applied and that instrument is not touched again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const held = await deps.storeCredit(tenantId, memberRef);
      let applied = 0;
      for (const c of held) {
        const mine = c.movements.find((m) => m.movementId === movementFor(c.instrument.instrumentId));
        if (mine !== undefined) applied += -mine.deltaMinor;
      }
      for (const c of held) {
        const remaining = t.amountMinor - applied;
        if (remaining <= 0) break;
        if (c.movements.some((m) => m.movementId === movementFor(c.instrument.instrumentId))) continue;
        if (c.instrument.expiresOn !== undefined && c.instrument.expiresOn < at.slice(0, 10)) continue;
        const balance = balanceOf(c.movements, c.instrument.instrumentId);
        const take = Math.min(balance, remaining);
        if (take <= 0) continue;
        await deps.recordCreditSpend(tenantId, c.instrument.instrumentId, {
          movementId: movementFor(c.instrument.instrumentId), instrumentId: c.instrument.instrumentId, kind: 'redeem',
          deltaMinor: -take, at, channel: 'store', saleId, customerRef: memberRef, capturedOffline: true,
        }, c.version);
        applied += take;
      }
      return { ref, saleId, memberRef, kind: 'store_credit', requestedMinor: t.amountMinor, appliedMinor: applied, shortfallMinor: t.amountMinor - applied, at };
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) continue;
      throw err;
    }
  }
  throw new Error(`store credit for sale ${saleId} kept changing under it; the till's resend will apply it`);
}

/**
 * Apply every spend tender on a banked sale. Idempotent on the sale and kind; never refuses; every shortfall is in the
 * answer for the caller to raise as an exception.
 */
export async function spendOnSale(
  deps: LoyaltyWalletDeps, tenantId: string,
  sale: { readonly saleId: string; readonly customerRef?: unknown; readonly tenders: readonly SpendTenderIn[] },
): Promise<readonly SpendOutcome[]> {
  const spendTenders = sale.tenders.filter((t) => isSpendTender(t.kind));
  if (spendTenders.length === 0) return [];
  const memberRef = isMemberRef(sale.customerRef) ? sale.customerRef : undefined;
  const at = deps.now();
  const out: SpendOutcome[] = [];
  const prior = memberRef === undefined ? [] : await deps.spendsApplied(tenantId, memberRef);
  for (const t of spendTenders) {
    const kind = t.kind as SpendTender;
    const ref = spendRefFor(sale.saleId, kind);
    if (memberRef === undefined) {
      // The store computer refuses this before the disk; a record that arrives anyway is a shortfall in full.
      out.push({ kind, ref, requestedMinor: t.amountMinor, appliedMinor: 0, shortfallMinor: t.amountMinor, alreadyApplied: false, detail: `${inr(t.amountMinor)} was paid with ${kind === 'loyalty_points' ? 'points' : 'store credit'} but the sale names no loyalty member — nothing could be taken.` });
      continue;
    }
    const done = prior.find((p) => p.ref === ref);
    const fact = done ?? (kind === 'loyalty_points'
      ? await applyPoints(deps, tenantId, sale.saleId, memberRef, t, at)
      : await applyStoreCredit(deps, tenantId, sale.saleId, memberRef, t, at));
    if (done === undefined) await deps.recordSpendApplied(tenantId, fact);
    const what = kind === 'loyalty_points' ? 'points' : 'store credit';
    out.push({
      kind, ref, requestedMinor: fact.requestedMinor, appliedMinor: fact.appliedMinor, shortfallMinor: fact.shortfallMinor, alreadyApplied: done !== undefined,
      detail: fact.shortfallMinor > 0
        ? `${inr(fact.requestedMinor)} of ${what} was spent at the till, but the member held only ${inr(fact.appliedMinor)} by the time it arrived — ${inr(fact.shortfallMinor)} was spent twice (another channel first).`
        : `${inr(fact.appliedMinor)} of ${what} spent.`,
    });
  }
  return out;
}

export function loyaltyWalletRoutes(deps: LoyaltyWalletDeps): readonly Route[] {
  return [
    {
      // The store computer's copy of the members' balances (member codes only — never a phone number, P-04).
      api: 'API-06', method: 'GET', path: '/v1/loyalty/wallets',
      permission: 'loyalty.points.read',
      handler: async (ctx) => ({ status: 200, body: await buildWalletFeed(deps, ctx.tenantId) }),
    },
  ];
}
