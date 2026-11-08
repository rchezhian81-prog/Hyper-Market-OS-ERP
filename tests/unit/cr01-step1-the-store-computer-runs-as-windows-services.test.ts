import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { main, parseEnvText, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import {
  API_KEYS, DB_CONF_INCLUDE, OWN_SERVICE_SIDS, SERVICES, accountOf, databaseSetupSql, hostDatabaseUrl, hostXml, serviceEnv,
  servicePaths, serviceSid,
} from '../../scripts/lib/store-computer-services.mjs';
import { dataLockRow, hostedTestMachine } from '../../scripts/lib/store-computer-windows.mjs';
import { layout } from '../../scripts/lib/store-computer.mjs';
import { OWNER_SID, lockedAcl, world, type World } from '../support/store-computer-world';
import { loadConfig, CLOUD_API_CONFIG } from '../../services/kernel/src/index';

/**
 * **CR-01 step 1 · ADR-0032 (OB-708 "2A"): on the store computer the shop database, the office API and the till run as
 * WINDOWS SERVICES — no Docker.**
 *
 *   install-services  makes the database once (never over an existing one), on this PC only; registers the three services
 *                     to start at boot and restart on failure, each under its OWN virtual account (NT SERVICE\<name>, no
 *                     password anywhere); gives each only its own folders, by SID; starts them in order; waits for the API
 *                     to say ready and the till's screens to answer. Re-running it changes nothing that is there.
 *   services-status   says, per service, running / starting by itself / its account, and whether the API says ready.
 *   remove-services   removes the three services and keeps every byte of the shop's data.
 *
 * No secret is in any service definition, any command line or any line said: the services read the settings file when
 * they start. Driven here with a pretend Windows (service control, icacls, PostgreSQL's programs, the service host);
 * NOTHING HERE RAN ON REAL WINDOWS — the clean-Windows CI job (`store-pc-windows` in .github/workflows/ci.yml) does.
 */

const said = (w: World): string => w.said.join('\n');
/** A synthetic database address, built from parts so no credential-shaped string sits in the source (secret scan). */
const pgUrl = (user: string, pw: string, hostPort: string, db: string): string => ['postgres', '://', user, ':', pw, '@', hostPort, '/', db].join('');
/** This copy's settings, read on the pretend PC (C:\\SRE-data\\.env.real). */
const settingsIn = (fs: Deps['fs']): Record<string, string> => parseEnvText(fs.readFileSync('C:\\SRE-data\\.env.real', 'utf8')) as Record<string, string>;

interface PretendService { state: 'running' | 'stopped'; auto: boolean; account: string; startFails?: boolean }
interface PretendWin {
  services: Map<string, PretendService>;
  calls: { cmd: string; args: string[]; env?: Record<string, string | undefined>; input?: string }[];
  started: string[];
  grants: string[][];
  initdbRuns: number;
  hostInstalls: string[];
  psqlInputs: string[];
}

/**
 * The owner's store PC (Windows 11 Pro), with Windows paths mapped onto temporary folders: C:\SRE is the world's release
 * folder; every other C:\… is <tmp>/drive-c/…. `sc.exe`, `icacls.exe`, PostgreSQL's programs and the service host answer
 * as Windows would; Docker answers from the world (no copy of this shop running in it).
 */
function storePc(w: World, over: Partial<Deps> = {}): { d: Deps; win: PretendWin; onC: (...p: string[]) => string } {
  const drives = `${w.root}-drives`;
  mkdirSync(join(drives, 'drive-c'), { recursive: true });
  const map = (p: unknown): unknown => {
    if (typeof p !== 'string' || !/^[A-Za-z]:(\\|$)/.test(p)) return p;
    if (/^C:\\SRE(\\|$)/i.test(p)) return w.root + p.slice(6).replace(/\\/g, '/');
    return join(drives, `drive-${p[0]!.toLowerCase()}`, p.slice(3).replace(/\\/g, '/'));
  };
  const onC = (...p: string[]): string => map(win32.join('C:\\', ...p)) as string;
  const fs = new Proxy(nodeFs, { get: (t, k) => { const f = (t as Record<string | symbol, unknown>)[k]; return typeof f === 'function' ? (...a: unknown[]) => (f as (...x: unknown[]) => unknown).apply(t, a.map(map)) : f; } }) as Deps['fs'];
  const win: PretendWin = { services: new Map(), calls: [], started: [], grants: [], initdbRuns: 0, hostInstalls: [], psqlInputs: [] };
  const base = w.deps.spawn;
  const spawn = (cmd: string, args: readonly string[], o: { cwd?: string; env?: Record<string, string | undefined>; input?: string; stdio?: unknown } = {}): SpawnResult => {
    win.calls.push({ cmd, args: [...args], ...(o.env === undefined ? {} : { env: o.env }), ...(o.input === undefined ? {} : { input: o.input }) });
    const exe = win32.basename(cmd).toLowerCase();
    if (exe === 'sc.exe') {
      const [verb, name] = args as string[];
      const s = win.services.get(name!);
      if (s === undefined && verb !== 'create') return { status: 1060, stdout: `[SC] OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n` };
      if (verb === 'query') return { status: 0, stdout: `SERVICE_NAME: ${name}\r\n        STATE              : ${s!.state === 'running' ? '4  RUNNING' : '1  STOPPED'}\r\n` };
      if (verb === 'qc') return { status: 0, stdout: `SERVICE_NAME: ${name}\r\n        START_TYPE         : ${s!.auto ? '2   AUTO_START' : '3   DEMAND_START'}\r\n        SERVICE_START_NAME : ${s!.account}\r\n` };
      if (verb === 'start') { if (s!.startFails === true) return { status: 1053 }; s!.state = 'running'; win.started.push(name!); return { status: 0 }; }
      if (verb === 'stop') { s!.state = 'stopped'; return { status: 0 }; }
      if (verb === 'delete') { win.services.delete(name!); return { status: 0 }; }
      if (verb === 'config') { s!.account = args[args.indexOf('obj=') + 1]!; s!.auto = args[args.indexOf('start=') + 1] === 'auto'; return { status: 0 }; }
      return { status: 0 }; // failure, description
    }
    if (exe === 'icacls.exe') { win.grants.push([...args]); return { status: 0 }; }
    if (exe === 'initdb.exe') {
      win.initdbRuns += 1;
      const dir = args[args.indexOf('-D') + 1]!;
      const pw = /^--pwfile=(.*)$/.exec(args.find((a) => a.startsWith('--pwfile='))!)![1]!;
      expect(fs.readFileSync(pw, 'utf8').trim()).toBe(settingsIn(fs)['POSTGRES_PASSWORD']); // the password reached initdb …
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(win32.join(dir, 'PG_VERSION'), '16\n');
      fs.writeFileSync(win32.join(dir, 'postgresql.conf'), "#listen_addresses = 'localhost'\n");
      return { status: 0 };
    }
    if (exe === 'pg_ctl.exe') { win.services.set(args[args.indexOf('-N') + 1]!, { state: 'stopped', auto: true, account: 'LocalSystem' }); return { status: 0 }; }
    if (exe === 'pg_isready.exe') return { status: 0, stdout: '127.0.0.1:5432 - accepting connections\r\n' };
    if (exe === 'psql.exe') { win.psqlInputs.push(o.input ?? ''); return { status: 0 }; }
    if (exe === 'sre-api.exe' || exe === 'sre-till.exe') {
      const name = win32.basename(cmd, '.exe');
      win.hostInstalls.push(name);
      win.services.set(name, { state: 'stopped', auto: true, account: 'LocalSystem' });
      return { status: 0, stdout: `Installing the service with id '${name}'` };
    }
    if (cmd === process.execPath && String(args[0]).endsWith('build-service.mjs')) return { status: 0 };
    return base(cmd, args, o);
  };
  const d: Deps = {
    ...w.deps,
    platform: 'win32',
    repoRoot: 'C:\\SRE',
    dataRoot: 'C:\\SRE-data',
    dataPointer: 'C:\\ProgramData\\SRE\\data-folder.json',
    env: { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData', USERNAME: 'owner', USERDOMAIN: 'SHOP-PC' },
    os: { totalmem: () => 16 * 1024 ** 3, release: () => '10.0.26200', version: () => 'Windows 11 Pro' },
    fs,
    spawn,
    ...over,
  };
  return { d, win, onC };
}

/** A store PC with this copy prepared, the till installed in the data folder, PostgreSQL 16's programs and the service host. */
async function readyPc(over: Partial<Deps> = {}): Promise<{ w: World; d: Deps; win: PretendWin; onC: (...p: string[]) => string }> {
  const w = world();
  const pc = storePc(w, over);
  expect(await main(['prepare'], pc.d)).toBe(0);
  const fs = pc.d.fs;
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']) { fs.mkdirSync('C:\\pgsql\\bin', { recursive: true }); fs.writeFileSync(`C:\\pgsql\\bin\\${exe}`, 'pretend'); }
  fs.mkdirSync('C:\\tools', { recursive: true });
  fs.writeFileSync('C:\\tools\\WinSW-x64.exe', 'pretend service host');
  fs.mkdirSync('C:\\SRE\\scripts', { recursive: true });
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.mkdirSync('C:\\SRE-data\\till', { recursive: true });
  fs.writeFileSync('C:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${settingsIn(fs)['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${settingsIn(fs)['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=C:\\SRE-data\\till\\edge-data\n`);
  w.said.length = 0;
  return { w, ...pc };
}
const INSTALL = ['install-services', '--pg-bin', 'C:\\pgsql\\bin', '--service-host', 'C:\\tools\\WinSW-x64.exe'];

/** Every secret this copy holds, for looking for them everywhere. */
const secretsOf = (d: Deps): string[] => {
  const s = settingsIn(d.fs);
  return ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'].map((k) => s[k]!).filter((v) => v.length > 0);
};

describe('install-services — the three services, each on its own account, started in order, answering', () => {
  it('installs, starts and checks the database, the API and the till; each runs as NT SERVICE\\<name> and starts by itself', async () => {
    const { w, d, win, onC } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    const out = said(w);
    for (const name of [SERVICES.database, SERVICES.api, SERVICES.till]) {
      expect(win.services.get(name)).toEqual({ state: 'running', auto: true, account: `NT SERVICE\\${name}` });
    }
    expect(win.started).toEqual([SERVICES.database, SERVICES.api, SERVICES.till]);
    expect(out).toMatch(/^STARTED — SRE Retail OS - shop database \(SRE-Database\), running as NT SERVICE\\SRE-Database\.$/m);
    expect(out).toMatch(/^READY — the shop database, the office API and the till run as Windows services on this PC only, and start by themselves when Windows starts\. No Docker is used\.$/m);
    // Nothing of Docker was started.
    expect(w.calls.some((c) => c.cmd === 'docker' && c.args.includes('up'))).toBe(false);
    // The database: made once, on this PC only, its settings file included once.
    expect(win.initdbRuns).toBe(1);
    const initdb = win.calls.find((c) => c.cmd.endsWith('initdb.exe'))!;
    expect(initdb.args).toEqual(expect.arrayContaining(['-D', 'C:\\SRE-data\\database', '-U', 'sre_admin', '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256']));
    expect(readFileSync(onC('SRE-data', 'database', 'sre-store-computer.conf'), 'utf8')).toContain("listen_addresses = '127.0.0.1'");
    expect(readFileSync(onC('SRE-data', 'database', 'postgresql.conf'), 'utf8')).toContain(DB_CONF_INCLUDE);
    // … and the password file it was read from is gone.
    expect(readdirSync(onC('SRE-data', 'scratch'))).toEqual([]);
    // The application login: not a superuser, not BYPASSRLS — and its password went on standard input, never an argument.
    expect(win.psqlInputs[0]).toMatch(/CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L/);
    const psql = win.calls.find((c) => c.cmd.endsWith('psql.exe'))!;
    expect(psql.env?.['PGPASSWORD']).toBe(settingsIn(d.fs)['POSTGRES_PASSWORD']);
  });

  it('the API depends on the database; the till depends on nothing (it sells with both stopped, P-01); both restart on failure', async () => {
    const { d } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    const api = d.fs.readFileSync('C:\\SRE-data\\run\\services\\SRE-API.xml', 'utf8');
    const till = d.fs.readFileSync('C:\\SRE-data\\run\\services\\SRE-Till.xml', 'utf8');
    expect(api).toContain('<depend>SRE-Database</depend>');
    expect(till).not.toContain('<depend>');
    for (const xml of [api, till]) {
      expect(xml).toContain('<startmode>Automatic</startmode>');
      expect(xml).toContain('<onfailure action="restart" delay="10 sec"/>');
      expect(xml).toContain('<stoptimeout>30 sec</stoptimeout>');
    }
    expect(api).toContain('store-computer-service.mjs&quot; api --settings &quot;C:\\SRE-data\\.env.real&quot;');
    expect(till).toContain('store-computer-service.mjs&quot; till --settings &quot;C:\\SRE-data\\till\\till.env&quot;');
  });

  it('gives each service only its own folders, by SID — the API alone reads the settings file; the till alone writes the till folder', async () => {
    const { d, win } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    const grant = (target: string, name: string, rights: string): boolean => win.grants.some((g) => g[0] === target && g[2] === `*${serviceSid(name)}:${rights}`);
    expect(grant('C:\\SRE-data\\database', SERVICES.database, '(OI)(CI)M')).toBe(true);
    expect(grant('C:\\SRE-data\\.env.real', SERVICES.api, 'R')).toBe(true);
    expect(grant('C:\\SRE-data\\till', SERVICES.till, '(OI)(CI)M')).toBe(true);
    expect(grant('C:\\SRE-data\\logs\\SRE-Till', SERVICES.till, '(OI)(CI)M')).toBe(true);
    expect(grant('C:\\SRE', SERVICES.api, '(OI)(CI)RX')).toBe(true);
    // Nobody else's: the till never reads the head-office settings, the database never the till.
    expect(win.grants.some((g) => g[0] === 'C:\\SRE-data\\.env.real' && g[2]!.startsWith(`*${serviceSid(SERVICES.till)}`))).toBe(false);
    expect(win.grants.some((g) => g[0] === 'C:\\SRE-data\\till' && !g[2]!.startsWith(`*${serviceSid(SERVICES.till)}`))).toBe(false);
    // Never a whole-PC group.
    expect(win.grants.flat().some((a) => /Users|Everyone|S-1-1-0|S-1-5-32-545/.test(a))).toBe(false);
  });

  it('no secret is in any service definition, any argument, or any line said', async () => {
    const { w, d, win } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    const secrets = secretsOf(d);
    const xmls = ['SRE-API', 'SRE-Till'].map((n) => d.fs.readFileSync(`C:\\SRE-data\\run\\services\\${n}.xml`, 'utf8'));
    const args = win.calls.flatMap((c) => [c.cmd, ...c.args]);
    for (const s of secrets) {
      expect(said(w)).not.toContain(s);
      for (const x of xmls) expect(x).not.toContain(s);
      for (const a of args) expect(a).not.toContain(s);
    }
  });

  it('re-running changes nothing that is there: the database is kept, nothing is installed twice, the include is not repeated', async () => {
    const { w, d, win, onC } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    w.said.length = 0;
    expect(await main(INSTALL, d)).toBe(0);
    expect(win.initdbRuns).toBe(1);
    expect(win.hostInstalls).toEqual(['SRE-API', 'SRE-Till']);
    expect(win.calls.filter((c) => c.cmd.endsWith('pg_ctl.exe'))).toHaveLength(1);
    expect(readFileSync(onC('SRE-data', 'database', 'postgresql.conf'), 'utf8').split(DB_CONF_INCLUDE)).toHaveLength(2);
    expect(said(w)).toMatch(/The shop database in C:\\SRE-data\\database is kept as it is\./);
  });
});

describe('install-services refuses before it changes anything', () => {
  const nothingChanged = (win: PretendWin): void => {
    expect(win.calls.filter((c) => /initdb|pg_ctl|icacls|SRE-/.test(c.cmd))).toEqual([]);
    expect(win.services.size).toBe(0);
  };

  it('off Windows, it names the command that is for that computer', async () => {
    const w = world();
    expect(await main(['prepare'], w.deps)).toBe(0);
    w.said.length = 0;
    expect(await main(INSTALL, w.deps)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — Windows services are for the store computer \(Windows 10 or 11\)\. On this computer, use: pnpm run store-computer -- up$/m);
  });

  it('on a Windows Server (OB-282) — and a test machine is let through ONLY when GitHub says it is its own hosted machine AND the job asks', async () => {
    const { w, d, win } = await readyPc();
    w.windows.edition = { productType: 3, caption: 'Microsoft Windows Server 2022 Datacenter' };
    expect(await main(INSTALL, d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — this computer is a Windows Server/);
    nothingChanged(win);
    for (const env of [
      { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', SRE_TEST_ON_HOSTED_RUNNER: '1' },
      { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
      { RUNNER_ENVIRONMENT: 'github-hosted', SRE_TEST_ON_HOSTED_RUNNER: '1' },
    ]) expect(hostedTestMachine({ env })).toBe(false);
    const ci = { ...d, env: { ...d.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', SRE_TEST_ON_HOSTED_RUNNER: '1' } };
    w.said.length = 0;
    expect(await main(INSTALL, ci)).toBe(0);
    expect(said(w)).toMatch(/^TEST MACHINE — this is one of GitHub's throw-away Windows Server test machines/m);
  });

  it('without the PostgreSQL folder or the service host, or with the till not installed: each named, nothing changed', async () => {
    const { w, d, win } = await readyPc();
    expect(await main(['install-services'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — name the PostgreSQL 16 programs folder with --pg-bin/);
    expect(said(w)).toMatch(/REFUSED — name the service host program with --service-host/);
    w.said.length = 0;
    d.fs.rmSync('C:\\pgsql\\bin\\pg_ctl.exe');
    d.fs.rmSync('C:\\SRE-data\\till\\till.env');
    expect(await main(INSTALL, d)).toBe(2);
    expect(said(w)).toMatch(/the PostgreSQL folder C:\\pgsql\\bin has no pg_ctl\.exe/);
    expect(said(w)).toMatch(/the till is not installed in the data folder yet/);
    nothingChanged(win);
  });

  it('while this shop still runs in Docker — moving it across, data kept, is step 2 (the setup program)', async () => {
    const { w, d, win } = await readyPc();
    w.docker.ownRunning = ['sre-real-db-1', 'sre-real-api-1'];
    expect(await main(INSTALL, d)).toBe(2);
    expect(said(w)).toMatch(/still running in Docker \(project sre-real\).*CR-01, step 2/);
    nothingChanged(win);
  });

  it('a port another program holds is named; a folder that holds files but is not a database is never overwritten', async () => {
    const { w, d, win } = await readyPc();
    w.ports.add(8081);
    expect(await main(INSTALL, d)).toBe(1);
    expect(said(w)).toMatch(/NOT INSTALLED — port 8081 on this computer is already taken by another program/);
    nothingChanged(win);
    w.ports.clear();
    d.fs.mkdirSync('C:\\SRE-data\\database', { recursive: true });
    d.fs.writeFileSync('C:\\SRE-data\\database\\notes.txt', 'someone put this here');
    w.said.length = 0;
    expect(await main(INSTALL, d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — C:\\SRE-data\\database holds files but is not a database\. It is never overwritten\./);
    expect(win.initdbRuns).toBe(0);
  });

  it('a service that will not start is named with where its own words are', async () => {
    const { w, d, win } = await readyPc();
    const realSet = win.services.set.bind(win.services);
    win.services.set = (k, v) => realSet(k, k === SERVICES.till ? { ...v, startFails: true } : v);
    expect(await main(INSTALL, d)).toBe(1);
    expect(said(w)).toMatch(/NOT STARTED — SRE Retail OS - till \(store edge\) did not start\. Its own words are in C:\\SRE-data\\logs\\SRE-Till\./);
  });
});

describe('services-status and remove-services', () => {
  it('status: OK for each, the API ready → 0; a stopped one is FIX → 1', async () => {
    const { w, d, win } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    w.said.length = 0;
    expect(await main(['services-status'], d)).toBe(0);
    expect(said(w)).toMatch(/^OK {7}SRE Retail OS - office API \(SRE-API\): running; starts by itself; runs as NT SERVICE\\SRE-API\.$/m);
    win.services.get(SERVICES.till)!.state = 'stopped';
    w.said.length = 0;
    expect(await main(['services-status'], d)).toBe(1);
    expect(said(w)).toMatch(/^FIX {6}SRE Retail OS - till \(store edge\) \(SRE-Till\): stopped;/m);
  });

  it('remove: the till first, then the API, then the database — and the shop\'s data is all still there', async () => {
    const { w, d, win } = await readyPc();
    expect(await main(INSTALL, d)).toBe(0);
    w.said.length = 0;
    expect(await main(['remove-services'], d)).toBe(0);
    const deletes = win.calls.filter((c) => c.cmd === 'sc.exe' && c.args[0] === 'delete').map((c) => c.args[1]);
    expect(deletes).toEqual([SERVICES.till, SERVICES.api, SERVICES.database]);
    expect(win.services.size).toBe(0);
    for (const kept of ['C:\\SRE-data\\database\\PG_VERSION', 'C:\\SRE-data\\.env.real', 'C:\\SRE-data\\till\\till.env']) expect(d.fs.existsSync(kept)).toBe(true);
    expect(said(w)).toMatch(/Kept, untouched: the shop database/);
  });
});

describe('what each service is handed when it starts (the launcher, scripts/store-computer-service.mjs)', () => {
  const settings = {
    DATABASE_URL: pgUrl('sre_app', 'abc123', 'db:5432', 'sre_real'), POSTGRES_PORT: '5433', POSTGRES_PASSWORD: 'abc123', PACK_SIGNING_KEY: 'p'.repeat(48),
    BOX_HISTORY_SEAL_KEY: 's'.repeat(48), IDP_SIGNING_KEY: 'i'.repeat(48), IDP_ISSUER: 'iss', IDP_AUDIENCE: 'aud', EDGE_TENANT_ID: 't-1', MIGRATION_TARGET_KIND: 'rehearsal',
  };
  it('the API: only what compose hands the API container, the database on this PC, listening on this PC only', () => {
    const env = serviceEnv('api', settings, { SystemRoot: 'C:\\Windows' }, 'C:\\SRE');
    expect(env).toMatchObject({ DATABASE_URL: pgUrl('sre_app', 'abc123', '127.0.0.1:5433', 'sre_real'), PORT: '8081', API_LISTEN_HOST: '127.0.0.1', NODE_ENV: 'production', SystemRoot: 'C:\\Windows', TZ: 'Asia/Kolkata' });
    expect(env['POSTGRES_PASSWORD']).toBeUndefined();
    expect(env['EDGE_TENANT_ID']).toBeUndefined();
    for (const k of Object.keys(env)) expect([...API_KEYS, 'PORT', 'API_LISTEN_HOST', 'NODE_ENV', 'SystemRoot', 'TZ']).toContain(k);
  });
  it('the till: its own till.env and this release\'s screens — never a wider screen address', () => {
    const env = serviceEnv('till', { EDGE_TENANT_ID: 't-1', EDGE_LANE_PORT: '8090', EDGE_SCREEN_HOST: '0.0.0.0' }, {}, 'C:\\SRE');
    expect(env).toMatchObject({ EDGE_TENANT_ID: 't-1', EDGE_LANE_PORT: '8090', EDGE_APPS_DIR: 'C:\\SRE\\apps' });
    expect(env['EDGE_SCREEN_HOST']).toBeUndefined();
  });
  it('a database address that is not the compose name is left as it is', () => {
    expect(hostDatabaseUrl(pgUrl('u', 'p', '10.0.0.5:5432', 'x'), '5432')).toBe(pgUrl('u', 'p', '10.0.0.5:5432', 'x'));
  });
});

describe('the pieces, on their own', () => {
  it('a service\'s SID is the one Windows makes (TrustedInstaller, as `sc showsid` prints it)', () => {
    expect(serviceSid('TrustedInstaller')).toBe('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
    expect(serviceSid('trustedinstaller')).toBe(serviceSid('TrustedInstaller'));
    expect(Object.values(OWN_SERVICE_SIDS)).toEqual([SERVICES.database, SERVICES.api, SERVICES.till]);
    expect(accountOf('SRE-API')).toBe('NT SERVICE\\SRE-API');
  });
  it('the database set-up SQL is the containers\' first-boot SQL: the shop database, an application role that is not a superuser', () => {
    const sql = databaseSetupSql({ db: 'sre_real', app: 'sre_app', password: 'a'.repeat(48) });
    expect(sql).toContain("SELECT format('CREATE DATABASE %I', 'sre_real') WHERE NOT EXISTS");
    expect(sql).toContain('GRANT CONNECT, TEMPORARY ON DATABASE "sre_real" TO "sre_app";');
    expect(sql).toContain('GRANT ALL ON SCHEMA public TO "sre_app";');
  });
  it('a service definition names only paths', () => {
    const P = servicePaths({ platform: 'win32', repoRoot: 'C:\\SRE', dataRoot: 'D:\\SRE-data', pgBin: 'C:\\pg\\bin', serviceHost: 'C:\\w.exe', nodePath: 'C:\\node\\node.exe' });
    expect(hostXml(P, SERVICES.till)).toContain('<executable>C:\\node\\node.exe</executable>');
    expect(hostXml(P, SERVICES.till)).toContain('<logpath>D:\\SRE-data\\logs\\SRE-Till</logpath>');
  });
});

describe('the data-folder lock counts the shop\'s own three services as its own (OB-284 still holds for everyone else)', () => {
  it('the API\'s account reading the settings file: OK; the Users group: still FIX', async () => {
    const { w, d } = await readyPc();
    const L = layout('C:\\SRE', 'win32', 'C:\\SRE-data');
    w.windows.acl['c:\\sre-data\\.env.real'] = [...lockedAcl(), { sid: serviceSid(SERVICES.api), name: 'NT SERVICE\\SRE-API', rights: 1179785 }];
    expect(dataLockRow(d, L, d.dataPointer)).toMatchObject({ status: 'OK', detail: expect.stringMatching(/only you, Windows itself \(SYSTEM\) and the shop's own services can read/) });
    w.windows.acl['c:\\sre-data\\.env.real'] = [...lockedAcl(), { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users', rights: 1179817 }];
    expect(dataLockRow(d, L, d.dataPointer)).toMatchObject({ status: 'FIX' });
    expect(OWNER_SID).not.toBe(serviceSid(SERVICES.api));
  });
});

describe('the API listens on this PC only when told, and only a loopback address is accepted (ADR-0032)', () => {
  const base = {
    DATABASE_URL: pgUrl('u', 'p', '127.0.0.1:5432', 'x'), PACK_SIGNING_KEY: 'k'.repeat(48), BOX_HISTORY_SEAL_KEY: 'b'.repeat(48),
    IDP_SIGNING_KEY: 'i'.repeat(48), IDP_ISSUER: 'iss', IDP_AUDIENCE: 'aud',
  };
  it('127.0.0.1 and ::1 are accepted; anything wider refuses the start, by name', () => {
    for (const host of ['127.0.0.1', '::1']) {
      const c = loadConfig(CLOUD_API_CONFIG, { ...base, API_LISTEN_HOST: host });
      expect(c.problems.filter((p) => p.key === 'API_LISTEN_HOST')).toEqual([]);
    }
    const wide = loadConfig(CLOUD_API_CONFIG, { ...base, API_LISTEN_HOST: '0.0.0.0' });
    expect(wide.problems).toContainEqual(expect.objectContaining({ key: 'API_LISTEN_HOST', problem: 'not_one_of_the_allowed_values' }));
  });
});
