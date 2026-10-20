// A pretend store computer for the store-computer setup's tests (scripts/lib/store-computer.mjs): a temporary repository
// folder holding the real infra/compose/.env.example, a pretend Docker (no Docker is needed), a pretend API, and every
// line the tool says captured — so a test can look for a secret in everything the owner would see.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Deps, SpawnResult } from '../../scripts/lib/store-computer.mjs';

/** The real repository: the tests run from its root (as every suite here does). */
export const REAL_REPO = resolve(process.cwd());

export interface PretendDocker {
  installed: boolean;
  running: boolean;
  compose: boolean;
  volumes: string[];
  demoContainers: string[];
  ownRunning: string[];
  databases: string[];
  upStatus: number;
}

export interface Call { readonly cmd: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: Record<string, string | undefined> }

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
export function world(over: Partial<Deps> = {}, opts: { realNode?: boolean; sliceStdout?: (args: readonly string[]) => { status: number; stdout: string } } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'sre-store-computer-'));
  mkdirSync(join(root, 'infra', 'compose'), { recursive: true });
  copyFileSync(join(REAL_REPO, 'infra', 'compose', '.env.example'), join(root, 'infra', 'compose', '.env.example'));
  const said: string[] = [];
  const calls: Call[] = [];
  const sliceSettingsSeen: string[] = [];
  const docker: PretendDocker = { installed: true, running: true, compose: true, volumes: ['sre-real_db-data'], demoContainers: [], ownRunning: [], databases: ['postgres', 'sre_real'], upStatus: 0 };
  const api = { ready: true, readyAfter: 0, asked: 0 };
  const ports = new Set<number>();

  const spawn = (cmd: string, args: readonly string[], o: { cwd?: string; env?: Record<string, string | undefined> }): SpawnResult => {
    calls.push({ cmd, args: [...args], ...(o.cwd === undefined ? {} : { cwd: o.cwd }), ...(o.env === undefined ? {} : { env: o.env }) });
    if (cmd === 'docker') {
      if (!docker.installed) return { status: null, error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) };
      if (args[0] === '--version') return { status: 0, stdout: 'Docker version 27.0.0\n' };
      if (args[0] === 'info') return docker.running ? { status: 0, stdout: '27.0.0\n' } : { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      if (args[0] === 'compose' && args[1] === 'version') return { status: docker.compose ? 0 : 1, stdout: '' };
      if (args[0] === 'ps') {
        const label = args.find((a) => a.startsWith('label='));
        if (label?.endsWith('=sre-pilot')) return { status: 0, stdout: docker.demoContainers.join('\n') };
        return { status: 0, stdout: docker.ownRunning.join('\n') };
      }
      if (args[0] === 'volume') return { status: 0, stdout: docker.volumes.join('\n') };
      if (args[0] === 'compose' && args.includes('up')) return { status: docker.upStatus };
      if (args[0] === 'compose' && args.includes('ps')) return { status: 0, stdout: 'NAME   SERVICE   STATUS\nsre-real-db-1   db   running (healthy)\nsre-real-api-1   api   running\n' };
      if (args[0] === 'compose' && args.includes('exec')) return docker.running ? { status: 0, stdout: `${docker.databases.join('\n')}\n` } : { status: 1, stdout: '' };
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
