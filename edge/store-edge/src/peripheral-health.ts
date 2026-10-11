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

import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';

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
}

export type ReportAnswer =
  | { readonly recorded: true; readonly report: PeripheralReport }
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

export class PeripheralReports {
  private readonly latestByLane = new Map<string, PeripheralReport>();
  readonly unreadableRecords: number;

  private constructor(private readonly log: OpenFileLog, private readonly now: () => string, restored: readonly PeripheralReport[], unreadable: number) {
    this.unreadableRecords = unreadable;
    for (const r of restored) this.latestByLane.set(r.laneId, r);
  }

  static async open(input: { readonly dataDir: string; readonly capacityBytes: number; readonly now?: () => string }): Promise<PeripheralReports> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'peripheral-health.log' });
    const restored: PeripheralReport[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as PeripheralReport;
        if (typeof r.laneId === 'string' && Array.isArray(r.devices)) restored.push(r); else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new PeripheralReports(log, input.now ?? (() => new Date().toISOString()), restored, unreadable);
  }

  /** Record what the till's devices say now — on the disk before it is answered. */
  async report(input: { readonly laneId: string; readonly by: string; readonly body: unknown }): Promise<ReportAnswer> {
    const devices = readDevices(input.body);
    if (devices === null) {
      return { recorded: false, refusedBecause: 'devices_not_readable', laneMessage: 'The till did not say which devices and how each one is (ok, not working properly, or failed). Nothing was recorded.' };
    }
    const report: PeripheralReport = { laneId: input.laneId, reportedBy: input.by, reportedAt: this.now(), devices };
    await this.log.append(JSON.stringify(report));
    this.latestByLane.set(report.laneId, report);
    return { recorded: true, report };
  }

  /** The latest report from each till, in lane order. */
  latest(): readonly PeripheralReport[] {
    return [...this.latestByLane.values()].sort((a, b) => a.laneId.localeCompare(b.laneId));
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
