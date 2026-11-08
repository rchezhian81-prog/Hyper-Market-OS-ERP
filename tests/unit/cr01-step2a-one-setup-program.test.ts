import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { main, type Deps } from '../../scripts/lib/store-computer.mjs';
import { SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import { bundledRuntime, releaseInfo } from '../../scripts/lib/store-computer-setup.mjs';
// @ts-expect-error — plain .mjs script module.
import { pgVersion, releasePackageJson, releasePlan, shippedApps, shipsScript } from '../../scripts/build-store-pc-release.mjs';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc, type PretendWin } from '../support/store-pc-windows';

/**
 * **CR-01 step 2a · OI-01 · OI-03 · OI-08 (first half): ONE setup program, no typed command.**
 *
 *   `store-computer setup` is what SRE-Setup.exe runs after copying its files: this PC's settings — made once with a NEW
 *   tenant id made here (OI-03), or KEPT exactly when this PC already has them (OI-08) — then the till, then the three
 *   Windows services (step 1). Run again, it replaces nothing. Every line goes to C:\ProgramData\SRE\setup.log too.
 *   An installed release brings its own PostgreSQL and service host (runtime\), so nothing is downloaded on the shop PC.
 *   The release folder holds only what runs: never tests, documents, seed data or a settings file but the example.
 *
 * Driven on a pretend Windows (tests/support/store-pc-windows.ts). The real proof is the `store-pc-setup` CI job, which
 * builds SRE-Setup.exe, runs it silently on a clean Windows machine, re-runs it and uninstalls it.
 */

const said = (w: World): string => w.said.join('\n');

/** A store PC on which SRE-Setup.exe has just copied an installed release into C:\SRE (the pretend Program Files). */
function installedRelease(): { w: World; d: Deps; win: PretendWin } {
  const w = world();
  const { d, win } = storePc(w);
  const fs = d.fs;
  for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist']) fs.mkdirSync(dir, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend service host');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
  fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
  fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.0', commit: 'abcdef1234567890' }));
  return { w, d, win };
}

describe('setup — the first run SRE-Setup.exe does: settings, till, services, in one step', () => {
  it('on a new PC: makes the settings with a new tenant id, installs the till and the three services, says SETUP DONE', async () => {
    const { w, d, win } = installedRelease();
    expect(await main(['setup', '--data-drive', 'C:'], d)).toBe(0);
    const s = settingsIn(d.fs);
    expect(s['EDGE_TENANT_ID']).toMatch(/^[0-9a-f-]{36}$/);
    const out = said(w);
    expect(out).toMatch(/^SRE Retail OS setup — release 1\.0\.0 \(abcdef12\)\.$/m);
    expect(out).toMatch(/^The till is installed in C:\\SRE-data\\till\.$/m);
    expect(out).toContain(`This shop's tenant id: ${s['EDGE_TENANT_ID']}`);
    expect(out).toMatch(/^SETUP DONE\.$/m);
    for (const name of [SERVICES.database, SERVICES.api, SERVICES.till]) expect(win.services.get(name)?.state).toBe('running');
    // The release's own PostgreSQL and service host were used; nothing was built on the shop PC (no build tools there).
    expect(win.calls.find((c) => c.cmd.endsWith('initdb.exe'))?.cmd).toBe('C:\\SRE\\runtime\\pgsql\\bin\\initdb.exe');
    expect(win.calls.some((c) => c.args.some((a) => String(a).endsWith('build-service.mjs')))).toBe(false);
    expect(win.tillInstalls[0]).toEqual(expect.arrayContaining(['--settings', 'C:\\SRE-data\\.env.real', '--lane', 'lane-1', '--skip-build']));
  });

  it('two installs make two different tenant ids (OI-03) — never typed, never copied', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { d } = installedRelease();
      expect(await main(['setup', '--data-drive', 'C:'], d)).toBe(0);
      ids.push(settingsIn(d.fs)['EDGE_TENANT_ID']!);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('run again: the settings file is byte-for-byte the same, the till and the database are kept, nothing is installed twice', async () => {
    const { w, d, win } = installedRelease();
    expect(await main(['setup', '--data-drive', 'C:'], d)).toBe(0);
    const before = d.fs.readFileSync('C:\\SRE-data\\.env.real', 'utf8');
    w.said.length = 0;
    expect(await main(['setup'], d)).toBe(0);
    expect(d.fs.readFileSync('C:\\SRE-data\\.env.real', 'utf8')).toBe(before);
    const out = said(w);
    expect(out).toMatch(/^This PC is already set up: its settings in C:\\SRE-data\\\.env\.real are KEPT, with every secret and its tenant id\.$/m);
    expect(out).toMatch(/^The till's settings in C:\\SRE-data\\till\\till\.env are KEPT\.$/m);
    expect(win.tillInstalls).toHaveLength(1);
    expect(win.initdbRuns).toBe(1);
    expect(win.hostInstalls).toEqual(['SRE-API', 'SRE-Till']);
  });

  it('a PC already set up keeps its data where it is, even when another drive is asked for', async () => {
    const { w, d } = installedRelease();
    expect(await main(['setup', '--data-drive', 'C:'], d)).toBe(0);
    w.said.length = 0;
    expect(await main(['setup', '--data-drive', 'D:'], d)).toBe(0);
    expect(said(w)).toMatch(/^ {2}Its shop data stays in C:\\SRE-data; the drive asked for, D:, is not used\.$/m);
  });

  it('every line is also kept in C:\\ProgramData\\SRE\\setup.log — and no secret is in it', async () => {
    const { d } = installedRelease();
    expect(await main(['setup', '--data-drive', 'C:'], d)).toBe(0);
    const log = d.fs.readFileSync('C:\\ProgramData\\SRE\\setup.log', 'utf8');
    expect(log).toMatch(/Z {2}SETUP DONE\./);
    const s = settingsIn(d.fs);
    for (const k of ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY']) expect(log).not.toContain(s[k]!);
  });

  it('refuses off Windows and on a Windows Server (OB-282), having changed nothing', async () => {
    const w = world();
    expect(await main(['setup'], w.deps)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — the setup is for the store computer \(Windows 10 or 11\)\./);
    const r = installedRelease();
    r.w.windows.edition = { productType: 3, caption: 'Microsoft Windows Server 2022 Standard' };
    expect(await main(['setup', '--data-drive', 'C:'], r.d)).toBe(2);
    expect(r.d.fs.existsSync('C:\\SRE-data\\.env.real')).toBe(false);
    expect(r.win.services.size).toBe(0);
  });

  it('knows an installed release by its release.json, and finds the PostgreSQL and service host it brings', () => {
    const { d } = installedRelease();
    expect(releaseInfo(d)).toMatchObject({ version: '1.0.0' });
    expect(bundledRuntime(d)).toEqual({ pgBin: 'C:\\SRE\\runtime\\pgsql\\bin', serviceHost: 'C:\\SRE\\runtime\\winsw\\WinSW-x64.exe' });
    d.fs.rmSync('C:\\SRE\\release.json');
    expect(bundledRuntime(d)).toEqual({});
  });
});

describe('the release folder holds only what runs (scripts/build-store-pc-release.mjs)', () => {
  it('scripts: the runnable tool, its library, its page and the built tools — never TypeScript sources or type files', () => {
    for (const ok of ['scripts/store-computer.mjs', 'scripts/lib/store-computer.mjs', 'scripts/dist/import-server.js', 'scripts/import-page/index.html', 'scripts/lib']) expect(shipsScript(ok)).toBe(true);
    for (const no of ['scripts/import-server.ts', 'scripts/lib/import-app.ts', 'scripts/lib/store-computer.d.mts', 'tests/unit/x.test.ts', 'docs/STATUS.md']) expect(shipsScript(no)).toBe(false);
  });
  it('never tests, documents, seed data, or a settings file but the example', () => {
    const plan = (releasePlan() as { from: string }[]).map((p) => p.from.replace(/\\/g, '/'));
    for (const p of plan) expect(p).not.toMatch(/^(tests|docs)\b|db\/seed|\.env(?!\.example$)/);
    expect(plan).toEqual(expect.arrayContaining(['services/api/dist', 'edge/store-edge/dist', 'db/migrations', 'infra/compose/.env.example', 'apps/pos/web', 'apps/web-erp/web']));
    expect(shippedApps()).toContain('pos');
  });
  it('one run-time library, pg, at the lockfile\'s version; an ES module package', () => {
    const pkg = releasePackageJson() as { type: string; dependencies: Record<string, string> };
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies).toEqual({ pg: pgVersion() });
    expect(readFileSync('pnpm-lock.yaml', 'utf8')).toContain(`pg@${pgVersion()}:`);
  });
});

describe('SRE-Setup.exe\'s own definition (infra/windows/sre-setup.iss)', () => {
  const iss = readFileSync('infra/windows/sre-setup.iss', 'utf8');
  it('runs the store-computer tool\'s setup with the Node it brings, fails by exit code, removes only the services on uninstall', () => {
    expect(iss).toContain("ExpandConstant('{app}\\runtime\\node\\node.exe')");
    expect(iss).toContain("'\" setup' + DataDriveArg()");
    expect(iss).toContain('function GetCustomSetupExitCode(): Integer;');
    expect(iss).toContain('""{app}\\scripts\\store-computer.mjs"" remove-services');
    expect(iss).toContain('PrivilegesRequired=admin');
    // Run again: the services hold the program's files, so they are stopped first, till first (seen on the clean-Windows
    // run: the second run was refused with exit 5 while they ran); the setup step starts them again.
    const stops = [...iss.matchAll(/'stop (SRE-[A-Za-z]+) \/y'/g)].map((m) => m[1]);
    expect(stops).toEqual(['SRE-Till', 'SRE-API', 'SRE-Database']);
    expect(iss).toContain('function PrepareToInstall(var NeedsRestart: Boolean): String;');
    // Uninstalling never deletes anything beyond the program's own files: no extra delete section, no folder wipe.
    expect(iss).not.toMatch(/DelTree|\[UninstallDelete\]/);
  });
});
