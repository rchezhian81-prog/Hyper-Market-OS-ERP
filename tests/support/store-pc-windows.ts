// A pretend Windows store PC for the store-computer tool's Windows-services and setup tests (CR-01 steps 1 and 2): Windows
// paths mapped onto temporary folders, and sc.exe, icacls.exe, PostgreSQL's programs, the service host and the till
// install answering as they would. NOTHING HERE IS REAL WINDOWS — the clean-Windows CI jobs are.

import { expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { main, parseEnvText, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import { world, type World } from './store-computer-world';

/** This copy's settings, read on the pretend PC (C:\\SRE-data\\.env.real). */
export const settingsIn = (fs: Deps['fs'], dataRoot = 'C:\\SRE-data'): Record<string, string> => parseEnvText(fs.readFileSync(`${dataRoot}\\.env.real`, 'utf8')) as Record<string, string>;

export interface PretendService { state: 'running' | 'stopped'; auto: boolean; account: string; startFails?: boolean }
export interface PretendWin {
  services: Map<string, PretendService>;
  calls: { cmd: string; args: string[]; env?: Record<string, string | undefined>; input?: string }[];
  started: string[];
  grants: string[][];
  initdbRuns: number;
  hostInstalls: string[];
  psqlInputs: string[];
  tillInstalls: string[][];
}

/**
 * The owner's store PC (Windows 11 Pro), with Windows paths mapped onto temporary folders: C:\SRE is the world's release
 * folder; every other C:\… is <tmp>/drive-c/…. `sc.exe`, `icacls.exe`, PostgreSQL's programs and the service host answer
 * as Windows would; Docker answers from the world (no copy of this shop running in it).
 */
export function storePc(w: World, over: Partial<Deps> = {}): { d: Deps; win: PretendWin; onC: (...p: string[]) => string } {
  const drives = `${w.root}-drives`;
  for (const l of ['c', 'f']) mkdirSync(join(drives, `drive-${l}`), { recursive: true });
  const map = (p: unknown): unknown => {
    if (typeof p !== 'string' || !/^[A-Za-z]:(\\|$)/.test(p)) return p;
    if (/^C:\\SRE(\\|$)/i.test(p)) return w.root + p.slice(6).replace(/\\/g, '/');
    return join(drives, `drive-${p[0]!.toLowerCase()}`, p.slice(3).replace(/\\/g, '/'));
  };
  const onC = (...p: string[]): string => map(win32.join('C:\\', ...p)) as string;
  const fs = new Proxy(nodeFs, { get: (t, k) => { const f = (t as Record<string | symbol, unknown>)[k]; return typeof f === 'function' ? (...a: unknown[]) => (f as (...x: unknown[]) => unknown).apply(t, a.map(map)) : f; } }) as Deps['fs'];
  const win: PretendWin = { services: new Map(), calls: [], started: [], grants: [], initdbRuns: 0, hostInstalls: [], psqlInputs: [], tillInstalls: [] };
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
      expect(fs.readFileSync(pw, 'utf8').trim()).toBe(settingsIn(fs, win32.dirname(dir))['POSTGRES_PASSWORD']); // the password reached initdb …
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
    if (String(args[0]).endsWith('install-till.mjs')) {
      const settingsFile = args[args.indexOf('--settings') + 1]!;
      const s = parseEnvText(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string>;
      const tillDir = win32.join(win32.dirname(settingsFile), 'till');
      fs.mkdirSync(tillDir, { recursive: true });
      fs.writeFileSync(win32.join(tillDir, 'till.env'), `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=${tillDir}\\edge-data\n`);
      win.tillInstalls.push([...args]);
      return { status: 0 };
    }
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
export async function readyPc(over: Partial<Deps> = {}): Promise<{ w: World; d: Deps; win: PretendWin; onC: (...p: string[]) => string }> {
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
