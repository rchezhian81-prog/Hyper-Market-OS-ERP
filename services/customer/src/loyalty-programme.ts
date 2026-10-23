// API-06 The loyalty programme's two owner settings — TIERS and POINTS EXPIRY (M17-FR-01 · D07-FR-03 · owner decision
// OB-295, 23 Oct 2026). Both are OFF until the owner enters the numbers, and every read says "not set" until then.
//
//   • TIERS by 12-month spend, each with a points multiplier. A member's tier is worked out at each bill from what they
//     spent in the 12 months before it (`tierFor`); the multiplier applies to the points the owner's base rule earns.
//     A member who spends less falls back a tier by themselves; nobody is put in a tier by hand.
//   • EXPIRY: points expire N months after they were earned, oldest first (`pointsExpiry`). Each expiry is a new
//     movement on the member's append-only ledger, keyed on the lot it expires, so a second run changes nothing.
//   • THE ACCOUNTING IS THE CA's. Expiring points reduces what the shop owes its members. The books are NOT changed by an
//     expiry until the Chartered Accountant confirms the journal; the settings say so beside the switch (OB-295).
//
// Each setting is a fact — who set it, when, why — never an overwrite (hard rules #2, #6). Setting either is the
// owner's alone (`loyalty.programme.configure`); reading is `loyalty.points.read`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  readTiers, tierFor, withMultiplier, twelveMonthsBefore, pointsExpiry, isMemberRef,
  MAX_EXPIRY_MONTHS, expirySourceRef,
  type LoyaltyTier, type LedgerMovement, type DueExpiry, type TierStanding,
} from '../../../packages/loyalty/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { MemberRecord } from './loyalty-members';

/** One owner setting as head office keeps it: the value, who set it, when and why, and its version. */
export interface ProgrammeSetting<T> {
  readonly value: T;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason: string;
  readonly version: number;
}

export interface LoyaltyProgrammeDeps {
  readonly tiers: (tenantId: string) => Promise<ProgrammeSetting<readonly LoyaltyTier[]> | undefined>;
  readonly recordTiers: (tenantId: string, s: ProgrammeSetting<readonly LoyaltyTier[]>) => Promise<void>;
  /** `value` null = expiry switched off again (a fact, like any other). */
  readonly expiry: (tenantId: string) => Promise<ProgrammeSetting<number | null> | undefined>;
  readonly recordExpiry: (tenantId: string, s: ProgrammeSetting<number | null>) => Promise<void>;
  /** Every member fact, oldest first (the latest per code is its state). */
  readonly allMembers: (tenantId: string) => Promise<readonly MemberRecord[]>;
  /** What the member spent, net of what came back, on bills dated in [from, to). */
  readonly spendBetween: (tenantId: string, memberRef: string, from: string, to: string) => Promise<number>;
  /** The member's points ledger, oldest first. */
  readonly movements: (tenantId: string, memberRef: string) => Promise<readonly LedgerMovement[]>;
  readonly pointsVersion: (tenantId: string, memberRef: string) => Promise<number>;
  /** One expiry movement (a negative delta), under the member's points guard. Idempotent on the movement id. */
  readonly recordExpiryMovement: (tenantId: string, memberRef: string, m: { readonly movementId: string; readonly delta: number; readonly sourceRef: string; readonly at: string }, expectedVersion: number) => Promise<void>;
  readonly now: () => string;
}

/** OB-295: the note beside the expiry switch — the CA confirms the accounting before it is switched on. */
export const EXPIRY_ACCOUNTING_NOTE = Object.freeze({
  en: 'Expiring points reduces what the shop owes its members. The Chartered Accountant must confirm how expired points are booked before expiry is switched on. Until that journal is agreed, an expiry does not change the books, and the loyalty liability check shows the expired value as a difference.',
  ta: 'காலாவதியாகும் புள்ளிகள், கடை தன் உறுப்பினர்களுக்குத் தர வேண்டியதைக் குறைக்கின்றன. காலாவதியை இயக்கும் முன், காலாவதியான புள்ளிகளைக் கணக்கில் எப்படிப் பதிவு செய்வது என்பதைப் பட்டயக் கணக்காளர் உறுதிசெய்ய வேண்டும். அந்தப் பதிவு ஒப்புக்கொள்ளப்படும் வரை, காலாவதி கணக்குகளை மாற்றாது; லாயல்டி பொறுப்புச் சரிபார்ப்பு காலாவதியான மதிப்பை வேறுபாடாகக் காட்டும்.',
});

const NOT_SET = Object.freeze({
  tiers: { en: 'Tiers: not set. Every member earns the base rule until the owner enters the tiers.', ta: 'நிலைகள்: அமைக்கப்படவில்லை. உரிமையாளர் நிலைகளை உள்ளிடும் வரை எல்லா உறுப்பினர்களும் அடிப்படை விதிப்படி புள்ளிகள் பெறுவர்.' },
  expiry: { en: 'Points expiry: not set. No points expire until the owner enters the number of months.', ta: 'புள்ளிகள் காலாவதி: அமைக்கப்படவில்லை. உரிமையாளர் மாதங்களின் எண்ணிக்கையை உள்ளிடும் வரை எந்தப் புள்ளியும் காலாவதியாகாது.' },
});

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const reasonOrRefuse = (raw: unknown): string => {
  if (!isStr(raw) || raw.trim().length > 300) {
    throw apiError(400, { code: 'reason_required', whatHappened: 'Say why the setting is changed (up to 300 letters) — it is kept with the change.', wasItSaved: 'not_saved', nextSafeAction: 'Write the reason and save again. Nothing was changed.' });
  }
  return raw.trim();
};

/** The current state of every member code. */
function currentMembers(all: readonly MemberRecord[]): readonly MemberRecord[] {
  const latest = new Map<string, MemberRecord>();
  for (const r of all) latest.set(r.memberRef, r);
  return [...latest.values()];
}

/** The tiers in force now — empty when not set or switched off. */
export async function tiersInForce(deps: Pick<LoyaltyProgrammeDeps, 'tiers'>, tenantId: string): Promise<readonly LoyaltyTier[]> {
  return (await deps.tiers(tenantId))?.value ?? [];
}

/** A member's standing at an instant: their 12-month spend before it and the tier it reaches. */
export async function standingAt(deps: Pick<LoyaltyProgrammeDeps, 'tiers' | 'spendBetween'>, tenantId: string, memberRef: string, at: string): Promise<TierStanding> {
  const tiers = await tiersInForce(deps, tenantId);
  if (tiers.length === 0) return tierFor([], 0);
  const w = twelveMonthsBefore(at);
  return tierFor(tiers, await deps.spendBetween(tenantId, memberRef, w.from, w.to));
}

/**
 * The tier multiplier a bill earns at (for `earnOnSale`): with no tiers set, none (the base rule, said as no tier).
 * The bill's own spend is not counted towards its own tier — the window ends at the bill.
 */
export async function tierMultiplierAt(deps: Pick<LoyaltyProgrammeDeps, 'tiers' | 'spendBetween'>, tenantId: string, memberRef: string, at: string): Promise<{ readonly tierId: string | null; readonly tierName: string | null; readonly multiplierBps: number } | undefined> {
  const tiers = await tiersInForce(deps, tenantId);
  if (tiers.length === 0) return undefined;
  const s = await standingAt(deps, tenantId, memberRef, at);
  return { tierId: s.tier?.tierId ?? null, tierName: s.tier?.name ?? null, multiplierBps: s.multiplierBps };
}

export { withMultiplier };

export interface ExpiryRunOutcome {
  readonly on: boolean;
  readonly months: number | null;
  readonly expired: readonly (DueExpiry & { readonly memberRef: string })[];
  readonly pointsExpired: number;
  readonly membersTouched: number;
  readonly detail: string;
  readonly asAt: string;
}

/**
 * One expiry pass over every member: what is due is recorded as an expiry movement, once per lot, under the member's
 * points guard (a spend landing at the same moment is re-read, never overwritten). Off → nothing moves, said.
 */
export async function runPointsExpiry(deps: LoyaltyProgrammeDeps, tenantId: string): Promise<ExpiryRunOutcome> {
  const asAt = deps.now();
  const months = (await deps.expiry(tenantId))?.value ?? null;
  if (months === null) {
    return { on: false, months: null, expired: [], pointsExpired: 0, membersTouched: 0, detail: NOT_SET.expiry.en, asAt };
  }
  const expired: (DueExpiry & { readonly memberRef: string })[] = [];
  const touched = new Set<string>();
  for (const m of currentMembers(await deps.allMembers(tenantId))) {
    for (let attempt = 0; ; attempt += 1) {
      const version = await deps.pointsVersion(tenantId, m.memberRef);
      const { due } = pointsExpiry({ movements: await deps.movements(tenantId, m.memberRef), expiryMonths: months, asOf: asAt });
      if (due.length === 0) break;
      const first = due[0]!;
      try {
        await deps.recordExpiryMovement(tenantId, m.memberRef, { movementId: first.expiryMovementId, delta: -first.points, sourceRef: expirySourceRef(first.lotMovementId), at: asAt }, version);
        expired.push({ ...first, memberRef: m.memberRef });
        touched.add(m.memberRef);
        attempt = -1; // the next lot of the same member, on the fresh version
      } catch (err) {
        if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
        throw err;
      }
    }
  }
  const points = expired.reduce((n, e) => n + e.points, 0);
  return {
    on: true, months, expired, pointsExpired: points, membersTouched: touched.size, asAt,
    detail: expired.length === 0 ? `No points were due to expire (points expire ${months} month(s) after they were earned).`
      : `${points} point(s) expired across ${touched.size} member(s), oldest first. The books are not changed until the CA confirms the journal.`,
  };
}

const settingView = <T>(s: ProgrammeSetting<T> | undefined) => (s === undefined ? null : { setBy: s.setBy, setAt: s.setAt, reason: s.reason, version: s.version });

export function loyaltyProgrammeRoutes(deps: LoyaltyProgrammeDeps): readonly Route[] {
  const programme = async (tenantId: string) => {
    const tiers = await deps.tiers(tenantId);
    const expiry = await deps.expiry(tenantId);
    const tierList = tiers?.value ?? [];
    const months = expiry?.value ?? null;
    return {
      tiers: tierList.length === 0
        ? { state: 'not_set' as const, tiers: [], say: NOT_SET.tiers, last: settingView(tiers) }
        : { state: 'set' as const, tiers: tierList, say: { en: `${tierList.length} tier(s) by 12-month spend.`, ta: `12 மாதச் செலவின்படி ${tierList.length} நிலை(கள்).` }, last: settingView(tiers) },
      expiry: months === null
        ? { state: 'not_set' as const, months: null, say: NOT_SET.expiry, last: settingView(expiry) }
        : { state: 'set' as const, months, say: { en: `Points expire ${months} month(s) after they are earned, oldest first.`, ta: `புள்ளிகள் பெற்ற ${months} மாதங்களுக்குப் பிறகு, பழையவை முதலில், காலாவதியாகும்.` }, last: settingView(expiry) },
      accountingNote: EXPIRY_ACCOUNTING_NOTE,
      limits: { maxTiers: 6, multiplierBps: { min: 10_000, max: 100_000 }, expiryMonths: { min: 1, max: MAX_EXPIRY_MONTHS } },
    };
  };
  return [
    {
      // The two owner settings as they stand — "not set" until entered — with the CA's accounting note.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/programme',
      permission: 'loyalty.points.read',
      handler: async (ctx) => ({ status: 200, body: { ...(await programme(ctx.tenantId)), asAt: deps.now() } }),
    },
    {
      // The owner sets (or clears, with []) the tier ladder. Body: { tiers: [{ tierId, name, nameTa?, minSpend12mMinor, multiplierBps }], reason }.
      api: 'API-06', method: 'PUT', path: '/v1/loyalty/programme/tiers',
      permission: 'loyalty.programme.configure', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readTiers(b['tiers']);
        if (!read.ok) throw apiError(400, { code: `tiers_${read.problem}`, whatHappened: read.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct the tiers and save again. Nothing was changed.' });
        const reason = reasonOrRefuse(b['reason']);
        const before = await deps.tiers(ctx.tenantId);
        if (before !== undefined && JSON.stringify(before.value) === JSON.stringify(read.tiers)) return { status: 200, body: { ...(await programme(ctx.tenantId)), unchanged: true } };
        await deps.recordTiers(ctx.tenantId, { value: read.tiers, setBy: ctx.userId, setAt: deps.now(), reason, version: (before?.version ?? 0) + 1 });
        return { status: 200, body: await programme(ctx.tenantId) };
      },
    },
    {
      // The owner sets the months after which earned points expire — or switches expiry off again with null.
      // Body: { months: 1..120 | null, reason }.
      api: 'API-06', method: 'PUT', path: '/v1/loyalty/programme/expiry',
      permission: 'loyalty.programme.configure', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const months = b['months'];
        if (!(months === null || (Number.isSafeInteger(months) && (months as number) >= 1 && (months as number) <= MAX_EXPIRY_MONTHS))) {
          throw apiError(400, { code: 'expiry_months_unreadable', whatHappened: `Points expire after a whole number of months, from 1 to ${MAX_EXPIRY_MONTHS} — or null to switch expiry off.`, wasItSaved: 'not_saved', nextSafeAction: 'Enter the months and save again. Nothing was changed.' });
        }
        const reason = reasonOrRefuse(b['reason']);
        const before = await deps.expiry(ctx.tenantId);
        if ((before?.value ?? null) === months) return { status: 200, body: { ...(await programme(ctx.tenantId)), unchanged: true } };
        await deps.recordExpiry(ctx.tenantId, { value: months as number | null, setBy: ctx.userId, setAt: deps.now(), reason, version: (before?.version ?? 0) + 1 });
        return { status: 200, body: await programme(ctx.tenantId) };
      },
    },
    {
      // One member's standing now: their 12-month spend, the tier it reaches (or no tier / tiers not set), the next tier
      // and what more spend reaches it, and the points due to expire next.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/members/:memberRef/standing',
      permission: 'loyalty.points.read',
      handler: async (ctx) => {
        const memberRef = ctx.params['memberRef'] ?? '';
        if (!isMemberRef(memberRef)) throw notFound(`loyalty member ${memberRef}`);
        const member = currentMembers(await deps.allMembers(ctx.tenantId)).find((m) => m.memberRef === memberRef);
        if (member === undefined) throw notFound(`loyalty member ${memberRef}`);
        const at = deps.now();
        const tiers = await tiersInForce(deps, ctx.tenantId);
        const w = twelveMonthsBefore(at);
        const spend = await deps.spendBetween(ctx.tenantId, memberRef, w.from, w.to);
        const standing = tierFor(tiers, spend);
        const months = (await deps.expiry(ctx.tenantId))?.value ?? null;
        const ledger = await deps.movements(ctx.tenantId, memberRef);
        const exp = months === null ? null : pointsExpiry({ movements: ledger, expiryMonths: months, asOf: at });
        return {
          status: 200,
          body: {
            memberRef, mobileLast4: member.mobileLast4, status: member.status,
            pointsBalance: ledger.reduce((n, m) => n + m.delta, 0),
            spend12mMinor: spend,
            tiers: tiers.length === 0 ? { state: 'not_set', say: NOT_SET.tiers } : { state: 'set' },
            tier: standing.tier, multiplierBps: standing.multiplierBps,
            ...(standing.next === undefined ? {} : { nextTier: { tierId: standing.next.tier.tierId, name: standing.next.tier.name, moreSpendMinor: standing.next.moreSpendMinor } }),
            expiry: exp === null ? { state: 'not_set', say: NOT_SET.expiry } : { state: 'set', months, next: exp.upcoming[0] ?? null, dueNow: exp.due.reduce((n, d) => n + d.points, 0) },
            asAt: at,
          },
        };
      },
    },
    {
      // Run the expiry now (it also runs on its own, on head office's timer). Off → nothing moves, said.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/points-expiry/run',
      permission: 'loyalty.points.write', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: { ...(await runPointsExpiry(deps, ctx.tenantId)), accountingNote: EXPIRY_ACCOUNTING_NOTE } }),
    },
  ];
}
