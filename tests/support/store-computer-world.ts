// A pretend store computer for the store-computer setup's tests (scripts/lib/store-computer.mjs): a temporary repository
// folder holding the real infra/compose/.env.example, a pretend Docker (no Docker is needed), a pretend API, and every
// line the tool says captured — so a test can look for a secret in everything the owner would see.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeSync } from 'node:fs';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Deps, SpawnResult } from '../../scripts/lib/store-computer.mjs';

/** The real repository: the tests run from its root (as every suite here does). */
export const REAL_REPO = resolve(process.cwd());

/** What a pretend database holds: row counts per table, money per event type, the newest event, the migrations applied. */
export interface PretendDb { tables: Record<string, number>; values: Record<string, number>; maxSeq: number; migrations: string[] }

export interface PretendDocker {
  installed: boolean;
  running: boolean;
  compose: boolean;
  volumes: string[];
  demoContainers: string[];
  ownRunning: string[];
  databases: string[];
  upStatus: number;
  /** The databases' contents (this copy's sre_real, and any scratch database a restore made). */
  data: Record<string, PretendDb>;
  /** The scratch databases that were dropped, in order. */
  dropped: string[];
  /** pg_dump's exit code inside the pretend container (0 = a good dump). */
  dumpExit: number;
  /** Rows the pretend pg_restore loses from the first table — a restore that does NOT reconcile. */
  restoreLoses: number;
  /** pg_restore's exit code. */
  restoreStatus: number;
  /** DROP DATABASE fails when true. */
  dropFails: boolean;
  /** The compose file the running API was started from (compose's config_files label). */
  apiFrom: string | undefined;
  /** `up` per folder: its exit code (default 0). */
  upStatusIn: (cwd: string) => number;
  /** A migration the previous release's `migrate` would add (a release that is not a clean rollback). */
  previousAddsMigration: string | undefined;
}

export interface Call {
  readonly cmd: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: Record<string, string | undefined>;
  readonly input?: string; readonly stdio?: unknown;
}

/** The pretend psql/pg_dump/pg_restore inside the pretend container. Exported for the tests that check the SQL itself. */
export const DUMP_PREFIX = 'PGDMP';
const totalsOf = (d: PretendDb): string => [
  ...Object.keys(d.tables).sort().map((t) => `ROWS|${t}|${d.tables[t]}`),
  ...Object.keys(d.values).sort().map((t) => `VAL|${t}|${d.values[t]}`),
  `SEQ|${d.maxSeq}`,
  ...[...d.migrations].sort().map((m) => `MIG|${m}`),
].join('\n');

export interface World {
  readonly root: string;
  readonly said: string[];
  readonly calls: Call[];
  readonly docker: PretendDocker;
  readonly api: { ready: boolean; readyAfter: number; asked: number };
  readonly ports: Set<number>;
  /** What each node command was given as its settings file, read at the moment it ran. */
  readonly sliceSettingsSeen: string[];
  deps: Deps;
}

/** `realNode`: run node commands (the tools build and migration:slice) for real, from the real repository. */
export function world(over: Partial<Deps> = {}, opts: { realNode?: boolean; sliceStdout?: (args: readonly string[]) => { status: number; stdout: string }; costOf?: (cmd: string, args: readonly string[], input?: string) => number } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'sre-store-computer-'));
  mkdirSync(join(root, 'infra', 'compose'), { recursive: true });
  copyFileSync(join(REAL_REPO, 'infra', 'compose', '.env.example'), join(root, 'infra', 'compose', '.env.example'));
  const said: string[] = [];
  const calls: Call[] = [];
  const sliceSettingsSeen: string[] = [];
  const docker: PretendDocker = {
    installed: true, running: true, compose: true, volumes: ['sre-real_db-data'], demoContainers: [], ownRunning: [], databases: ['postgres', 'sre_real'], upStatus: 0,
    data: { sre_real: { tables: { event_ledger: 4, products: 12, schema_migrations: 2 }, values: { SaleCommitted: 100_000 }, maxSeq: 4, migrations: ['0001_a.sql', '0002_b.sql'] } },
    dropped: [], dumpExit: 0, restoreLoses: 0, restoreStatus: 0, dropFails: false, apiFrom: undefined, upStatusIn: () => 0, previousAddsMigration: undefined,
  };
  const api = { ready: true, readyAfter: 0, asked: 0 };
  const ports = new Set<number>();

  const spawn = (cmd: string, args: readonly string[], o: { cwd?: string; env?: Record<string, string | undefined>; input?: string; stdio?: unknown }): SpawnResult => {
    calls.push({ cmd, args: [...args], ...(o.cwd === undefined ? {} : { cwd: o.cwd }), ...(o.env === undefined ? {} : { env: o.env }), ...(o.input === undefined ? {} : { input: o.input }), ...(o.stdio === undefined ? {} : { stdio: o.stdio }) });
    clock += opts.costOf?.(cmd, args, o.input) ?? 0;
    if (cmd === 'docker') {
      if (!docker.installed) return { status: null, error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) };
      if (args[0] === '--version') return { status: 0, stdout: 'Docker version 27.0.0\n' };
      if (args[0] === 'info') return docker.running ? { status: 0, stdout: '27.0.0\n' } : { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      if (args[0] === 'compose' && args[1] === 'version') return { status: docker.compose ? 0 : 1, stdout: '' };
      if (args[0] === 'ps' && args.includes('label=com.docker.compose.service=api')) return { status: 0, stdout: docker.apiFrom === undefined ? '' : `${docker.apiFrom}\n` };
      if (args[0] === 'ps') {
        const label = args.find((a) => a.startsWith('label='));
        if (label?.endsWith('=sre-pilot')) return { status: 0, stdout: docker.demoContainers.join('\n') };
        return { status: 0, stdout: docker.ownRunning.join('\n') };
      }
      if (args[0] === 'volume') return { status: 0, stdout: docker.volumes.join('\n') };
      if (args[0] === 'compose' && args.includes('up')) {
        const status = docker.upStatus !== 0 ? docker.upStatus : docker.upStatusIn(o.cwd ?? '');
        if (status === 0 && args.includes('--build')) {
          docker.apiFrom = join(o.cwd ?? '', args[args.indexOf('-f') + 1]!);
          const prevAdds = docker.previousAddsMigration;
          if (prevAdds !== undefined && !(o.cwd ?? '').startsWith(root)) docker.data['sre_real']!.migrations.push(prevAdds);
        }
        return { status };
      }
      if (args[0] === 'compose' && args.includes('ps')) return { status: 0, stdout: 'NAME   SERVICE   STATUS\nsre-real-db-1   db   running (healthy)\nsre-real-api-1   api   running\n' };
      if (args[0] === 'compose' && args.includes('exec')) {
        if (!docker.running) return { status: 1, stdout: '', stderr: 'service "db" is not running' };
        const program = args[args.indexOf('db') + 1];
        const target = args[args.indexOf('-d') + 1]!;
        const sql = args.includes('-c') ? args[args.indexOf('-c') + 1]! : (args.includes('-Atc') ? args[args.indexOf('-Atc') + 1]! : undefined);
        const fd = Array.isArray(o.stdio) ? o.stdio : [];
        if (program === 'pg_restore') {
          const text = readFileSync(fd[0] as number, 'latin1');
          if (!text.startsWith(DUMP_PREFIX)) return { status: 1, stderr: 'pg_restore: error: input file does not appear to be a valid archive' };
          const d = JSON.parse(text.slice(DUMP_PREFIX.length)) as PretendDb;
          const first = Object.keys(d.tables).sort()[0];
          if (docker.restoreLoses > 0 && first !== undefined) d.tables[first] = d.tables[first]! - docker.restoreLoses;
          docker.data[target] = d;
          return { status: docker.restoreStatus, stderr: docker.restoreStatus === 0 ? '' : 'pg_restore: error: could not execute query: ERROR:  pretend\n' };
        }
        if (sql !== undefined && /^SELECT datname FROM pg_database/.test(sql)) return { status: 0, stdout: `${[...new Set([...docker.databases, ...Object.keys(docker.data)])].join('\n')}\n` };
        if (sql !== undefined && /^CREATE DATABASE "([a-z0-9_]+)"$/.test(sql)) {
          const name = /"([a-z0-9_]+)"/.exec(sql)![1]!;
          if (name in docker.data) return { status: 1, stderr: `ERROR:  database "${name}" already exists` };
          docker.data[name] = { tables: {}, values: {}, maxSeq: 0, migrations: [] };
          return { status: 0, stdout: '' };
        }
        if (sql !== undefined && /^DROP DATABASE "([a-z0-9_]+)"$/.test(sql)) {
          if (docker.dropFails) return { status: 1, stderr: 'ERROR:  database is being accessed by other users' };
          const name = /"([a-z0-9_]+)"/.exec(sql)![1]!;
          docker.dropped.push(name);
          delete docker.data[name];
          return { status: 0, stdout: '' };
        }
        if (o.input !== undefined && o.input.includes('pg_export_snapshot')) {
          const d = docker.data[target]!;
          writeSync(fd[1] as number, `${DUMP_PREFIX}${JSON.stringify(d)}`);
          return { status: 0, stderr: `SNAP|00000003-0000001B-1\n${totalsOf(d)}\nDUMPEXIT|${docker.dumpExit}\nDONE|\n` };
        }
        if (o.input !== undefined) {
          const d = docker.data[target];
          return d === undefined ? { status: 2, stderr: `FATAL:  database "${target}" does not exist` } : { status: 0, stdout: `${totalsOf(d)}\n` };
        }
        return { status: 0, stdout: `${docker.databases.join('\n')}\n` };
      }
      return { status: 1, stdout: '' };
    }
    // node: the tools build and the slice command.
    const settingsAt = args.indexOf('--settings');
    if (settingsAt !== -1) sliceSettingsSeen.push(readFileSync(args[settingsAt + 1]!, 'utf8'));
    if (opts.realNode === true) {
      const r = spawnSync(cmd, [...args], { cwd: REAL_REPO, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (args.includes('tools')) return { status: 0, stdout: 'tools bundle written\n' };
    if (opts.sliceStdout !== undefined) return opts.sliceStdout(args);
    const manifest = JSON.parse(readFileSync(join(args[args.indexOf('--dir') + 1]!, 'slice.json'), 'utf8')) as { tenantId: string };
    const seen = sliceSettingsSeen[sliceSettingsSeen.length - 1] ?? '';
    if (/^MIGRATION_TARGET_KIND=production$/m.test(seen)) return { status: 1, stdout: 'REFUSED (production_target) — pretend\n' };
    if (manifest.tenantId === 'pilot-demo') return { status: 1, stdout: 'REFUSED (demo_tenant) — pretend\n' };
    return { status: 0, stdout: 'staged\n' };
  };

  let clock = Date.parse('2026-10-20T04:30:00.000Z');
  const deps: Deps = {
    repoRoot: root,
    platform: 'linux',
    env: {},
    fs,
    spawn,
    fetch: async () => {
      api.asked += 1;
      const ready = api.ready && api.asked > api.readyAfter;
      return { ok: ready, json: async () => ({ ready }) };
    },
    portInUse: async (port: number) => ports.has(port),
    sleep: async (ms: number) => { clock += ms; },
    now: () => new Date(clock),
    random: (n: number) => randomBytes(n),
    uuid: () => randomUUID(),
    os: { totalmem: () => 16 * 1024 ** 3, release: () => '6.8.0', version: () => 'Linux' },
    freeDiskBytes: () => 200 * 1024 ** 3,
    timeZone: () => 'Asia/Kolkata',
    nodeVersion: 'v22.11.0',
    nodePath: process.execPath,
    tmpdir: () => tmpdir(),
    say: (line: string) => { said.push(line); },
    ...over,
  };
  return { root, said, calls, docker, api, ports, sliceSettingsSeen, deps };
}

/** This copy's settings, as written. */
export const settingsOf = (w: World): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(join(w.root, 'infra', 'compose', '.env.real'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
  }
  return out;
};
