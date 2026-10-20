import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers.
import { parseArgs, planTillSettings, renderTillEnv, storeTokenMinter, tillEnvChangesFor, updateTillEnv, isRealCopySettings, STORE_TOKEN_HOURS } from '../../scripts/install-till.mjs';
// @ts-expect-error — plain .mjs script module.
import { tillEnvPathFor, passedArgs, pinCommandEnv } from '../../scripts/till-pin.mjs';
// @ts-expect-error — plain .mjs script module.
import { parseEnv } from '../../scripts/standup-check.mjs';
import { main, prepare, parseCommandLine } from '../../scripts/lib/store-computer.mjs';
import { verifyToken } from '../../services/identity/src/token';
import { world } from '../support/store-computer-world';

/**
 * The faults found while checking the owner's Windows guide (W-1, W-5, W-6) and the store-computer side of OB-257:
 *
 *   W-1  `till:install -- --lane lane-1` — pnpm 10 passes the `--` on; the installer now skips it.
 *   W-5  the installer writes the till's connection itself: with the store computer's own settings and `--store`, this
 *        copy's own loopback address, a store token for store-edge locked to that store (never shown), the store id and
 *        "take the setup from head office" — and, for the real copy, guest sales only (OB-252) and the office PIN (OB-259).
 *        An existing till.env keeps its key, lane and folders; only those settings change, in place.
 *   W-6  `pnpm run till:pin` finds and loads the till's own settings (the data folder first) before the PIN command runs.
 *   OB-257 the setup commands are handed to the setup tool in THIS window (it asks questions), with this copy's settings.
 */

const KEY = 'k'.repeat(64);
const REAL = { EDGE_TENANT_ID: 'ab000000-0000-4000-8000-000000000001', PACK_SIGNING_KEY: KEY, IDP_SIGNING_KEY: 'i'.repeat(64), IDP_ISSUER: 'sre-real-store-computer-x', IDP_AUDIENCE: 'sre-real-api', API_PORT: '8081' };

describe('W-1 — the installer accepts the "--" the runbooks show', () => {
  it('skips a leading (or any) "--" and still names a real unknown option', () => {
    expect(parseArgs(['--', '--lane', 'lane-1', '--settings', 'x']).unknown).toEqual([]);
    expect(parseArgs(['--', '--lane', 'lane-1']).lane).toBe('lane-1');
    expect(parseArgs(['--', '--colour', 'blue']).unknown).toEqual(['--colour', 'blue']);
  });
});

describe('W-5 — the installer writes the till\'s connection itself', () => {
  const flags = (over: Record<string, unknown> = {}) => ({ ...parseArgs(['--lane', 'lane-1']), settingsNamed: true, ...over });
  const plan = (over: Record<string, unknown> = {}) => planTillSettings({ flags: flags(), installDir: '/d/till', appsDir: '/r/apps', composeEnv: REAL, realCopy: true, mintStoreToken: storeTokenMinter(REAL, Date.parse('2026-10-20T10:00:00Z')), ...over });

  it('before the store exists: offline-first, guest sales only and the office PIN on, no token', () => {
    const p = plan();
    expect(p.ok).toBe(true);
    expect(p.settings).toMatchObject({ CLOUD_API_URL: '', CLOUD_API_TOKEN: '', EDGE_GUEST_SALES_ONLY: '1', EDGE_OFFICE_SIGN_IN: 'pin' });
    expect(p.settings.EDGE_STORE_ID).toBeUndefined();
  });

  it('with --store: this copy\'s own loopback address, a store-edge token locked to the store, the store and its setup source', () => {
    const p = plan({ flags: flags({ store: 'SRE-MAIN' }) });
    expect(p.ok).toBe(true);
    expect(p.settings).toMatchObject({ CLOUD_API_URL: ['http', '://127.0.0.1:8081'].join(''), EDGE_STORE_ID: 'SRE-MAIN', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_GUEST_SALES_ONLY: '1' });
    const v = verifyToken(p.settings.CLOUD_API_TOKEN, { secret: REAL.IDP_SIGNING_KEY, issuer: REAL.IDP_ISSUER, audience: REAL.IDP_AUDIENCE }, Date.parse('2026-10-20T10:01:00Z'));
    expect(v).toMatchObject({ ok: true, principal: { userId: 'store-edge', tenantId: REAL.EDGE_TENANT_ID, branchId: 'SRE-MAIN' } });
    expect(STORE_TOKEN_HOURS).toBe(720);
    // The notes say a token was made — never the token.
    expect(p.notes.join(' ')).toMatch(/a NEW store token .* is never shown/);
    expect(p.notes.join(' ')).not.toContain(p.settings.CLOUD_API_TOKEN);
    // The file round-trips.
    expect(parseEnv(renderTillEnv(p.settings))).toEqual(p.settings);
    // A bad store id, or settings with no identity key, are named problems.
    expect(plan({ flags: flags({ store: 'a b' }) }).problems.join(' ')).toMatch(/--store must be/);
    const noKey = { ...REAL, IDP_SIGNING_KEY: '' };
    expect(plan({ flags: flags({ store: 'S' }), composeEnv: noKey, mintStoreToken: storeTokenMinter(noKey) }).problems.join(' ')).toMatch(/store token could not be made: the settings file has no IDP_SIGNING_KEY/);
  });

  it('an existing till.env: only the connection changes, in place; the key, lane and folders stay; a re-run without --store changes nothing', () => {
    const existingText = renderTillEnv(plan().settings);
    const existing = parseEnv(existingText);
    const connected = plan({ flags: flags({ store: 'SRE-MAIN' }), existing });
    const changes = tillEnvChangesFor({ settings: connected.settings, existing, flags: flags({ store: 'SRE-MAIN' }) });
    const out = updateTillEnv(existingText, changes);
    expect(out.changed.sort()).toEqual(['CLOUD_API_TOKEN', 'CLOUD_API_URL', 'EDGE_STORE_ID', 'EDGE_STORE_PACK_SOURCE']);
    const after = parseEnv(out.text);
    expect(after).toMatchObject({ PACK_SIGNING_KEY: KEY, EDGE_LANE_ID: 'lane-1', EDGE_DATA_DIR: existing.EDGE_DATA_DIR, EDGE_STORE_ID: 'SRE-MAIN' });
    expect(out.text.split('\n').filter((l: string) => l.startsWith('#'))).toEqual(existingText.split('\n').filter((l: string) => l.startsWith('#')));
    expect(tillEnvChangesFor({ settings: plan({ existing: after }).settings, existing: after, flags: flags() })).toEqual({});
    // An older till.env without the newer settings gets them, and nothing else.
    const older = { ...existing }; delete older.EDGE_GUEST_SALES_ONLY; delete older.EDGE_OFFICE_SIGN_IN;
    expect(tillEnvChangesFor({ settings: plan({ existing: older }).settings, existing: older, flags: flags() })).toEqual({ EDGE_GUEST_SALES_ONLY: '1', EDGE_OFFICE_SIGN_IN: 'pin' });
  });

  it('knows the real copy by its settings file: .env.real, or the shop data folder\'s note beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-w5-'));
    expect(isRealCopySettings(join(dir, '.env.real'))).toBe(true);
    expect(isRealCopySettings(join(dir, 'compose.env'))).toBe(false);
    writeFileSync(join(dir, 'THIS-IS-THE-SHOP-DATA-FOLDER.txt'), 'x');
    expect(isRealCopySettings(join(dir, 'compose.env'))).toBe(true);
    expect(isRealCopySettings(undefined)).toBe(false);
  });
});

describe('W-6 — till:pin loads the till\'s own settings', () => {
  it('finds the data folder\'s till.env first, else this release\'s, and runs the command with it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sre-w6-'));
    const data = `${repo}-data`;
    expect(tillEnvPathFor({ repoRoot: repo, platform: 'linux', env: {} })).toBeUndefined();
    mkdirSync(join(repo, 'till'), { recursive: true });
    writeFileSync(join(repo, 'till', 'till.env'), 'EDGE_DATA_DIR=/old\n');
    expect(tillEnvPathFor({ repoRoot: repo, platform: 'linux', env: {} })).toBe(join(repo, 'till', 'till.env'));
    mkdirSync(join(data, 'till'), { recursive: true });
    writeFileSync(join(data, 'till', 'till.env'), 'EDGE_DATA_DIR=/new\n');
    expect(tillEnvPathFor({ repoRoot: repo, platform: 'linux', env: {} })).toBe(join(data, 'till', 'till.env'));
    expect(passedArgs(['--', '--user', 'u1', '--by', 'A B'])).toEqual(['--user', 'u1', '--by', 'A B']);
    expect(pinCommandEnv({ PATH: '/bin', EDGE_DATA_DIR: '/shell' }, `# c\nEDGE_DATA_DIR=/new\nPACK_SIGNING_KEY=${KEY}\n`)).toEqual({ PATH: '/bin', EDGE_DATA_DIR: '/new', PACK_SIGNING_KEY: KEY });
  });
});

describe('OB-257 — the setup commands are handed to the setup tool, in this window, with this copy\'s settings', () => {
  it('reads every setup flag; refuses before prepare; builds the tool and runs it with the settings and the till\'s', async () => {
    const cl = parseCommandLine(['--', 'grant', '--as', 'u-m', '--approver', 'u-o', '--person', 'u-c', '--role', 'cashier', '--store', 'S1', '--reason', 'pilot cashier']);
    expect(cl.problems).toEqual([]);
    expect(cl.setup).toEqual({ '--approver': 'u-o', '--person': 'u-c', '--role': 'cashier', '--store': 'S1', '--reason': 'pilot cashier' });
    expect(parseCommandLine(['shop', '--gstin']).problems).toEqual(['--gstin needs a value']);

    const seen: { args: readonly string[] }[] = [];
    const w = world({}, { sliceStdout: (args) => { seen.push({ args }); return { status: 0, stdout: '' }; } });
    expect(await main(['shop', '--as', 'u-o'], w.deps)).toBe(2);
    expect(w.said.join('\n')).toMatch(/REFUSED — this copy has no settings file yet/);
    expect(await prepare(w.deps)).toBe(0);
    expect(await main(['bill-prefix', '--as', 'u-o', '--store', 'S1', '--till', 'lane-1', '--prefix', 'S1L1-'], w.deps)).toBe(0);
    expect(seen.at(-1)!.args).toEqual([join('scripts', 'dist', 'owner-setup.js'), 'bill-prefix', '--store', 'S1', '--till', 'lane-1', '--prefix', 'S1L1-', '--as', 'u-o', '--settings', join(w.data, '.env.real')]);
    const ran = w.calls.filter((c) => c.args[0] === join('scripts', 'dist', 'owner-setup.js'));
    expect(ran.at(-1)!.stdio).toBe('inherit');
  });
});
