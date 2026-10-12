// Store computer and till health reach head office (M35-FR-03 · D04-FR-05 · OB-54 · P-08 · §31).
//
// Head office could judge the sync clock and the queues from the box's watermark reports, but three things only the box
// knows stayed `unknown` at head office: whether its disk still has room to record a sale, what the tills' own devices
// last said (scanner, printer, scale, drawer, card machine — D04-FR-05, kept on the box for the manager's Today screen),
// and how deep its own queue is right now. After each sync pass the box now says so (POST below), and head office's
// observed health judges them:
//   • disk — `down` when the box itself would refuse the next sale (its sales log, plus the reserve the box keeps, no
//     longer fits its capacity, or the filesystem has less free than that reserve). That is the box's own rule
//     (edge/store-edge/src/durability.ts `commitLocally`), not a new one; otherwise `ok`, with the free bytes and the
//     headroom shown (M35-FR-04 "capacity headroom is reported");
//   • till devices — `degraded` when any device failed or is not working properly, each named (a device failing never
//     stops a sale, so it is never `down`); `unknown` when no till has reported, never "all fine";
//   • the box's queue — judged on the shop's own queue and dead-letter thresholds (the same ones the cloud queue uses).
// A report older than the shop's sync-lag warning threshold (§32, 15 minutes by default — the alert rules' own setting)
// is STALE: the last values are shown, said to be stale and how old, and the component is `unknown` — never `ok` on old
// news (P-08). While a box is cut off it cannot report, so its report ages into stale by itself.
//
// Store-locked (OB-54): the report names no store; head office stamps the store the box's SIGNED credential names
// (`STORE_STAMP_FIELD`), and only that store's own computer may report it. A report that names another store is refused
// at the door and kept as a refusal. Append-only: every report is kept; the latest per store is read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { ComponentHealth, HealthStatus, HealthThresholds } from '../../../packages/ops/src/index';
import { STORE_COMPUTER_REPORT, assertStoreComputerOf, type StoreComputerScopeOf } from './store-computer-identity';

export const BOX_HEALTH_PATH = '/v1/store-computers/health-reports';

/** The till device kinds and states the box keeps (mirrors edge/store-edge/src/peripheral-health.ts). */
export const TILL_DEVICE_KINDS = ['scanner', 'printer', 'scale', 'cash_drawer', 'card_terminal'] as const;
export const TILL_DEVICE_STATES = ['ok', 'degraded', 'failed'] as const;

export interface BoxDisk {
  /** Free bytes on the filesystem that holds the box's data folder. */
  readonly freeBytes: number;
  readonly totalBytes: number;
  /** The sales log's size and the capacity the box was given for it, and the reserve below which it refuses a sale. */
  readonly salesLogUsedBytes: number;
  readonly salesLogCapacityBytes: number;
  readonly reserveBytes: number;
}

export interface TillDeviceReport {
  readonly laneId: string;
  readonly reportedAt: string;
  readonly devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[];
}

/** One report, as head office keeps it. */
export interface BoxHealthRecord {
  readonly storeId: string;
  /** The box's clock at the report (cut back to `receivedAt` when it was ahead). */
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly reportedBy: string;
  readonly disk: BoxDisk;
  readonly queue: { readonly unsent: number; readonly deadLettered: number };
  readonly tills: readonly TillDeviceReport[];
  readonly clockAheadCorrected: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);

/** Read a box's report (the store is the stamped one, read by the route). `problems` when it is not one. */
export function readBoxHealthReport(body: unknown, receivedAt: string):
  { observedAt: string; disk: BoxDisk; queue: { unsent: number; deadLettered: number }; tills: TillDeviceReport[]; clockAheadCorrected: boolean } | { problems: string[] } {
  const b = isObj(body) ? body : {};
  const problems: string[] = [];
  if (!isIso(b['observedAt'])) problems.push('observedAt must be an ISO-8601 UTC time');
  const d = isObj(b['disk']) ? b['disk'] : undefined;
  const diskKeys = ['freeBytes', 'totalBytes', 'salesLogUsedBytes', 'salesLogCapacityBytes', 'reserveBytes'] as const;
  if (d === undefined || !diskKeys.every((k) => isCount(d[k]))) problems.push(`disk needs whole-number ${diskKeys.join(', ')}`);
  else if ((d['freeBytes'] as number) > (d['totalBytes'] as number)) problems.push('disk.freeBytes cannot exceed disk.totalBytes');
  const q = isObj(b['queue']) ? b['queue'] : undefined;
  if (q === undefined || !isCount(q['unsent']) || !isCount(q['deadLettered'])) problems.push('queue needs whole-number unsent and deadLettered');
  const rawTills = b['tills'];
  const tills: TillDeviceReport[] = [];
  let corrected = false;
  if (!Array.isArray(rawTills) || rawTills.length > 50) problems.push('tills must be a list (at most 50) of { laneId, reportedAt, devices }');
  else {
    rawTills.forEach((t: unknown, i) => {
      if (!isObj(t) || typeof t['laneId'] !== 'string' || t['laneId'].trim() === '' || !isIso(t['reportedAt']) || !Array.isArray(t['devices']) || t['devices'].length === 0 || t['devices'].length > 20) {
        problems.push(`tills[${i}] needs laneId, reportedAt (ISO-8601 UTC) and 1–20 devices`); return;
      }
      const devices: { kind: string; state: string; detail?: string }[] = [];
      for (const x of t['devices'] as unknown[]) {
        if (!isObj(x) || !(TILL_DEVICE_KINDS as readonly string[]).includes(x['kind'] as string) || !(TILL_DEVICE_STATES as readonly string[]).includes(x['state'] as string)) {
          problems.push(`tills[${i}] names a device or state head office does not know (kinds: ${TILL_DEVICE_KINDS.join(', ')}; states: ${TILL_DEVICE_STATES.join(', ')})`); return;
        }
        const detail = typeof x['detail'] === 'string' && x['detail'].trim() !== '' ? x['detail'].trim().slice(0, 120) : undefined;
        devices.push({ kind: x['kind'] as string, state: x['state'] as string, ...(detail === undefined ? {} : { detail }) });
      }
      let reportedAt = t['reportedAt'] as string;
      if (Date.parse(reportedAt) > Date.parse(receivedAt)) { reportedAt = receivedAt; corrected = true; }
      tills.push({ laneId: (t['laneId'] as string).trim(), reportedAt, devices });
    });
  }
  if (problems.length > 0) return { problems };
  const observedRaw = b['observedAt'] as string;
  const observedAt = earlier(observedRaw, receivedAt);
  if (observedAt !== observedRaw) corrected = true;
  const disk = d!;
  return {
    observedAt,
    disk: {
      freeBytes: disk['freeBytes'] as number, totalBytes: disk['totalBytes'] as number, salesLogUsedBytes: disk['salesLogUsedBytes'] as number,
      salesLogCapacityBytes: disk['salesLogCapacityBytes'] as number, reserveBytes: disk['reserveBytes'] as number,
    },
    queue: { unsent: q!['unsent'] as number, deadLettered: q!['deadLettered'] as number },
    tills, clockAheadCorrected: corrected,
  };
}

/** The latest report per store (by the box's own time, then by arrival). */
export function latestBoxReports(records: readonly BoxHealthRecord[]): ReadonlyMap<string, BoxHealthRecord> {
  const out = new Map<string, BoxHealthRecord>();
  for (const r of records) {
    const cur = out.get(r.storeId);
    if (cur === undefined || Date.parse(r.observedAt) > Date.parse(cur.observedAt)
      || (r.observedAt === cur.observedAt && Date.parse(r.receivedAt) >= Date.parse(cur.receivedAt))) out.set(r.storeId, r);
  }
  return out;
}

/**
 * OB-78 "A" (owner, 12 Oct 2026, in writing, "Warn at hours of trading left") · M35-FR-03 · M35-FR-04 · P-08 — how many
 * TRADING hours a store computer's disk has left before it would refuse a sale, estimated from its own reports.
 *
 * THE METHOD (stated, so a person can check it by hand):
 *   1. Take this store's reports from the last 7 days up to the latest one, oldest first. If the sales log ever got
 *      SMALLER between two reports (a new log, a clean-up), only the reports after that are used — older growth says
 *      nothing about the log the box writes now.
 *   2. Between each pair of consecutive reports, if the sales log GREW, that gap counts as trading time: its growth and
 *      its minutes are added up. A gap in which the log did not grow (the shop shut, a quiet hour) is left out, so
 *      night-time does not dilute the rate — the estimate is in hours of TRADING, never clock hours.
 *   3. The growth rate is (bytes added) / (trading hours counted).
 *   4. The room left is the smaller of: the sales-log room above the box's reserve (capacity - log - reserve), and the
 *      disk's free space above that reserve (free - reserve) — the box's own refusal rule (`boxCanRecordSales`).
 *   5. Hours of trading left = room left / growth rate, rounded DOWN to one decimal place (never rounded up into comfort).
 *
 * TOO LITTLE HISTORY gives "not yet known", never a guess: fewer than 2 growing gaps, or less than 60 minutes of trading
 * counted, gives `known: false` with the reason; so does a log that has not grown at all in the window.
 */
export const DISK_ESTIMATE_LOOKBACK_HOURS = 7 * 24;
export const DISK_ESTIMATE_MIN_GROWING_GAPS = 2;
export const DISK_ESTIMATE_MIN_TRADING_MINUTES = 60;

export type TradingHoursEstimate =
  | { readonly known: true; readonly hoursLeft: number; readonly bytesPerTradingHour: number; readonly roomLeftBytes: number; readonly tradingMinutesCounted: number; readonly growingGaps: number; readonly from: string; readonly to: string }
  | { readonly known: false; readonly why: string; readonly tradingMinutesCounted: number; readonly growingGaps: number };

export function estimateTradingHoursLeft(storeRecords: readonly BoxHealthRecord[], latest: BoxHealthRecord): TradingHoursEstimate {
  const since = Date.parse(latest.observedAt) - DISK_ESTIMATE_LOOKBACK_HOURS * 3_600_000;
  const ordered = [...storeRecords]
    .filter((r) => r.storeId === latest.storeId && Date.parse(r.observedAt) >= since && Date.parse(r.observedAt) <= Date.parse(latest.observedAt))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  // Only the run since the log last got smaller (step 1).
  let start = 0;
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i]!.disk.salesLogUsedBytes < ordered[i - 1]!.disk.salesLogUsedBytes) start = i;
  const run = ordered.slice(start);
  let bytes = 0;
  let minutes = 0;
  let gaps = 0;
  for (let i = 1; i < run.length; i += 1) {
    const grew = run[i]!.disk.salesLogUsedBytes - run[i - 1]!.disk.salesLogUsedBytes;
    const gapMinutes = (Date.parse(run[i]!.observedAt) - Date.parse(run[i - 1]!.observedAt)) / 60_000;
    if (grew > 0 && gapMinutes > 0) { bytes += grew; minutes += gapMinutes; gaps += 1; }
  }
  const tradingMinutesCounted = Math.floor(minutes);
  if (gaps < DISK_ESTIMATE_MIN_GROWING_GAPS || minutes < DISK_ESTIMATE_MIN_TRADING_MINUTES) {
    return {
      known: false, tradingMinutesCounted, growingGaps: gaps,
      why: `hours of trading left: not yet known — the store computer's reports show the sales log growing over ${gaps} gap(s) and ${tradingMinutesCounted} minute(s) of trading; at least ${DISK_ESTIMATE_MIN_GROWING_GAPS} gaps and ${DISK_ESTIMATE_MIN_TRADING_MINUTES} minutes are needed before it can be estimated (never guessed)`,
    };
  }
  const bytesPerTradingHour = bytes / (minutes / 60);
  const d = latest.disk;
  const roomLeftBytes = Math.max(0, Math.min(d.salesLogCapacityBytes - d.salesLogUsedBytes - d.reserveBytes, d.freeBytes - d.reserveBytes));
  // room / (bytes / hours), in whole numbers first so a round answer stays round (9, never 8.9 by a floating hair).
  const hoursLeft = Math.floor((roomLeftBytes * minutes * 10) / (bytes * 60)) / 10;
  return { known: true, hoursLeft, bytesPerTradingHour: Math.round(bytesPerTradingHour), roomLeftBytes, tradingMinutesCounted, growingGaps: gaps, from: run[0]!.observedAt, to: latest.observedAt };
}

/** The owner's default early-warning line (OB-78): warn when fewer than this many hours of trading are left. */
export const DEFAULT_BOX_DISK_WARN_HOURS = 48;

/** One store computer as head office's health read shows it. */
export interface BoxHealthView {
  readonly storeId: string;
  readonly state: 'reported' | 'never_reported';
  readonly lastReportAt: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  /** The box would still record a sale on its last report (null: never reported). */
  readonly canRecordSales: boolean | null;
  readonly disk: BoxDisk | null;
  readonly queue: { readonly unsent: number; readonly deadLettered: number } | null;
  readonly tills: readonly TillDeviceReport[];
  /** OB-78: hours of trading the disk has left by the stated method — null when not yet known (or never reported). */
  readonly tradingHoursLeft: number | null;
  /** OB-78: how that was worked out, or why it is not yet known, in words. */
  readonly tradingHoursLeftSays: string | null;
}

const mb = (bytes: number): string => `${Math.floor(bytes / 1_048_576)} MB`;
const ago = (s: number): string => (s < 3_600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`);

/** The box's own rule (commitLocally): the next sale fits only when the log plus the reserve fits, and the disk has the reserve free. */
export const boxCanRecordSales = (d: BoxDisk): boolean =>
  d.salesLogUsedBytes + d.reserveBytes < d.salesLogCapacityBytes && d.freeBytes > d.reserveBytes;

/**
 * Judge every store computer's latest report against now. Stores head office knows that never reported are listed
 * (never_reported) with no component — their absence is named in `notObserved` by the caller, never read as healthy.
 */
export function judgeBoxes(input: {
  readonly records: readonly BoxHealthRecord[];
  readonly knownStores?: readonly string[];
  readonly at: string;
  readonly thresholds: HealthThresholds;
  /** OB-78: warn (`degraded`) when fewer than this many hours of trading are left — the owner's tenant setting (default 48). */
  readonly diskWarnHours?: number;
}): { readonly boxes: readonly BoxHealthView[]; readonly components: readonly ComponentHealth[]; readonly localStoreWritable: boolean | undefined } {
  const warnHours = input.diskWarnHours ?? DEFAULT_BOX_DISK_WARN_HOURS;
  const latest = latestBoxReports(input.records);
  const ids = [...new Set([...(input.knownStores ?? []), ...latest.keys()])].sort();
  const boxes: BoxHealthView[] = [];
  const components: ComponentHealth[] = [];
  let anyFreshCannot = false;
  let allFreshCan = latest.size > 0;
  for (const storeId of ids) {
    const r = latest.get(storeId);
    if (r === undefined) {
      allFreshCan = false;
      boxes.push({ storeId, state: 'never_reported', lastReportAt: null, ageSeconds: null, stale: true, canRecordSales: null, disk: null, queue: null, tills: [], tradingHoursLeft: null, tradingHoursLeftSays: null });
      continue;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(r.observedAt)) / 1000));
    const stale = ageSeconds >= input.thresholds.syncLagWarnSeconds;
    const can = boxCanRecordSales(r.disk);
    if (stale) allFreshCan = false; else if (!can) { anyFreshCannot = true; allFreshCan = false; }
    const estimate = estimateTradingHoursLeft(input.records, r);
    const estimateSays = estimate.known
      ? `about ${estimate.hoursLeft} hours of trading left before it would refuse a sale (the sales log grew ${mb(estimate.bytesPerTradingHour)} per trading hour over ${estimate.tradingMinutesCounted} minutes of trading in its reports since ${estimate.from}; ${mb(estimate.roomLeftBytes)} of room left above the reserve)`
      : estimate.why;
    const runningOut = can && estimate.known && estimate.hoursLeft < warnHours;
    boxes.push({ storeId, state: 'reported', lastReportAt: r.observedAt, ageSeconds, stale, canRecordSales: can, disk: r.disk, queue: r.queue, tills: r.tills, tradingHoursLeft: estimate.known ? estimate.hoursLeft : null, tradingHoursLeftSays: estimateSays });
    const staleNote = `STALE — store ${storeId}'s computer last reported ${ago(ageSeconds)} ago (${r.observedAt}); it has not been heard from since, so this is old news, not the state now`;
    const headroom = Math.max(0, r.disk.salesLogCapacityBytes - r.disk.salesLogUsedBytes - r.disk.reserveBytes);
    const diskEvidence = {
      freeBytes: r.disk.freeBytes, totalBytes: r.disk.totalBytes, salesLogHeadroomBytes: headroom, reportedAt: r.observedAt, ageSeconds,
      tradingHoursLeft: estimate.known ? estimate.hoursLeft : 'not yet known', warnBelowTradingHours: warnHours,
    };
    const diskSays = runningOut
      ? `store ${storeId}'s computer will run out of room for sales soon — ${estimateSays}, below the owner's warning line of ${warnHours} hours. Make room on it (or give it a bigger disk) before the tills have to refuse sales`
      : can
      ? `store ${storeId}'s computer can record sales: ${mb(r.disk.freeBytes)} free of ${mb(r.disk.totalBytes)}, ${mb(headroom)} of sales-log room left above the reserve; ${estimateSays}`
      : `store ${storeId}'s computer CANNOT record another sale — its disk is full (${mb(r.disk.freeBytes)} free; sales log ${mb(r.disk.salesLogUsedBytes)} of ${mb(r.disk.salesLogCapacityBytes)} with a ${mb(r.disk.reserveBytes)} reserve). Its tills refuse sales until room is made`;
    components.push({
      // OB-78: a fresh report whose hours of trading left are under the owner's line is `degraded` (the early warning); a
      // stale report stays `unknown` (old news never raises or clears the warning); a full disk is `down` as before.
      name: `box_disk:${storeId}`, status: stale ? 'unknown' : !can ? 'down' : runningOut ? 'degraded' : 'ok',
      detail: stale ? `${staleNote}. Then: ${diskSays}` : diskSays, evidence: diskEvidence,
    });

    const q = r.queue;
    const qStatus: HealthStatus = q.deadLettered >= input.thresholds.deadLetterCritical && q.deadLettered > 0 ? 'down'
      : q.unsent >= input.thresholds.queueDepthCritical ? 'down'
        : q.unsent >= input.thresholds.queueDepthWarn || q.deadLettered > 0 ? 'degraded' : 'ok';
    const qSays = q.unsent === 0 && q.deadLettered === 0 ? `store ${storeId}'s computer has sent everything`
      : `store ${storeId}'s computer holds ${q.unsent} item(s) still to send${q.deadLettered > 0 ? ` and ${q.deadLettered} item(s) head office refused, waiting for a person` : ''}`;
    components.push({
      name: `box_queue:${storeId}`, status: stale ? 'unknown' : qStatus,
      detail: stale ? `${staleNote}. Then: ${qSays}` : qSays,
      evidence: { unsent: q.unsent, deadLettered: q.deadLettered, reportedAt: r.observedAt, ageSeconds },
    });

    if (r.tills.length === 0) {
      components.push({ name: `till_devices:${storeId}`, status: 'unknown', detail: `no till at store ${storeId} has reported its scanner, printer, scale, drawer or card machine yet — not known, never "all fine"` });
    } else {
      const bad = r.tills.flatMap((t) => t.devices.filter((d) => d.state !== 'ok')
        .map((d) => `${t.laneId}: ${d.kind.replace('_', ' ')} ${d.state === 'failed' ? 'has failed' : 'is not working properly'}${d.detail === undefined ? '' : ` — ${d.detail}`}`));
      const oldest = r.tills.map((t) => t.reportedAt).sort()[0]!;
      const says = bad.length === 0 ? `every till device at store ${storeId} reported working (oldest till report ${oldest})` : `store ${storeId}: ${bad.join('; ')} — the till still sells; a person should fix it`;
      components.push({
        name: `till_devices:${storeId}`, status: stale ? 'unknown' : bad.length === 0 ? 'ok' : 'degraded',
        detail: stale ? `${staleNote}. Then: ${says}` : says,
        evidence: { notWorking: bad.length, tills: r.tills.length, oldestTillReportAt: oldest, ageSeconds },
      });
    }
  }
  return { boxes, components, localStoreWritable: anyFreshCannot ? false : allFreshCan ? true : undefined };
}

export interface BoxHealthDeps {
  readonly now: () => string;
  readonly storeComputerScopeOf?: StoreComputerScopeOf;
  readonly record: (tenantId: string, r: BoxHealthRecord) => Promise<void>;
}

export function boxHealthRoutes(deps: BoxHealthDeps): readonly Route[] {
  return [{
    // The store computer says how its disk, its queue and its tills' devices are. Its own store only (stamped, OB-54).
    api: 'API-11', method: 'POST', path: BOX_HEALTH_PATH,
    permission: STORE_COMPUTER_REPORT, idempotent: true,
    handler: async (ctx) => {
      const b = isObj(ctx.body) ? ctx.body : {};
      // Head office stamped the box credential's store here; a person's request carries none and is refused below.
      const storeId = typeof b['storeId'] === 'string' ? b['storeId'] : '';
      await assertStoreComputerOf(deps.storeComputerScopeOf, ctx, storeId, 'how its disk, queue and till devices are');
      const receivedAt = deps.now();
      const read = readBoxHealthReport(ctx.body, receivedAt);
      if ('problems' in read) {
        throw apiError(400, {
          code: 'not_readable_as_box_health',
          whatHappened: `The store computer's health report could not be read: ${read.problems.join('; ')}.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { observedAt, disk: { freeBytes, totalBytes, salesLogUsedBytes, salesLogCapacityBytes, reserveBytes }, queue: { unsent, deadLettered }, tills: [...] }. Nothing was recorded.',
        });
      }
      const r: BoxHealthRecord = { storeId, observedAt: read.observedAt, receivedAt, reportedBy: ctx.userId, disk: read.disk, queue: read.queue, tills: read.tills, clockAheadCorrected: read.clockAheadCorrected };
      await deps.record(ctx.tenantId, r);
      return { status: 200, body: { recorded: r, canRecordSales: boxCanRecordSales(r.disk) } };
    },
  }];
}
