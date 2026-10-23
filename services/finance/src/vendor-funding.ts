// API-09 supplier funding of a PROMOTION, recorded, folded and reconciled (M05-FR-04 "… vendor funding …"; acceptance
// "vendor-funded value reconciles to finance" · OB-288 P2, on the display-funding pattern).
//
// Until now "the supplier is covering it" was a calculator: the caller typed the units sold and the money received. Here
// each side is head office's own record:
//   • the AGREEMENT — a supplier funds ₹X a unit of a promotion (optionally only some of its products, and up to a cap) —
//     is recorded by the person who launches offers and approved by Finance through the maker-checker engine (kind
//     `promotion_funding`); one not approved stays flagged;
//   • the UNITS sold under the offer are FOLDED from the banked bills: each bill in the offer's window is re-judged by the
//     same deterministic engine the till ran, and the units on the lines the offer reached are counted (a bill the engine
//     cannot re-judge — an offer that needed a coupon, which the bill does not record — is counted as "not judged", said);
//   • each RECEIPT finance records is a journal through the accountant's posting map (kind `promotion_funding`) — the
//     journal IS the receipt, so the register can never disagree with the ledger by a missed write;
//   • the RECONCILIATION reads both sides: earned (units × rate, to the cap), received, the income the ledger holds, what
//     is outstanding, and findings by exception (not approved, ledger differs, received more than earned, ended with money
//     outstanding, units not fully judged).
//
//   POST /v1/promotions/:promotionId/funding/:supplierId                         { perUnitMinor, capMinor?, productIds?, approvalId? }
//   POST /v1/finance/promotion-funding/:promotionId/:supplierId/receipts/:receiptId  { amountMinor, receivedOn, reference }
//   GET  /v1/finance/promotion-funding

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import type { Promotion } from '../../../packages/promotions/src/promotions';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

export const PROMOTION_FUNDING_KIND = 'promotion_funding';

export interface FundingAgreement {
  readonly promotionId: string;
  readonly supplierId: string;
  readonly perUnitMinor: number;
  readonly capMinor?: number;
  /** Only these of the offer's products are funded; absent = every product the offer reaches. */
  readonly productIds?: readonly string[];
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly approvedBy?: string;
}

export interface PromotionFundingJournal extends JournalEntry {
  readonly promotionFunding: {
    readonly promotionId: string;
    readonly supplierId: string;
    readonly receiptId: string;
    readonly amountMinor: number;
    readonly receivedOn: string;
    readonly reference: string;
  };
}

/** What the banked bills say about an offer: units on the lines it reached, the bills it applied to, and bills not judged. */
export interface UnitsUnderOffer {
  readonly units: number;
  readonly bills: number;
  readonly billsNotJudged: number;
}

export interface VendorFundingDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly promotion: (tenantId: string, promotionId: string) => Promise<Promotion | undefined>;
  readonly agreements: (tenantId: string) => Promise<readonly FundingAgreement[]>;
  readonly recordAgreement: (tenantId: string, a: FundingAgreement, key: string) => Promise<void>;
  readonly approvals?: ApprovalPort;
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined>;
  readonly fundingJournals: (tenantId: string) => Promise<readonly PromotionFundingJournal[]>;
  readonly unitsUnderOffer: (tenantId: string, promotion: Promotion, fundedProducts: readonly string[] | undefined) => Promise<UnitsUnderOffer>;
}

/** The account the mapping CREDITS for promotion funding — the income the ledger holds for it; undefined when unmapped. */
export function promotionFundingIncomeAccount(map: PostingMap | undefined): string | undefined {
  return map?.rules.find((r) => r.kind === PROMOTION_FUNDING_KIND)?.legs.find((l) => l.side === 'credit')?.account;
}

/** The latest agreement per promotion × supplier (a correction supersedes; nothing is overwritten in the store). */
export function currentAgreements(all: readonly FundingAgreement[]): readonly FundingAgreement[] {
  const m = new Map<string, FundingAgreement>();
  for (const a of all) m.set(`${a.promotionId}\u001f${a.supplierId}`, a);
  return [...m.values()].sort((a, b) => `${a.promotionId}${a.supplierId}`.localeCompare(`${b.promotionId}${b.supplierId}`));
}

export type FundingFinding = 'not_approved_by_finance' | 'ledger_differs' | 'received_more_than_earned' | 'ended_with_money_outstanding' | 'units_not_fully_judged' | 'promotion_not_defined';

export interface FundingLine {
  readonly promotionId: string;
  readonly supplierId: string;
  readonly perUnitMinor: number;
  readonly capMinor: number | null;
  readonly unitsSold: number;
  readonly billsUnderOffer: number;
  readonly billsNotJudged: number;
  readonly earnedMinor: number;
  readonly receivedMinor: number;
  readonly ledgerMinor: number;
  readonly outstandingMinor: number;
  readonly agrees: boolean;
  readonly approved: boolean;
  readonly findings: readonly FundingFinding[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export function vendorFundingRoutes(deps: VendorFundingDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/funding/:supplierId',
      permission: 'promotion.launch', idempotent: true,
      handler: async (ctx) => {
        const promotionId = (ctx.params['promotionId'] ?? '').trim();
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const productIds = b['productIds'];
        if (promotionId === '' || supplierId === '' || !isPosInt(b['perUnitMinor']) || (b['capMinor'] !== undefined && !isPosInt(b['capMinor']))
          || (productIds !== undefined && !(Array.isArray(productIds) && productIds.length > 0 && productIds.every(isStr)))) {
          throw apiError(400, {
            code: 'not_readable_as_a_funding_agreement',
            whatHappened: 'A funding agreement needs the promotion and supplier in the path and { perUnitMinor (whole paise a unit, above 0), capMinor?, productIds? (only these products are funded), approvalId? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send what the supplier agreed to pay a unit. Nothing was saved.',
          });
        }
        const promotion = await deps.promotion(ctx.tenantId, promotionId);
        if (promotion === undefined) throw notFound(`promotion ${promotionId}`);
        // Finance approves the funding terms (the display-contract rule): an approval someone who may approve suppliers GAVE.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'promotion_funding', subjectRef: `${promotionId}:${supplierId}`, details: actionDetails(ctx.body, { promotionId, supplierId }),
          valueMinor: isPosInt(b['capMinor']) ? b['capMinor'] : null, maker: ctx.userId, usedBy: `promotion-funding:${promotionId}:${supplierId}`, now: deps.now(),
        });
        const agreement: FundingAgreement = {
          promotionId, supplierId, perUnitMinor: b['perUnitMinor'], ...(isPosInt(b['capMinor']) ? { capMinor: b['capMinor'] } : {}),
          ...(Array.isArray(productIds) ? { productIds: [...new Set(productIds as string[])].sort() } : {}),
          recordedBy: ctx.userId, recordedAt: deps.now(), ...(opened === undefined ? {} : { approvedBy: opened.decision.decidedBy }),
        };
        await opened?.spend();
        await deps.recordAgreement(ctx.tenantId, agreement, ctx.idempotencyKey ?? `${promotionId}:${supplierId}:${agreement.recordedAt}`);
        return { status: 201, body: { agreement, approved: agreement.approvedBy !== undefined } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/promotion-funding/:promotionId/:supplierId/receipts/:receiptId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const promotionId = (ctx.params['promotionId'] ?? '').trim();
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const receiptId = (ctx.params['receiptId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (receiptId === '' || !isPosInt(b['amountMinor']) || !isDate(b['receivedOn']) || !isStr(b['reference'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_funding_receipt',
            whatHappened: 'A promotion-funding receipt needs { amountMinor (whole paise, above 0), receivedOn (YYYY-MM-DD), reference (the bank or cheque reference) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the money as it arrived. Nothing was recorded.',
          });
        }
        const [agreements, journals] = await Promise.all([deps.agreements(t), deps.fundingJournals(t)]);
        const prior = journals.find((j) => j.promotionFunding.promotionId === promotionId && j.promotionFunding.supplierId === supplierId && j.promotionFunding.receiptId === receiptId);
        if (prior !== undefined) return { status: 200, body: { receipt: prior.promotionFunding, entryId: prior.entryId, alreadyRecorded: true } };
        const agreement = currentAgreements(agreements).find((a) => a.promotionId === promotionId && a.supplierId === supplierId);
        if (agreement === undefined) throw notFound(`funding agreement for promotion ${promotionId} with supplier ${supplierId}`);
        const received = journals.filter((j) => j.promotionFunding.promotionId === promotionId && j.promotionFunding.supplierId === supplierId).reduce((s, j) => s + j.promotionFunding.amountMinor, 0);
        if (agreement.capMinor !== undefined && received + b['amountMinor'] > agreement.capMinor) {
          throw apiError(422, {
            code: 'receipt_exceeds_funding_cap',
            whatHappened: `The agreement caps the funding at ${agreement.capMinor} paise and ${received} has been received; ${b['amountMinor']} more would pass the cap.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record only what the agreement funds; anything more is a different agreement or money to return. Nothing was recorded.',
          });
        }
        const map = await deps.postingMap(t);
        const income = promotionFundingIncomeAccount(map);
        if (map === undefined || income === undefined) {
          throw apiError(409, {
            code: 'promotion_funding_not_mapped',
            whatHappened: 'The ledger mapping does not say which accounts supplier promotion funding goes to, so the money cannot be put in the books — that is the accountant\'s decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant adds a "promotion_funding" rule to the mapping (PUT /v1/finance/posting-map), then record the receipt again. Nothing was recorded.',
          });
        }
        const entryId = `promotion-funding:${promotionId}:${supplierId}:${receiptId}`;
        const posted = mapToJournal({ id: entryId, kind: PROMOTION_FUNDING_KIND, at: `${b['receivedOn']}T00:00:00.000Z`, currency: 'INR', components: { amount: b['amountMinor'] } }, map);
        const states = await deps.periodStates(t);
        const belongsTo = b['receivedOn'].slice(0, 7);
        const closed = states.get(belongsTo) === 'closed';
        const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
        const journal: PromotionFundingJournal = {
          entryId, period, documentDate: b['receivedOn'],
          narrative: `Promotion funding from supplier ${supplierId} for offer ${promotionId}, receipt ${receiptId}, ref ${b['reference'].trim()}` + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
          lines: posted.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
          postedBy: ctx.userId,
          promotionFunding: { promotionId, supplierId, receiptId, amountMinor: b['amountMinor'], receivedOn: b['receivedOn'], reference: b['reference'].trim() },
        };
        const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
        if (!gate.ok) throw apiError(422, { code: gate.refusedBecause ?? 'journal_refused', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and record again. Nothing was recorded.' });
        await deps.appendJournal(t, journal);
        return { status: 201, body: { receipt: journal.promotionFunding, entryId, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/promotion-funding',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [agreements, journals, map] = await Promise.all([deps.agreements(t), deps.fundingJournals(t), deps.postingMap(t)]);
        const income = promotionFundingIncomeAccount(map);
        const now = deps.now();
        const lines: FundingLine[] = [];
        for (const a of currentAgreements(agreements)) {
          const promotion = await deps.promotion(t, a.promotionId);
          const sold = promotion === undefined ? { units: 0, bills: 0, billsNotJudged: 0 } : await deps.unitsUnderOffer(t, promotion, a.productIds);
          const mine = journals.filter((j) => j.promotionFunding.promotionId === a.promotionId && j.promotionFunding.supplierId === a.supplierId);
          const receivedMinor = mine.reduce((s, j) => s + j.promotionFunding.amountMinor, 0);
          const ledgerMinor = income === undefined ? 0 : mine.flatMap((j) => j.lines).filter((l) => l.accountCode === income).reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
          const uncapped = sold.units * a.perUnitMinor;
          const earnedMinor = a.capMinor === undefined ? uncapped : Math.min(uncapped, a.capMinor);
          const outstandingMinor = earnedMinor - receivedMinor;
          const agrees = income !== undefined && receivedMinor === ledgerMinor;
          const findings: FundingFinding[] = [];
          if (promotion === undefined) findings.push('promotion_not_defined');
          if (a.approvedBy === undefined) findings.push('not_approved_by_finance');
          if (!agrees) findings.push('ledger_differs');
          if (outstandingMinor < 0) findings.push('received_more_than_earned');
          if (promotion !== undefined && Date.parse(promotion.endsAt) < Date.parse(now) && outstandingMinor > 0) findings.push('ended_with_money_outstanding');
          if (sold.billsNotJudged > 0) findings.push('units_not_fully_judged');
          lines.push({
            promotionId: a.promotionId, supplierId: a.supplierId, perUnitMinor: a.perUnitMinor, capMinor: a.capMinor ?? null,
            unitsSold: sold.units, billsUnderOffer: sold.bills, billsNotJudged: sold.billsNotJudged, earnedMinor, receivedMinor, ledgerMinor,
            outstandingMinor, agrees, approved: a.approvedBy !== undefined, findings,
          });
        }
        return {
          status: 200,
          body: {
            lines, agrees: lines.every((l) => l.agrees), incomeAccount: income ?? null,
            earnedMinor: lines.reduce((s, l) => s + l.earnedMinor, 0), receivedMinor: lines.reduce((s, l) => s + l.receivedMinor, 0),
            ledgerMinor: lines.reduce((s, l) => s + l.ledgerMinor, 0), needingAttention: lines.filter((l) => l.findings.length > 0).length,
            unitsFrom: 'banked_bills_re_judged_by_the_till_engine', asAt: now,
          },
        };
      },
    },
  ];
}
