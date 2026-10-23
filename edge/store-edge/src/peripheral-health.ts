// TILL DEVICE HEALTH — what the till's own devices last said, kept on this store computer (D04-FR-05 "peripheral health" ·
// M12-FR-04 "lane health (peripherals, sync, offline state) shown" · P-03 · P-08).
//
// The scanner, the receipt printer, the scale, the cash drawer and the card machine are hardware: what talks to them is a
// device adapter on the till computer (external — a physical gate). Whatever that adapter is, it reports here through the
// till's own signed-in session: each device and whether it is ok, not working properly, or failed, with a word on why.
// The box keeps the reports on its disk (appended, never rewritten), so the manager's Today screen can say "lane-1:
// printer has failed — paper out" — and says "not reported" when no till has said anything, never "all fine".
//
// A device failing never stops a sale (hard rule #1): this is information for a person, not a gate.
//
// Round 15 (verifier LOW — the log grew without limit and was replayed whole at every start). Still append-only; nothing
// is ever deleted:
//   • `peripheral-health.log` keeps the history. A report is written when a till's devices CHANGE, or when that till's last
//     written report is UNCHANGED_CHECKPOINT_MS old (a "still the same" checkpoint). An unchanged re-send in between only
//     refreshes the in-memory latest — the 5-minute heartbeat no longer adds a record every time.
//   • `peripheral-health-latest-<n>.log` is a compact latest-per-till index, appended in step with the history. Each
//     generation opens with ONE snapshot record of every till's latest report; after INDEX_GENERATION_RECORDS records the
//     next generation is started (older generations stay on the disk). At start the box reads only the newest readable
//     generation — a bounded file — never the whole history. A box with no index yet folds the history once (the old
//     way), then starts generation 1.
//   • Round 16 (verifier LOW — the index still grew with every checkpoint): the index takes a record ONLY when a till's
//     devices MATERIALLY change (a device's state or its word on why). A "still the same" checkpoint goes to the history
//     alone. So the index — and therefore the number of generations — grows with real device changes, not with time: a
//     shop of healthy, quiet tills adds nothing to it, however long it runs. Generations are still never deleted. After a
//     restart a till's latest is its last CHANGE (its report time is that change's), until the till's next re-send (within
//     5 minutes) refreshes it; the history keeps every checkpoint.
//   • the device adapter's own last-observed time (`adapterObservedAt`), when the till sends it, is kept with the report,
//     so head office judges the lane's freshness by the adapter's clock (a hung adapter reads stale).
//
// M12-FR-01 (QG-05 · §32 "scan-to-line p95 ≤ 300 ms on certified pilot hardware — measured and shown"; "scan-performance
// telemetry"): the till times every scan from the scanner's last key to the line on its screen and sends the samples here
// with its device report — or on their own (`{ scanTimings: [ms, …] }`), fire-and-forget, never on the sale path. Every
// sample is kept on this box's disk (append-only, one file per calendar day: `scan-timings-<YYYY-MM-DD>.log`), and the
// box answers each till with ITS lane's figures for the day — how many scans, the p95, the median, the slowest, how many
// were over the 300 ms target. A day with no samples is "not measured yet", never a fake 0 ms (P-08). The box reads only
// today's file at start (bounded by a day); older days stay on the disk, never deleted.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import { makeTradingDayRule, tradingDateOf } from '../../../packages/calendar/src/index';

/** QG-05 · §32: the scan-to-line target. */
export const SCAN_TO_LINE_TARGET_MS = 300;
/** The most samples one report may carry (a till sends every 25 scans, or when asked). */
export const MAX_SCAN_SAMPLES_PER_REPORT = 1_000;
/** A sample above this is not a scan time (the till was asleep, a dialog was open): refused, said. */
export const MAX_SCAN_SAMPLE_MS = 60_000;
export const scanTimingsFile = (day: string): string => `scan-timings-${day}.log`;

/** One lane's scan-to-line figures for a day, from every sample on this box's disk. */
export interface ScanSpeed {
  readonly laneId: string;
  readonly day: string;
  readonly samples: number;
  readonly p95Ms: number;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly overTargetCount: number;
  readonly targetMs: number;
  /** Whether the day's p95 is within the target. */
  readonly withinTarget: boolean;
  /** Samples the till could not keep (its buffer was full while it could not reach this box) — said, never hidden. */
  readonly droppedSamples: number;
  readonly lastAt: string;
}

/**
 * The scan timings in a report body: undefined when none were sent, null when they cannot be read (not a list of whole
 * milliseconds 0 … 60 000, or too many), else the samples. `droppedSamples` is how many the till had to let go.
 */
export function readScanTimings(body: unknown): { readonly samples: readonly number[]; readonly dropped: number } | null | undefined {
  if (!isObj(body) || body['scanTimings'] === undefined) return undefined;
  const list = body['scanTimings'];
  if (!Array.isArray(list) || list.length > MAX_SCAN_SAMPLES_PER_REPORT) return null;
  if (!list.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SCAN_SAMPLE_MS)) return null;
  const d = body['droppedScanTimings'];
  const dropped = typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : 0;
  return { samples: (list as number[]).map((n) => Math.round(n)), dropped };
}

/** p95 (nearest rank), median and slowest of a set of samples; undefined for none — never a fake zero. */
export function scanSpeedOf(samples: readonly number[], targetMs: number = SCAN_TO_LINE_TARGET_MS): { readonly p95Ms: number; readonly medianMs: number; readonly maxMs: number; readonly overTargetCount: number } | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return { p95Ms: rank(0.95), medianMs: rank(0.5), maxMs: sorted[sorted.length - 1]!, overTargetCount: sorted.filter((n) => n > targetMs).length };
}

// The store's calendar day in India time (the shop is in Tamil Nadu), whatever zone this machine is set to.
const calendarDay = (iso: string): string => tradingDateOf(iso, makeTradingDayRule('00:00'), 'Asia/Kolkata');

export const PERIPHERAL_KINDS = ['scanner', 'printer', 'scale', 'cash_drawer', 'card_terminal'] as const;
export type PeripheralKindHere = (typeof PERIPHERAL_KINDS)[number];
export const PERIPHERAL_STATES = ['ok', 'degraded', 'failed'] as const;

export interface DeviceState {
  readonly kind: PeripheralKindHere;
  readonly state: (typeof PERIPHERAL_STATES)[number];
  readonly detail?: string;
}

export interface PeripheralReport {
  readonly laneId: string;
  readonly reportedBy: string;
  readonly reportedAt: string;
  readonly devices: readonly DeviceState[];
  /** When the till's device adapter says it last observed the devices (its own clock), when it said. */
  readonly adapterObservedAt?: string;
}

export type ReportAnswer =
  /**
   * `written`: false when the report only refreshed an unchanged till's latest (that state is already on the disk).
   * `report` is null when the till sent only scan timings (M12-FR-01) and no devices. `scanSpeed`: the lane's figures for
   * today after this report's samples — null when no scan has been timed today ("not measured yet").
   */
  | { readonly recorded: true; readonly report: PeripheralReport | null; readonly written?: boolean; readonly scanSpeed?: ScanSpeed | null }
  | { readonly recorded: false; readonly refusedBecause: string; readonly laneMessage: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a report body: a list of devices, each a known kind with a known state; detail is short plain text. */
export function readDevices(body: unknown): readonly DeviceState[] | null {
  const list = isObj(body) ? body['devices'] : undefined;
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) return null;
  const out: DeviceState[] = [];
  for (const d of list) {
    if (!isObj(d) || !PERIPHERAL_KINDS.includes(d['kind'] as PeripheralKindHere) || !PERIPHERAL_STATES.includes(d['state'] as DeviceState['state'])) return null;
    const detail = typeof d['detail'] === 'string' && d['detail'].trim() !== '' ? d['detail'].trim().slice(0, 120) : undefined;
    out.push({ kind: d['kind'] as PeripheralKindHere, state: d['state'] as DeviceState['state'], ...(detail === undefined ? {} : { detail }) });
  }
  return out;
}

/** A history record is written on a change, or when a till's last written report is this old ("still the same"). */
export const UNCHANGED_CHECKPOINT_MS = 15 * 60_000;
/** Records per index generation before the next one (opening with a fresh snapshot) is started. */
export const INDEX_GENERATION_RECORDS = 500;
const HISTORY_FILE = 'peripheral-health.log';
export const peripheralIndexFile = (n: number): string => `peripheral-health-latest-${n}.log`;
const INDEX_PATTERN = /^peripheral-health-latest-(\d+)\.log$/;

const stateKey = (devices: readonly DeviceState[]): string => JSON.stringify(devices.map((d) => [d.kind, d.state, d.detail ?? '']));
const asReport = (v: unknown): PeripheralReport | undefined =>
  (isObj(v) && typeof v['laneId'] === 'string' && Array.isArray(v['devices']) ? v as unknown as PeripheralReport : undefined);

export class PeripheralReports {
  private readonly latestByLane = new Map<string, PeripheralReport>();
  /** When each till's report was last WRITTEN (its checkpoint clock). */
  private readonly writtenAt = new Map<string, number>();
  /** M12-FR-01: today's scan samples per lane (from today's file at start), and the open file for that day. */
  private scanDay: { day: string; log: OpenFileLog; byLane: Map<string, { samples: number[]; dropped: number; lastAt: string }> } | undefined;
  readonly unreadableRecords: number;
  /** Where the box started from: the index generation (0 = none), and how many history / index records it read. */
  readonly startedFrom: { readonly generation: number; readonly historyRecordsRead: number; readonly indexRecordsRead: number };

  private constructor(
    private readonly history: OpenFileLog, private index: OpenFileLog, private generation: number, private indexRecords: number,
    private readonly dataDir: string, private readonly capacityBytes: number, private readonly now: () => string,
    restored: ReadonlyMap<string, PeripheralReport>, unreadable: number, startedFrom: PeripheralReports['startedFrom'],
  ) {
    this.unreadableRecords = unreadable;
    this.startedFrom = startedFrom;
    for (const [lane, r] of restored) { this.latestByLane.set(lane, r); this.writtenAt.set(lane, Date.parse(r.reportedAt)); }
  }

  static async open(input: { readonly dataDir: string; readonly capacityBytes: number; readonly now?: () => string }): Promise<PeripheralReports> {
    const history = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: HISTORY_FILE });
    const generations = (await readdir(input.dataDir)).flatMap((f) => { const m = INDEX_PATTERN.exec(f); return m === null ? [] : [Number(m[1])]; }).sort((a, b) => b - a);
    let restored: Map<string, PeripheralReport> | undefined;
    let unreadable = 0;
    let from: number | undefined;
    let records = 0;
    const fold = (into: Map<string, PeripheralReport>, record: string): void => {
      try { const r = asReport(JSON.parse(record)); if (r === undefined) unreadable += 1; else into.set(r.laneId, r); } catch { unreadable += 1; }
    };
    // The newest generation whose opening snapshot reads. A newer one that does not (a crash while it was being started)
    // is passed over — and kept on the disk, never removed.
    for (const n of generations) {
      const verdicts = await readLog(join(input.dataDir, peripheralIndexFile(n)));
      const first = verdicts[0];
      let snapshot: unknown;
      try { snapshot = first !== undefined && first.ok ? (JSON.parse(first.record) as { snapshot?: unknown }).snapshot : undefined; } catch { snapshot = undefined; }
      if (!Array.isArray(snapshot)) { if (verdicts.length > 0) unreadable += 1; continue; }
      restored = new Map();
      for (const r of snapshot) { const ok = asReport(r); if (ok !== undefined) restored.set(ok.laneId, ok); }
      for (const v of verdicts.slice(1)) { if (v.ok) fold(restored, v.record); else unreadable += 1; }
      from = n; records = verdicts.length;
      break;
    }
    let historyRead = 0;
    if (restored === undefined) {
      // No readable index (a box from before round 15): fold the history ONCE, the old way, and start an index from it.
      restored = new Map();
      for (const v of await readLog(history.path)) {
        historyRead += 1;
        if (v.ok) fold(restored, v.record); else unreadable += 1;
      }
    }
    const startedFrom = { generation: from ?? 0, historyRecordsRead: historyRead, indexRecordsRead: from === undefined ? 0 : records };
    // Continue the generation read when it is the newest; otherwise start the next one, opening with a snapshot.
    const continueFrom = from !== undefined && from === generations[0];
    const generation = continueFrom ? from! : (generations[0] ?? 0) + 1;
    const index = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: peripheralIndexFile(generation) });
    if (!continueFrom) {
      await index.append(JSON.stringify({ snapshot: [...restored.values()] }));
      records = 1;
    }
    return new PeripheralReports(history, index, generation, records, input.dataDir, input.capacityBytes, input.now ?? (() => new Date().toISOString()), restored, unreadable, startedFrom);
  }

  /** Record what the till's devices say now — a change (or a due checkpoint) is on the disk before it is answered. */
  async report(input: { readonly laneId: string; readonly by: string; readonly body: unknown }): Promise<ReportAnswer> {
    // M12-FR-01: the till's scan timings, on the disk before the answer — with or without a device report.
    const timings = readScanTimings(input.body);
    if (timings === null) {
      return { recorded: false, refusedBecause: 'scan_timings_not_readable', laneMessage: `The till's scan timings were not a list of up to ${MAX_SCAN_SAMPLES_PER_REPORT} times in milliseconds (0 to ${MAX_SCAN_SAMPLE_MS}). Nothing was recorded.` };
    }
    const sentDevices = isObj(input.body) && input.body['devices'] !== undefined;
    if (timings !== undefined && !sentDevices) {
      return { recorded: true, report: null, written: timings.samples.length > 0 || timings.dropped > 0, scanSpeed: await this.recordScanTimings(input.laneId, input.by, timings) };
    }
    const devices = readDevices(input.body);
    if (devices === null) {
      return { recorded: false, refusedBecause: 'devices_not_readable', laneMessage: 'The till did not say which devices and how each one is (ok, not working properly, or failed). Nothing was recorded.' };
    }
    const scanSpeed = timings === undefined ? undefined : await this.recordScanTimings(input.laneId, input.by, timings);
    const answer = await this.reportDevices(input, devices);
    return scanSpeed === undefined || !answer.recorded ? answer : { ...answer, scanSpeed };
  }

  private async reportDevices(input: { readonly laneId: string; readonly by: string; readonly body: unknown }, devices: readonly DeviceState[]): Promise<ReportAnswer> {
    const said = isObj(input.body) ? input.body['adapterObservedAt'] : undefined;
    const adapterObservedAt = typeof said === 'string' && !Number.isNaN(Date.parse(said)) ? new Date(Date.parse(said)).toISOString() : undefined;
    const report: PeripheralReport = { laneId: input.laneId, reportedBy: input.by, reportedAt: this.now(), devices, ...(adapterObservedAt === undefined ? {} : { adapterObservedAt }) };
    const before = this.latestByLane.get(report.laneId);
    const changed = before === undefined || stateKey(before.devices) !== stateKey(devices);
    const lastWritten = this.writtenAt.get(report.laneId);
    const due = lastWritten === undefined || Number.isNaN(lastWritten) || Date.parse(report.reportedAt) - lastWritten >= UNCHANGED_CHECKPOINT_MS;
    if (!changed && !due) {
      this.latestByLane.set(report.laneId, report);
      return { recorded: true, report, written: false };
    }
    const line = JSON.stringify(report);
    await this.history.append(line);
    this.writtenAt.set(report.laneId, Date.parse(report.reportedAt));
    this.latestByLane.set(report.laneId, report);
    if (changed) {
      // Only a material change reaches the index (round 16): a checkpoint is history-only.
      await this.index.append(line);
      this.indexRecords += 1;
      if (this.indexRecords >= INDEX_GENERATION_RECORDS) await this.nextGeneration();
    }
    return { recorded: true, report, written: true };
  }

  /** Start the next index generation with one snapshot of every till's latest; the older generation stays on the disk. */
  private async nextGeneration(): Promise<void> {
    const next = await openFileLog({ dataDir: this.dataDir, capacityBytes: this.capacityBytes, fileName: peripheralIndexFile(this.generation + 1) });
    await next.append(JSON.stringify({ snapshot: [...this.latestByLane.values()] }));
    const old = this.index;
    this.index = next; this.generation += 1; this.indexRecords = 1;
    await old.close();
  }

  /** M12-FR-01: today's open scan-timings file and samples — today's file read back after a restart. */
  private async scanDayFor(day: string): Promise<NonNullable<PeripheralReports['scanDay']>> {
    if (this.scanDay?.day === day) return this.scanDay;
    const byLane = new Map<string, { samples: number[]; dropped: number; lastAt: string }>();
    const log = await openFileLog({ dataDir: this.dataDir, capacityBytes: this.capacityBytes, fileName: scanTimingsFile(day) });
    for (const v of await readLog(log.path)) {
      if (!v.ok) continue;
      try {
        const r = JSON.parse(v.record) as { laneId?: unknown; at?: unknown; ms?: unknown; dropped?: unknown };
        if (typeof r.laneId !== 'string' || typeof r.at !== 'string' || !Array.isArray(r.ms)) continue;
        const lane = byLane.get(r.laneId) ?? { samples: [], dropped: 0, lastAt: r.at };
        lane.samples.push(...r.ms.filter((n): n is number => typeof n === 'number'));
        lane.dropped += typeof r.dropped === 'number' ? r.dropped : 0;
        lane.lastAt = r.at;
        byLane.set(r.laneId, lane);
      } catch { /* an unreadable line is skipped; it stays on the disk */ }
    }
    const old = this.scanDay;
    this.scanDay = { day, log, byLane };
    if (old !== undefined) await old.log.close();
    return this.scanDay;
  }

  private async recordScanTimings(laneId: string, by: string, timings: { readonly samples: readonly number[]; readonly dropped: number }): Promise<ScanSpeed | null> {
    const at = this.now();
    const day = await this.scanDayFor(calendarDay(at));
    if (timings.samples.length > 0 || timings.dropped > 0) {
      await day.log.append(JSON.stringify({ laneId, by, at, ms: timings.samples, ...(timings.dropped > 0 ? { dropped: timings.dropped } : {}) }));
      const lane = day.byLane.get(laneId) ?? { samples: [], dropped: 0, lastAt: at };
      lane.samples.push(...timings.samples);
      lane.dropped += timings.dropped;
      lane.lastAt = at;
      day.byLane.set(laneId, lane);
    }
    return this.scanSpeedFor(laneId, day.day) ?? null;
  }

  /** M12-FR-01: one lane's scan-to-line figures for today (by this box's clock) — undefined when none was timed. */
  scanSpeedFor(laneId: string, day: string = calendarDay(this.now())): ScanSpeed | undefined {
    if (this.scanDay?.day !== day) return undefined;
    const lane = this.scanDay.byLane.get(laneId);
    const s = lane === undefined ? undefined : scanSpeedOf(lane.samples);
    if (lane === undefined || s === undefined) return undefined;
    return { laneId, day, samples: lane.samples.length, ...s, targetMs: SCAN_TO_LINE_TARGET_MS, withinTarget: s.p95Ms <= SCAN_TO_LINE_TARGET_MS, droppedSamples: lane.dropped, lastAt: lane.lastAt };
  }

  /** M12-FR-01: every lane's scan-to-line figures for today, in lane order (for the manager's screen). */
  async scanSpeedToday(): Promise<readonly ScanSpeed[]> {
    const day = await this.scanDayFor(calendarDay(this.now()));
    return [...day.byLane.keys()].sort().flatMap((l) => { const s = this.scanSpeedFor(l, day.day); return s === undefined ? [] : [s]; });
  }

  /** The latest report from each till, in lane order. */
  latest(): readonly PeripheralReport[] {
    return [...this.latestByLane.values()].sort((a, b) => a.laneId.localeCompare(b.laneId));
  }

  async close(): Promise<void> {
    await this.history.close();
    await this.index.close();
    if (this.scanDay !== undefined) await this.scanDay.log.close();
  }
}
