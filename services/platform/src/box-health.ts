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
}): { readonly boxes: readonly BoxHealthView[]; readonly components: readonly ComponentHealth[]; readonly localStoreWritable: boolean | undefined } {
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
      boxes.push({ storeId, state: 'never_reported', lastReportAt: null, ageSeconds: null, stale: true, canRecordSales: null, disk: null, queue: null, tills: [] });
      continue;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(r.observedAt)) / 1000));
    const stale = ageSeconds >= input.thresholds.syncLagWarnSeconds;
    const can = boxCanRecordSales(r.disk);
    if (stale) allFreshCan = false; else if (!can) { anyFreshCannot = true; allFreshCan = false; }
    boxes.push({ storeId, state: 'reported', lastReportAt: r.observedAt, ageSeconds, stale, canRecordSales: can, disk: r.disk, queue: r.queue, tills: r.tills });
    const staleNote = `STALE — store ${storeId}'s computer last reported ${ago(ageSeconds)} ago (${r.observedAt}); it has not been heard from since, so this is old news, not the state now`;
    const headroom = Math.max(0, r.disk.salesLogCapacityBytes - r.disk.salesLogUsedBytes - r.disk.reserveBytes);
    const diskEvidence = { freeBytes: r.disk.freeBytes, totalBytes: r.disk.totalBytes, salesLogHeadroomBytes: headroom, reportedAt: r.observedAt, ageSeconds };
    const diskSays = can
      ? `store ${storeId}'s computer can record sales: ${mb(r.disk.freeBytes)} free of ${mb(r.disk.totalBytes)}, ${mb(headroom)} of sales-log room left above the reserve`
      : `store ${storeId}'s computer CANNOT record another sale — its disk is full (${mb(r.disk.freeBytes)} free; sales log ${mb(r.disk.salesLogUsedBytes)} of ${mb(r.disk.salesLogCapacityBytes)} with a ${mb(r.disk.reserveBytes)} reserve). Its tills refuse sales until room is made`;
    components.push({
      name: `box_disk:${storeId}`, status: stale ? 'unknown' : can ? 'ok' : 'down',
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
      // Round 13 (verifier B5, probe P3 · P-08): each till is judged by ITS OWN report time, not the box's. The box relays
      // each till's LAST report; a till that stopped reporting (switched off, cable out) keeps its last "ok" on the box, so
      // a till report older than the threshold is STALE — that lane is old news, never "ok".
      const lanes = r.tills.map((t) => {
        const laneAge = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(t.reportedAt)) / 1000));
        const bad = t.devices.filter((d) => d.state !== 'ok')
          .map((d) => `${t.laneId}: ${d.kind.replace('_', ' ')} ${d.state === 'failed' ? 'has failed' : 'is not working properly'}${d.detail === undefined ? '' : ` — ${d.detail}`}`);
        return { laneId: t.laneId, reportedAt: t.reportedAt, ageSeconds: laneAge, stale: laneAge >= input.thresholds.syncLagWarnSeconds, bad };
      });
      const freshBad = lanes.filter((l) => !l.stale).flatMap((l) => l.bad);
      const staleLanes = lanes.filter((l) => l.stale);
      const oldest = r.tills.map((t) => t.reportedAt).sort()[0]!;
      const staleSays = staleLanes.length === 0 ? '' : `STALE — ${staleLanes.map((l) => `till ${l.laneId} last reported its devices ${ago(l.ageSeconds)} ago (${l.reportedAt})${l.bad.length === 0 ? '' : `, then saying ${l.bad.join('; ')}`}`).join('; ')}: not heard from since, so its devices are not known now`;
      const freshSays = freshBad.length > 0 ? `store ${storeId}: ${freshBad.join('; ')} — the till still sells; a person should fix it`
        : staleLanes.length === lanes.length ? '' : `every till device at store ${storeId} that reported recently said it was working`;
      const says = [freshSays, staleSays].filter((x) => x !== '').join('. ');
      // A fresh failure is known now (degraded); a stale lane with nothing failing fresh is unknown — never ok.
      const tillStatus: HealthStatus = freshBad.length > 0 ? 'degraded' : staleLanes.length > 0 ? 'unknown' : 'ok';
      components.push({
        name: `till_devices:${storeId}`, status: stale ? 'unknown' : tillStatus,
        detail: stale ? `${staleNote}. Then: ${says}` : says,
        evidence: {
          notWorking: freshBad.length, tills: r.tills.length, staleTills: staleLanes.length, oldestTillReportAt: oldest, ageSeconds,
          staleLanes: staleLanes.map((l) => `${l.laneId}@${l.reportedAt}`).join(','),
        },
      });
    }
  }
  return { boxes, components, localStoreWritable: anyFreshCannot ? false : allFreshCan ? true : undefined };
}

export interface BoxHealthDeps {
  readonly now: () => string;
  readonly storeComputerScopeOf?: StoreComputerScopeOf;
  /** Records the report; answers the record head office KEEPS (the first, when this is a re-send of the same report). */
  readonly record: (tenantId: string, r: BoxHealthRecord) => Promise<void | BoxHealthRecord>;
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
      // The reply is what head office KEPT (a re-send answers the first record, never an unsaved copy).
      const kept = (await deps.record(ctx.tenantId, r)) ?? r;
      return { status: 200, body: { recorded: kept, canRecordSales: boxCanRecordSales(kept.disk) } };
    },
  }];
}
