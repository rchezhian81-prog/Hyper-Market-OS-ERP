import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { readdir } from 'node:fs/promises';
import { bootPos, SCAN_TIMES_SEND_EVERY } from '../../apps/pos/src/browser-entry';
import { readLog } from '../../edge/store-edge/src/file-log';
import { signInTill } from '../support/till-operator';
import { startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **M12-FR-01 · QG-05 — the till times every scan and the store computer keeps it: the p95 is measured on the real lane and
 * read back, with NO head office anywhere (P-01), across a cold restart of the store computer.**
 *
 *   the till notes each scan's time → every 25 it sends them to the box (after the scan, never on it) → the box keeps each
 *   one on its disk and answers the lane's figures; a sale commits as before → the box goes away: the timings WAIT on the
 *   till and the read says the box is out of reach (not a made-up figure) → the box restarts COLD → the waiting timings
 *   go, and the figures count every one from the disk.
 * Synthetic data only.
 */

const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

const CAT = {
  tenantId: 't-scan', version: 1, builtAt: new Date().toISOString(),
  products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' as const }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' as const }],
};
const settle = () => new Promise((r) => setTimeout(r, 50));
// One fixed port, so the till finds its box again after the restart (as a real till does).
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(typeof a === 'object' && a !== null ? a.port : 0)); }); });

describe('M12-FR-01 — the till times every scan and the box keeps it', () => {
  it('sent every 25 after the scan; kept on the box; p95 read back; waits when the box is away; counted after a cold restart', async () => {
    const box = await startBox({ tenantId: 't-scan', people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack: storePack('S1'), env: { EDGE_LANE_PORT: String(await freePort()) } });
    boxes.push(box);
    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: CAT });
    // Not signed in: nothing is read, said.
    expect(await till.scanSpeed()).toMatchObject({ known: false, why: expect.stringMatching(/Sign in/) });
    await signInTill(till, 'u-lanecash');
    expect(await till.scanSpeed()).toEqual({ known: false, why: 'No scan has been timed on this till today yet.', waiting: 0 });

    // 30 scans: 28 fast, 2 slow. The first 25 go by themselves.
    const times = [...Array.from({ length: 28 }, (_, i) => 40 + i), 350, 900];
    for (const ms of times.slice(0, SCAN_TIMES_SEND_EVERY)) { till.scanBarcode('8901234567890'); till.noteScanTime(ms); }
    await settle();
    const onDisk = async (): Promise<number[]> => {
      const files = (await readdir(box.dir)).filter((f) => f.startsWith('scan-timings-'));
      return (await Promise.all(files.map((f) => readLog(`${box.dir}/${f}`)))).flat().flatMap((v) => (v.ok ? (JSON.parse(v.record) as { ms: number[] }).ms : []));
    };
    expect(await onDisk()).toHaveLength(SCAN_TIMES_SEND_EVERY); // sent by themselves, after the 25th scan
    for (const ms of times.slice(SCAN_TIMES_SEND_EVERY)) till.noteScanTime(ms);
    const read = await till.scanSpeed();
    expect(read).toMatchObject({ known: true, samples: 30, maxMs: 900, overTargetCount: 2, targetMs: 300, waiting: 0 });
    const sorted = [...times].sort((a, b) => a - b);
    expect(read).toMatchObject({ p95Ms: sorted[Math.ceil(0.95 * 30) - 1], withinTarget: sorted[Math.ceil(0.95 * 30) - 1]! <= 300 });
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString()); // the sale is unaffected by the telemetry

    // The box goes away: the till keeps its timings and says so — never a made-up figure.
    await box.stop();
    for (const ms of [55, 65, 75]) till.noteScanTime(ms);
    expect(await till.scanSpeed()).toMatchObject({ known: false, why: expect.stringMatching(/cannot reach its store computer/), waiting: 3 });

    // ── the store computer restarts COLD: the waiting timings go, and every one is counted from the disk ───────────────
    await box.restartCold();
    expect(await till.scanSpeed()).toMatchObject({ known: true, samples: 33, waiting: 0 });
    expect((await onDisk()).sort((a, b) => a - b)).toEqual([...times, 55, 65, 75].sort((a, b) => a - b));
  }, 60_000);
});
