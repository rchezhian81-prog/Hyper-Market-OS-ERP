import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { DEVICE_TLS_FILES } from '../../edge/store-edge/src/device-tls';
import { runDeviceAuthorityCommand, deviceTlsDirOf } from '../../edge/store-edge/src/device-authority-command';
import { isPermittedAddress } from '../../edge/store-edge/src/device-certificates';
// @ts-expect-error — plain .mjs script module.
import { parseEnv } from '../../scripts/standup-check.mjs';
// @ts-expect-error — plain .mjs script module.
import { isShopAddress, makeDeviceLock, parseArgs, tillEnvChangesFor, updateTillEnv } from '../../scripts/install-till.mjs';

/**
 * **OB-422 — "the store computer creates its own certificate (and a local signing authority) at install".**
 *
 * The till installer is run as a real command (`--device-port 8092 --device-host 192.168.10.5`) after the edge is built;
 * it writes the door's settings and runs the built edge's `device-authority` command, which makes the authority and the
 * door's certificate in the lock folder beside the data folder. The installer prints the fingerprint a person compares
 * at enrolment — never a key. The edge then STARTS from the file it wrote and uses that same authority (no new one).
 * A public address is refused before anything is written.
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

describe('OB-422: the installer makes the store computer\'s lock', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sre-ob422-install-'));
    execFileSync(process.execPath, ['scripts/build-service.mjs', 'edge', '--quiet'], { stdio: 'ignore' });
  }, 120_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('one command with a door: the settings name it, the authority and certificate are made, the fingerprint is said, no key is', async () => {
    const r = run(['--dir', dir, '--tenant', 't-sre', '--lane', 'lane-1', '--generate-key', '--skip-build', '--device-port', '8092', '--device-host', '192.168.10.5', '--from-compose-env', join(dir, 'no-such-env')], dir);
    expect(r.code, r.out).toBe(0);
    const env = parseEnv(await readFile(join(dir, 'till.env'), 'utf8')) as Record<string, string>;
    expect(env).toMatchObject({ EDGE_DEVICE_PORT: '8092', EDGE_DEVICE_HOST: '192.168.10.5', EDGE_DEVICE_TLS_DIR: `${join(dir, 'edge-data')}-device-tls` });
    const lock = env['EDGE_DEVICE_TLS_DIR']!;
    expect((await readdir(lock)).sort()).toEqual(Object.values(DEVICE_TLS_FILES).sort());
    expect(r.out).toMatch(/made its own signing authority \(fingerprint [0-9A-F:]{95}/);
    expect(r.out).toMatch(/certificate made for 127\.0\.0\.1, 192\.168\.10\.5/);
    expect(r.out).toContain(`The authority each handheld trusts (public — safe to copy): ${join(lock, DEVICE_TLS_FILES.authorityCert)}`);
    expect(r.out).not.toMatch(/PRIVATE KEY|BEGIN/);
    const keyLine = (await readFile(join(lock, DEVICE_TLS_FILES.authorityKey), 'utf8')).split('\n')[1]!;
    expect(r.out).not.toContain(keyLine);
    const fingerprint = /Its fingerprint \(check it on the handheld when you install it\): ([0-9A-F:]{95})/.exec(r.out)![1];

    // The edge starts from the file it wrote and uses THAT authority — nothing new is made. (Loopback for the test; the
    // certificate covers it as well as the shop address.)
    const said: string[] = [];
    const edge = (await startEdge({ ...env, EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_DEVICE_HOST: '127.0.0.1' }, (l: string) => { said.push(l); }))!;
    try {
      expect(edge.devices!.authority().fingerprint).toBe(fingerprint);
      expect(said.join('\n')).not.toMatch(/made its own signing authority|certificate made for|certificate renewed for/);
    } finally {
      await edge.stop();
    }
    // Run again (the command is the administrator's check too): nothing needed, the same fingerprint said.
    const again = runDeviceAuthorityCommand(env);
    expect(again.ok).toBe(true);
    expect(again.lines.join('\n')).toContain('nothing needed renewing');
    expect(again.lines.join('\n')).toContain(fingerprint);
  });

  it('a public address, a door port that clashes, or an address without a port: refused, nothing written', async () => {
    const other = await mkdtemp(join(tmpdir(), 'sre-ob422-install-bad-'));
    try {
      const r = run(['--dir', other, '--tenant', 't-sre', '--lane', 'lane-1', '--generate-key', '--skip-build', '--device-port', '8091', '--device-host', '8.8.8.8', '--from-compose-env', join(other, 'no-such-env')], other);
      expect(r.code).toBe(78);
      expect(r.out).toMatch(/--device-host must be this computer's address on the staff wifi/);
      expect(r.out).toMatch(/the handheld door's port must differ from the lane and screen ports/);
      expect(existsSync(join(other, 'till.env'))).toBe(false);
      const r2 = run(['--dir', other, '--tenant', 't-sre', '--lane', 'lane-1', '--generate-key', '--skip-build', '--device-host', '192.168.1.4', '--from-compose-env', join(other, 'no-such-env')], other);
      expect(r2.out).toMatch(/--device-host needs --device-port/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('the installer\'s address rule is the authority\'s; a re-run adds the door only when named; with no built edge the lock waits for the first start', () => {
    for (const a of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.9.9', '172.32.0.1', '192.168.0.1', '192.169.0.1', '8.8.8.8', '256.1.1.1', 'shop-pc', '::1']) {
      expect(isShopAddress(a), a).toBe(isPermittedAddress(a));
    }
    expect(parseArgs(['--device-port', '8092', '--device-host', '192.168.1.4'])).toMatchObject({ devicePort: '8092', deviceHost: '192.168.1.4', unknown: [] });
    const settings = { EDGE_DEVICE_PORT: '8092', EDGE_DEVICE_HOST: '192.168.1.4', EDGE_OFFICE_SIGN_IN: 'pin' };
    expect(tillEnvChangesFor({ settings, existing: { EDGE_OFFICE_SIGN_IN: 'pin' }, flags: {} })).toEqual({});
    expect(tillEnvChangesFor({ settings, existing: { EDGE_OFFICE_SIGN_IN: 'pin' }, flags: { devicePort: '8092', deviceHost: '192.168.1.4' } })).toEqual({ EDGE_DEVICE_PORT: '8092', EDGE_DEVICE_HOST: '192.168.1.4' });
    expect(updateTillEnv('EDGE_LANE_ID=lane-1\n', { EDGE_DEVICE_PORT: '8092' })).toEqual({ text: 'EDGE_LANE_ID=lane-1\nEDGE_DEVICE_PORT=8092\n', changed: ['EDGE_DEVICE_PORT'] });
    expect(makeDeviceLock({ repoRoot: '/nowhere', settings: {}, exists: () => false })).toEqual({ ok: true, lines: [expect.stringMatching(/made when the till first starts/)] });
    expect(deviceTlsDirOf({ EDGE_DATA_DIR: '/shop/till/edge-data/' })).toBe('/shop/till/edge-data-device-tls');
    expect(deviceTlsDirOf({ EDGE_DATA_DIR: '/a', EDGE_DEVICE_TLS_DIR: '/b' })).toBe('/b');
    expect(runDeviceAuthorityCommand({})).toMatchObject({ ok: false, lines: [expect.stringMatching(/no EDGE_DATA_DIR/)] });
    expect(runDeviceAuthorityCommand({ EDGE_DATA_DIR: '/tmp/x', EDGE_DEVICE_HOST: '8.8.8.8' })).toMatchObject({ ok: false, lines: [expect.stringMatching(/not this computer's address/)] });
  });
});
