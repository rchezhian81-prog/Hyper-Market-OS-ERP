// API-09 Finance — the day book (M23-FR-01): a trading day's synced sales and returns become balanced
// journals through the accountant's ledger mapping.
//
// Three facts shape these routes. First, WHICH account anything posts to is the CA's decision (AVR-09):
// with no mapping defined nothing posts, and the refusal says so — the system never guesses a chart of
// accounts. Second, every source document ends up in a journal or in a VISIBLE exception (P-08): a sale
// whose GST rate nobody knows, a tender kind the mapping does not name — each is recorded, with the
// receipts it holds back, and shows as `open` until a later posting covers them. Third, a re-run is safe:
// each journal lists the sources it covers, and a posting only ever posts what no journal covers yet.
//
// A closed month stays closed (hard rule #2, QG-07): a day whose own period is closed posts to the next
// open period carrying its real trading date, and the voucher says so — exactly what the manual journal
// route tells a person to do, done deterministically.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildDayBook, postDayBook, validatePostingMap, DEFAULT_RETAIL_POSTING_MAP,
  type DayBookSale, type DayBookReturn, type DayBookException, type DayBookSourceKind, type PostingMap,
} from '../../../packages/finance/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';

/** The mapping in force, as defined by a named person. Versions are append-only; the latest is in force. */
export interface StoredPostingMap extends PostingMap {
  readonly version: number;
  readonly definedBy: string;
  readonly definedAt: string;
}

/** A day-book voucher: a finance journal that also says which day, which kind and which receipts it is made of. */
export interface DayBookJournal extends JournalEntry {
  readonly dayBook: {
    readonly tradingDay: string;
    readonly kind: string;
    readonly sourceKind: DayBookSourceKind;
    readonly sourceIds: readonly string[];
    readonly components: Readonly<Record<string, number>>;
    /** Set when the day's own period was closed and the voucher went to the next open one, carrying its real date. */
    readonly belongsTo?: string;
  };
}

export interface DayBookExceptionRecord extends DayBookException {
  readonly exceptionId: string;
  readonly tradingDay: string;
  readonly raisedAt: string;
  readonly raisedBy: string;
}

export interface DayBookDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  readonly definePostingMap: (tenantId: string, map: StoredPostingMap) => Promise<void> | void;
  /** The synced sales whose `tradingDay` is the day (the trading day, not the clock day). */
  readonly salesOn: (tenantId: string, tradingDay: string) => Promise<readonly DayBookSale[]> | readonly DayBookSale[];
  /** The returns processed on the day. */
  readonly returnsOn: (tenantId: string, tradingDay: string) => Promise<readonly DayBookReturn[]> | readonly DayBookReturn[];
  readonly originalSales: (tenantId: string, saleIds: readonly string[]) => Promise<ReadonlyMap<string, DayBookSale>> | ReadonlyMap<string, DayBookSale>;
  /** The catalogue's GST rate per product, basis points. */
  readonly taxRates: (tenantId: string) => Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
  readonly dayBookJournals: (tenantId: string, tradingDay: string) => Promise<readonly DayBookJournal[]> | readonly DayBookJournal[];
  readonly recordException: (tenantId: string, exception: DayBookExceptionRecord) => Promise<void> | void;
  readonly exceptionsOn: (tenantId: string, tradingDay: string) => Promise<readonly DayBookExceptionRecord[]> | readonly DayBookExceptionRecord[];
}

const TRADING_DAY = /^\d{4}-\d{2}-\d{2}$/;

function tradingDayOf(ctx: RequestContext): string {
  const day = ctx.params['tradingDay'] ?? '';
  if (!TRADING_DAY.test(day)) {
    throw apiError(400, {
      code: 'bad_trading_day',
      whatHappened: `'${day}' is not a trading day. A trading day is written YYYY-MM-DD.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send the trading day as YYYY-MM-DD, e.g. 2026-09-28.',
    });
  }
  return day;
}

/** A short, stable fingerprint of a set of source ids — the same receipts held back for the same reason are one exception. */
export function fingerprint(ids: readonly string[]): string {
  let h = 5381;
  for (const ch of [...ids].sort().join('|')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const exceptionIdFor = (tradingDay: string, e: DayBookException): string =>
  `${tradingDay}:${e.reason}:${e.kind ?? e.sourceKind}:${fingerprint(e.sourceIds)}`;

/** Per posting kind, the sources the day's journals of that kind already cover. */
export function coveredByKind(journals: readonly DayBookJournal[]): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const j of journals) {
    const ids = out.get(j.dayBook.kind) ?? new Set<string>();
    for (const id of j.dayBook.sourceIds) ids.add(id);
    out.set(j.dayBook.kind, ids);
  }
  return out;
}

/**
 * Whether a later posting has covered what an exception held back. A RULE exception (it names a kind) is
 * resolved only by a journal of that kind — the sale voucher posting does not settle an unmapped tender.
 * A RECEIPT exception is resolved by any journal covering the receipt.
 */
export function exceptionState(e: DayBookException, journals: readonly DayBookJournal[]): 'open' | 'resolved' {
  const byKind = coveredByKind(journals);
  const anyKind = new Set([...byKind.values()].flatMap((ids) => [...ids]));
  const covers = e.kind === undefined ? anyKind : (byKind.get(e.kind) ?? new Set<string>());
  return e.sourceIds.every((id) => covers.has(id)) ? 'resolved' : 'open';
}

const summarise = (j: DayBookJournal) => ({
  entryId: j.entryId, kind: j.dayBook.kind, sourceKind: j.dayBook.sourceKind, sources: j.dayBook.sourceIds.length,
  period: j.period, documentDate: j.documentDate, ...(j.dayBook.belongsTo === undefined ? {} : { belongsTo: j.dayBook.belongsTo }),
  components: j.dayBook.components, lines: j.lines, postedBy: j.postedBy, narrative: j.narrative,
});

export function dayBookRoutes(deps: DayBookDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/posting-map',
      permission: 'finance.period.read',
      handler: async (ctx) => ({
        status: 200,
        body: { map: (await deps.postingMap(ctx.tenantId)) ?? null, suggested: DEFAULT_RETAIL_POSTING_MAP, asAt: deps.now() },
      }),
    },
    {
      api: 'API-09', method: 'PUT', path: '/v1/finance/posting-map',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => {
        const checked = validatePostingMap(ctx.body);
        if (!checked.ok) {
          throw apiError(422, {
            code: 'posting_map_invalid',
            whatHappened: `The mapping could not be accepted: ${checked.problems.join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the rules named and send the whole mapping again. The mapping in force is unchanged.',
          });
        }
        const current = await deps.postingMap(ctx.tenantId);
        const stored: StoredPostingMap = {
          rules: checked.map.rules, version: (current?.version ?? 0) + 1, definedBy: ctx.userId, definedAt: deps.now(),
        };
        await deps.definePostingMap(ctx.tenantId, stored);
        return { status: 200, body: { version: stored.version, rules: stored.rules.length, kinds: stored.rules.map((r) => r.kind) } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/day-book/:tradingDay/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const tradingDay = tradingDayOf(ctx);
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, {
            code: 'posting_map_not_defined',
            whatHappened: 'No ledger mapping has been defined for this shop, so nothing can post — which account a sale goes to is the accountant\'s decision, not the system\'s.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines the mapping first (PUT /v1/finance/posting-map; GET it for a suggested starting map). Nothing was posted and nothing was lost — the day posts whenever the mapping exists.',
          });
        }
        const [sales, returns, rates, posted, states] = await Promise.all([
          deps.salesOn(t, tradingDay), deps.returnsOn(t, tradingDay), deps.taxRates(t), deps.dayBookJournals(t, tradingDay), deps.periodStates(t),
        ]);
        const originals = await deps.originalSales(
          t, [...new Set(returns.map((r) => r.originalSaleId).filter((id): id is string => id !== null))],
        );
        const alreadyPosted = coveredByKind(posted);
        const book = buildDayBook({
          tradingDay, sales, returns, originalSales: originals, taxRateOf: (p) => rates.get(p), alreadyPosted,
        });
        const outcome = postDayBook(book, map, 'INR');

        const belongsTo = tradingDay.slice(0, 7);
        const closed = states.get(belongsTo) === 'closed';
        const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
        const countByKind = new Map<string, number>();
        for (const j of posted) countByKind.set(j.dayBook.kind, (countByKind.get(j.dayBook.kind) ?? 0) + 1);

        const exceptions: DayBookException[] = [...book.exceptions, ...outcome.exceptions];
        const appended: DayBookJournal[] = [];
        for (const { aggregate, entry } of outcome.journals) {
          const n = (countByKind.get(aggregate.kind) ?? 0) + 1;
          countByKind.set(aggregate.kind, n);
          const journal: DayBookJournal = {
            entryId: `daybook:${tradingDay}:${aggregate.kind}:${n}`,
            period, documentDate: tradingDay,
            narrative: `Day book ${tradingDay} — ${aggregate.kind}: ${aggregate.sourceIds.length} ${aggregate.sourceKind}(s)`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            lines: entry.lines.map((l) => ({
              accountCode: l.account,
              debitMinor: l.side === 'debit' ? l.amount.minor : 0,
              creditMinor: l.side === 'credit' ? l.amount.minor : 0,
            })),
            postedBy: ctx.userId,
            dayBook: {
              tradingDay, kind: aggregate.kind, sourceKind: aggregate.sourceKind, sourceIds: aggregate.sourceIds,
              components: aggregate.components, ...(closed ? { belongsTo } : {}),
            },
          };
          // The same gate the manual journal route runs — balance, narrative, closed period. Belt and braces.
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) {
            exceptions.push({
              sourceKind: aggregate.sourceKind, sourceIds: aggregate.sourceIds, kind: aggregate.kind,
              reason: 'unbalanced_journal', detail: gate.detail,
            });
            continue;
          }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }

        const raisedAt = deps.now();
        const records: DayBookExceptionRecord[] = exceptions.map((e) => ({
          ...e, exceptionId: exceptionIdFor(tradingDay, e), tradingDay, raisedAt, raisedBy: ctx.userId,
        }));
        for (const r of records) await deps.recordException(t, r);

        return {
          status: appended.length > 0 ? 201 : 200,
          body: {
            tradingDay, postedTo: period, ...(closed ? { postedLate: { belongsTo } } : {}),
            journals: appended.map(summarise), exceptions: records,
            skipped: book.skipped.length, zeroValue: book.zeroValue, counted: book.counted,
          },
        };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/day-book/:tradingDay',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const tradingDay = tradingDayOf(ctx);
        const [journals, raised] = await Promise.all([deps.dayBookJournals(ctx.tenantId, tradingDay), deps.exceptionsOn(ctx.tenantId, tradingDay)]);
        const covered = new Set(journals.flatMap((j) => j.dayBook.sourceIds));
        const accounts = new Map<string, { debitMinor: number; creditMinor: number }>();
        for (const j of journals) {
          for (const l of j.lines) {
            const a = accounts.get(l.accountCode) ?? { debitMinor: 0, creditMinor: 0 };
            a.debitMinor += l.debitMinor;
            a.creditMinor += l.creditMinor;
            accounts.set(l.accountCode, a);
          }
        }
        const seen = new Set<string>();
        const exceptions = raised
          .filter((e) => (seen.has(e.exceptionId) ? false : (seen.add(e.exceptionId), true)))
          .map((e) => ({ ...e, state: exceptionState(e, journals) }));
        return {
          status: 200,
          body: {
            tradingDay,
            journals: journals.map(summarise),
            accounts: [...accounts].sort(([a], [b]) => a.localeCompare(b))
              .map(([accountCode, a]) => ({ accountCode, ...a, balanceMinor: a.debitMinor - a.creditMinor })),
            covered: covered.size,
            exceptions,
            open: exceptions.filter((e) => e.state === 'open').length,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
