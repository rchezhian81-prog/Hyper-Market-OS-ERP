// API-09 Finance — supplier DISPLAY FUNDING received and reconciled (FUL-11 · M04-FR-04 · D02-FR-06 · M23-FR-01 · §28 · P-08).
//
// M04-FR-04: "supplier display funding is tracked against the space it funds and reconciled in finance (M23)"; acceptance:
// "a display-space contract with funding is recorded and reconciles to finance". Until now the review of display contracts
// took "what finance has received" as a figure typed into the request — so the one fact the review exists to check was the
// caller's say-so. Here finance RECORDS each payment the supplier makes against a contract, as a journal through the
// accountant's own mapping, and the reconciliation reads both sides from head office's records:
//
//   • RECORD (`POST /v1/finance/display-funding/:contractId/receipts/:receiptId`, finance) — { amountMinor, receivedOn,
//     reference }. Refused, nothing written: an unknown contract; more than the contract still has outstanding; a mapping that
//     does not name `display_funding` (which account the money goes to is the accountant's call). One receipt is ONE journal
//     (the journal IS the receipt record), so a re-send posts nothing twice and the register can never disagree with the ledger
//     by a missed write.
//   • RECONCILE (`GET /v1/finance/display-funding`) — per contract: the funding agreed, the money received, what is still
//     outstanding, and the income the LEDGER holds for it (credits on the account the mapping names); `agrees` only when the
//     receipts and the ledger match to the paisa. An expired contract with money outstanding, and a contract nobody in
//     finance approved, are said by name (control by exception, P-03).
//
// The display-contract review (`POST /v1/merchandising/display-contracts/review`) reads its "received" from here.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import type { DisplayContract } from '../../../packages/merchandising/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

/** A display-funding receipt: a finance journal that also says which contract and receipt it is. */
export interface DisplayFundingJournal extends JournalEntry {
  readonly displayFunding: {
    readonly contractId: string;
    readonly receiptId: string;
    readonly supplierId: string;
    readonly storeId: string;
    readonly amountMinor: number;
    readonly receivedOn: string;
    readonly reference: string;
  };
}

export interface DisplayFundingDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  /** Every display contract as merchandising recorded it (latest per contract). */
  readonly contracts: (tenantId: string) => Promise<readonly DisplayContract[]> | readonly DisplayContract[];
  /** Every display-funding journal already posted. */
  readonly fundingJournals: (tenantId: string) => Promise<readonly DisplayFundingJournal[]> | readonly DisplayFundingJournal[];
}

export const DISPLAY_FUNDING_KIND = 'display_funding';

/** The account the mapping CREDITS for display funding — the income the ledger holds for it; undefined when unmapped. */
export function displayFundingIncomeAccount(map: PostingMap | undefined): string | undefined {
  return map?.rules.find((r) => r.kind === DISPLAY_FUNDING_KIND)?.legs.find((l) => l.side === 'credit')?.account;
}

export interface DisplayFundingLine {
  readonly contractId: string;
  readonly supplierId: string;
  readonly storeId: string;
  readonly fundingMinor: number;
  readonly receivedMinor: number;
  readonly outstandingMinor: number;
  readonly ledgerMinor: number;
  readonly agrees: boolean;
  readonly approved: boolean;
  readonly endsOn: string;
  readonly findings: readonly ('expired_with_money_outstanding' | 'not_approved_by_finance' | 'ledger_differs')[];
}

/** Per contract: agreed, received, outstanding, and what the ledger holds — two figures reached two ways. Pure. */
export function reconcileDisplayFunding(input: {
  readonly contracts: readonly DisplayContract[];
  readonly journals: readonly DisplayFundingJournal[];
  readonly incomeAccount: string | undefined;
  readonly today: string;
}): { readonly lines: readonly DisplayFundingLine[]; readonly agrees: boolean; readonly fundingMinor: number; readonly receivedMinor: number; readonly ledgerMinor: number } {
  const lines = input.contracts.map((c): DisplayFundingLine => {
    const mine = input.journals.filter((j) => j.displayFunding.contractId === c.contractId);
    const receivedMinor = mine.reduce((s, j) => s + j.displayFunding.amountMinor, 0);
    const ledgerMinor = input.incomeAccount === undefined ? 0 : mine.flatMap((j) => j.lines)
      .filter((l) => l.accountCode === input.incomeAccount).reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
    const outstandingMinor = c.fundingAmount.minor - receivedMinor;
    const agrees = input.incomeAccount !== undefined && receivedMinor === ledgerMinor;
    const findings: DisplayFundingLine['findings'][number][] = [];
    if (c.endsOn < input.today && outstandingMinor > 0) findings.push('expired_with_money_outstanding');
    if (c.approvedBy === undefined) findings.push('not_approved_by_finance');
    if (!agrees) findings.push('ledger_differs');
    return {
      contractId: c.contractId, supplierId: c.supplierId, storeId: c.storeId, fundingMinor: c.fundingAmount.minor, receivedMinor,
      outstandingMinor, ledgerMinor, agrees, approved: c.approvedBy !== undefined, endsOn: c.endsOn, findings,
    };
  });
  return {
    lines, agrees: lines.every((l) => l.agrees),
    fundingMinor: lines.reduce((s, l) => s + l.fundingMinor, 0), receivedMinor: lines.reduce((s, l) => s + l.receivedMinor, 0),
    ledgerMinor: lines.reduce((s, l) => s + l.ledgerMinor, 0),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export function displayFundingRoutes(deps: DisplayFundingDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/display-funding/:contractId/receipts/:receiptId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const receiptId = (ctx.params['receiptId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (contractId === '' || receiptId === '' || !isPosInt(b['amountMinor']) || !isDate(b['receivedOn']) || !isStr(b['reference'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_funding_receipt',
            whatHappened: 'A display-funding receipt needs the contractId and receiptId in the path and { amountMinor (whole paise, more than 0), receivedOn (YYYY-MM-DD), reference (the bank or cheque reference) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the money as it arrived. Nothing was recorded.',
          });
        }
        const [contracts, journals] = await Promise.all([deps.contracts(t), deps.fundingJournals(t)]);
        const prior = journals.find((j) => j.displayFunding.contractId === contractId && j.displayFunding.receiptId === receiptId);
        if (prior !== undefined) return { status: 200, body: { receipt: prior.displayFunding, entryId: prior.entryId, alreadyRecorded: true } };
        const contract = contracts.find((c) => c.contractId === contractId);
        if (contract === undefined) throw notFound(`display contract ${contractId}`);
        const received = journals.filter((j) => j.displayFunding.contractId === contractId).reduce((s, j) => s + j.displayFunding.amountMinor, 0);
        const outstanding = contract.fundingAmount.minor - received;
        if (b['amountMinor'] > outstanding) {
          throw apiError(422, {
            code: 'receipt_exceeds_contract',
            whatHappened: `Contract ${contractId} funds ${contract.fundingAmount.minor} paise and ${received} has already been received; ${b['amountMinor']} more would be ${b['amountMinor'] - outstanding} above what was agreed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record only what the contract funds; anything more is a different agreement (record it as one), or money to return. Nothing was recorded.',
          });
        }
        const map = await deps.postingMap(t);
        const income = displayFundingIncomeAccount(map);
        if (map === undefined || income === undefined) {
          throw apiError(409, {
            code: 'display_funding_not_mapped',
            whatHappened: 'The ledger mapping does not say which accounts supplier display funding goes to, so the money cannot be put in the books — that is the accountant\'s decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant adds a "display_funding" rule to the mapping (PUT /v1/finance/posting-map; the suggested map has one), then record the receipt again. Nothing was recorded.',
          });
        }
        const posted = mapToJournal({ id: `display-funding:${contractId}:${receiptId}`, kind: DISPLAY_FUNDING_KIND, at: `${b['receivedOn']}T00:00:00.000Z`, currency: 'INR', components: { amount: b['amountMinor'] } }, map);
        const states = await deps.periodStates(t);
        const belongsTo = b['receivedOn'].slice(0, 7);
        const closed = states.get(belongsTo) === 'closed';
        const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
        const journal: DisplayFundingJournal = {
          entryId: `display-funding:${contractId}:${receiptId}`, period, documentDate: b['receivedOn'],
          narrative: `Display funding from supplier ${contract.supplierId} for contract ${contractId} (${contract.description}), receipt ${receiptId}, ref ${b['reference'].trim()}`
            + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
          lines: posted.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
          postedBy: ctx.userId,
          displayFunding: {
            contractId, receiptId, supplierId: contract.supplierId, storeId: contract.storeId, amountMinor: b['amountMinor'],
            receivedOn: b['receivedOn'], reference: b['reference'].trim(),
          },
        };
        const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
        if (!gate.ok) {
          throw apiError(422, { code: gate.refusedBecause ?? 'journal_refused', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and record again. Nothing was recorded.' });
        }
        await deps.appendJournal(t, journal);
        return { status: 201, body: { receipt: journal.displayFunding, entryId: journal.entryId, outstandingMinor: outstanding - b['amountMinor'], alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/display-funding',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [contracts, journals, map] = await Promise.all([deps.contracts(t), deps.fundingJournals(t), deps.postingMap(t)]);
        const storeId = ctx.query['storeId'];
        const result = reconcileDisplayFunding({
          contracts: isStr(storeId) ? contracts.filter((c) => c.storeId === storeId) : contracts,
          journals, incomeAccount: displayFundingIncomeAccount(map), today: deps.now().slice(0, 10),
        });
        return {
          status: 200,
          body: {
            ...result, incomeAccount: displayFundingIncomeAccount(map) ?? null,
            needingAttention: result.lines.filter((l) => l.findings.length > 0).length, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
