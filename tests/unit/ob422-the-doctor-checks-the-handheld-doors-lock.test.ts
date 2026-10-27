import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doctorRows } from '../../scripts/lib/store-computer.mjs';
import { ensureDeviceTls } from '../../edge/store-edge/src/device-tls';
import { world, type World } from '../support/store-computer-world';

/**
 * **OB-422 — the store computer's doctor checks the handheld door's lock (read-only).** When this computer's till opens
 * the handheld door, the lock must be there, beside (never inside) the till's data, private, and its certificate not near
 * its end — the till renews it while it runs, so one near its end means the till has not been running. The doctor reads
 * public certificates only, and says what to do in plain words.
 */

const DAY = 86_400_000;
const doorRow = (w: World) => doctorRows(w.deps).find((r: { name: string }) => r.name === 'Handheld door') as { status: string; detail: string; fix?: string } | undefined;

function tillWith(w: World, lines: string): { till: string; lock: string } {
  const till = join(w.data, 'till'); // a copy not set up yet uses the data folder's layout
  mkdirSync(join(till, 'edge-data'), { recursive: true });
  writeFileSync(join(till, 'till.env'), `EDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_LANE_PORT=8090\n${lines}`);
  return { till, lock: `${join(till, 'edge-data')}-device-tls` };
}

describe('the doctor and the handheld door\'s lock (OB-422)', () => {
  it('no handheld door on this computer: no row', () => {
    const w = world();
    tillWith(w, '');
    expect(doorRow(w)).toBeUndefined();
  });

  it('a door with no lock yet: FIX — start the till once; a made lock: OK, with the fingerprint and the date', () => {
    const w = world();
    const { lock } = tillWith(w, 'EDGE_DEVICE_PORT=8092\nEDGE_DEVICE_HOST=192.168.10.5\n');
    expect(doorRow(w)).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/the lock is not made yet/), fix: expect.stringMatching(/Start the till once/) });
    const made = ensureDeviceTls({ dir: lock, addresses: ['127.0.0.1', '192.168.10.5'], now: w.deps.now() });
    expect(made.ok).toBe(true);
    const ok = doorRow(w)!;
    expect(ok.status).toBe('OK');
    expect(ok.detail).toMatch(/^locked \(https only\): authority [0-9A-F:]{23}…, the door's certificate runs to 2027-01-18T04:30:00\.000Z and is renewed by the till$/);
    expect(JSON.stringify(ok)).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it('a key other users can read, a certificate near its end, an authority ending within a year, a lock inside the data — each said', () => {
    const w = world();
    const { till, lock } = tillWith(w, 'EDGE_DEVICE_PORT=8092\n');
    // Made 85 days before the doctor's "now": the 90-day certificate has 5 days left — the till has not been running.
    ensureDeviceTls({ dir: lock, addresses: ['127.0.0.1'], now: new Date(w.deps.now().getTime() - 85 * DAY) });
    expect(doorRow(w)).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/so it has not been running/), fix: expect.stringMatching(/leave it running: it renews the certificate by itself/) });
    if (process.platform !== 'win32') {
      chmodSync(join(lock, 'authority-key.pem'), 0o644);
      expect(doorRow(w)).toMatchObject({ status: 'FIX', detail: 'authority-key.pem can be read by other users on this computer' });
      chmodSync(join(lock, 'authority-key.pem'), 0o600);
    }
    // An authority made 9.5 years ago (its door certificate renewed today): it ends within a year — NEEDS-YOU.
    rmSync(lock, { recursive: true, force: true });
    ensureDeviceTls({ dir: lock, addresses: ['127.0.0.1'], now: new Date(w.deps.now().getTime() - 9.5 * 365 * DAY) });
    ensureDeviceTls({ dir: lock, addresses: ['127.0.0.1'], now: w.deps.now() });
    expect(doorRow(w)).toMatchObject({ status: 'NEEDS-YOU', detail: expect.stringMatching(/signing authority ends/), fix: expect.stringMatching(/every handheld enrolled again/) });
    // A lock named INSIDE the till's data folder: a backup would carry the key off the computer.
    writeFileSync(join(till, 'till.env'), `EDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_DEVICE_PORT=8092\nEDGE_DEVICE_TLS_DIR=${join(till, 'edge-data', 'lock')}\n`);
    expect(doorRow(w)).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/inside the till's data folder, so a backup would carry its private key off this computer/) });
  });
});
