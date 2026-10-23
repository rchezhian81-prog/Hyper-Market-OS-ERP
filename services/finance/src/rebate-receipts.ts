// API-09 Finance — supplier REBATE money received and reconciled (M06-FR-03 acceptance "a rebate accrues and reconciles to
// finance" · D03-FR-03 · M23-FR-01 · §28 "Finance approves rebate claims" · P-08). Same shape as display-funding.ts:
//
//   • RECORD (`POST /v1/finance/rebate-receipts/:schemeId/receipts/:receiptId`, finance) — { amountMinor, receivedOn,
//     reference }. Refused, nothing written: an unknown scheme; more than the scheme has ACCRUED and not yet received (what
//     the purchase register folded from matched invoices); a mapping that does not name `supplier_rebate` (which account
//     the money goes to is the accountant's call). One receipt is ONE journal — the journal IS the receipt record — so a
//     re-send posts nothing twice and the register can never disagree with the ledger by a missed write.
//   • RECONCILE (`GET /v1/finance/rebate-receipts`) — per scheme: accrued (purchase register), received (these journals),
//     outstanding, and the income the LEDGER holds for it on the mapped account; `agrees` only when receipts and ledger match
//     to the paisa. A scheme past its end with money outstanding, and an unapproved scheme, are said by name (P-03).
//
// `services/purchase/src/rebates.ts` reads its "received" from here, so the outstanding figure is the ledger's.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import type { RebateScheme } from '../../../packages/purchasing/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

export interface RebateReceiptJournal extends JournalEntry {
  readonly rebateReceipt: {
    readonly schemeId: string;
    readonly receiptId: string;
    readonly supplierId: string;
    readonly amountMinor: number;
    readonly receivedOn: string;
    readonly reference: string;
  };
}

export interface RebateReceiptDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  readonly schemes: (tenantId: string) => Promise<readonly RebateScheme[]> | readonly RebateScheme[];
  /** What the purchase register has accrued for the scheme (latest measurement per accrual), in paise. */
  readonly accruedFor: (tenantId: string, schemeId: string) => Promise<number> | number;
  readonly rebateJournals: (tenantId: string) => Promise<readonly RebateReceiptJournal[]> | readonly RebateReceiptJournal[];
}

export const SUPPLIER_REBATE_KIND = 'supplier_rebate';

/** The account the mapping CREDITS for supplier rebates — the income the ledger holds for them; undefined when unmapped. */
export function rebateIncomeAccount(map: PostingMap | undefined): string | undefined {
  return map?.rules.find((r) => r.kind === SUPPLIER_REBATE_KIND)?.legs.find((l) => l.side === 'credit')?.account;
}

export interface RebateReconciliationLine {
  readonly schemeId: string;
  readonly supplierId: string;
  readonly accruedMinor: number;
  readonly receivedMinor: number;
  readonly outstandingMinor: number;
  readonly ledgerMinor: number;
  readonly agrees: boolean;
  readonly endsOn: string;
  readonly findings: readonly ('ended_with_money_outstanding' | 'scheme_not_approved' | 'ledger_differs')[];
}

/** Per scheme: accrued, received, outstanding, and what the ledger holds — two figures reached two ways. Pure. */
export function reconcileRebates(input: {
  readonly schemes: readonly RebateScheme[];
  readonly accrued: ReadonlyMap<string, number>;
  readonly journals: readonly RebateReceiptJournal[];
  readonly incomeAccount: string | undefined;
  readonly today: string;
}) {
  const lines = input.schemes.map((s): RebateReconciliationLine => {
    const mine = input.journals.filter((j) => j.rebateReceipt.schemeId === s.schemeId);
    const receivedMinor = mine.reduce((t, j) => t + j.rebateReceipt.amountMinor, 0);
    const ledgerMinor = input.incomeAccount === undefined ? 0 : mine.flatMap((j) => j.lines)
      .filter((l) => l.accountCode === input.incomeAccount).reduce((t, l) => t + l.creditMinor - l.debitMinor, 0);
    const accruedMinor = input.accrued.get(s.schemeId) ?? 0;
    const outstandingMinor = accruedMinor - receivedMinor;
    const agrees = input.incomeAccount !== undefined && receivedMinor === ledgerMinor;
    const findings: RebateReconciliationLine['findings'][number][] = [];
    if (s.endsOn < input.today && outstandingMinor > 0) findings.push('ended_with_money_outstanding');
    if (s.approvedBy === undefined) findings.push('scheme_not_approved');
    if (!agrees) findings.push('ledger_differs');
    return { schemeId: s.schemeId, supplierId: s.supplierId, accruedMinor, receivedMinor, outstandingMinor, ledgerMinor, agrees, endsOn: s.endsOn, findings };
  });
  return {
    lines, agrees: lines.every((l) => l.agrees),
    accruedMinor: lines.reduce((t, l) => t + l.accruedMinor, 0), receivedMinor: lines.reduce((t, l) => t + l.receivedMinor, 0),
    ledgerMinor: lines.reduce((t, l) => t + l.ledgerMinor, 0),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export function rebateReceiptRoutes(deps: RebateReceiptDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/rebate-receipts/:schemeId/receipts/:receiptId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const receiptId = (ctx.params['receiptId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (schemeId === '' || receiptId === '' || !isPosInt(b['amountMinor']) || !isDate(b['receivedOn']) || !isStr(b['reference'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rebate_receipt',
            whatHappened: 'A rebate receipt needs the schemeId and receiptId in the path and { amountMinor (whole paise, more than 0), receivedOn (YYYY-MM-DD), reference (the bank, cheque or credit-note reference) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the money as it arrived. Nothing was recorded.',
          });
        }
        const [schemes, journals] = await Promise.all([deps.schemes(t), deps.rebateJournals(t)]);
        const prior = journals.find((j) => j.rebateReceipt.schemeId === schemeId && j.rebateReceipt.receiptId === receiptId);
        if (prior !== undefined) return { status: 200, body: { receipt: prior.rebateReceipt, entryId: prior.entryId, alreadyRecorded: true } };
        const scheme = schemes.find((s) => s.schemeId === schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const accrued = await deps.accruedFor(t, schemeId);
        const received = journals.filter((j) => j.rebateReceipt.schemeId === schemeId).reduce((s, j) => s + j.rebateReceipt.amountMinor, 0);
        const outstanding = accrued - received;
        if (b['amountMinor'] > outstanding) {
          throw apiError(422, {
            code: 'receipt_exceeds_accrued',
            whatHappened: `Scheme ${schemeId} has accrued ${accrued} paise from matched invoices and ${received} has already been received; ${b['amountMinor']} more would be ${b['amountMinor'] - outstanding} above what was earned.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Post the accrual for the period first (it is folded from the matched invoices), or record only what was earned. Nothing was recorded.',
          });
        }
        const map = await deps.postingMap(t);
        const income = rebateIncomeAccount(map);
        if (map === undefined || income === undefined) {
          throw apiError(409, {
            code: 'supplier_rebate_not_mapped',
            whatHappened: 'The ledger mapping does not say which accounts supplier rebates go to, so the money cannot be put in the books — that is the accountant\'s decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant adds a "supplier_rebate" rule to the mapping (PUT /v1/finance/posting-map), then record the receipt again. Nothing was recorded.',
          });
        }
        const posted = mapToJournal({ id: `supplier-rebate:${schemeId}:${receiptId}`, kind: SUPPLIER_REBATE_KIND, at: `${b['receivedOn']}T00:00:00.000Z`, currency: 'INR', components: { amount: b['amountMinor'] } }, map);
        const states = await deps.periodStates(t);
        const belongsTo = b['receivedOn'].slice(0, 7);
        const closed = states.get(belongsTo) === 'closed';
        const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
        const journal: RebateReceiptJournal = {
          entryId: `supplier-rebate:${schemeId}:${receiptId}`, period, documentDate: b['receivedOn'],
          narrative: `Supplier rebate from ${scheme.supplierId} under scheme ${schemeId}, receipt ${receiptId}, ref ${b['reference'].trim()}`
            + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
          lines: posted.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
          postedBy: ctx.userId,
          rebateReceipt: { schemeId, receiptId, supplierId: scheme.supplierId, amountMinor: b['amountMinor'], receivedOn: b['receivedOn'], reference: b['reference'].trim() },
        };
        const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
        if (!gate.ok) {
          throw apiError(422, { code: gate.refusedBecause ?? 'journal_refused', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and record again. Nothing was recorded.' });
        }
        await deps.appendJournal(t, journal);
        return { status: 201, body: { receipt: journal.rebateReceipt, entryId: journal.entryId, outstandingMinor: outstanding - b['amountMinor'], alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/rebate-receipts',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [schemes, journals, map] = await Promise.all([deps.schemes(t), deps.rebateJournals(t), deps.postingMap(t)]);
        const accrued = new Map<string, number>();
        for (const s of schemes) accrued.set(s.schemeId, await deps.accruedFor(t, s.schemeId));
        const result = reconcileRebates({ schemes, accrued, journals, incomeAccount: rebateIncomeAccount(map), today: deps.now().slice(0, 10) });
        return { status: 200, body: { ...result, incomeAccount: rebateIncomeAccount(map) ?? null, needingAttention: result.lines.filter((l) => l.findings.length > 0).length, asAt: deps.now() } };
      },
    },
  ];
}
