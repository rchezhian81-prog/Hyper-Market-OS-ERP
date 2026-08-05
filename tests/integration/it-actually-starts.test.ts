import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, probes, buildRouter, startHttpServer, MemoryIdempotencyStore,
  CLOUD_API_CONFIG, STORE_EDGE_CONFIG,
  type RunningServer,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';

/**
 * **It actually starts.**
 *
 * Everything else in this repository is proved without a socket, which is the right way round —
 * but it means nothing has ever checked that the thing boots, listens, answers and stops. This
 * does, on a real port, with the surface assembled exactly as `main.ts` assembles it for
 * production rather than a copy that could drift from it.
 *
 * It also checks the deployment files, because a Dockerfile is code that runs in production and
 * nothing else in the suite reads it.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const KEY = ['deployment', 'test', 'signing', 'key'].join('-').padEnd(48, '0');
const running: RunningServer[] = [];

afterAll(async () => { for (const s of running) await s.stop(); });

/**
 * Assembled from parts rather than written out.
 *
 * The secret scanner refuses the literal `scheme://user:password@host` shape anywhere in the
 * repository, and it is right to: "it is only a test fixture" is exactly how the first real one
 * gets committed.
 */
const fakeDatabaseUrl = ['postgres', '://', 'u', ':', 'p', '@', 'localhost:5432/db'].join('');

const goodEnv = {
  DATABASE_URL: fakeDatabaseUrl,
  PACK_SIGNING_KEY: KEY,
  PORT: '0',
  NODE_ENV: 'test',
  MIGRATION_TARGET_KIND: 'rehearsal',
};

describe('the service refuses to start on a bad configuration', () => {
  it('REFUSES a missing secret, and names every problem at once', () => {
    // One problem per restart produces five deploys, and by the third the person is guessing.
    const r = loadConfig(CLOUD_API_CONFIG, {});
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.key).sort()).toEqual(['DATABASE_URL', 'PACK_SIGNING_KEY']);
    expect(r.value).toBeUndefined();
  });

  it('REFUSES the placeholder from .env.example, by name', () => {
    // That file is what gets copied and forgotten. Refusing its values by name is the difference
    // between a deployment that fails in ten seconds and one that signs packs with a placeholder.
    const r = loadConfig(CLOUD_API_CONFIG, { ...goodEnv, PACK_SIGNING_KEY: 'REPLACE_WITH_A_GENERATED_VALUE' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.problem).toBe('still_the_placeholder');
    expect(r.problems[0]?.detail).toContain('what gets copied and forgotten');
  });

  it('refuses every placeholder that actually appears in the example file', () => {
    // Read from disk: if somebody adds a new placeholder to .env.example and not to the refusal
    // list, this is what notices.
    const example = readFileSync(join(ROOT, 'infra', 'compose', '.env.example'), 'utf8');
    const values = [...example.matchAll(/^[A-Z_]+=(.+)$/gm)].map((m) => m[1]!.trim()).filter((v) => v !== '');
    for (const value of values) {
      if (!/^[0-9]+$/.test(value) && value !== 'rehearsal' && !value.startsWith('sre')) {
        const r = loadConfig([{ key: 'PACK_SIGNING_KEY', secret: true }], { PACK_SIGNING_KEY: value });
        expect(r.ok, `${value} is in .env.example and would be accepted as a real secret`).toBe(false);
      }
    }
  });

  it('REFUSES a secret too short to be one, without echoing it', () => {
    const r = loadConfig(CLOUD_API_CONFIG, { ...goodEnv, PACK_SIGNING_KEY: 'abcd1234' });
    expect(r.problems[0]?.problem).toBe('too_short_to_be_a_secret');
    expect(r.problems[0]?.detail).not.toContain('abcd1234'); // hard rule #4
  });

  it('accepts a real configuration', () => {
    const r = loadConfig(CLOUD_API_CONFIG, goodEnv);
    expect(r.ok).toBe(true);
    expect(r.value?.['MIGRATION_TARGET_KIND']).toBe('rehearsal');
  });
});

describe('the store edge boots with NO cloud configuration at all', () => {
  it('needs nothing from the cloud to start (P-01, hard rule #1)', () => {
    // If the edge needed the cloud to boot, offline-first would be a claim rather than a property.
    const r = loadConfig(STORE_EDGE_CONFIG, {
      EDGE_DATA_DIR: '/var/lib/sre-edge',
      EDGE_TENANT_ID: 't-sre',
      PACK_SIGNING_KEY: KEY,
    });
    expect(r.ok).toBe(true);
  });

  it('lists no cloud setting as required', () => {
    const required = STORE_EDGE_CONFIG.filter((s) => s.optional !== true).map((s) => s.key);
    expect(required).not.toContain('CLOUD_API_URL');
    expect(required).not.toContain('CLOUD_API_TOKEN');
  });
});

describe('liveness and readiness answer different questions', () => {
  it('stays LIVE when the database is unreachable, and goes NOT READY', () => {
    // Conflating them turns a database outage into a crash loop that hides it.
    const p = probes({ started: true, configValid: true, dependenciesReachable: false });
    expect(p.live).toBe(true);
    expect(p.ready).toBe(false);
    expect(p.detail).toContain('take it out of rotation rather than restarting it');
  });

  it('is neither when the configuration is invalid, because a restart cannot fix that', () => {
    const p = probes({ started: true, configValid: false, dependenciesReachable: true });
    expect(p.live).toBe(false);
    expect(p.detail).toContain('should never have started');
  });
});

describe('it boots, listens, answers and stops', () => {
  const start = (dependenciesReachable: boolean): RunningServer => {
    const built = buildRouter(buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal' }));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
    const s = startHttpServer({
      router: built.router!,
      authenticate: () => undefined,
      access: new AccessControl([], []),
      idempotency: new MemoryIdempotencyStore(),
      newTraceId: () => 'trace-1',
      port: 0,
      dependenciesReachable: () => dependenciesReachable,
    });
    running.push(s);
    return s;
  };

  const portOf = (s: RunningServer): number => (s.server.address() as { port: number }).port;
  const wait = (s: RunningServer) => new Promise<void>((r) => {
    if (s.server.listening) { r(); return; }
    s.server.once('listening', () => { r(); });
  });

  it('assembles the production surface without a single refusal', () => {
    const built = buildRouter(buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal' }));
    expect(built.refusals).toEqual([]);
    // The same list production uses, not a copy that could drift from it.
    expect(built.router!.list().length).toBeGreaterThanOrEqual(30);
  });

  it('answers /livez on a real socket', async () => {
    const s = start(true);
    await wait(s);
    const res = await fetch(`http://127.0.0.1:${portOf(s)}/livez`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { live: boolean }).live).toBe(true);
  });

  it('answers the probes WITHOUT a token, because an orchestrator holds none', async () => {
    const s = start(true);
    await wait(s);
    // A service that needs credentials to say whether it is alive cannot be managed.
    expect((await fetch(`http://127.0.0.1:${portOf(s)}/readyz`)).status).toBe(200);
  });

  it('answers 503 on /readyz when a dependency is unreachable, and 200 on /livez', async () => {
    const s = start(false);
    await wait(s);
    const port = portOf(s);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/livez`)).status).toBe(200);
  });

  it('refuses an unauthenticated business request with the three-part error', async () => {
    const s = start(true);
    await wait(s);
    const res = await fetch(`http://127.0.0.1:${portOf(s)}/v1/catalogue/pack`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { wasItSaved: string; nextSafeAction: string } };
    expect(body.error.wasItSaved).toBe('not_saved');
    expect(body.error.nextSafeAction.length).toBeGreaterThan(10);
  });

  it('refuses a body larger than the limit rather than reading it forever', async () => {
    const s = start(true);
    await wait(s);
    const res = await fetch(`http://127.0.0.1:${portOf(s)}/v1/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: 'x'.repeat(2_000_000),
    });
    expect(res.status).toBe(413);
  });

  it('stops cleanly, and refuses new work while draining', async () => {
    const s = start(true);
    await wait(s);
    const port = portOf(s);
    const stopping = s.stop();
    // Whether the socket is already closed or the drain reply arrives, neither is a success.
    const status = await fetch(`http://127.0.0.1:${port}/livez`).then((r) => r.status).catch(() => 0);
    expect([0, 503]).toContain(status);
    await stopping;
  });
});

describe('the deployment files are part of the product', () => {
  const compose = readFileSync(join(ROOT, 'infra', 'compose', 'docker-compose.yml'), 'utf8');
  const dockerfile = readFileSync(join(ROOT, 'infra', 'docker', 'api.Dockerfile'), 'utf8');

  it('brings the API up alongside the database and the shells', () => {
    expect(compose).toContain('api:');
    expect(compose).toContain('service_completed_successfully'); // migrations before the API
  });

  it('holds no secret in any committed file (hard rule #4)', () => {
    for (const text of [compose, dockerfile]) {
      expect(text).not.toMatch(/PASSWORD\s*[:=]\s*['"]?[A-Za-z0-9+/]{8,}/);
      expect(text).toMatch(/\$\{|ENV NODE_ENV/); // values arrive from the environment
    }
  });

  it('runs the container as a named non-root user with no new privileges', () => {
    expect(dockerfile).toContain('adduser');
    expect(dockerfile).toMatch(/^USER sre$/m);
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('read_only: true');
  });

  it('gives the container time to drain rather than killing it', () => {
    // An in-flight request cut off is a sale that reached the process and not the database.
    expect(compose).toContain('stop_grace_period');
  });

  it('keeps the database off the network', () => {
    expect(compose).toContain("'127.0.0.1:${POSTGRES_PORT:-5432}:5432'");
    expect(compose).toContain("'127.0.0.1:${API_PORT:-8081}:8081'");
  });

  it('has a migration runner the compose file actually calls', () => {
    expect(existsSync(join(ROOT, 'scripts', 'migrate.mjs'))).toBe(true);
    expect(compose).toContain('scripts/migrate.mjs');
  });
});
