import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog } from '../../edge/store-edge/src/file-log';
import {
  PeripheralReports, readScanTimings, scanSpeedOf, scanTimingsFile, SCAN_TO_LINE_TARGET_MS, MAX_SCAN_SAMPLES_PER_REPORT,
} from '../../edge/store-edge/src/peripheral-health';

/**
 * **M12-FR-01 · QG-05 (§32 "scan-to-line p95 ≤ 300 ms on certified pilot hardware — measured and shown"; "scan-performance
 * telemetry").** The store computer keeps EVERY timed scan a till sends (append-only, one file per day), answers the till
 * with its lane's figures for the day — p95 (nearest rank), median, slowest, over-target count — and reads today's file
 * back after a cold restart. No scan timed is "not measured yet", never 0 ms (P-08). Synthetic data only.
 */

describe('M12-FR-01 — the figures', () => {
  it('p95 by nearest rank, median, slowest, over the 300 ms target; none → undefined, never zero', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1 … 100 ms
    expect(scanSpeedOf(hundred)).toEqual({ p95Ms: 95, medianMs: 50, maxMs: 100, overTargetCount: 0 });
    expect(scanSpeedOf([400, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 310])).toEqual({ p95Ms: 310, medianMs: 110, maxMs: 400, overTargetCount: 2 });
    expect(scanSpeedOf([])).toBeUndefined();
    expect(SCAN_TO_LINE_TARGET_MS).toBe(300);
  });
  it('a report\'s timings: whole ms 0 … 60 000, at most 1 000; anything else cannot be read', () => {
    expect(readScanTimings({ devices: [] })).toBeUndefined();
    expect(readScanTimings({ scanTimings: [12.4, 0, 60_000], droppedScanTimings: 3 })).toEqual({ samples: [12, 0, 60_000], dropped: 3 });
    for (const bad of [{ scanTimings: 'fast' }, { scanTimings: [-1] }, { scanTimings: [60_001] }, { scanTimings: [Number.NaN] }, { scanTimings: ['5'] }, { scanTimings: Array(MAX_SCAN_SAMPLES_PER_REPORT + 1).fill(5) }]) {
      expect(readScanTimings(bad)).toBeNull();
    }
  });
});

describe('M12-FR-01 — the store computer keeps every scan time and answers the lane\'s figures', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

  it('timings alone or with devices; on the disk before the answer; per lane; read back cold; unreadable refused, nothing written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-scan-'));
    dirs.push(dir);
    const clock = { at: '2026-10-23T05:00:00.000Z' };
    let box = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_000_000, now: () => clock.at });
    expect(await box.scanSpeedToday()).toEqual([]);
    const first = await box.report({ laneId: 'lane-1', by: 'u-c', body: { scanTimings: [100, 120, 140] } });
    expect(first).toMatchObject({ recorded: true, report: null, written: true, scanSpeed: { laneId: 'lane-1', day: '2026-10-23', samples: 3, p95Ms: 140, medianMs: 120, maxMs: 140, overTargetCount: 0, withinTarget: true, droppedSamples: 0 } });
    // With a device report: both kept; another lane's figures are its own.
    const both = await box.report({ laneId: 'lane-1', by: 'u-c', body: { devices: [{ kind: 'scanner', state: 'ok' }], scanTimings: [450], droppedScanTimings: 2 } });
    expect(both).toMatchObject({ recorded: true, report: { laneId: 'lane-1', devices: [{ kind: 'scanner', state: 'ok' }] }, scanSpeed: { samples: 4, p95Ms: 450, overTargetCount: 1, withinTarget: false, droppedSamples: 2 } });
    await box.report({ laneId: 'lane-2', by: 'u-d', body: { scanTimings: [80] } });
    // An unreadable set: refused, in words; nothing written.
    const bad = await box.report({ laneId: 'lane-1', by: 'u-c', body: { scanTimings: [-5] } });
    expect(bad).toMatchObject({ recorded: false, refusedBecause: 'scan_timings_not_readable' });
    // An empty set: nothing written, the figures read.
    expect(await box.report({ laneId: 'lane-1', by: 'u-c', body: { scanTimings: [] } })).toMatchObject({ recorded: true, written: false, scanSpeed: { samples: 4 } });
    const records = (await readLog(join(dir, scanTimingsFile('2026-10-23')))).filter((v) => v.ok);
    expect(records.map((v) => (v.ok ? JSON.parse(v.record) : null))).toEqual([
      { laneId: 'lane-1', by: 'u-c', at: clock.at, ms: [100, 120, 140] },
      { laneId: 'lane-1', by: 'u-c', at: clock.at, ms: [450], dropped: 2 },
      { laneId: 'lane-2', by: 'u-d', at: clock.at, ms: [80] },
    ]);

    await box.close();
    box = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_000_000, now: () => clock.at }); // COLD
    expect((await box.scanSpeedToday()).map((s) => [s.laneId, s.samples, s.p95Ms])).toEqual([['lane-1', 4, 450], ['lane-2', 1, 80]]);

    // The next day (India time) starts its own file; yesterday's stays on the disk.
    clock.at = '2026-10-23T19:00:00.000Z'; // 00:30 IST, 24 October
    expect(await box.report({ laneId: 'lane-1', by: 'u-c', body: { scanTimings: [90] } })).toMatchObject({ scanSpeed: { day: '2026-10-24', samples: 1, p95Ms: 90 } });
    expect((await readdir(dir)).filter((f) => f.startsWith('scan-timings-')).sort()).toEqual([scanTimingsFile('2026-10-23'), scanTimingsFile('2026-10-24')]);
    await box.close();
  });
});
