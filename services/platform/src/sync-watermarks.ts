// How fresh head office's picture of each store really is (EA-01 · M29-FR-01/03 · D13 · P-08 · §31).
//
// The audit found the owner's dashboard stamping every figure "as at" the moment it was READ — so a store that had been
// cut off since 08:00 showed its 08:00 takings at 16:00 as "live". Head office cannot tell freshness from the newest
// sale it holds: a store trading through a cloud cut has newer sales on its own disk that head office has never seen.
//
// Only the store computer knows how far its queues have reached, so after each sync pass it says so (POST below): per
// queue (sales, refunds, …) "everything committed before this instant has reached you", what still waits, and what
// head office refused. Head office keeps every report (append-only) and reads the latest per store. While a box is cut
// off it cannot report, so the report head office holds ages, and every figure built on it says lagging, then stale.
//
//   • Only the store's own computer reports for it: `store.computer.report` AND a `store_computer` role grant at that
//     store (round 6 · store-computer-identity.ts). A cashier or manager — who also read the store's setup — cannot.
//   • A box clock running ahead cannot buy freshness: a watermark later than head office's receipt is cut back to the
//     receipt time and the report says so.
//   • A branch head office knows that has never reported is shown — never reported, and stale — not left out.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { STORE_COMPUTER_REPORT, assertStoreComputerOf, type StoreComputerScopeOf } from './store-computer-identity';

/** The queues a store computer drains to head office. */
export const SYNC_DOMAINS = ['sales', 'refunds', 'completions', 'day_close', 'concession_tags', 'device_events', 'till_cash'] as const;
export type SyncDomain = typeof SYNC_DOMAINS[number];

export interface DomainWatermarkReport {
  readonly domain: SyncDomain;
  /** Everything the box committed before this instant has reached head office (null: the box has not passed yet). */
  readonly completeThrough: string | null;
  readonly unsent: number;
  readonly deadLettered: number;
}

/** One report, as head office keeps it. */
export interface SyncWatermarkRecord {
  readonly storeId: string;
  /** The box's clock at the report (cut back to `receivedAt` when it was ahead). */
  readonly observedAt: string;
  /** Head office's clock when the report arrived. */
  readonly receivedAt: string;
  readonly reportedBy: string;
  readonly domains: readonly DomainWatermarkReport[];
  /** True when the box's clock was ahead of head office's and a time was cut back. */
  readonly clockAheadCorrected: boolean;
}

export type Staleness = 'live' | 'lagging' | 'stale';

/** One branch × one queue, as the owner's sync page sees it. */
export interface BranchSyncFreshness {
  readonly branchId: string;
  readonly branchName: string;
  readonly domain: SyncDomain;
  readonly state: 'reported' | 'never_reported';
  /** The last complete sync of this queue at this branch — the figure's real "as at". Null: never known. */
  readonly lastCompleteSyncAt: string | null;
  /** When head office last heard from the box at all. */
  readonly lastReportAt: string | null;
  readonly unsent: number | null;
  readonly deadLettered: number | null;
  readonly staleness: Staleness;
  readonly ageMinutes: number | null;
  readonly detail: string;
}

/** Thresholds, in minutes. Default 5 / 60 (§32), the same as a figure's. */
export interface FreshnessThresholds {
  readonly laggingAfterMinutes: number;
  readonly staleAfterMinutes: number;
}
export const DEFAULT_THRESHOLDS: FreshnessThresholds = { laggingAfterMinutes: 5, staleAfterMinutes: 60 };

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);

/** Read a box's report; `problems` when it is not one. Times later than `receivedAt` are cut back to it. */
export function readWatermarkReport(body: unknown, receivedAt: string): { observedAt: string; domains: DomainWatermarkReport[]; clockAheadCorrected: boolean } | { problems: string[] } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!isIso(b['observedAt'])) problems.push('observedAt must be an ISO-8601 UTC time');
  const raw = b['domains'];
  if (!Array.isArray(raw) || raw.length === 0) problems.push('domains must be a non-empty list');
  const domains: DomainWatermarkReport[] = [];
  let corrected = false;
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    raw.forEach((d: unknown, i) => {
      const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
      const domain = o['domain'];
      if (typeof domain !== 'string' || !(SYNC_DOMAINS as readonly string[]).includes(domain)) { problems.push(`domains[${i}].domain must be one of ${SYNC_DOMAINS.join(', ')}`); return; }
      if (seen.has(domain)) { problems.push(`domain ${domain} is listed twice`); return; }
      seen.add(domain);
      const ct = o['completeThrough'];
      if (!(ct === null || isIso(ct))) { problems.push(`domains[${i}].completeThrough must be an ISO-8601 UTC time or null`); return; }
      if (!isNonNegInt(o['unsent']) || !isNonNegInt(o['deadLettered'])) { problems.push(`domains[${i}] needs whole-number unsent and deadLettered`); return; }
      let completeThrough = ct;
      if (completeThrough !== null && Date.parse(completeThrough) > Date.parse(receivedAt)) { completeThrough = receivedAt; corrected = true; }
      domains.push({ domain: domain as SyncDomain, completeThrough, unsent: o['unsent'], deadLettered: o['deadLettered'] });
    });
  }
  if (problems.length > 0) return { problems };
  const observedRaw = b['observedAt'] as string;
  const observedAt = earlier(observedRaw, receivedAt);
  if (observedAt !== observedRaw) corrected = true;
  return { observedAt, domains, clockAheadCorrected: corrected };
}

/** The latest report per store: the one the box made last (by its observed time, then by arrival). */
export function latestPerStore(records: readonly SyncWatermarkRecord[]): ReadonlyMap<string, SyncWatermarkRecord> {
  const out = new Map<string, SyncWatermarkRecord>();
  for (const r of records) {
    const cur = out.get(r.storeId);
    if (cur === undefined
      || Date.parse(r.observedAt) > Date.parse(cur.observedAt)
      || (r.observedAt === cur.observedAt && Date.parse(r.receivedAt) >= Date.parse(cur.receivedAt))) out.set(r.storeId, r);
  }
  return out;
}

/** Each store's latest report for one domain, in the shape the reporting adapters merge (EA-01). */
export function latestDomainReports(records: readonly SyncWatermarkRecord[], domain: SyncDomain): ReadonlyMap<string, { completeThrough: string | null; unsent: number; deadLettered: number; reportedAt: string }> {
  const out = new Map<string, { completeThrough: string | null; unsent: number; deadLettered: number; reportedAt: string }>();
  for (const [storeId, r] of latestPerStore(records)) {
    const d = r.domains.find((x) => x.domain === domain);
    if (d !== undefined) out.set(storeId, { completeThrough: d.completeThrough, unsent: d.unsent, deadLettered: d.deadLettered, reportedAt: r.receivedAt });
  }
  return out;
}

function judge(lastCompleteSyncAt: string | null, now: string, t: FreshnessThresholds): { staleness: Staleness; ageMinutes: number | null } {
  if (lastCompleteSyncAt === null) return { staleness: 'stale', ageMinutes: null };
  const ageMinutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(lastCompleteSyncAt)) / 60_000));
  return { staleness: ageMinutes > t.staleAfterMinutes ? 'stale' : ageMinutes > t.laggingAfterMinutes ? 'lagging' : 'live', ageMinutes };
}

/**
 * Every branch head office knows (and any that reported without being known) × every queue: its last complete sync,
 * judged against now. A branch that never reported is stale with no time — the honest answer, never a cheerful one.
 */
export function branchSyncFreshness(input: {
  readonly branches: ReadonlyMap<string, string>;
  readonly records: readonly SyncWatermarkRecord[];
  readonly now: string;
  readonly thresholds?: (branchId: string) => FreshnessThresholds;
  readonly domains?: readonly SyncDomain[];
}): readonly BranchSyncFreshness[] {
  const latest = latestPerStore(input.records);
  const ids = [...new Set([...input.branches.keys(), ...latest.keys()])].sort();
  const domains = input.domains ?? SYNC_DOMAINS;
  const rows: BranchSyncFreshness[] = [];
  for (const branchId of ids) {
    const branchName = input.branches.get(branchId) ?? branchId;
    const report = latest.get(branchId);
    const t = input.thresholds?.(branchId) ?? DEFAULT_THRESHOLDS;
    for (const domain of domains) {
      const d = report?.domains.find((x) => x.domain === domain);
      if (report === undefined || d === undefined) {
        rows.push({
          branchId, branchName, domain, state: 'never_reported', lastCompleteSyncAt: null,
          lastReportAt: report?.receivedAt ?? null, unsent: null, deadLettered: null, staleness: 'stale', ageMinutes: null,
          detail: `${branchName} (${domain}): the store computer has never reported how far this has synced, so nothing here can be called current.`,
        });
        continue;
      }
      const { staleness, ageMinutes } = judge(d.completeThrough, input.now, t);
      const since = d.completeThrough === null ? 'no complete sync yet' : `complete up to ${d.completeThrough}`;
      const refused = d.deadLettered > 0 ? ` ${d.deadLettered} item(s) head office refused are waiting for a person.` : '';
      rows.push({
        branchId, branchName, domain, state: 'reported', lastCompleteSyncAt: d.completeThrough, lastReportAt: report.receivedAt,
        unsent: d.unsent, deadLettered: d.deadLettered, staleness, ageMinutes,
        detail: staleness === 'live'
          ? `${branchName} (${domain}): ${since}.${refused}`
          : staleness === 'lagging'
            ? `${branchName} (${domain}): ${since} — ${ageMinutes ?? '?'} minutes behind, catching up.${refused}`
            : `${branchName} (${domain}): ${since} — stale${ageMinutes === null ? '' : `, ${Math.round(ageMinutes / 60)} hour(s) old`}. Do not decide on this branch's figures until its store computer syncs.${refused}`,
      });
    }
  }
  return rows;
}

export interface SyncWatermarkDeps {
  readonly now: () => string;
  /** The stores head office knows: id → name (its org register's branches). */
  readonly stores: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  readonly branchScopeOf: (tenantId: string, userId: string, permission: string) => Promise<readonly string[] | 'all' | undefined>;
  /** Round 6: where the caller is a store computer (its `store_computer` grants only) — the only identity that reports. */
  readonly storeComputerScopeOf?: StoreComputerScopeOf;
  readonly records: (tenantId: string) => Promise<readonly SyncWatermarkRecord[]>;
  readonly record: (tenantId: string, r: SyncWatermarkRecord) => Promise<void>;
  readonly thresholds?: (tenantId: string, branchId: string) => Promise<FreshnessThresholds>;
}

export function syncWatermarkRoutes(deps: SyncWatermarkDeps): readonly Route[] {
  return [
    {
      // The store computer says how far each queue has reached. Its own store only.
      api: 'API-01', method: 'POST', path: '/v1/stores/:storeId/sync-watermarks',
      permission: STORE_COMPUTER_REPORT, idempotent: true,
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        if (!(await deps.stores(ctx.tenantId)).has(storeId)) throw notFound(`store ${storeId}`);
        await assertStoreComputerOf(deps.storeComputerScopeOf, ctx, storeId, 'how far it has synced');
        const receivedAt = deps.now();
        const read = readWatermarkReport(ctx.body, receivedAt);
        if ('problems' in read) {
          throw apiError(400, { code: 'not_readable_as_sync_watermarks', whatHappened: `The report could not be read: ${read.problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send { observedAt, domains: [{ domain, completeThrough, unsent, deadLettered }] }.' });
        }
        const r: SyncWatermarkRecord = { storeId, observedAt: read.observedAt, receivedAt, reportedBy: ctx.userId, domains: read.domains, clockAheadCorrected: read.clockAheadCorrected };
        await deps.record(ctx.tenantId, r);
        return { status: 200, body: { recorded: r } };
      },
    },
    {
      // Per branch and queue: the last complete sync, and whether that makes the figures live, lagging or stale.
      api: 'API-10', method: 'GET', path: '/v1/sync/source-freshness',
      permission: 'reporting.dashboard.read',
      handler: async (ctx) => {
        const now = deps.now();
        const branches = await deps.stores(ctx.tenantId);
        const ths = new Map<string, FreshnessThresholds>();
        if (deps.thresholds !== undefined) for (const id of branches.keys()) ths.set(id, await deps.thresholds(ctx.tenantId, id));
        const sources = branchSyncFreshness({ branches, records: await deps.records(ctx.tenantId), now, thresholds: (id) => ths.get(id) ?? DEFAULT_THRESHOLDS });
        return { status: 200, body: { asAt: now, sources } };
      },
    },
  ];
}
