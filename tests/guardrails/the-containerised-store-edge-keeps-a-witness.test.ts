import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { posix } from 'node:path';

/**
 * **Verifier r19 OB87-1 — the containerised store edge keeps its bill-number witness.** The edge runs with a read-only root
 * and, until r19, only its data volume: the witness folder (`EDGE_WITNESS_DIR`, by default `<data>-witness`) could not be
 * opened, so every restart looked like a possible restore and the box took a brand-new "ZZ" prefix each boot. This proves,
 * for the store's compose file and for the hosted demo's overlay on top of it (the deploy and the canary run exactly those
 * files — infra/deploy/release.sh `SRE_COMPOSE_FILES`):
 *   • the edge sets EDGE_WITNESS_DIR, and mounts a NAMED volume there of its own (writable under `read_only: true`);
 *   • that folder is not the data folder and not inside it, and the volume is not the data volume (a backup of edge-data
 *     must never carry it);
 *   • the volume is declared, and the image makes the folder and gives it to the user the edge runs as;
 *   • the CI container job checks the running container can write it (the pattern of the job's other live checks).
 * When the docker CLI is present it also asks `docker compose config` for the merged result (as CI's container job does).
 */

const BASE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
const DOCKERFILE = readFileSync('infra/docker/edge.Dockerfile', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');

interface Svc { environment?: Record<string, string> | string[]; volumes?: (string | { type?: string; source?: string; target?: string; read_only?: boolean })[]; read_only?: boolean }
interface Compose { services: Record<string, Svc>; volumes?: Record<string, unknown> }

/**
 * The edge service and the top-level volumes of a compose file, read from its text (the repository's guardrails read compose
 * files as text — no YAML library is a dependency): `environment:` KEY: value lines, `volumes:` `- source:target[:mode]`
 * items, `read_only:`. Comments and blank lines are skipped.
 */
function load(yaml: string): Compose {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === '  edge:');
  const rest = start === -1 ? [] : lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  const block = end === -1 ? rest : rest.slice(0, end);
  const edge: { environment: Record<string, string>; volumes: string[]; read_only?: boolean } = { environment: {}, volumes: [] };
  let section = '';
  for (const l of block) {
    if (/^\s*(#.*)?$/.test(l)) continue;
    const key = /^ {4}([a-z_]+):\s*(.*)$/.exec(l);
    if (key !== null) { section = key[1]!; if (section === 'read_only') edge.read_only = key[2]!.trim() === 'true'; continue; }
    if (section === 'environment') {
      const kv = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(l);
      if (kv !== null) edge.environment[kv[1]!] = kv[2]!.trim().replace(/^'(.*)'$/, '$1');
    } else if (section === 'volumes') {
      const item = /^ {6}- (.+)$/.exec(l);
      if (item !== null) edge.volumes.push(item[1]!.trim());
    }
  }
  const top = lines.findIndex((l) => l === 'volumes:');
  const volumes: Record<string, unknown> = {};
  if (top !== -1) for (const l of lines.slice(top + 1)) { if (/^\S/.test(l)) break; const v = /^ {2}([a-z0-9-]+):/.exec(l); if (v !== null) volumes[v[1]!] = {}; }
  return { services: { edge }, volumes };
}

const env = (s: Svc): Record<string, string> => (Array.isArray(s.environment)
  ? Object.fromEntries(s.environment.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
  : (s.environment ?? {}));
const mounts = (s: Svc): { source: string; target: string; type: string; readOnly: boolean }[] => (s.volumes ?? []).map((v) => {
  if (typeof v === 'string') {
    const [source, target, mode] = v.split(':');
    return { source: source!, target: target!, type: source!.startsWith('.') || source!.startsWith('/') || source!.startsWith('$') ? 'bind' : 'volume', readOnly: mode === 'ro' };
  }
  return { source: v.source ?? '', target: v.target ?? '', type: v.type ?? 'volume', readOnly: v.read_only === true };
});
const inside = (inner: string, outer: string): boolean => {
  const rel = posix.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
};

function judge(c: Compose): void {
  const edge = c.services['edge']!;
  expect(edge.read_only).toBe(true);
  const e = env(edge);
  const data = e['EDGE_DATA_DIR']!;
  const witness = e['EDGE_WITNESS_DIR'];
  expect(witness, 'the edge must name its witness folder').toBeTruthy();
  expect(inside(witness!, data), 'the witness folder must not be the data folder or inside it').toBe(false);
  const m = mounts(edge);
  const dataMount = m.find((x) => x.target === data);
  const witnessMount = m.find((x) => x.target === witness);
  expect(dataMount?.type).toBe('volume');
  expect(witnessMount, 'a volume must be mounted at the witness folder (the root is read-only)').toBeDefined();
  expect(witnessMount!.type).toBe('volume');
  expect(witnessMount!.readOnly).toBe(false);
  expect(witnessMount!.source).not.toBe(dataMount!.source);
  // Mounted under no other mount of the edge's either (a bind over its parent would hide it).
  for (const other of m) if (other !== witnessMount && other.target !== witness) expect(inside(witness!, other.target)).toBe(false);
  expect(Object.keys(c.volumes ?? {}), 'the witness volume must be declared').toContain(witnessMount!.source);
}

describe('OB87-1: the containerised store edge keeps a witness outside its data volume', () => {
  it('the store compose file gives the edge a separate, writable witness volume', () => {
    judge(load(BASE) as Compose);
  });

  it('the hosted demo overlay (the deploy and the canary run base + overlay) keeps it', () => {
    const base = load(BASE) as Compose;
    const pilot = load(PILOT) as Compose;
    // Compose MERGES a service's environment and its volumes by target; a `!override` would replace them — the overlay must not.
    const pilotEdge = PILOT.slice(PILOT.indexOf('\n  edge:\n'), PILOT.indexOf('\n  edge:\n') + 1 + PILOT.slice(PILOT.indexOf('\n  edge:\n') + 1).search(/\n {2}\S/));
    expect(pilotEdge).toContain('EDGE_LANE_PORT');
    expect(pilotEdge).not.toContain('!override');
    expect(env(pilot.services['edge']!)['EDGE_WITNESS_DIR']).toBeUndefined();
    expect(mounts(pilot.services['edge']!).some((x) => x.target === env(base.services['edge']!)['EDGE_WITNESS_DIR'])).toBe(false);
    const merged: Compose = {
      services: {
        edge: {
          read_only: pilot.services['edge']!.read_only ?? base.services['edge']!.read_only,
          environment: { ...env(base.services['edge']!), ...env(pilot.services['edge']!) },
          volumes: [...(base.services['edge']!.volumes ?? []), ...(pilot.services['edge']!.volumes ?? [])],
        },
      },
      volumes: { ...(base.volumes ?? {}), ...(pilot.volumes ?? {}) },
    };
    judge(merged);
  });

  it('the image makes the witness folder and gives it to the user the edge runs as', () => {
    const witness = env((load(BASE) as Compose).services['edge']!)['EDGE_WITNESS_DIR']!;
    expect(DOCKERFILE).toContain(`mkdir -p ${witness} && chown sre:sre ${witness}`);
    expect(DOCKERFILE).toMatch(new RegExp(`VOLUME \\[[^\\]]*"${witness.replace(/[/-]/g, (c) => `\\${c}`)}"`));
    expect(DOCKERFILE.indexOf(`chown sre:sre ${witness}`)).toBeLessThan(DOCKERFILE.indexOf('USER sre'));
  });

  it('CI\'s container job checks the running edge can write its witness and says it keeps it', () => {
    expect(CI).toContain('The store edge keeps its bill-number witness');
    expect(CI).toMatch(/exec -T edge sh -c[^\n]*EDGE_WITNESS_DIR/);
  });

  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  it.skipIf(docker.status !== 0)('docker compose config agrees (base, and base + the hosted demo overlay)', () => {
    const envFile = 'infra/compose/.env.example';
    for (const files of [['docker-compose.yml'], ['docker-compose.yml', 'docker-compose.pilot.yml']]) {
      const out = execFileSync('docker', ['compose', '--env-file', envFile.replace('infra/compose/', ''), ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], { cwd: 'infra/compose', encoding: 'utf8' });
      judge(JSON.parse(out) as Compose);
    }
  });
});
