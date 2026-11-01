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
  buildDayBook, postDayBook, validatePostingMap, dayBookLedgerLines, DEFAULT_RETAIL_POSTING_MAP, POSTING_KINDS_TO_MAP,
  type DayBookSale, type DayBookReturn, type DayBookException, type DayBookSourceKind, type PostingMap, type DayBookLoyalty,
} from '../../../packages/finance/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';

/** The mapping in force, as defined by a named person. Versions are append-only; the latest is in force. */
export interface StoredPostingMap extends PostingMap {
  readonly version: number;
  readonly definedBy: string;
  readonly definedAt: string;
  /** Round 4d: what the accountant said the change was for (optional; the audit trail holds who and when either way). */
  readonly note?: string;
}

/** One version of the mapping as the setup screen lists it: who, when, why, and which kinds it added, changed or dropped. */
export interface PostingMapVersionSummary {
  readonly version: number;
  readonly definedBy: string;
  readonly definedAt: string;
  readonly note?: string;
  readonly rules: number;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly dropped: readonly string[];
}

/** Every version, newest first, each compared with the one before it (a kind's legs are compared exactly). */
export function postingMapHistory(versions: readonly StoredPostingMap[]): readonly PostingMapVersionSummary[] {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const legsOf = (m: StoredPostingMap | undefined): ReadonlyMap<string, string> =>
    new Map((m?.rules ?? []).map((r) => [r.kind, JSON.stringify(r.legs.map((l) => [l.account, l.side, l.component]))]));
  return ordered.map((v, i) => {
    const before = legsOf(ordered[i - 1]);
    const now = legsOf(v);
    return {
      version: v.version, definedBy: v.definedBy, definedAt: v.definedAt, ...(v.note === undefined ? {} : { note: v.note }), rules: v.rules.length,
      added: [...now.keys()].filter((k) => !before.has(k)),
      changed: [...now.keys()].filter((k) => before.has(k) && before.get(k) !== now.get(k)),
      dropped: [...before.keys()].filter((k) => !now.has(k)),
    };
  }).reverse();
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
    /**
     * OB-264: in the mirror pilot, the old ERP's bill number for each source that has one — a sale's own, a refund's from
     * the sale it came off — so the day book reads bill by bill against the old ERP. Absent when no source has one.
     */
    readonly oldErpBills?: readonly { readonly sourceId: string; readonly oldErpBillNumber: string }[];
    /**
     * OB-340: on a sale or sale-return voucher, each department's exact net (its lines' taxable value after their
     * discounts), as the department owned the products when the voucher posted. The revenue line is carried split the same
     * way, each part naming its department as its centre. Absent when no line was in a department.
     */
    readonly netByDepartment?: Readonly<Record<string, number>>;
    /** OB-340: returns whose net could not be told apart by department (left with the store, said by id). */
    readonly departmentNotKnown?: readonly string[];
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
  /** Round 4d: every version ever defined (append-only), for the setup screen's history. Absent: no history is offered. */
  readonly postingMapVersions?: (tenantId: string) => Promise<readonly StoredPostingMap[]>;
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
  /**
   * The day's valued loyalty facts — points the day's sales earned and the day's returns took back (PF-09 step 3). Absent
   * on a composition without loyalty: nothing loyalty posts.
   */
  readonly loyaltyOn?: (tenantId: string, sales: readonly DayBookSale[], returns: readonly DayBookReturn[]) => Promise<readonly DayBookLoyalty[]>;
  /**
   * OB-340 (owner, 24 Oct 2026): which department owns each product now (through its category — the organisation's
   * department ownership). Absent on a composition without departments: the day book does not split by department.
   */
  readonly departmentOf?: (tenantId: string) => Promise<(productId: string) => string | undefined>;
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
  ...(j.dayBook.oldErpBills === undefined ? {} : { oldErpBills: j.dayBook.oldErpBills }),
  ...(j.dayBook.netByDepartment === undefined ? {} : { netByDepartment: j.dayBook.netByDepartment }),
  ...(j.dayBook.departmentNotKnown === undefined ? {} : { departmentNotKnown: j.dayBook.departmentNotKnown }),
});

/**
 * OB-264: the old ERP's bill number behind each source of a voucher — a sale's own, a refund's from its original sale —
 * in the voucher's own source order. Undefined when none of its sources carries one (outside the mirror pilot).
 */
export function oldErpBillsOf(
  sourceKind: DayBookSourceKind, sourceIds: readonly string[], sales: readonly DayBookSale[], returns: readonly DayBookReturn[], originals: ReadonlyMap<string, DayBookSale>,
): readonly { readonly sourceId: string; readonly oldErpBillNumber: string }[] | undefined {
  const oldOf = new Map<string, string>();
  if (sourceKind === 'sale') for (const sale of sales) if (typeof sale.oldErpBillNumber === 'string') oldOf.set(sale.saleId, sale.oldErpBillNumber);
  if (sourceKind === 'return') {
    for (const r of returns) {
      const original = r.originalSaleId === null ? undefined : originals.get(r.originalSaleId) ?? sales.find((x) => x.saleId === r.originalSaleId);
      if (typeof original?.oldErpBillNumber === 'string') oldOf.set(r.returnId, original.oldErpBillNumber);
    }
  }
  const out = sourceIds.flatMap((id) => (oldOf.has(id) ? [{ sourceId: id, oldErpBillNumber: oldOf.get(id)! }] : []));
  return out.length === 0 ? undefined : out;
}

export function dayBookRoutes(deps: DayBookDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/posting-map',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const [map, versions] = await Promise.all([deps.postingMap(ctx.tenantId), deps.postingMapVersions?.(ctx.tenantId)]);
        return {
          status: 200,
          body: {
            map: map ?? null, suggested: DEFAULT_RETAIL_POSTING_MAP,
            // Round 4d: the kinds other engines post that the suggestion leaves to the accountant (no account guessed), and
            // every version ever defined — who, when, why and which kinds it changed (append-only; the latest is in force).
            toMap: POSTING_KINDS_TO_MAP,
            ...(versions === undefined ? {} : { history: postingMapHistory(versions) }),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'PUT', path: '/v1/finance/posting-map',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { basedOn?: unknown; note?: unknown };
        if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
          throw apiError(400, {
            code: 'posting_map_note_unreadable', whatHappened: 'The note on a mapping change, when sent, is text of at most 500 characters.',
            wasItSaved: 'not_saved', nextSafeAction: 'Shorten the note, or leave it out. The mapping in force is unchanged.',
          });
        }
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
        // Round 4d · hard rule 10: a screen says which version it edited (`basedOn`, 0 for "none yet"); when somebody saved
        // another version since, the change is refused by name — never a silent last-write-wins over their rules.
        if (body.basedOn !== undefined && body.basedOn !== (current?.version ?? 0)) {
          throw apiError(409, {
            code: 'posting_map_changed_since',
            whatHappened: `The mapping was changed by ${current?.definedBy ?? 'somebody'} (version ${current?.version ?? 0}) after you opened version ${String(body.basedOn)}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Read the mapping again, look at what changed, and make your change on the newer version. Nothing was changed.',
          });
        }
        const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined;
        const stored: StoredPostingMap = {
          rules: checked.map.rules, version: (current?.version ?? 0) + 1, definedBy: ctx.userId, definedAt: deps.now(),
          ...(note === undefined ? {} : { note }),
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
        const loyalty = deps.loyaltyOn === undefined ? undefined : await deps.loyaltyOn(t, sales, returns);
        const departmentOf = deps.departmentOf === undefined ? undefined : await deps.departmentOf(t);
        const book = buildDayBook({
          tradingDay, sales, returns, originalSales: originals, taxRateOf: (p) => rates.get(p), alreadyPosted,
          ...(loyalty === undefined ? {} : { loyalty }),
          ...(departmentOf === undefined ? {} : { departmentOf }),
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
            // OB-340: the revenue line carried per department (each part naming its department); every other line as posted.
            lines: dayBookLedgerLines(aggregate, entry, map),
            postedBy: ctx.userId,
            dayBook: {
              tradingDay, kind: aggregate.kind, sourceKind: aggregate.sourceKind, sourceIds: aggregate.sourceIds,
              components: aggregate.components, ...(closed ? { belongsTo } : {}),
              ...(aggregate.netByDepartment === undefined ? {} : { netByDepartment: aggregate.netByDepartment }),
              ...(aggregate.departmentNotKnown === undefined ? {} : { departmentNotKnown: aggregate.departmentNotKnown }),
              ...((): { oldErpBills?: NonNullable<DayBookJournal['dayBook']['oldErpBills']> } => {
                const old = oldErpBillsOf(aggregate.sourceKind, aggregate.sourceIds, sales, returns, originals);
                return old === undefined ? {} : { oldErpBills: old };
              })(),
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
