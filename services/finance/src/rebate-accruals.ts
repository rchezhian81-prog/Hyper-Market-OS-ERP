// API-09 Finance — supplier REBATE ACCRUALS posted to the books (D10-FR-04 "loyalty/gift/rebate liabilities" · M06-FR-03
// "a rebate accrues and reconciles to finance" · D03-FR-03 · M23-FR-01 · WF-18 · P-08 · hard rule #2).
//
// The purchase register works out what each rebate scheme has EARNED from matched bills (the accrual, re-measured as bills
// arrive — `services/purchase/src/rebates.ts`). Until now the books saw a rebate only when the money arrived
// (`rebate-receipts.ts`), so a month's earned-but-unpaid rebate was in nobody's balance sheet. Here:
//
//   • POST (`POST /v1/finance/rebate-accruals/post`) — for every APPROVED scheme, what the register has accrued against
//     what the ledger already holds for it; the difference posts as ONE journal through the accountant's mapping
//     (`supplier_rebate_accrual`: e.g. Dr rebate receivable, Cr rebate income). A re-measure DOWN posts the mirror journal
//     (a compensating entry), never an edit. Nothing to post: nothing is written. Refused, nothing written: a mapping
//     without the rule; a mapping whose receipt rule (`supplier_rebate`) credits the SAME account the accrual credits —
//     the income would then be counted twice (once earned, once received); the accountant points the receipt at the
//     receivable instead.
//   • READ (`GET /v1/finance/rebate-accruals`) — per scheme: accrued on the register, accrued in the ledger, received, and
//     the receivable the ledger holds; `agrees` only when register and ledger match to the paisa (WF-18 close check).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import type { RebateScheme } from '../../../packages/purchasing/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import { SUPPLIER_REBATE_KIND, type RebateReceiptJournal } from './rebate-receipts';

export const SUPPLIER_REBATE_ACCRUAL_KIND = 'supplier_rebate_accrual';

export interface RebateAccrualJournal extends JournalEntry {
  readonly rebateAccrual: {
    readonly schemeId: string;
    readonly supplierId: string;
    /** What this journal adds to (positive) or takes off (negative) the accrual the books hold. */
    readonly deltaMinor: number;
    /** What the purchase register had accrued for the scheme when this was posted. */
    readonly registerAccruedMinor: number;
    readonly sequence: number;
  };
}

export interface RebateAccrualDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined> | PostingMap | undefined;
  readonly schemes: (tenantId: string) => Promise<readonly RebateScheme[]> | readonly RebateScheme[];
  /** What the purchase register has accrued for the scheme (latest measurement per accrual), in paise. */
  readonly accruedFor: (tenantId: string, schemeId: string) => Promise<number> | number;
  readonly accrualJournals: (tenantId: string) => Promise<readonly RebateAccrualJournal[]> | readonly RebateAccrualJournal[];
  readonly receiptJournals: (tenantId: string) => Promise<readonly RebateReceiptJournal[]> | readonly RebateReceiptJournal[];
  /** The shop's calendar day of an instant — the date an accrual journal carries. */
  readonly shopDayOf: (iso: string) => string;
}

/** The accounts the accrual rule debits (the receivable) and credits (the income); undefined when unmapped. */
export function accrualAccounts(map: PostingMap | undefined): { readonly receivable: string; readonly income: string } | undefined {
  const rule = map?.rules.find((r) => r.kind === SUPPLIER_REBATE_ACCRUAL_KIND);
  const receivable = rule?.legs.find((l) => l.side === 'debit')?.account;
  const income = rule?.legs.find((l) => l.side === 'credit')?.account;
  return receivable === undefined || income === undefined ? undefined : { receivable, income };
}

export interface RebateAccrualLine {
  readonly schemeId: string;
  readonly supplierId: string;
  readonly approved: boolean;
  readonly registerAccruedMinor: number;
  readonly ledgerAccruedMinor: number;
  readonly receivedMinor: number;
  /** The receivable the ledger holds for the scheme: accrued in the ledger less what the receipts credited to it. */
  readonly ledgerReceivableMinor: number | null;
  readonly toPostMinor: number;
  readonly agrees: boolean;
}

/** Per scheme: register against ledger. Pure. */
export function rebateAccrualPosition(input: {
  readonly schemes: readonly RebateScheme[];
  readonly accrued: ReadonlyMap<string, number>;
  readonly accruals: readonly RebateAccrualJournal[];
  readonly receipts: readonly RebateReceiptJournal[];
  readonly accounts: { readonly receivable: string; readonly income: string } | undefined;
}): readonly RebateAccrualLine[] {
  return input.schemes.map((s) => {
    const mine = input.accruals.filter((j) => j.rebateAccrual.schemeId === s.schemeId);
    const receipts = input.receipts.filter((j) => j.rebateReceipt.schemeId === s.schemeId);
    const ledgerAccruedMinor = mine.reduce((t, j) => t + j.rebateAccrual.deltaMinor, 0);
    const registerAccruedMinor = input.accrued.get(s.schemeId) ?? 0;
    const receivedMinor = receipts.reduce((t, j) => t + j.rebateReceipt.amountMinor, 0);
    const acct = input.accounts?.receivable;
    const ledgerReceivableMinor = acct === undefined ? null : [...mine, ...receipts].flatMap((j) => j.lines)
      .filter((l) => l.accountCode === acct).reduce((t, l) => t + l.debitMinor - l.creditMinor, 0);
    const approved = s.approvedBy !== undefined;
    return {
      schemeId: s.schemeId, supplierId: s.supplierId, approved, registerAccruedMinor, ledgerAccruedMinor, receivedMinor, ledgerReceivableMinor,
      toPostMinor: approved ? registerAccruedMinor - ledgerAccruedMinor : 0,
      agrees: registerAccruedMinor === ledgerAccruedMinor,
    };
  });
}

export function rebateAccrualRoutes(deps: RebateAccrualDeps): readonly Route[] {
  const position = async (t: string) => {
    const [schemes, accruals, receipts, map] = await Promise.all([deps.schemes(t), deps.accrualJournals(t), deps.receiptJournals(t), deps.postingMap(t)]);
    const accrued = new Map<string, number>();
    for (const s of schemes) accrued.set(s.schemeId, await deps.accruedFor(t, s.schemeId));
    const accounts = accrualAccounts(map);
    return { map, accounts, accruals, lines: rebateAccrualPosition({ schemes, accrued, accruals, receipts, accounts }) };
  };
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/rebate-accruals/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const p = await position(t);
        if (p.map === undefined || p.accounts === undefined) {
          throw apiError(409, {
            code: 'supplier_rebate_accrual_not_mapped',
            whatHappened: 'The ledger mapping has no "supplier_rebate_accrual" rule (a debit and a credit), so earned rebates cannot be put in the books — which accounts they use is the accountant\'s decision.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant adds the rule (PUT /v1/finance/posting-map), then post again. Nothing was posted.',
          });
        }
        const receiptCredit = p.map.rules.find((r) => r.kind === SUPPLIER_REBATE_KIND)?.legs.find((l) => l.side === 'credit')?.account;
        if (receiptCredit !== undefined && receiptCredit === p.accounts.income) {
          throw apiError(409, {
            code: 'rebate_income_counted_twice',
            whatHappened: `The receipt rule "supplier_rebate" credits ${receiptCredit}, the same income the accrual credits — every rebate would be income twice (when earned and when received).`,
            wasItSaved: 'not_saved',
            nextSafeAction: `The accountant points the receipt rule's credit at the receivable (${p.accounts.receivable}) instead, then post again. Nothing was posted.`,
          });
        }
        const states = await deps.periodStates(t);
        const day = deps.shopDayOf(deps.now());
        const posted: RebateAccrualJournal[] = [];
        const notPosted: { schemeId: string; reason: string }[] = [];
        for (const line of p.lines) {
          if (!line.approved) {
            if (line.registerAccruedMinor !== line.ledgerAccruedMinor) notPosted.push({ schemeId: line.schemeId, reason: 'the scheme is not approved, so what it accrued is not put in the books yet' });
            continue;
          }
          if (line.toPostMinor === 0) continue;
          const amount = Math.abs(line.toPostMinor);
          const mapped = mapToJournal({ id: `rebate-accrual:${line.schemeId}`, kind: SUPPLIER_REBATE_ACCRUAL_KIND, at: `${day}T00:00:00.000Z`, currency: 'INR', components: { amount } }, p.map);
          const lines = mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 }));
          const belongsTo = day.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const sequence = p.accruals.filter((j) => j.rebateAccrual.schemeId === line.schemeId).length + 1;
          const journal: RebateAccrualJournal = {
            entryId: `rebate-accrual:${line.schemeId}:${sequence}`, period, documentDate: day,
            narrative: `Supplier rebate ${line.toPostMinor > 0 ? 'earned' : 'earned figure re-measured down'} — scheme ${line.schemeId} of ${line.supplierId}: the purchase register has accrued ${line.registerAccruedMinor} paise, the books held ${line.ledgerAccruedMinor}`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            // A re-measure down is the mirror of an accrual: the same accounts, the sides swapped (a compensating journal).
            lines: line.toPostMinor > 0 ? lines : lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
            postedBy: ctx.userId,
            rebateAccrual: { schemeId: line.schemeId, supplierId: line.supplierId, deltaMinor: line.toPostMinor, registerAccruedMinor: line.registerAccruedMinor, sequence },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { notPosted.push({ schemeId: line.schemeId, reason: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          posted.push(journal);
        }
        return { status: posted.length > 0 ? 201 : 200, body: { posted, notPosted, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/rebate-accruals',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const p = await position(ctx.tenantId);
        return {
          status: 200,
          body: {
            lines: p.lines, accounts: p.accounts ?? null, agrees: p.lines.every((l) => l.agrees),
            registerAccruedMinor: p.lines.reduce((s, l) => s + l.registerAccruedMinor, 0),
            ledgerAccruedMinor: p.lines.reduce((s, l) => s + l.ledgerAccruedMinor, 0),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
