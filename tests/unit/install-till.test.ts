import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers (no types file needed).
import { checkNodeVersion, parseArgs, planTillSettings, renderTillEnv, renderStartScript, renderSystemdUnit, renderNextSteps, BUILD_STEPS, MIN_NODE_MAJOR } from '../../scripts/install-till.mjs';
// @ts-expect-error — plain .mjs script module.
import { parseEnv } from '../../scripts/standup-check.mjs';

/**
 * **The one-PC till installer decides honestly (Stage D · KL-08 · hard rule #4).**
 *
 * The runner is a thin shell over these helpers; what they decide is what a technician gets. The rules
 * worth pinning: the signing key is COPIED from the cloud's settings (the till must trade on packs the
 * cloud signed) and only GENERATED for an offline-only till when asked; an existing key is never
 * rotated; a cloud token is never copied from anywhere; every problem is named at once; the start
 * scripts load the settings file and run the built edge; the next-steps text never carries the key.
 */

const KEY = 'k'.repeat(64);
const flags = (over: Record<string, unknown> = {}) => ({ ...parseArgs([]), ...over });
const plan = (over: Record<string, unknown> = {}) => planTillSettings({ flags: flags(), installDir: '/shop/till', appsDir: '/repo/apps', ...over });

describe('install-till — the machine', () => {
  it('needs Node 22 or newer, and says how to fix an old one', () => {
    expect(checkNodeVersion(`v${MIN_NODE_MAJOR}.1.0`).ok).toBe(true);
    expect(checkNodeVersion('v24.0.0').ok).toBe(true);
    const old = checkNodeVersion('v18.19.0');
    expect(old.ok).toBe(false);
    expect(old.fix).toMatch(/nodejs\.org/);
    expect(checkNodeVersion('weird').ok).toBe(false);
  });

  it('parses the flags and names anything it does not know', () => {
    const f = parseArgs(['--tenant', 't-sre', '--dir', '/x', '--generate-key', '--skip-build', '--lane-port', '9000', '--bogus']);
    expect(f).toMatchObject({ tenant: 't-sre', dir: '/x', generateKey: true, skipBuild: true, lanePort: '9000', screenPort: '8091', force: false, unknown: ['--bogus'] });
  });
});

describe('install-till — the settings plan', () => {
  it('copies the tenant and the signing key from the cloud settings file, and the cloud URL — never the token', () => {
    const p = plan({ composeEnv: { EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, CLOUD_API_URL: 'http://127.0.0.1:8081', CLOUD_API_TOKEN: 'secret-token-that-must-not-travel' } });
    expect(p.ok).toBe(true);
    expect(p.settings).toMatchObject({ EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, CLOUD_API_URL: 'http://127.0.0.1:8081', CLOUD_API_TOKEN: '', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '8091', EDGE_DATA_DIR: '/shop/till/edge-data', EDGE_APPS_DIR: '/repo/apps' });
    expect(p.notes.join(' ')).toMatch(/copied the pack signing key/);
  });

  it('refuses a placeholder key and a missing tenant, naming both at once; generates a key only when asked, and says the till is offline-only', () => {
    const bad = plan({ composeEnv: { EDGE_TENANT_ID: 'REPLACE_WITH_YOUR_TENANT_ID', PACK_SIGNING_KEY: 'REPLACE_WITH_A_GENERATED_VALUE' } });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/no tenant id/);
    expect(bad.problems.join(' ')).toMatch(/no pack signing key/);
    const offline = plan({ flags: flags({ tenant: 't-sre', generateKey: true }), generatedKey: 'g'.repeat(64) });
    expect(offline.ok).toBe(true);
    expect(offline.settings.PACK_SIGNING_KEY).toBe('g'.repeat(64));
    expect(offline.notes.join(' ')).toMatch(/OFFLINE-ONLY/);
    expect(offline.notes.join(' ')).toMatch(/offline-first/i);
  });

  it('never rotates the key an earlier install wrote, keeps its capacity and its token, and refuses a short key or clashing ports', () => {
    const kept = plan({ flags: flags({ tenant: 't-sre' }), composeEnv: { PACK_SIGNING_KEY: 'c'.repeat(64) }, existing: { PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '123', CLOUD_API_TOKEN: 'tok'.padEnd(30, 'x') } });
    expect(kept.settings.PACK_SIGNING_KEY).toBe(KEY);
    expect(kept.settings.EDGE_CAPACITY_BYTES).toBe('123');
    expect(kept.settings.CLOUD_API_TOKEN).toBe('tok'.padEnd(30, 'x'));
    expect(kept.notes.join(' ')).toMatch(/never rotates/);
    const short = plan({ flags: flags({ tenant: 't-sre' }), composeEnv: { PACK_SIGNING_KEY: 'short' } });
    expect(short.problems.join(' ')).toMatch(/shorter than 32/);
    const clash = plan({ flags: flags({ tenant: 't-sre', generateKey: true, lanePort: '8090', screenPort: '8090' }) });
    expect(clash.problems.join(' ')).toMatch(/must differ/);
    expect(plan({ flags: flags({ tenant: 't-sre', generateKey: true, lanePort: 'abc' }) }).problems.join(' ')).toMatch(/port number/);
  });
});

describe('install-till — the files it writes', () => {
  const settings = plan({ composeEnv: { EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY } }).settings;

  it('the settings file round-trips through the readiness check\'s parser and carries every edge setting', () => {
    const text = renderTillEnv(settings);
    expect(parseEnv(text)).toEqual(settings);
    expect(text).toMatch(/hard rule #4/);
  });

  it('the start scripts load till.env from their own folder and run the BUILT edge; the systemd unit does the same', () => {
    const sh = renderStartScript('linux', { repoRoot: '/repo' });
    expect(sh).toMatch(/^#!\/usr\/bin\/env sh/);
    expect(sh).toContain('. "$HERE/till.env"');
    expect(sh).toContain('exec node "/repo/edge/store-edge/dist/start.js"');
    const cmd = renderStartScript('win32', { repoRoot: 'C:\\repo' });
    expect(cmd).toContain('%~dp0till.env');
    expect(cmd).toContain('eol=#');
    expect(cmd).toContain('node "C:\\repo/edge/store-edge/dist/start.js"'.replace('C:\\repo/edge/store-edge/dist/start.js', cmd.match(/node "([^"]+)"/)![1]!));
    const unit = renderSystemdUnit({ installDir: '/shop/till', repoRoot: '/repo' });
    expect(unit).toContain('EnvironmentFile=/shop/till/till.env');
    expect(unit).toContain('ExecStart=/usr/bin/env node /repo/edge/store-edge/dist/start.js');
    expect(unit).toContain('Restart=always');
  });

  it('builds exactly the till screen, the office screens and the store edge', () => {
    expect(BUILD_STEPS.map((s: { args: string[] }) => s.args)).toEqual([['scripts/build-app.mjs', 'pos'], ['scripts/build-app.mjs', 'web-erp'], ['scripts/build-service.mjs', 'edge']]);
  });

  it('the next steps name the start script, the till URL and the readiness check — and never the key', () => {
    const text = renderNextSteps({ settings, installDir: '/shop/till', platform: 'linux' });
    expect(text).toContain('/shop/till/start-till.sh');
    expect(text).toContain('http://127.0.0.1:8091/pos/');
    expect(text).toContain('standup:check');
    expect(text).toMatch(/OFFLINE-FIRST/);
    expect(text).not.toContain(KEY);
    expect(renderNextSteps({ settings, installDir: 'C:\\till', platform: 'win32' })).toContain('double-click start-till.cmd');
    expect(renderNextSteps({ settings: { ...settings, CLOUD_API_URL: 'http://c' }, installDir: '/t', platform: 'linux' })).toContain('Sync target: http://c');
  });
});
