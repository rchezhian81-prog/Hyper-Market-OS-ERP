// W3: one fixture for an office page proved in ONE connected run — the screen, the store computer and the real cloud on
// PostgreSQL together (the evidence ledger's "Browser (connected)" kind, docs/evidence/TEST-SCOPE.md §4).
//
//   • head office is the PRODUCTION API assembly (`startRealCloud`) over real PostgreSQL — no in-memory harness, no stub;
//   • the page is served by a REAL store computer (`startEdge`, its screen socket), which checks the person's own words in its
//     signed pack before it serves the page — and those words are head office's own answer for that person
//     (`GET /v1/identity/me` under their token), never typed in the test;
//   • every `/v1` call the page makes on the box's origin reaches the real API under THAT person's own signed token, with its
//     body and idempotency key — the part the box's head-office link plays in the shop (OB-388 · ADR-0029; its sign-in is
//     proven in `month-end-opens-through-the-store-computer-after-head-office-sign-in.e2e.ts`). Nothing in between answers.
//
// Synthetic data only. Skips (in the callers) without DATABASE_URL or the pre-installed Chromium.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../../edge/store-edge/src/main';
import { issueTillPins } from '../../support/till-operator';
import { deviceBase, sharedDeviceTls, trustingBrowserArgs } from '../../support/box-tls';
import { startRealCloud, type RealCloud } from '../../support/real-store';
import { TEST_IDP, type ApiHarness } from '../../support/api-harness';
import { SqlEventStore } from '../../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../../packages/persistence/src/pg-client';
import { makeEvent } from '../../../packages/contracts/src/event';
import { STREAM } from '../../../services/api/src/adapters';

export const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
export const DATABASE_URL = process.env['DATABASE_URL'];
/** Both a browser and a real database: the run is connected, or it does not run. */
export const CONNECTED = existsSync(CHROMIUM) && DATABASE_URL !== undefined;
export const OWNER = 'u-owner';

/** A person the box knows: their id, and the store their sign-in names (their token's branch claim), if any. */
export interface BoxPerson { readonly userId: string; readonly branchId?: string }

export interface Reply { readonly status: number; readonly body: unknown }

export interface BoxCloudShop {
  readonly cloud: RealCloud;
  readonly tenantId: string;
  readonly store: string;
  /** A head-office call as `who` (setup a second person does outside the page) — the real API, over HTTP. */
  call(method: 'GET' | 'POST' | 'PUT', path: string, who: string, body?: unknown, branchId?: string): Promise<Reply>;
  /** Open `path` on the store computer as `who`. Every `/v1` call the page makes is listed (`writes`: the non-GETs). */
  open(who: string, path: string, opts?: { readonly acceptDownloads?: boolean }): Promise<{ page: Page; status: number; errors: string[]; reads: string[]; writes: string[]; close(): Promise<void> }>;
  /** W4: the real store computer itself (its sync agent, pulls and queues). */
  readonly edge: EdgeProcess;
  /**
   * W4 (`phones` given): open `path` on the box's DEVICE socket (https, trusted the way an enrolled handheld trusts the box)
   * in a phone-sized browser. The phone talks only to the box — never to head office (P-01).
   */
  phone(path: string, opts?: BrowserContextOptions): Promise<{ page: Page; errors: string[]; close(): Promise<void> }>;
  stop(): Promise<void>;
}

/**
 * W4: the box's own link to head office, as a shop's store computer is installed — its machine identity (`boxUser`, which
 * the caller's seed grants `store_computer` for the store), so its sync agent carries the phones' and tills' work up and its
 * pulls bring head office's assignments, terms and (with `storePackFromHeadOffice`, OB-26 "A") its whole signed setup down.
 */
export interface BoxLink { readonly boxUser: string; readonly storePackFromHeadOffice?: boolean }

/**
 * The real API seen through the in-memory harness's `request` shape, so the shared setup helpers (`tests/support/*`, which
 * take an `ApiHarness`) drive the real cloud unchanged. Only `request` is offered; anything else is refused loudly.
 */
export function harnessOver(cloud: RealCloud): ApiHarness {
  const request: ApiHarness['request'] = async (r) => {
    const qs = r.query === undefined ? '' : `${r.path.includes('?') ? '&' : '?'}${new URLSearchParams(r.query).toString()}`;
    const res = await fetch(`${cloud.baseUrl}${r.path}${qs}`, {
      method: r.method,
      headers: {
        authorization: `Bearer ${TEST_IDP.issue({ sub: r.userId, tenantId: cloud.tenantId, ...(r.branchId === undefined ? {} : { branchId: r.branchId }) })}`,
        ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(r.idempotencyKey === undefined ? {} : { 'idempotency-key': r.idempotencyKey }),
      },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text === '' ? null : JSON.parse(text); } catch { /* not JSON — as it came */ }
    return { status: res.status, body, headers: {} } as Awaited<ReturnType<ApiHarness['request']>>;
  };
  return new Proxy({ request } as unknown as ApiHarness, {
    get: (target, prop) => {
      if (prop === 'request') return request;
      if (prop === 'then') return undefined;
      throw new Error(`harnessOver: the real cloud offers only request(), not ${String(prop)}`);
    },
  });
}

/**
 * A role the owner may not hand out himself (a machine identity, or a role carrying permissions he does not hold) — laid
 * on the ledger by the operator, exactly as `scripts/bootstrap-tenant.ts` does for an initial admin.
 */
export async function operatorGrant(cloud: RealCloud, userId: string, roleId: string, branchScope: readonly string[] | 'all' = 'all'): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
  try {
    const at = new Date().toISOString();
    const grantId = `${roleId}-${userId}`;
    await new SqlEventStore(pgPoolClient(pool)).append(cloud.tenantId, STREAM.identity, makeEvent({
      id: `grant-${grantId}-${cloud.tenantId}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${cloud.tenantId}-${roleId}-${userId}`, source: 'test/w3-connected',
      payload: { userId, roleId, branchScope, request: { grantId, userId, roleId, branchScope, requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
    }));
  } finally { await pool.end(); }
}

export async function ok(p: Promise<Reply>, label: string): Promise<unknown> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function startBoxPageOnCloud(input: {
  readonly name: string;
  /** Everyone who opens a page on the box. Their words in the box's pack are head office's answer for them. */
  readonly people: readonly BoxPerson[];
  readonly seed: (cloud: RealCloud, h: ApiHarness, store: string) => Promise<void>;
  /** The box's own store (default `store-1`). */
  readonly store?: string;
  /** W4: the box's own link to head office (default: none — the page's calls reach head office through the browser). */
  readonly link?: BoxLink;
  /** W4: open the box's device socket for the phones; `pins` are the people whose till PINs the box's administrator issues. */
  readonly phones?: { readonly pins: readonly string[] };
}): Promise<BoxCloudShop> {
  if (DATABASE_URL === undefined) throw new Error('startBoxPageOnCloud needs DATABASE_URL');
  execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
  const tenantId = randomUUID();
  const store = input.store ?? 'store-1';
  const key = ['w3', input.name, 'connected', 'key'].join('-').padEnd(48, '0');
  const cloud = await startRealCloud({ databaseUrl: DATABASE_URL, tenantId, owner: OWNER, packSigningKey: key });
  const h = harnessOver(cloud);
  const branchOf = new Map(input.people.map((p) => [p.userId, p.branchId]));
  const tokenOf = (who: string, branchId = branchOf.get(who)): string => TEST_IDP.issue({ sub: who, tenantId, ...(branchId === undefined ? {} : { branchId }) });
  const call: BoxCloudShop['call'] = async (method, path, who, body, branchId) => {
    const r = await h.request({
      method, path, userId: who, ...(branchId ?? branchOf.get(who) ? { branchId: (branchId ?? branchOf.get(who))! } : {}), tenantId,
      ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
    });
    return { status: r.status, body: r.body };
  };

  let edge: EdgeProcess | undefined;
  let browser: Browser | undefined;
  const dir = await mkdtemp(join(tmpdir(), `sre-w3c-${input.name}-`));
  const tls = input.phones === undefined ? undefined : await sharedDeviceTls();
  try {
    await input.seed(cloud, h, store);
    if (input.phones !== undefined) await issueTillPins(dir, key, input.phones.pins);
    // The box's pack names each person with head office's own words for them — what the box checks before it serves a page.
    const roles: { id: string; name: string; permissions: string[] }[] = [];
    for (const p of input.people) {
      const me = (await call('GET', '/v1/identity/me', p.userId)).body as { permissions?: string[] };
      roles.push({ id: `r-${p.userId}`, name: p.userId, permissions: [...new Set(['identity.self.read', ...(me.permissions ?? [])])] });
    }
    const packFile = join(dir, 'store-pack.json');
    const fromHeadOffice = input.link?.storePackFromHeadOffice === true;
    if (!fromHeadOffice) await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: store, branchId: store },
      roles, roleAssignments: input.people.map((p) => ({ userId: p.userId, roleId: `r-${p.userId}`, branchScope: [store] })),
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenantId, PACK_SIGNING_KEY: key, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
      ...(fromHeadOffice ? { EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: store } : { EDGE_PACK_FILE: packFile }),
      ...(input.link === undefined ? {} : { CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: input.link.boxUser, tenantId, branchId: store }) }),
      ...(tls === undefined ? {} : { EDGE_DEVICE_PORT: '0', EDGE_DEVICE_TLS_DIR: tls.dir }),
    }, () => {}))!;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, ...(tls === undefined ? {} : { args: trustingBrowserArgs(tls.keyPin) }) });
  } catch (e) {
    await browser?.close(); await edge?.stop(); await cloud.stop(); await rm(dir, { recursive: true, force: true });
    throw e;
  }
  const box = edge;
  const b = browser;

  return {
    cloud, tenantId, store, call, edge: box,
    phone: async (path, opts) => {
      if (tls === undefined) throw new Error('this box was started without `phones`, so it has no device socket');
      const context = await b.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...opts });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${deviceBase(box)}${path}`, { waitUntil: 'load' });
      return { page, errors, close: () => context.close() };
    },
    open: async (who, path, opts) => {
      const context = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who }, acceptDownloads: opts?.acceptDownloads === true });
      const reads: string[] = []; const writes: string[] = [];
      await context.route('**/v1/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        (req.method() === 'GET' ? reads : writes).push(`${req.method()} ${url.pathname}`);
        const raw = req.postDataBuffer();
        const headers = req.headers();
        let upstream: Response;
        try {
          upstream = await fetch(`${cloud.baseUrl}${url.pathname}${url.search}`, {
          method: req.method(),
          headers: {
            authorization: `Bearer ${tokenOf(who)}`,
            ...(headers['content-type'] === undefined ? {} : { 'content-type': headers['content-type'] }),
            ...(headers['idempotency-key'] === undefined ? {} : { 'idempotency-key': headers['idempotency-key'] }),
          },
          ...(raw === null || raw.length === 0 ? {} : { body: raw }),
          });
        } catch {
          // Head office cannot be reached: the call fails as a lost link does (the page must say so, P-08).
          await route.abort('connectionrefused');
          return;
        }
        await route.fulfill({ status: upstream.status, contentType: upstream.headers.get('content-type') ?? 'application/json', body: Buffer.from(await upstream.arrayBuffer()) });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(`http://127.0.0.1:${box.screens!.port}${path}`, { waitUntil: 'load' });
      return { page, status: res?.status() ?? 0, errors, reads, writes, close: () => context.close() };
    },
    stop: async () => { await b.close(); await box.stop(); await cloud.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); if (tls !== undefined) await rm(join(tls.dir, '..'), { recursive: true, force: true }); },
  };
}
