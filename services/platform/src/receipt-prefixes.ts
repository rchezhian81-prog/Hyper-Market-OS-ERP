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

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  readReceiptPrefix, receiptNumberFor, GST_INVOICE_NUMBER_MAX, RECEIPT_COUNTER_DIGITS, RECEIPT_COUNTER_MAX, RECEIPT_PREFIX_MAX,
} from '../../../packages/contracts/src/receipt-number';

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
}

/** The pack's `receiptSeries` line for a till (edge/store-edge/src/receipt-numbers.ts `PackReceiptSeries`). */
export interface IssuedSeries {
  readonly laneId: string;
  readonly prefix: string;
  readonly padTo: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
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
  /** Append one issue, refused with `PrefixWriteRaced` when the guard moved. */
  readonly recordIssue: (tenantId: string, issue: ReceiptPrefixIssue, expectedVersion: number) => Promise<void>;
  /** The tills head office registered (device registry `pos_lane`, not retired): which store each is at. */
  readonly registeredTills?: (tenantId: string) => Promise<readonly { readonly storeId: string; readonly tillId: string; readonly label?: string }[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const TILL_ID = /^[A-Za-z0-9._-]{1,40}$/;
const RETRIES = 16;

/** The current prefix per (store, till), with its history. Pure. */
export function foldTillPrefixes(issues: readonly ReceiptPrefixIssue[]): readonly TillPrefix[] {
  const by = new Map<string, ReceiptPrefixIssue[]>();
  for (const i of issues) {
    const k = `${i.storeId}\u0000${i.tillId}`;
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  return [...by.values()].map((h) => {
    const cur = h.reduce((a, b) => (b.version >= a.version ? b : a));
    return {
      storeId: cur.storeId, tillId: cur.tillId, prefix: cur.prefix, version: cur.version, setBy: cur.setBy, setAt: cur.setAt,
      firstNumber: receiptNumberFor(cur.prefix, 1), lastNumber: receiptNumberFor(cur.prefix, RECEIPT_COUNTER_MAX), history: h,
    };
  }).sort((a, b) => (a.storeId === b.storeId ? (a.tillId < b.tillId ? -1 : 1) : a.storeId < b.storeId ? -1 : 1));
}

/** The store pack's `receiptSeries` for one store: each till's CURRENT prefix, 1…999 999, 6 digits. Pure. */
export function issuedSeriesFor(issues: readonly ReceiptPrefixIssue[], storeId: string): readonly IssuedSeries[] {
  return foldTillPrefixes(issues).filter((t) => t.storeId === storeId)
    .map((t) => ({ laneId: t.tillId, prefix: t.prefix, padTo: RECEIPT_COUNTER_DIGITS, rangeStart: 1, rangeEnd: RECEIPT_COUNTER_MAX }));
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
        if (!TILL_ID.test(tillId)) {
          throw apiError(400, { code: 'not_readable_as_a_till', whatHappened: `"${tillId}" is not a till name head office can keep (letters, digits, ".", "_" or "-", up to 40).`, wasItSaved: 'not_saved', nextSafeAction: 'Use the till\'s name as its store computer knows it (for example lane-1). Nothing was saved.' });
        }
        const read = readReceiptPrefix(b['prefix']);
        if (!read.ok) {
          throw apiError(400, { code: 'receipt_prefix_not_allowed', whatHappened: `${read.words}`, wasItSaved: 'not_saved', nextSafeAction: `Choose a prefix of ${RECEIPT_PREFIX_MAX} characters or fewer, for example S2L1-. Nothing was saved.` });
        }
        if (b['reason'] !== undefined && (typeof b['reason'] !== 'string' || b['reason'].length > 500)) {
          throw apiError(400, { code: 'receipt_prefix_not_allowed', whatHappened: 'The reason, when given, is text of up to 500 characters.', wasItSaved: 'not_saved', nextSafeAction: 'Send a short reason, or none. Nothing was saved.' });
        }
        const prefix = read.prefix;
        for (let attempt = 0; ; attempt += 1) {
          const guard = await deps.guardVersion(ctx.tenantId);
          const all = await deps.issues(ctx.tenantId);
          // Any OTHER till that ever held this prefix — its bills exist, so it is never issued again elsewhere.
          const holder = all.find((i) => i.prefix === prefix && !(i.storeId === storeId && i.tillId === tillId));
          if (holder !== undefined) {
            const holderName = stores.get(holder.storeId) ?? holder.storeId;
            throw apiError(409, {
              code: 'receipt_prefix_taken',
              whatHappened: `The prefix ${prefix} was issued to till ${holder.tillId} at ${holderName} (${holder.storeId}) on ${holder.setAt.slice(0, 10)}. Two tills must never share a prefix, or their bill numbers would clash.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Choose a prefix no other till has used, for example the store and till numbers (S2L1-). Nothing was saved.',
            });
          }
          const mine = all.filter((i) => i.storeId === storeId && i.tillId === tillId);
          const current = mine.reduce<ReceiptPrefixIssue | undefined>((a, x) => (a === undefined || x.version >= a.version ? x : a), undefined);
          if (current !== undefined && current.prefix === prefix) {
            return { status: 200, body: { prefix: foldTillPrefixes(mine)[0], unchanged: true } };
          }
          const issue: ReceiptPrefixIssue = {
            storeId, tillId, prefix, version: (current?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
            ...(typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? { reason: b['reason'].trim() } : {}),
          };
          try {
            await deps.recordIssue(ctx.tenantId, issue, guard);
          } catch (e) {
            if (e instanceof PrefixWriteRaced && attempt < RETRIES) continue;
            throw e;
          }
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'receipt.prefix.issue', objectType: 'till', objectId: `${storeId}/${tillId}`,
            at: issue.setAt, origin: { tenantId: ctx.tenantId, branchId: storeId },
            before: current === undefined ? null : { prefix: current.prefix, version: String(current.version) },
            after: { prefix, version: String(issue.version), ...(issue.reason === undefined ? {} : { reason: issue.reason }) },
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
              : 'No prefix issued yet. With one store the till keeps its store computer\'s own numbering (R-<till>-); issue one before a second store opens.',
          }));
        return {
          status: 200,
          body: {
            storesInBusiness: stores.size, multiStore, tills, needsPrefix,
            rule: { maxNumberLength: GST_INVOICE_NUMBER_MAX, counterDigits: RECEIPT_COUNTER_DIGITS, maxPrefixLength: RECEIPT_PREFIX_MAX, reservedStarts: ['R-', 'ZZ'] },
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
