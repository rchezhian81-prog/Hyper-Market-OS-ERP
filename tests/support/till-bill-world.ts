// Test support for the till-bill package (audit-1 P5 · audit-2 P3): head office on the in-memory event store OR real
// PostgreSQL (each restartable COLD), a real store computer reaching it through a stand-in fetch whose line can be cut,
// and helpers to start / restart that box on the same disk. Synthetic data only (hard rule #7); nothing here is a secret.

import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from './api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, type TillPerson } from './till-operator';

export { TEST_PACK_KEY };

/** One head-office backing: how to build it and how to restart it cold over the same data. */
export interface Backing {
  readonly name: string;
  readonly harness: () => ApiHarness;
  readonly restart: (h: ApiHarness) => ApiHarness;
}

/**
 * The backings a test runs on — always the in-memory store; real PostgreSQL too when `DATABASE_URL` is set (an EMPTY database
 * is fine: the migrations run first). Call `openBackings()` in `beforeAll` and `closeBackings()` in `afterAll`.
 */
export function backingsFor(databaseUrl: string | undefined): { readonly backings: Backing[]; readonly open: () => Promise<void>; readonly close: () => Promise<void> } {
  let pool: Pool | undefined;
  const backings: Backing[] = [{ name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) }];
  if (databaseUrl !== undefined) {
    const onPg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
    backings.push({ name: 'real PostgreSQL, head office restarted cold', harness: onPg, restart: () => onPg() });
  }
  return {
    backings,
    open: async () => {
      if (databaseUrl === undefined) return;
      pool = new Pool({ connectionString: databaseUrl, max: 6, options: '-c app.tenant_id=*' });
      const dir = 'db/migrations';
      await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    },
    close: async () => { await pool?.end(); },
  };
}

/** A head office for one fresh tenant, with the request helpers a scenario needs, and a cold restart. */
export interface HeadOffice {
  readonly tenantId: string;
  h: ApiHarness;
  call(method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>, branchId?: string): Promise<{ status: number; body: unknown }>;
  ok(method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Record<string, unknown>>;
  restartCold(): void;
}

export async function headOffice(backing: Backing, cast: readonly { readonly userId: string; readonly role: string; readonly stores?: readonly string[] }[] = []): Promise<HeadOffice> {
  const tenantId = randomUUID();
  let n = 0;
  const office: HeadOffice = {
    tenantId,
    h: backing.harness(),
    call: async (method, path, userId, body, query, branchId) => office.h.request({
      method, path, userId, tenantId, ...(branchId === undefined ? {} : { branchId }),
      ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }),
      ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }),
    }),
    ok: async (method, path, userId, body, query) => {
      const r = await office.call(method, path, userId, body, query);
      if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as Record<string, unknown>;
    },
    restartCold: () => { office.h = backing.restart(office.h); },
  };
  await office.h.seedOwner(tenantId, 'u-owner');
  for (const c of cast) await office.h.provisionRole(tenantId, c.userId, c.role, c.stores ?? 'all');
  return office;
}

/** The store computer's link to head office: a stand-in for `fetch` that the test can cut (`online = false`). */
export interface Link { online: boolean; restore(): void }

export function linkBoxTo(office: HeadOffice, boxUser: string, storeId: string): Link {
  const saved = globalThis.fetch;
  const link: Link = {
    online: true,
    restore: () => { globalThis.fetch = saved; },
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
    if (!link.online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    const res = await office.h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname,
      token: TEST_IDP.issue({ sub: boxUser, tenantId: office.tenantId, branchId: storeId }),
      ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
      ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams.entries()) }),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
  return link;
}

/** A store computer on its own disk, startable again on the same disk (a cold restart). */
export interface Box {
  readonly dir: string;
  edge: EdgeProcess;
  /** Stop the box process and start a new one on the same disk. */
  restartCold(): Promise<EdgeProcess>;
  stop(): Promise<void>;
  remove(): Promise<void>;
}

export async function startBox(input: {
  readonly tenantId: string;
  readonly people: readonly TillPerson[];
  readonly pack: Record<string, unknown>;
  /** Head office's address (the stand-in fetch answers it); absent = a box with no head office at all. */
  readonly cloud?: { readonly boxUser: string; readonly storeId: string };
  readonly env?: Record<string, string>;
}): Promise<Box> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-till-bill-'));
  const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: input.people, pack: input.pack });
  const env = {
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: input.tenantId, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    ...(input.cloud === undefined ? {} : {
      CLOUD_API_URL: 'https://cloud.example.test',
      CLOUD_API_TOKEN: TEST_IDP.issue({ sub: input.cloud.boxUser, tenantId: input.tenantId, branchId: input.cloud.storeId }),
    }),
    ...ready, ...(input.env ?? {}),
  };
  const start = async (): Promise<EdgeProcess> => {
    const e = await startEdge(env, () => {});
    if (e === undefined) throw new Error('the store computer refused to start');
    return e;
  };
  const box: Box = {
    dir,
    edge: await start(),
    restartCold: async () => { await box.edge.stop(); box.edge = await start(); return box.edge; },
    stop: async () => { await box.edge.stop(); },
    remove: async () => { await rm(dir, { recursive: true, force: true }); },
  };
  return box;
}

/** The plain store pack a till box needs (store, trading day, a refund policy). */
export function storePack(storeId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policies: {
      storeId, branchId: storeId, branchName: 'SRE Hyper Market', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
      handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', ...extra,
    },
    servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
    lossPreventionRules: [],
  };
}
