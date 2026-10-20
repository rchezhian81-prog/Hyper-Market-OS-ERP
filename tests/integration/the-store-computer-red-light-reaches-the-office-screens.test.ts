import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import type { LaneSyncStatus } from '../../edge/store-edge/src/sync-status';
import { prepareTillBox } from '../support/till-operator';

/**
 * Audit row 6 on a REAL store edge: the store computer's own check (`store-computer status` writes the file named by
 * EDGE_STORE_COMPUTER_STATUS_FILE) rides along with the box's sync status, `GET /lane/sync-status` — the read the office
 * screens already make every ten seconds — so the red banner needs no internet and no new service. A box with no file
 * named reports nothing (it is not the shop's store computer); a file that is missing says the check has never run; the
 * box never writes the file; and the sale path never reads it (it is re-read on a timer, off the request).
 */

const KEY = ['red', 'light', 'signing', 'key'].join('-').padEnd(48, '0');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function lane(extra: Record<string, string> = {}): Promise<{ edge: EdgeProcess; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-red-light-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    ...await prepareTillBox({ dir, key: KEY }), ...extra,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, dir };
}
const statusOf = async (edge: EdgeProcess): Promise<LaneSyncStatus> => (await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json()) as LaneSyncStatus;

describe("the store computer's red light reaches the office screens through the box's sync status", () => {
  it('a red check is handed over word for word; a box with no file named says nothing about it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-red-status-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const file = join(dir, 'store-computer-status.json');
    await writeFile(file, JSON.stringify({
      kind: 'sre-store-computer-status', version: 1, checkedAt: new Date().toISOString(), staleAfterMinutes: 30, overall: 'red',
      alerts: [{ code: 'disk_full', en: "This computer's disk is 91% full (9.0 GB free). Free some space before it fills.", ta: 'இந்தக் கணினியின் வட்டு 91% நிரம்பியுள்ளது (9.0 GB காலி). நிரம்பும் முன் இடத்தைக் காலி செய்யுங்கள்.' }],
      checks: [],
    }));
    const { edge } = await lane({ EDGE_STORE_COMPUTER_STATUS_FILE: file });
    const s = await statusOf(edge);
    expect(s.storeComputer).toMatchObject({ known: true, stale: false, overall: 'red', alerts: [{ code: 'disk_full', en: expect.stringMatching(/91% full/), ta: expect.stringMatching(/91% நிரம்பியுள்ளது/) }] });
    const plain = await lane();
    expect((await statusOf(plain.edge)).storeComputer).toBeUndefined();
  });

  it('no file yet is RED ("the check has not run"), and the box never makes one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-red-none-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const file = join(dir, 'never-written.json');
    const { edge } = await lane({ EDGE_STORE_COMPUTER_STATUS_FILE: file });
    expect((await statusOf(edge)).storeComputer).toMatchObject({ known: false, overall: 'red', alerts: [{ code: 'check_never_ran' }] });
    await expect(unlink(file)).rejects.toThrow(/ENOENT/);
  });
});
