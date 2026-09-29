import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
// @ts-expect-error — plain .mjs script module.
import { parseEnv } from '../../scripts/standup-check.mjs';

/**
 * **The one-command till install writes settings that START A WORKING TILL (Stage D · KL-08 · H-11 · P-01).**
 *
 * The installer is run as a real command into a temporary folder, exactly as a technician runs it on the
 * shop PC (`--skip-build`: the bundles are the e2e suites' business; here the question is the settings and
 * the scripts). Then the edge is started FROM THE FILE IT WROTE — the same `startEdge` the start script
 * runs — and the served till page and the save socket answer on this machine's loopback. That is the
 * proof the install steps stand on: not that a file was written, but that the file starts a till.
 *
 * Also: the key is never printed; a second run keeps the settings file (and its key) unless forced; the
 * key is copied from the cloud's settings file when one is given, so the till trades on the cloud's packs.
 */

const SCRIPT = 'scripts/install-till.mjs';
const run = (args: readonly string[], cwd: string) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(process.cwd(), SCRIPT), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

describe('the installed till starts (Stage D, KL-08)', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sre-till-install-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('one command writes till.env, the data folder and the start scripts — and never prints the key', async () => {
    const r = run(['--dir', dir, '--tenant', 't-sre', '--generate-key', '--skip-build', '--from-compose-env', join(dir, 'no-such-env')], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Till installed.');
    expect(r.out).toContain('OFFLINE-ONLY');
    expect(r.out).toContain(`http://127.0.0.1:8091/pos/`);
    const env = parseEnv(await readFile(join(dir, 'till.env'), 'utf8')) as Record<string, string>;
    expect(env).toMatchObject({ EDGE_TENANT_ID: 't-sre', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '8091', EDGE_CAPACITY_BYTES: '10737418240', CLOUD_API_URL: '', CLOUD_API_TOKEN: '' });
    expect(env['PACK_SIGNING_KEY']!.length).toBeGreaterThanOrEqual(32);
    expect(r.out).not.toContain(env['PACK_SIGNING_KEY']);
    expect(env['EDGE_DATA_DIR']).toBe(join(dir, 'edge-data'));
    expect(env['EDGE_APPS_DIR']).toBe(join(process.cwd(), 'apps'));
    expect((await stat(join(dir, 'edge-data'))).isDirectory()).toBe(true);
    expect((await stat(join(dir, 'start-till.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(dir, 'till.env'))).mode & 0o077).toBe(0); // private to the owner
    expect(await readFile(join(dir, 'start-till.cmd'), 'utf8')).toContain('till.env');
    expect(await readFile(join(dir, 'sre-till.service'), 'utf8')).toContain('EnvironmentFile=');
  });

  it('the settings it wrote START the edge: the till page is served and the save socket answers on loopback', async () => {
    const env = parseEnv(await readFile(join(dir, 'till.env'), 'utf8')) as Record<string, string>;
    // Ports 0 here so the test never clashes with a real till on this machine; everything else is the file's.
    const edge = (await startEdge({ ...env, EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0' }, () => {}))!;
    try {
      expect(edge.lane).not.toBeNull();
      expect(edge.screens).not.toBeNull();
      const page = await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('pos.bundle.js');
      const socket = await fetch(`http://127.0.0.1:${edge.lane!.port}/`);
      expect(socket.status).toBe(404);
      expect(((await socket.json()) as { error: string }).error).toContain('the lane socket serves');
    } finally {
      await edge.stop();
    }
  });

  it('a second run keeps the settings file and its key unless forced; the key is copied from the cloud settings when given', async () => {
    const before = await readFile(join(dir, 'till.env'), 'utf8');
    const again = run(['--dir', dir, '--skip-build', '--from-compose-env', join(dir, 'no-such-env')], dir);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already exists');
    expect(await readFile(join(dir, 'till.env'), 'utf8')).toBe(before);

    const cloudDir = await mkdtemp(join(tmpdir(), 'sre-till-cloud-'));
    try {
      const cloudKey = 'c'.repeat(48);
      await writeFile(join(cloudDir, 'compose.env'), `EDGE_TENANT_ID=t-cloud\nPACK_SIGNING_KEY=${cloudKey}\nCLOUD_API_URL=http://127.0.0.1:8081\nCLOUD_API_TOKEN=${'t'.repeat(40)}\n`);
      const r = run(['--dir', join(cloudDir, 'till'), '--skip-build', '--from-compose-env', join(cloudDir, 'compose.env')], cloudDir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('copied the pack signing key');
      const env = parseEnv(await readFile(join(cloudDir, 'till', 'till.env'), 'utf8')) as Record<string, string>;
      expect(env).toMatchObject({ EDGE_TENANT_ID: 't-cloud', PACK_SIGNING_KEY: cloudKey, CLOUD_API_URL: 'http://127.0.0.1:8081', CLOUD_API_TOKEN: '' }); // the token never travels
      expect(r.out).not.toContain(cloudKey);
    } finally {
      await rm(cloudDir, { recursive: true, force: true });
    }
  });

  it('refuses to install with nothing to sign packs with, naming the fix — and exits 78 like the edge itself', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'sre-till-bare-'));
    try {
      const r = run(['--dir', bare, '--tenant', 't-sre', '--skip-build', '--from-compose-env', join(bare, 'none')], bare);
      expect(r.code).toBe(78);
      expect(r.out).toContain('no pack signing key');
      expect(r.out).toContain('--generate-key');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
