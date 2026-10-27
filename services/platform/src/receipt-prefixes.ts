// HEAD OFFICE ISSUES EACH TILL ITS BILL-NUMBER PREFIX (OB-81 "A", owner, 12 Oct 2026 · OB-80 · M01-FR-02 · audit PF-04 ·
// P-01 · P-02 · P-08 · hard rules #2, #6, #10).
//
// Before this, the store computer numbered a till's bills from the store pack's `receiptSeries` — which head office never
// filled — else `R-<lane>-000001`. Two stores whose tills are both "lane-1" (OB-80) would print the same bill numbers and
// send the same sale ids. Now:
//
//   • the owner/admin (`platform.setup.write`, at a store they hold) issues a prefix for one (store, till); each change is a
//     new VERSION on an append-only log, audited (who, before, after) — the old prefix is never forgotten and never moved
//     to another till, so a past bill number can never be issued again (bills are never renumbered);
//   • the prefix is checked against the shared rule (packages/contracts/src/receipt-number.ts): 2–10 characters GST allows,
//     not a reserved start — so prefix + 6-digit count is at most 16 characters;
//   • a prefix any OTHER till ever held is refused BY NAME (409 `receipt_prefix_taken`, naming the store and the till), under
//     a write guard so two owners cannot issue one prefix to two tills at the same moment; the same prefix to the same till
//     is the same answer (nothing new recorded);
//   • the store pack carries each till's current prefix as its `receiptSeries` (1…999 999, 6 digits) and the number of
//     stores in the business (`receiptNumbering`) — the store computer numbers from it (edge/store-edge/src/receipt-numbers.ts);
//   • `GET /v1/receipt-prefixes` lists every till's prefix and history, and FLAGS each registered till with none once the
//     business has more than one store (its box then sells under its store-qualified default, also flagged on every sale).
//
// Maker-checker: the store pack's receipt range had no head-office publish path before this, so there is no existing
// approval to inherit; the issue is a single audited act of the setup permission, as every other store setting is.
//
// A2 (roadmap v2.1 addendum · CGST Rule 46(b): the series resets on the financial-year boundary): a prefix may be issued FOR
// a financial year (`financialYear: "2026-27"`). A till then holds one prefix per year; the store computer numbers each
// bill under the prefix of the year the bill is dated in, so the count restarts at 000001 on 1 April. A prefix is never
// issued twice — not to another till, and not to the same till for another year — so numbers never repeat across years.
// Head office issues next year's prefix before 1 April; `GET /v1/receipt-prefixes` names every year-scoped till that has
// no prefix yet for the current or the coming year.
//
// OB-376 (owner, 25 Oct 2026): a HANDHELD QUEUE TILL is a till lane too — its bills are numbered by the store computer for
// lane `device:<deviceId>` (ADR-0028). Head office issues that lane its own prefix by the SAME route and the same rules
// (unique, versioned, audited, carried in the store pack), so its bills are no longer flagged "numbered without an issued
// prefix". Only a handheld head office registered at that store is accepted (when the register is wired), and every
// registered handheld with no prefix is listed — not flagged: a warehouse or picker handheld never rings a bill.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  readReceiptPrefix, receiptNumberFor, GST_INVOICE_NUMBER_MAX, RECEIPT_COUNTER_DIGITS, RECEIPT_COUNTER_MAX, RECEIPT_PREFIX_MAX,
  isFinancialYear, financialYearOf, nextFinancialYear,
} from '../../../packages/contracts/src/receipt-number';
import { shopClock, shopDateIn, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

/** One issue of a prefix to a (store, till) — append-only. */
export interface ReceiptPrefixIssue {
  readonly storeId: string;
  readonly tillId: string;
  readonly prefix: string;
  /** 1 for the till's first prefix, +1 each change. */
  readonly version: number;
  readonly reason?: string;
  readonly setBy: string;
  readonly setAt: string;
  /** A2: the financial year this prefix numbers ("2026-27"). Absent → the till's one prefix, for every year. */
  readonly financialYear?: string;
}

/** A till's current prefix and everything it held before. */
export interface TillPrefix {
  readonly storeId: string;
  readonly tillId: string;
  readonly prefix: string;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
  /** The first and last bill numbers this prefix allows — the last at most 16 characters. */
  readonly firstNumber: string;
  readonly lastNumber: string;
  readonly history: readonly ReceiptPrefixIssue[];
  /** A2: the financial year this prefix numbers, when it is year-scoped. */
  readonly financialYear?: string;
}

/** The pack's `receiptSeries` line for a till (edge/store-edge/src/receipt-numbers.ts `PackReceiptSeries`). */
export interface IssuedSeries {
  readonly laneId: string;
  readonly prefix: string;
  readonly padTo: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** A2: the financial year this series numbers, when it is year-scoped. */
  readonly financialYear?: string;
}

/** Thrown by `recordIssue` when another issue landed since `expectedVersion` was read: read again and re-judge. */
export class PrefixWriteRaced extends Error {}

export interface ReceiptPrefixDeps {
  readonly now: () => string;
  /** The stores head office knows: id → name (its org register's branches). */
  readonly stores: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  /** Every issue ever made, in order (the append-only log). */
  readonly issues: (tenantId: string) => Promise<readonly ReceiptPrefixIssue[]>;
  /** The write guard's current version: read it BEFORE `issues`, pass it to `recordIssue`. */
  readonly guardVersion: (tenantId: string) => Promise<number>;
  /**
   * Append one issue, refused with `PrefixWriteRaced` when the guard moved. When the write did NOT land because the same
   * version was already written by someone else at the same moment (the append deduped — verifier r17 OB81-2), it answers
   * `{ kept }`: the issue head office actually holds. Nothing else answers anything (void = it landed).
   */
  readonly recordIssue: (tenantId: string, issue: ReceiptPrefixIssue, expectedVersion: number) => Promise<void | { readonly kept: ReceiptPrefixIssue }>;
  /** The tills head office registered (device registry `pos_lane`, not retired): which store each is at. */
  readonly registeredTills?: (tenantId: string) => Promise<readonly { readonly storeId: string; readonly tillId: string; readonly label?: string }[]>;
  /** OB-376: the handhelds head office registered (device registry `handheld`, not retired): which store each is at. */
  readonly registeredHandhelds?: (tenantId: string) => Promise<readonly { readonly storeId: string; readonly deviceId: string; readonly label?: string }[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** M01-FR-02 (re-audit T1): the tenant's calendar — "this year" and "is it March" are the shop's own date. Absent → shop default. */
  readonly calendar?: ShopCalendarOf;
}

const TILL_ID = /^[A-Za-z0-9._-]{1,40}$/;
/** OB-376: a handheld queue till's lane, as its store computer numbers it (`device:<deviceId>`, ADR-0028). */
export const QUEUE_TILL_LANE_PREFIX = 'device:';
const QUEUE_TILL_LANE = /^device:([A-Za-z0-9._-]{1,40})$/;
/** OB-376: the handheld a lane names, when it is a queue till's lane; otherwise undefined. */
export const handheldOfLane = (tillId: string): string | undefined => QUEUE_TILL_LANE.exec(tillId)?.[1];
const RETRIES = 16;

/** The current prefix per (store, till), with its history. Pure. */
export function foldTillPrefixes(issues: readonly ReceiptPrefixIssue[]): readonly TillPrefix[] {
  const by = new Map<string, ReceiptPrefixIssue[]>();
  for (const i of issues) {
    // A2: a year-scoped prefix is the till's for ONE year — its own line, beside the till's other years.
    const k = `${i.storeId}\u0000${i.tillId}\u0000${i.financialYear ?? ''}`;
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  return [...by.values()].map((h) => {
    const cur = h.reduce((a, b) => (b.version >= a.version ? b : a));
    return {
      storeId: cur.storeId, tillId: cur.tillId, prefix: cur.prefix, version: cur.version, setBy: cur.setBy, setAt: cur.setAt,
      firstNumber: receiptNumberFor(cur.prefix, 1), lastNumber: receiptNumberFor(cur.prefix, RECEIPT_COUNTER_MAX), history: h,
      ...(cur.financialYear === undefined ? {} : { financialYear: cur.financialYear }),
    };
  }).sort((a, b) => (a.storeId === b.storeId
    ? (a.tillId === b.tillId ? ((a.financialYear ?? '') < (b.financialYear ?? '') ? -1 : 1) : a.tillId < b.tillId ? -1 : 1)
    : a.storeId < b.storeId ? -1 : 1));
}

/** The store pack's `receiptSeries` for one store: each till's CURRENT prefix, 1…999 999, 6 digits. Pure. */
export function issuedSeriesFor(issues: readonly ReceiptPrefixIssue[], storeId: string): readonly IssuedSeries[] {
  const tills = foldTillPrefixes(issues).filter((t) => t.storeId === storeId);
  // A2: a till with ANY year-scoped prefix numbers by year — its yearless prefix (from before) is no longer sent.
  const yearScoped = new Set(tills.filter((t) => t.financialYear !== undefined).map((t) => t.tillId));
  return tills.filter((t) => t.financialYear !== undefined || !yearScoped.has(t.tillId))
    .map((t) => ({
      laneId: t.tillId, prefix: t.prefix, padTo: RECEIPT_COUNTER_DIGITS, rangeStart: 1, rangeEnd: RECEIPT_COUNTER_MAX,
      ...(t.financialYear === undefined ? {} : { financialYear: t.financialYear }),
    }));
}

export function receiptPrefixRoutes(deps: ReceiptPrefixDeps): readonly Route[] {
  return [
    {
      // Issue (or change) one till's bill-number prefix. Body: { prefix, reason? }. Idempotent on the caller's key, and the
      // same prefix to the same till again records nothing new.
      api: 'API-01', method: 'POST', path: '/v1/stores/:storeId/tills/:tillId/receipt-prefix',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        const tillId = ctx.params['tillId'] ?? '';
        const stores = await deps.stores(ctx.tenantId);
        if (!stores.has(storeId)) throw notFound(`store ${storeId}`);
        assertBranchInScope(ctx, storeId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const handheld = handheldOfLane(tillId);
        if (!TILL_ID.test(tillId) && handheld === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_till', whatHappened: `"${tillId}" is not a till name head office can keep (letters, digits, ".", "_" or "-", up to 40; a handheld queue till is device:<its device id>).`, wasItSaved: 'not_saved', nextSafeAction: 'Use the till\'s name as its store computer knows it (for example lane-1, or device:hh-1 for a handheld queue till). Nothing was saved.' });
        }
        // OB-376: a queue till's lane must be a handheld head office registered at THIS store — never a guessed device.
        if (handheld !== undefined && deps.registeredHandhelds !== undefined
          && !(await deps.registeredHandhelds(ctx.tenantId)).some((h) => h.deviceId === handheld && h.storeId === storeId)) {
          throw apiError(422, { code: 'not_a_handheld_of_this_store', whatHappened: `Head office has no handheld ${handheld} registered at store ${storeId}, so lane ${tillId} cannot be given a bill-number prefix.`, wasItSaved: 'not_saved', nextSafeAction: 'Register the handheld at this store on the Tills & devices page first, then issue the prefix. Nothing was saved.' });
        }
        const read = readReceiptPrefix(b['prefix']);
        if (!read.ok) {
          throw apiError(400, { code: 'receipt_prefix_not_allowed', whatHappened: `${read.words}`, wasItSaved: 'not_saved', nextSafeAction: `Choose a prefix of ${RECEIPT_PREFIX_MAX} characters or fewer, for example S2L1-. Nothing was saved.` });
        }
        // A2: a prefix FOR a financial year ("2026-27"), or — absent — the till's one prefix for every year.
        const financialYear = b['financialYear'];
        if (financialYear !== undefined && !isFinancialYear(financialYear)) {
          throw apiError(400, { code: 'not_a_financial_year', whatHappened: `The financial year ${JSON.stringify(financialYear)} is not one written like 2026-27 (1 April 2026 to 31 March 2027).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the year as YYYY-YY, or leave it out. Nothing was saved.' });
        }
        if (b['reason'] !== undefined && (typeof b['reason'] !== 'string' || b['reason'].length > 500)) {
          throw apiError(400, { code: 'receipt_prefix_not_allowed', whatHappened: 'The reason, when given, is text of up to 500 characters.', wasItSaved: 'not_saved', nextSafeAction: 'Send a short reason, or none. Nothing was saved.' });
        }
        const prefix = read.prefix;
        for (let attempt = 0; ; attempt += 1) {
          const guard = await deps.guardVersion(ctx.tenantId);
          const all = await deps.issues(ctx.tenantId);
          // Any OTHER till that ever held this prefix — its bills exist, so it is never issued again elsewhere. A2: nor to this
          // till for ANOTHER year — the count restarts each year, so a prefix used in one year can never number another.
          const holder = all.find((i) => i.prefix === prefix && !(i.storeId === storeId && i.tillId === tillId && i.financialYear === financialYear));
          if (holder !== undefined) {
            const holderName = stores.get(holder.storeId) ?? holder.storeId;
            const sameTill = holder.storeId === storeId && holder.tillId === tillId;
            throw apiError(409, {
              code: 'receipt_prefix_taken',
              whatHappened: sameTill
                ? `The prefix ${prefix} was this till's for ${holder.financialYear ?? 'every year'} (issued ${shopDateIn(holder.setAt)}). Bill numbers start again each financial year, so a prefix used in one year can never number another, or the numbers would repeat.`
                : `The prefix ${prefix} was issued to till ${holder.tillId} at ${holderName} (${holder.storeId}) on ${shopDateIn(holder.setAt)}. Two tills must never share a prefix, or their bill numbers would clash.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Choose a prefix no other till has used, for example the store and till numbers (S2L1-). Nothing was saved.',
            });
          }
          const mine = all.filter((i) => i.storeId === storeId && i.tillId === tillId && i.financialYear === financialYear);
          const current = mine.reduce<ReceiptPrefixIssue | undefined>((a, x) => (a === undefined || x.version >= a.version ? x : a), undefined);
          if (current !== undefined && current.prefix === prefix) {
            return { status: 200, body: { prefix: foldTillPrefixes(mine)[0], unchanged: true } };
          }
          const issue: ReceiptPrefixIssue = {
            // The version counts every issue to this till, whatever its year — each issue is its own entry on the log.
            storeId, tillId, prefix, version: all.filter((i) => i.storeId === storeId && i.tillId === tillId).reduce((v, i) => Math.max(v, i.version), 0) + 1, setBy: ctx.userId, setAt: deps.now(),
            ...(typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? { reason: b['reason'].trim() } : {}),
            ...(typeof financialYear === 'string' ? { financialYear } : {}),
          };
          let written: void | { readonly kept: ReceiptPrefixIssue };
          try {
            written = await deps.recordIssue(ctx.tenantId, issue, guard);
          } catch (e) {
            if (e instanceof PrefixWriteRaced && attempt < RETRIES) continue;
            throw e;
          }
          // Verifier r17 OB81-2 (hard rule #10, P-08): someone else wrote this till's SAME version at the same moment, so this
          // write did not land. Never a silent last-write-wins, never an audit entry for an issue that did not happen: the
          // same prefix is the same outcome (200, unchanged); a different one is a visible conflict naming the kept prefix.
          if (written !== undefined && written !== null && typeof written === 'object' && 'kept' in written) {
            const kept = written.kept;
            if (kept.prefix === prefix) return { status: 200, body: { prefix: foldTillPrefixes([...mine, kept])[0], unchanged: true } };
            throw apiError(409, {
              code: 'receipt_prefix_changed_at_the_same_moment',
              whatHappened: `At the same moment, ${kept.setBy} set till ${tillId}'s prefix to ${kept.prefix}. That is the prefix head office kept; ${prefix} was not saved.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `Re-open the till's prefix: it is ${kept.prefix}. If it should be ${prefix}, agree with ${kept.setBy} and send it again. Nothing was saved.`,
            });
          }
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'receipt.prefix.issue', objectType: 'till', objectId: `${storeId}/${tillId}`,
            at: issue.setAt, origin: { tenantId: ctx.tenantId, branchId: storeId },
            before: current === undefined ? null : { prefix: current.prefix, version: String(current.version) },
            after: { prefix, version: String(issue.version), ...(issue.reason === undefined ? {} : { reason: issue.reason }), ...(issue.financialYear === undefined ? {} : { financialYear: issue.financialYear }) },
            correlationId: `${storeId}/${tillId}`,
          });
          return { status: current === undefined ? 201 : 200, body: { prefix: foldTillPrefixes([...mine, issue])[0] } };
        }
      },
    },
    {
      // Every till's prefix and history, and every registered till that has none while the business has more than one store.
      api: 'API-01', method: 'GET', path: '/v1/receipt-prefixes',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const stores = await deps.stores(ctx.tenantId);
        const inScope = (s: string): boolean => ctx.scope === undefined || ctx.scope === 'all' || ctx.scope.includes(s);
        const tills = foldTillPrefixes(await deps.issues(ctx.tenantId)).filter((t) => inScope(t.storeId));
        const multiStore = stores.size > 1;
        const has = new Set(tills.map((t) => `${t.storeId}\u0000${t.tillId}`));
        const registered = deps.registeredTills === undefined ? [] : await deps.registeredTills(ctx.tenantId);
        const needsPrefix = registered
          .filter((r) => inScope(r.storeId) && !has.has(`${r.storeId}\u0000${r.tillId}`))
          .map((r) => ({
            storeId: r.storeId, storeName: stores.get(r.storeId) ?? r.storeId, tillId: r.tillId, ...(r.label === undefined ? {} : { label: r.label }),
            flagged: multiStore,
            why: multiStore
              ? `Till ${r.tillId} at ${stores.get(r.storeId) ?? r.storeId} has no bill-number prefix and the business has more than one store: its store computer numbers its bills under its own store prefix (ZZ…) until one is issued.`
              : 'No prefix issued yet. With one store a till that already numbers R-<till>- carries on; a new or replaced till numbers under its store computer\'s own store prefix (ZZ…), and each such bill is flagged (OB-85). Issue one before a second store opens.',
          }));
        // OB-376: every registered handheld with no prefix for its queue-till lane — listed (a queue till's bills are flagged
        // until it has one), never flagged as owed: a warehouse or picker handheld never rings a bill.
        const handhelds = deps.registeredHandhelds === undefined ? [] : await deps.registeredHandhelds(ctx.tenantId);
        const handheldsWithoutPrefix = handhelds
          .filter((h) => inScope(h.storeId) && !has.has(`${h.storeId}\u0000${QUEUE_TILL_LANE_PREFIX}${h.deviceId}`))
          .map((h) => ({
            storeId: h.storeId, storeName: stores.get(h.storeId) ?? h.storeId, tillId: `${QUEUE_TILL_LANE_PREFIX}${h.deviceId}`,
            ...(h.label === undefined ? {} : { label: h.label }), flagged: false,
            why: `Handheld ${h.deviceId}${h.label === undefined ? '' : ` (${h.label})`}: if it is used as a queue till, issue lane ${QUEUE_TILL_LANE_PREFIX}${h.deviceId} its own prefix — until then each bill it takes is numbered under its store computer's own prefix (ZZ…) and flagged.`,
          }));
        // A2: every year-scoped till with no prefix for the current year, or (from 1 March) for the coming one — the store
        // computer would otherwise number under a fallback on 1 April. Said, by name, ahead of the day.
        const now = deps.now();
        const zone = (await shopClock(deps.calendar).calendar(ctx.tenantId)).timeZone;
        const thisYear = financialYearOf(now, zone) ?? '';
        const comingYear = thisYear === '' ? '' : nextFinancialYear(thisYear);
        const march = shopDateIn(now, zone).slice(5, 7) === '03';
        const yearScoped = new Map<string, Set<string>>();
        for (const t of tills) {
          if (t.financialYear === undefined) continue;
          const k = `${t.storeId}\u0000${t.tillId}`;
          yearScoped.set(k, (yearScoped.get(k) ?? new Set()).add(t.financialYear));
        }
        const needsYearPrefix = [...yearScoped.entries()].flatMap(([k, years]) => {
          const [storeId, tillId] = k.split('\u0000') as [string, string];
          return [thisYear, ...(march ? [comingYear] : [])].filter((y) => y !== '' && !years.has(y)).map((financialYear) => ({
            storeId, storeName: stores.get(storeId) ?? storeId, tillId, financialYear,
            why: `Till ${tillId} at ${stores.get(storeId) ?? storeId} has no bill-number prefix for ${financialYear}. Bill numbers start again each financial year: on 1 April its store computer numbers under its own store prefix (ZZ…) until one is issued.`,
          }));
        });
        return {
          status: 200,
          body: {
            storesInBusiness: stores.size, multiStore, tills, needsPrefix: [...needsPrefix, ...handheldsWithoutPrefix],
            currentFinancialYear: thisYear, needsYearPrefix,
            rule: { maxNumberLength: GST_INVOICE_NUMBER_MAX, counterDigits: RECEIPT_COUNTER_DIGITS, maxPrefixLength: RECEIPT_PREFIX_MAX, reservedStarts: ['R-', 'ZZ'] },
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
