// M17-FR-02 / D07-FR-04 (R4, signed OB-227 · OB-221) — referral rewards earned but not yet paid are a LIABILITY on the
// books; coupons are not (OB-221, subject to the CA).
//
//   POST /v1/loyalty/referrals/:referralId/payout    a person pays the reward out (how, and a reference)
//   POST /v1/loyalty/referrals/:referralId/expire    a person lets an unpaid reward lapse (with a reason)
//   GET  /v1/finance/referral-liability              the register against the books, to the paisa
//   POST /v1/finance/referral-liability/post         the accountant posts the register's movements through the mapping
//
// The register is append-only (hard rule #2): EARNING is the existing `ReferralRewarded` fact (a referral assessed payable
// — services/customer/src/coupons.ts); a PAYOUT or an EXPIRY is a new `ReferralRewardSettled` fact. Nothing is edited;
// what is owed on a referral is earned less settled. The books carry the same three movements, each ONE balanced journal
// posted through the accountant's posting map by the EXISTING posting gate (services/finance/src/index.ts `postJournal`):
// `referral:earned` raises the liability, `referral:paid` and `referral:expired` reduce it — each a compensating entry,
// never an edit. The liability account is the one the mapping credits on `referral:earned`. The read compares the books
// with the register exactly; any difference is an exception with its sign, never rounded away (P-08). A kind the mapping
// does not name stays visibly unposted. Coupons are untouched: they are not a liability and the read says so.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError, type PostingMap } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry } from '../../finance/src/index';
import { containsCardNumber } from '../../../packages/tender/src/card-token';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export interface ReferralEarned {
  readonly referralId: string;
  readonly rewardMinor: number;
  readonly at: string;
}

export interface ReferralSettled {
  readonly referralId: string;
  readonly kind: 'paid' | 'expired';
  readonly amountMinor: number;
  readonly how?: 'cash' | 'store_credit' | 'bank_transfer';
  readonly reference?: string;
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
}

export type ReferralMovementKind = 'earned' | 'paid' | 'expired';

export interface ReferralMovement {
  readonly movementId: string;
  readonly referralId: string;
  readonly kind: ReferralMovementKind;
  /** Always positive; the kind says which way it moves the liability. */
  readonly amountMinor: number;
  readonly at: string;
}

export interface ReferralJournal extends JournalEntry {
  readonly referral: { readonly movementId: string; readonly referralId: string; readonly kind: string; readonly belongsTo?: string };
}

export interface ReferralLiabilityDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly earned: (tenantId: string) => Promise<readonly ReferralEarned[]>;
  readonly settled: (tenantId: string) => Promise<readonly ReferralSettled[]>;
  readonly recordSettled: (tenantId: string, s: ReferralSettled) => Promise<void>;
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined>;
  readonly referralJournals: (tenantId: string) => Promise<readonly ReferralJournal[]>;
  /** An account's balance across every posted journal, credit-positive. */
  readonly creditBalance: (tenantId: string, accountCode: string) => Promise<number>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** R1b (M01-FR-02): the shop's calendar — a movement's journal date and period are its shop trading day's. */
  readonly calendar?: ShopCalendarOf;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const HOWS = ['cash', 'store_credit', 'bank_transfer'] as const;

/** The register's movements: one per earning, one per settlement — the order they happened. */
export function referralMovements(earned: readonly ReferralEarned[], settled: readonly ReferralSettled[]): ReferralMovement[] {
  const out: ReferralMovement[] = [];
  const seen = new Set<string>();
  for (const e of earned) {
    if (seen.has(e.referralId)) continue; // one reward per referral (the assess route refuses a second)
    seen.add(e.referralId);
    out.push({ movementId: `earned:${e.referralId}`, referralId: e.referralId, kind: 'earned', amountMinor: e.rewardMinor, at: e.at });
  }
  for (const s of settled) out.push({ movementId: `${s.kind}:${s.referralId}`, referralId: s.referralId, kind: s.kind, amountMinor: s.amountMinor, at: s.at });
  return out;
}

/** What is still owed per referral: earned less paid less expired. */
export function referralRegister(earned: readonly ReferralEarned[], settled: readonly ReferralSettled[]) {
  const rows = new Map<string, { referralId: string; earnedMinor: number; paidMinor: number; expiredMinor: number }>();
  for (const m of referralMovements(earned, settled)) {
    const r = rows.get(m.referralId) ?? { referralId: m.referralId, earnedMinor: 0, paidMinor: 0, expiredMinor: 0 };
    if (m.kind === 'earned') r.earnedMinor += m.amountMinor; else if (m.kind === 'paid') r.paidMinor += m.amountMinor; else r.expiredMinor += m.amountMinor;
    rows.set(m.referralId, r);
  }
  const referrals = [...rows.values()].map((r) => {
    const outstandingMinor = r.earnedMinor - r.paidMinor - r.expiredMinor;
    return { ...r, outstandingMinor, state: outstandingMinor > 0 ? 'owed' : r.paidMinor > 0 ? 'paid' : 'expired' };
  }).sort((a, b) => a.referralId.localeCompare(b.referralId));
  return { referrals, outstandingMinor: referrals.reduce((s, r) => s + r.outstandingMinor, 0) };
}

/** The liability account: the one the mapping CREDITS when a reward is earned. */
export function liabilityAccountOf(map: PostingMap | undefined): string | undefined {
  return map?.rules.find((r) => r.kind === 'referral:earned')?.legs.find((l) => l.side === 'credit')?.account;
}

export function referralLiabilityRoutes(deps: ReferralLiabilityDeps): readonly Route[] {
  const settle = (kind: 'paid' | 'expired') => async (ctx: Parameters<Route['handler']>[0]) => {
    const referralId = (ctx.params['referralId'] ?? '').trim();
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    if (kind === 'paid' && (!(HOWS as readonly string[]).includes(b['how'] as string) || !isStr(b['reference']))) {
      throw apiError(400, { code: 'not_readable_as_a_referral_payout', whatHappened: 'A payout needs { how: cash | store_credit | bank_transfer, reference } — the receipt, credit or transfer it was paid by.', wasItSaved: 'not_saved', nextSafeAction: 'Say how it was paid and the reference. Nothing was recorded.' });
    }
    if (kind === 'paid' && containsCardNumber(b['reference'] as string)) {
      throw apiError(400, { code: 'reference_looks_like_card_data', whatHappened: 'The reference looks like a card number. A card number is never kept (hard rule #3).', wasItSaved: 'not_saved', nextSafeAction: 'Give the receipt or transfer number instead. Nothing was recorded.' });
    }
    if (kind === 'expired' && !isStr(b['reason'])) {
      throw apiError(400, { code: 'expiry_needs_a_reason', whatHappened: 'Letting a reward lapse needs { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing was recorded.' });
    }
    const [earned, settled] = await Promise.all([deps.earned(ctx.tenantId), deps.settled(ctx.tenantId)]);
    const row = referralRegister(earned, settled).referrals.find((r) => r.referralId === referralId);
    if (row === undefined) throw notFound(`an earned referral reward ${referralId}`);
    if (row.outstandingMinor <= 0) {
      throw apiError(409, { code: 'referral_nothing_outstanding', whatHappened: `Referral ${referralId}'s reward is already ${row.state} — nothing is owed on it.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
    }
    const s: ReferralSettled = {
      referralId, kind, amountMinor: row.outstandingMinor, by: ctx.userId, at: deps.now(),
      ...(kind === 'paid' ? { how: b['how'] as ReferralSettled['how'], reference: (b['reference'] as string).slice(0, 80) } : { reason: (b['reason'] as string).slice(0, 300) }),
    };
    await deps.recordSettled(ctx.tenantId, s);
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: `referral.reward.${kind}`, objectType: 'referral', objectId: referralId, at: s.at,
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { outstandingMinor: String(row.outstandingMinor) }, after: { outstandingMinor: '0' },
      reason: kind === 'paid' ? `paid by ${s.how ?? ''}` : (s.reason ?? ''), correlationId: `referral-${kind}-${referralId}`,
    });
    return { status: 201, body: { settlement: s, outstandingMinor: 0, detail: `The liability falls by ₹${(s.amountMinor / 100).toFixed(2)} when the accountant next posts — a compensating entry, never an edit.` } };
  };

  return [
    { api: 'API-06', method: 'POST', path: '/v1/loyalty/referrals/:referralId/payout', permission: 'loyalty.referral.settle', entitlement: 'loyalty', idempotent: true, handler: settle('paid') },
    { api: 'API-06', method: 'POST', path: '/v1/loyalty/referrals/:referralId/expire', permission: 'loyalty.referral.settle', entitlement: 'loyalty', idempotent: true, handler: settle('expired') },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/referral-liability',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const [earned, settled, map, journals] = await Promise.all([deps.earned(ctx.tenantId), deps.settled(ctx.tenantId), deps.postingMap(ctx.tenantId), deps.referralJournals(ctx.tenantId)]);
        const register = referralRegister(earned, settled);
        const posted = new Set(journals.map((j) => j.referral.movementId));
        const unposted = referralMovements(earned, settled).filter((m) => !posted.has(m.movementId));
        const account = liabilityAccountOf(map);
        const booksMinor = account === undefined ? null : await deps.creditBalance(ctx.tenantId, account);
        const differenceMinor = booksMinor === null ? null : booksMinor - register.outstandingMinor;
        const reconciles = differenceMinor === 0;
        const exception = account === undefined
          ? { code: 'referral_liability_not_mapped', detail: 'The posting map has no rule for referral:earned, so the books carry no referral liability yet — the accountant maps it. Not known, not zero.' }
          : reconciles ? null
          : { code: 'referral_liability_difference', differenceMinor, detail: `The books carry ₹${(Math.abs(differenceMinor!) / 100).toFixed(2)} ${differenceMinor! > 0 ? 'more' : 'less'} than the register owes${unposted.length > 0 ? ` — ${unposted.length} movement(s) not yet posted` : ''}. A person settles it.` };
        return {
          status: 200,
          body: {
            register, account: account ?? null, booksMinor, differenceMinor, reconciles, exception,
            unposted, coupons: { liability: false, detail: 'Coupons are not a liability (owner decision OB-221, subject to the CA).' },
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/referral-liability/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, { code: 'posting_map_not_defined', whatHappened: 'No ledger mapping is defined, so no referral movement can post — which accounts they go to is the accountant\'s decision.', wasItSaved: 'not_saved', nextSafeAction: 'Define the mapping (PUT /v1/finance/posting-map) with rules for referral:earned, referral:paid and referral:expired. Nothing was posted.' });
        }
        const [earned, settled, journals, states] = await Promise.all([deps.earned(t), deps.settled(t), deps.referralJournals(t), deps.periodStates(t)]);
        const posted = new Set(journals.map((j) => j.referral.movementId));
        const appended: ReferralJournal[] = [];
        const exceptions: { movementId: string; kind: string; reason: string; detail: string }[] = [];
        for (const m of referralMovements(earned, settled).filter((x) => !posted.has(x.movementId))) {
          const kind = `referral:${m.kind}`;
          let mapped;
          try {
            mapped = postMapped({ id: m.movementId, kind, at: m.at, currency: 'INR', components: { amount: m.amountMinor } }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ movementId: m.movementId, kind, reason, detail: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const documentDate = await shopClock(deps.calendar).tradingDayOf(t, m.at);
          const belongsTo = documentDate.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const journal: ReferralJournal = {
            entryId: `referral:${m.movementId}`, period, documentDate,
            narrative: `Referral reward ${m.kind} — ${m.referralId}${closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''}`,
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId,
            referral: { movementId: m.movementId, referralId: m.referralId, kind, ...(closed ? { belongsTo } : {}) },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ movementId: m.movementId, kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
  ];
}
