// API-09 Finance — payables (M23-FR-01 · SP-7b · audit finding F04's payable half): the supplier account becomes
// balanced journals through the accountant's ledger mapping, and the two — the purchase register and the finance
// ledger — are reconciled as two figures reached two different ways (QG-07).
//
// The supplier account is a PROJECTION the purchase service reads from its registers (the matched invoice's payable,
// the debit notes a return / claim raised). Finance reads it and never edits it (§28): a posting run computes, per
// source, the difference between what the register now says and what the ledger already holds, and posts exactly that
// — an accrual, a reversal when a re-match withheld more, a debit note once. Which account anything goes to is the
// accountant's mapping (AVR-09); a kind the mapping does not name is a VISIBLE exception until the mapping does
// (P-08); a re-run posts nothing twice; a closed month takes nothing — the entry goes to the next open period carrying
// its real document date (hard rule #2, QG-07).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  planPayablesPostings, postPayables, reconcilePayables,
  type PayablesAccount, type PayablesException, type PayablesKind, type PayablesSourceKind, type PostedPayablesJournal,
} from '../../../packages/finance/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

/** A payables voucher: a finance journal that also says which supplier, which source and which kind it is made of. */
export interface PayablesJournal extends JournalEntry {
  readonly payables: {
    readonly kind: PayablesKind;
    readonly sourceKind: PayablesSourceKind;
    readonly sourceId: string;
    readonly supplierId: string;
    readonly components: Readonly<Record<string, number>>;
    /** Set when the source's own period was closed and the voucher went to the next open one, carrying its real date. */
    readonly belongsTo?: string;
  };
}

export interface PayablesExceptionRecord extends PayablesException {
  readonly exceptionId: string;
  readonly raisedAt: string;
  readonly raisedBy: string;
}

export interface PayablesDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  /** Every supplier's account as the purchase service projects it from its registers. */
  readonly supplierAccounts: (tenantId: string) => Promise<readonly PayablesAccount[]> | readonly PayablesAccount[];
  readonly payablesJournals: (tenantId: string) => Promise<readonly PayablesJournal[]> | readonly PayablesJournal[];
  readonly recordException: (tenantId: string, exception: PayablesExceptionRecord) => Promise<void> | void;
  readonly exceptions: (tenantId: string) => Promise<readonly PayablesExceptionRecord[]> | readonly PayablesExceptionRecord[];
}

export const exceptionIdFor = (e: PayablesException): string => `payables:${e.kind}:${e.sourceIds.join('+')}:${e.reason}`;

/** An exception is resolved once a journal of ITS kind covers its source — a later mapping fix followed by a posting. */
export function exceptionState(e: PayablesException, journals: readonly PayablesJournal[]): 'open' | 'resolved' {
  return e.sourceIds.every((id) => journals.some((j) => j.payables.kind === e.kind && j.payables.sourceId === id)) ? 'resolved' : 'open';
}

const asPosted = (j: PayablesJournal): PostedPayablesJournal => ({ ...j.payables, lines: j.lines });

const summarise = (j: PayablesJournal) => ({
  entryId: j.entryId, kind: j.payables.kind, sourceKind: j.payables.sourceKind, sourceId: j.payables.sourceId, supplierId: j.payables.supplierId,
  period: j.period, documentDate: j.documentDate, ...(j.payables.belongsTo === undefined ? {} : { belongsTo: j.payables.belongsTo }),
  components: j.payables.components, lines: j.lines, postedBy: j.postedBy, narrative: j.narrative,
});

export function payablesRoutes(deps: PayablesDeps): readonly Route[] {
  return [
    {
      // Post what the ledger does not yet hold of every supplier's account. Nothing to send: the figures are the registers'.
      api: 'API-09', method: 'POST', path: '/v1/finance/payables/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, {
            code: 'posting_map_not_defined',
            whatHappened: 'No ledger mapping has been defined for this shop, so nothing can post — which account a supplier\'s invoice goes to is the accountant\'s decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines the mapping first (PUT /v1/finance/posting-map; GET it for a suggested starting map, which includes the supplier-account rules). Nothing was posted and nothing was lost.',
          });
        }
        const [accounts, posted, states] = await Promise.all([deps.supplierAccounts(t), deps.payablesJournals(t), deps.periodStates(t)]);
        const planned = planPayablesPostings(accounts, posted.map(asPosted));
        const outcome = postPayables(planned, map, 'INR');
        const exceptions: PayablesException[] = [...outcome.exceptions];
        const appended: PayablesJournal[] = [];
        const countFor = new Map<string, number>();
        for (const j of posted) {
          const k = `${j.payables.kind}|${j.payables.sourceId}`;
          countFor.set(k, (countFor.get(k) ?? 0) + 1);
        }
        for (const { posting, entry } of outcome.journals) {
          const k = `${posting.kind}|${posting.sourceId}`;
          const n = (countFor.get(k) ?? 0) + 1;
          countFor.set(k, n);
          const belongsTo = posting.documentDate.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const amount = Object.values(posting.components).reduce((s, v) => s + v, 0);
          const journal: PayablesJournal = {
            entryId: `payables:${posting.kind}:${posting.sourceId}:${n}`,
            period, documentDate: posting.documentDate,
            narrative: `Payables — supplier ${posting.supplierId}: ${posting.kind} ${posting.sourceId} for ${amount} minor units`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            lines: entry.lines.map((l) => ({
              accountCode: l.account,
              debitMinor: l.side === 'debit' ? l.amount.minor : 0,
              creditMinor: l.side === 'credit' ? l.amount.minor : 0,
            })),
            postedBy: ctx.userId,
            payables: {
              kind: posting.kind, sourceKind: posting.sourceKind, sourceId: posting.sourceId, supplierId: posting.supplierId,
              components: posting.components, ...(closed ? { belongsTo } : {}),
            },
          };
          // The same gate the manual journal route runs — balance, narrative, closed period. Belt and braces.
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) {
            exceptions.push({ sourceKind: posting.sourceKind, sourceIds: [posting.sourceId], kind: posting.kind, supplierId: posting.supplierId, reason: 'unbalanced_journal', detail: gate.detail });
            continue;
          }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        const raisedAt = deps.now();
        const records: PayablesExceptionRecord[] = exceptions.map((e) => ({ ...e, exceptionId: exceptionIdFor(e), raisedAt, raisedBy: ctx.userId }));
        for (const r of records) await deps.recordException(t, r);
        return {
          status: appended.length > 0 ? 201 : 200,
          body: { planned: planned.length, journals: appended.map(summarise), exceptions: records, suppliers: accounts.length, asAt: raisedAt },
        };
      },
    },
    {
      // The payables ledger and the reconciliation: every posted voucher, every exception with its state, and per supplier
      // the register's figure beside the ledger's — the difference always visible (P-08), never a silent tie-out.
      api: 'API-09', method: 'GET', path: '/v1/finance/payables',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [accounts, journals, raised, map] = await Promise.all([deps.supplierAccounts(t), deps.payablesJournals(t), deps.exceptions(t), deps.postingMap(t)]);
        const seen = new Set<string>();
        const exceptions = raised
          .filter((e) => (seen.has(e.exceptionId) ? false : (seen.add(e.exceptionId), true)))
          .map((e) => ({ ...e, state: exceptionState(e, journals) }));
        const open = exceptions.filter((e) => e.state === 'open');
        return {
          status: 200,
          body: {
            journals: journals.map(summarise),
            exceptions: [...open, ...exceptions.filter((e) => e.state !== 'open')],
            open: open.length,
            reconciliation: reconcilePayables(accounts, journals.map(asPosted), map),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
