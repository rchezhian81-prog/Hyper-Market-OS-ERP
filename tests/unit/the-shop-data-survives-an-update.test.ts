import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { prepare, resolveLayout, type Deps } from '../../scripts/lib/store-computer.mjs';
import { migrateDataFolder, releaseProblems, rewriteTillEnv, update } from '../../scripts/lib/store-computer-data.mjs';
import { scheduleBackup } from '../../scripts/lib/store-computer-schedule.mjs';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers (as tests/unit/install-till.test.ts does).
import { tillInstallDir, renderStartScript, planTillSettings, renderTillEnv, DATA_MARKER } from '../../scripts/install-till.mjs';
import { settingsOf, world, type World } from '../support/store-computer-world';

/**
 * Audit row 9 (lane B B11 · lane C C-12; hard rules #1, #2, #6) — updating must never lose data. The settings (.env.real),
 * the check records and the till's own data (sales, queue, dead letters, PIN checks, bill-number witness) live in the
 * shop's DATA FOLDER, outside the release folder. `migrate-data-folder` moves a copy set up the first way: every file
 * copied and checked by SHA-256, the settings last, the old places renamed (never deleted). `update --from <new release
 * folder>` checks the new release, takes an encrypted backup first, stops the till it started, installs and starts the
 * new release on the SAME data, and makes it the live release. `till:install --settings <data folder>\.env.real` keeps
 * working and puts the till's data in the data folder.
 */

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const frame = (r: string): string => `${Buffer.byteLength(r)} ${r}\n`;
const said = (w: World): string => w.said.join('\n');

/** A copy set up the FIRST way: settings, records and the till's data all inside the release folder. */
async function firstLayout(): Promise<World> {
  const w = world();
  const inRelease = { ...w.deps } as Partial<Deps>;
  delete (inRelease as { dataRoot?: string }).dataRoot;
  expect(await prepare(inRelease as Deps)).toBe(0);
  expect(existsSync(join(w.root, 'infra', 'compose', '.env.real'))).toBe(true);
  mkdirSync(join(w.root, 'infra', 'compose', 'records'), { recursive: true });
  writeFileSync(join(w.root, 'infra', 'compose', 'records', 'g4-check-2026-10-19.json'), '{"kind":"g4-isolation-check"}\n');
  const till = join(w.root, 'till');
  mkdirSync(join(till, 'edge-data'), { recursive: true });
  mkdirSync(join(till, 'edge-witness'), { recursive: true });
  writeFileSync(join(till, 'till.env'), `# the till\nEDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_WITNESS_DIR=${join(till, 'edge-witness')}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nPACK_SIGNING_KEY=${'p'.repeat(48)}\n`);
  writeFileSync(join(till, 'edge-data', 'sales.log'), frame('{"saleId":"S-1"}') + frame('{"saleId":"S-2"}'));
  writeFileSync(join(till, 'edge-data', 'dead-letters'), frame('{"key":"k1"}'));
  writeFileSync(join(till, 'edge-data', 'till-credentials.json'), '{"version":1,"credentials":[{"userId":"u1"}]}\n');
  writeFileSync(join(till, 'edge-witness', 'receipt-numbers.witness.log'), frame('{"n":7}'));
  w.said.length = 0;
  return w;
}

describe('migrate-data-folder', () => {
  it('copies every file, checks each SHA-256, moves the settings LAST, renames the old places (never deletes) and rewrites the start scripts', async () => {
    const w = await firstLayout();
    const before = {
      settings: sha(join(w.root, 'infra', 'compose', '.env.real')),
      sales: sha(join(w.root, 'till', 'edge-data', 'sales.log')),
      dead: sha(join(w.root, 'till', 'edge-data', 'dead-letters')),
      pins: sha(join(w.root, 'till', 'edge-data', 'till-credentials.json')),
      witness: sha(join(w.root, 'till', 'edge-witness', 'receipt-numbers.witness.log')),
    };
    expect(resolveLayout(w.deps).mode).toBe('in-release');
    expect(await migrateDataFolder(w.deps)).toBe(0);
    expect(resolveLayout(w.deps).mode).toBe('data-folder');
    expect(sha(join(w.data, '.env.real'))).toBe(before.settings);
    expect(sha(join(w.data, 'till', 'edge-data', 'sales.log'))).toBe(before.sales);
    expect(sha(join(w.data, 'till', 'edge-data', 'dead-letters'))).toBe(before.dead);
    expect(sha(join(w.data, 'till', 'edge-data', 'till-credentials.json'))).toBe(before.pins);
    expect(sha(join(w.data, 'till', 'edge-witness', 'receipt-numbers.witness.log'))).toBe(before.witness);
    expect(readFileSync(join(w.data, 'records', 'g4-check-2026-10-19.json'), 'utf8')).toContain('g4-isolation-check');
    expect(existsSync(join(w.data, DATA_MARKER))).toBe(true);
    // The till's settings now point at the data folder, keep every other value, and name the status file.
    const tillEnv = readFileSync(join(w.data, 'till', 'till.env'), 'utf8');
    expect(tillEnv).toContain(`EDGE_DATA_DIR=${join(w.data, 'till', 'edge-data')}`);
    expect(tillEnv).toContain(`EDGE_WITNESS_DIR=${join(w.data, 'till', 'edge-witness')}`);
    expect(tillEnv).toContain(`EDGE_STORE_COMPUTER_STATUS_FILE=${join(w.data, 'status', 'store-computer-status.json')}`);
    expect(tillEnv).toContain(`PACK_SIGNING_KEY=${'p'.repeat(48)}`);
    expect(tillEnv).toContain('EDGE_LANE_ID=lane-1');
    // Nothing deleted: the old places are renamed, beside where they were.
    const kept = readdirSync(join(w.root, 'infra', 'compose')).filter((n) => n.includes('moved-to-data-folder'));
    expect(kept.sort()).toEqual([expect.stringMatching(/^\.env\.real\.moved-to-data-folder-/), expect.stringMatching(/^records\.moved-to-data-folder-/)]);
    expect(readdirSync(join(w.root, 'till')).filter((n) => n.includes('moved-to-data-folder')).length).toBe(3);
    expect(existsSync(join(w.root, 'infra', 'compose', '.env.real'))).toBe(false);
    // The start scripts in the release read the till's settings from the data folder, and serve THIS release's screens.
    const cmd = readFileSync(join(w.root, 'till', 'start-till.cmd'), 'utf8');
    expect(cmd).toContain(`in ("${join(w.data, 'till', 'till.env')}") do set`);
    expect(cmd).toContain(`set "EDGE_APPS_DIR=${join(w.root, 'apps')}"`);
    expect(said(w)).toMatch(/^MOVED — this copy's data is now in the shop's data folder/m);
    expect(said(w)).not.toContain('p'.repeat(20));
    for (const v of Object.values(settingsOf(w)).filter((x) => x.length >= 32)) expect(said(w)).not.toContain(v);
    // Twice is harmless.
    expect(await migrateDataFolder(w.deps)).toBe(0);
    expect(said(w)).toMatch(/Nothing to move — this copy already uses the shop's data folder/);
  });

  it('refuses while the till runs (its files are open), with two settings files, or with nothing to move — changing nothing', async () => {
    const w = await firstLayout();
    w.ports.add(8090);
    expect(await migrateDataFolder(w.deps)).toBe(2);
    expect(said(w)).toMatch(/the till is running .* Close the till's black window \(start-till\) first/);
    expect(existsSync(w.data)).toBe(false);
    w.ports.clear();
    mkdirSync(w.data, { recursive: true });
    writeFileSync(join(w.data, '.env.real'), 'X=1\n');
    expect(await migrateDataFolder(w.deps)).toBe(2);
    expect(said(w)).toMatch(/there are two settings files/);
    const fresh = world();
    expect(await migrateDataFolder(fresh.deps)).toBe(2);
    expect(said(fresh)).toMatch(/there is no settings file to move/);
  });

  it('a copy that fails half way takes back its partial copies: the old places are exactly as they were', async () => {
    const w = await firstLayout();
    const real = w.deps.fs;
    let n = 0;
    w.deps = { ...w.deps, fs: { ...real, copyFileSync: (a: string, b: string, m?: number) => { n += 1; if (n === 3) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return real.copyFileSync(a, b, m); } } as Deps['fs'] };
    expect(await migrateDataFolder(w.deps)).toBe(1);
    expect(said(w)).toMatch(/NOT DONE — ENOSPC: no space left on device\. Nothing was moved/);
    expect(existsSync(join(w.root, 'infra', 'compose', '.env.real'))).toBe(true);
    expect(existsSync(join(w.root, 'till', 'edge-data', 'sales.log'))).toBe(true);
    expect(existsSync(join(w.data, '.env.real'))).toBe(false);
    expect(resolveLayout(w.deps).mode).toBe('in-release');
  });

  it('rewriteTillEnv keeps every line it does not own and adds what is missing', () => {
    expect(rewriteTillEnv('# c\nEDGE_DATA_DIR=/old\nEDGE_LANE_ID=lane-1\n', { edgeData: '/new/d', witness: '/new/w', statusFile: '/new/s.json' }))
      .toBe('# c\nEDGE_DATA_DIR=/new/d\nEDGE_LANE_ID=lane-1\nEDGE_WITNESS_DIR=/new/w\n# The store computer\'s own check (store-computer status): the office screens show its red banner.\nEDGE_STORE_COMPUTER_STATUS_FILE=/new/s.json\n');
  });
});

describe('update --from <new release folder>', () => {
  const MIG = { '0001_a.sql': 'CREATE TABLE a (id int);\n' };
  function release(root: string, migrations: Record<string, string>, code: string): void {
    for (const d of [['db', 'migrations'], ['infra', 'compose'], ['scripts', 'lib'], ['services', 'api']]) mkdirSync(join(root, ...d), { recursive: true });
    for (const [n, sql] of Object.entries(migrations)) writeFileSync(join(root, 'db', 'migrations', n), sql);
    writeFileSync(join(root, 'infra', 'compose', 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'scripts', 'lib', 'store-computer.mjs'), '');
    writeFileSync(join(root, 'scripts', 'install-till.mjs'), '');
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'services', 'api', 'main.ts'), code);
  }
  async function live(): Promise<{ w: World; next: string; drive: string }> {
    const w = world();
    w.deps = { ...w.deps, env: { npm_execpath: '/pnpm/bin/pnpm.cjs', USERNAME: 'owner', USERDOMAIN: 'PC' } };
    expect(await prepare(w.deps)).toBe(0);
    release(w.root, MIG, 'export const v = 1;\n');
    const till = join(w.data, 'till');
    mkdirSync(join(till, 'edge-data'), { recursive: true });
    writeFileSync(join(till, 'till.env'), `EDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_LANE_PORT=8090\n`);
    mkdirSync(join(w.root, 'edge', 'store-edge', 'dist'), { recursive: true });
    const next = mkdtempSync(join(tmpdir(), 'sre-next-release-'));
    release(next, { ...MIG, '0002_b.sql': 'CREATE TABLE b (id int);\n' }, 'export const v = 2;\n');
    mkdirSync(join(next, 'edge', 'store-edge', 'dist'), { recursive: true });
    writeFileSync(join(next, 'edge', 'store-edge', 'dist', 'start.js'), '');
    const drive = mkdtempSync(join(tmpdir(), 'sre-update-drive-'));
    expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
    // The pretend till answers once started.
    const start = w.deps.spawnDetached!;
    w.deps = { ...w.deps, spawnDetached: (cmd, args, o) => { const r = start(cmd, args, o); w.ports.add(8090); return r; } };
    w.said.length = 0;
    w.calls.length = 0;
    return { w, next, drive };
  }

  it('backup first, the till this tool started stopped, the new release installed, built and started on the SAME data, then made live', async () => {
    const { w, next, drive } = await live();
    // The till is running, started by this tool at sign-in.
    w.ports.add(8090);
    mkdirSync(join(w.data, 'run'), { recursive: true });
    writeFileSync(join(w.data, 'run', 'till.json'), JSON.stringify({ pid: 4242, startedAt: 'x', release: w.root }));
    const kill = w.deps.killProcess!;
    w.deps = { ...w.deps, killProcess: (pid) => { kill(pid); w.ports.delete(8090); } };
    const manifestsBefore = readdirSync(drive).filter((f) => f.endsWith('.manifest.json')).length;
    expect(await update(w.deps, { from: next }), said(w)).toBe(0);
    expect(readdirSync(drive).filter((f) => f.endsWith('.manifest.json')).length).toBe(manifestsBefore + 1);
    expect(w.killed).toEqual([4242]);
    const node = w.calls.filter((c) => c.cmd === process.execPath);
    expect(node.map((c) => [c.args.map(String), c.cwd])).toEqual([
      [['/pnpm/bin/pnpm.cjs', 'install', '--frozen-lockfile'], next],
      [[join(next, 'scripts', 'install-till.mjs'), '--settings', join(w.data, '.env.real')], next],
    ]);
    const up = w.calls.find((c) => c.args.includes('up'))!;
    expect(up.cwd).toBe(join(next, 'infra', 'compose'));
    expect(up.args).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', join(w.data, '.env.real'), 'up', '-d', '--build', 'db', 'migrate', 'api']);
    expect(JSON.parse(readFileSync(join(w.data, 'run', 'current-release.json'), 'utf8'))).toMatchObject({ folder: next, previous: w.root });
    expect(w.detached.at(-1)!.args).toEqual([join(next, 'edge', 'store-edge', 'dist', 'start.js')]);
    expect(w.detached.at(-1)!.env).toMatchObject({ EDGE_APPS_DIR: join(next, 'apps') });
    expect(said(w)).toMatch(/^UPDATED — the shop system now runs from .*\. The shop's data stayed in /m);
    expect(said(w)).toMatch(/it is now the PREVIOUS release \(the rollback drill's --previous\)/);
    // The data folder itself was never touched by the update (the same settings, the same till data).
    expect(existsSync(join(w.data, '.env.real'))).toBe(true);
    // Run again from the old folder: refused — the live release is the new one now.
    expect(await update(w.deps, { from: next })).toBe(2);
    expect(said(w)).toMatch(/the live release is .*, not this folder\. Run update from there/);
  });

  it('refuses a folder that is this one, inside it, incomplete, holding shop data, not continuing this release, or the same release', async () => {
    const { w, next } = await live();
    expect(releaseProblems(w.deps, w.root)[0]).toMatch(/names this release's own folder/);
    expect(releaseProblems(w.deps, join(w.root, 'sub'))[0]).toMatch(/is inside this release's folder/);
    const empty = mkdtempSync(join(tmpdir(), 'sre-empty-'));
    expect(releaseProblems(w.deps, empty)[0]).toMatch(/is not a complete release/);
    const dirty = mkdtempSync(join(tmpdir(), 'sre-dirty-'));
    cpSync(next, dirty, { recursive: true });
    mkdirSync(join(dirty, 'till', 'edge-data'), { recursive: true });
    expect(releaseProblems(w.deps, dirty)).toEqual([expect.stringMatching(/holds shop data \(till\/edge-data\)/)]);
    const fork = mkdtempSync(join(tmpdir(), 'sre-fork-'));
    cpSync(next, fork, { recursive: true });
    writeFileSync(join(fork, 'db', 'migrations', '0001_a.sql'), 'CREATE TABLE a (id bigint);\n');
    expect(releaseProblems(w.deps, fork)).toEqual([expect.stringMatching(/the database step 0001_a\.sql differs between the two releases — the new release does not continue this one/)]);
    const same = mkdtempSync(join(tmpdir(), 'sre-same-'));
    release(same, MIG, 'export const v = 1;\n');
    expect(releaseProblems(w.deps, same)).toEqual([expect.stringMatching(/same release as this one/)]);
    expect(await update(w.deps, { from: dirty })).toBe(2);
    expect(w.calls.filter((c) => c.args.includes('up'))).toEqual([]);
  });

  it('a till opened by hand must be closed by hand; a new release that will not start puts THIS release back on the same data', async () => {
    const { w, next } = await live();
    w.ports.add(8090);
    expect(await update(w.deps, { from: next })).toBe(2);
    expect(said(w)).toMatch(/the till is running in a window this tool did not open\. Close the till's black window/);
    expect(w.calls.filter((c) => c.args.includes('up'))).toEqual([]);
    w.ports.delete(8090);
    w.docker.upStatusIn = (cwd) => (cwd.startsWith(next) ? 1 : 0);
    w.said.length = 0;
    expect(await update(w.deps, { from: next })).toBe(1);
    expect(said(w)).toMatch(/NOT UPDATED — Docker could not start the new release\./);
    expect(said(w)).toMatch(/This release is running again\./);
    const ups = w.calls.filter((c) => c.args.includes('up'));
    expect(ups.map((c) => c.cwd)).toEqual([join(next, 'infra', 'compose'), join(w.root, 'infra', 'compose')]);
    expect(JSON.parse(readFileSync(join(w.data, 'run', 'current-release.json'), 'utf8'))).toMatchObject({ folder: w.root });
  });
});

describe('till:install on the store computer (keeps --settings working)', () => {
  it('--settings in the data folder puts the till\'s settings and data in its till folder; elsewhere nothing changes', () => {
    const data = mkdtempSync(join(tmpdir(), 'sre-data-'));
    writeFileSync(join(data, DATA_MARKER), 'x');
    expect(tillInstallDir({ flags: { composeEnv: join(data, '.env.real') }, repoRoot: '/repo' })).toEqual({ installDir: join(data, 'till'), dataFolder: data });
    expect(tillInstallDir({ flags: { composeEnv: '/repo/infra/compose/.env.real' }, repoRoot: '/repo' })).toEqual({ installDir: '/repo/till' });
    expect(tillInstallDir({ flags: { composeEnv: join(data, '.env.real'), dir: '/somewhere' }, repoRoot: '/repo' })).toEqual({ installDir: '/somewhere' });
    expect(tillInstallDir({ flags: { dataDir: '/d/till' }, repoRoot: '/repo' })).toEqual({ installDir: '/d/till' });
  });

  it('the start scripts read till.env from the data folder and serve this release\'s screens; without it they read their own folder as before', () => {
    const cmd = renderStartScript('win32', { repoRoot: 'C:\\SRE-2026-11', tillEnvPath: 'C:\\SRE-data\\till\\till.env', platformPath: win32 });
    expect(cmd).toContain('in ("C:\\SRE-data\\till\\till.env") do set "%%A=%%B"');
    expect(cmd).toContain('set "EDGE_APPS_DIR=C:\\SRE-2026-11\\apps"');
    expect(cmd).toContain('node "C:\\SRE-2026-11\\edge\\store-edge\\dist\\start.js" %*');
    expect(cmd).toMatch(/do NOT start it here as well/);
    const sh = renderStartScript('linux', { repoRoot: '/srv/sre', tillEnvPath: '/srv/sre-data/till/till.env' });
    expect(sh).toContain('set -a; . "/srv/sre-data/till/till.env"; set +a');
    expect(sh).toContain('EDGE_APPS_DIR="/srv/sre/apps"; export EDGE_APPS_DIR');
    expect(renderStartScript('win32', { repoRoot: 'C:\\repo' })).toContain('%~dp0till.env');
  });

  it('in the data folder the till\'s settings name the status file its box reads for the red banner; elsewhere they do not', () => {
    const flags = { lane: 'lane-1', lanePort: '8090', screenPort: '8091', generateKey: false };
    const compose = { EDGE_TENANT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PACK_SIGNING_KEY: 'k'.repeat(48) };
    const inData = planTillSettings({ flags, installDir: '/d/till', appsDir: '/r/apps', composeEnv: compose, statusFile: '/d/status/store-computer-status.json' });
    expect(inData.ok).toBe(true);
    expect(renderTillEnv(inData.settings)).toContain('\nEDGE_STORE_COMPUTER_STATUS_FILE=/d/status/store-computer-status.json\n');
    expect(renderTillEnv(planTillSettings({ flags, installDir: '/r/till', appsDir: '/r/apps', composeEnv: compose }).settings)).not.toContain('EDGE_STORE_COMPUTER_STATUS_FILE');
  });
});
