// API-09 Finance — the B2B money effects (M22-FR-02/04 → M23-FR-01 · FUL-09's invoice / AR / collection money · P-02 · P-08 ·
// hard rule #2).
//
// Before this, a B2B tax invoice was a document and nothing else: it did not become a receivable anyone could age, it did not
// move the customer's AR balance, and it never reached the books; a collection moved the collections sub-ledger only. Now:
//
//   • a tax invoice, when it is issued, becomes — in ONE write — the structured receivable collections ages (due on the
//     customer's payment terms), an `invoice` movement on the customer's AR ledger, and a postable fact for the books;
//   • a collection, when it is allocated, becomes — in ONE write — a `payment` movement on the AR ledger and a postable fact;
//   • the accountant's posting run turns each postable fact into ONE balanced journal through the mapping (`b2b:invoice`:
//     receivables against revenue and output tax; `b2b:receipt`: the money received against receivables), once — a re-run
//     posts nothing; a kind the mapping does not name stays visibly unposted; a closed month takes nothing.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

/** One B2B money fact the books must carry. */
export interface B2BPostable {
  readonly sourceId: string;
  readonly kind: 'invoice' | 'receipt';
  readonly customerId: string;
  /** The invoice's issue date, or the day the money was received. */
  readonly documentDate: string;
  /** invoice: { total, net, tax }; receipt: { amount }. */
  readonly components: Readonly<Record<string, number>>;
  readonly ref: string;
}

export interface B2BJournal extends JournalEntry {
  readonly b2b: { readonly sourceId: string; readonly kind: string; readonly customerId: string; readonly belongsTo?: string };
}

export interface B2BPostingDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  readonly postables: (tenantId: string) => Promise<readonly B2BPostable[]> | readonly B2BPostable[];
  readonly b2bJournals: (tenantId: string) => Promise<readonly B2BJournal[]> | readonly B2BJournal[];
}

export function b2bPostingRoutes(deps: B2BPostingDeps): readonly Route[] {
  const position = async (t: string) => {
    const [facts, journals] = await Promise.all([deps.postables(t), deps.b2bJournals(t)]);
    const posted = new Set(journals.map((j) => j.b2b.sourceId));
    return { facts, journals, unposted: facts.filter((f) => !posted.has(f.sourceId)) };
  };
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/b2b/post',
      permission: 'finance.journal.post', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, {
            code: 'posting_map_not_defined',
            whatHappened: 'No ledger mapping has been defined for this shop, so no B2B invoice or collection can post — which accounts they go to is the accountant\'s decision.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines the mapping first (PUT /v1/finance/posting-map; GET it for a suggested starting map with the B2B rules). Nothing was posted.',
          });
        }
        const [{ unposted }, states] = await Promise.all([position(t), deps.periodStates(t)]);
        const appended: B2BJournal[] = [];
        const exceptions: { readonly sourceId: string; readonly kind: string; readonly reason: string; readonly detail: string }[] = [];
        for (const f of unposted) {
          const kind = `b2b:${f.kind}`;
          let mapped;
          try {
            mapped = postMapped({ id: f.sourceId, kind, at: `${f.documentDate}T00:00:00.000Z`, currency: 'INR', components: f.components }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ sourceId: f.sourceId, kind, reason, detail: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const belongsTo = f.documentDate.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const journal: B2BJournal = {
            entryId: `b2b:${f.sourceId}`, period, documentDate: f.documentDate,
            narrative: `B2B ${f.kind === 'invoice' ? 'tax invoice' : 'collection'} ${f.ref} — customer ${f.customerId}${closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''}`,
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId,
            b2b: { sourceId: f.sourceId, kind, customerId: f.customerId, ...(closed ? { belongsTo } : {}) },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ sourceId: f.sourceId, kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/b2b/postings',
      permission: 'finance.period.read', entitlement: 'b2b',
      handler: async (ctx) => {
        const p = await position(ctx.tenantId);
        return { status: 200, body: { facts: p.facts, journals: p.journals, unposted: p.unposted.map((f) => f.sourceId), asAt: deps.now() } };
      },
    },
  ];
}
