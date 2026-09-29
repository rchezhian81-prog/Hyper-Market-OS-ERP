import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';

/**
 * **A receipt template PUBLISHED at head office reaches the till through the real edge, and survives a reboot
 * with the cable out (M01-FR-02 · §31 · P-01 · P-08).**
 *
 * One person drafts the receipt wording, a DIFFERENT person approves it, it is published (the real routes). The
 * real `startEdge` pulls the versions in force (`GET /v1/org/document-templates/published`, under the box's own
 * identity), lays them into the lane's pack, persists them, and the SERVED till page carries them as
 * `window.posReceiptTemplate` — the header, the footer and the VERSION to stamp on every bill. Only the socket is
 * replaced. Then: a reboot with no cloud restores the set from disk; a second version published later supersedes
 * the first on the box; and the box's identity may read what is in force but not the setup register.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa1e';
const KEY = ['edge', 'templates', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const PADMIN = 'u-padmin'; const SYNC = 'u-sync';
const BASE = '/v1/org/document-templates';

const RECEIPT_V1 = { header: ['SRE Hyper Market', '12 Bazaar Street, Tirunelveli 627001', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you — please visit again'], language: 'en_ta', paperFormat: 'thermal-80' };
const RECEIPT_V2 = { ...RECEIPT_V1, footer: ['Thank you — please visit again', 'Returns within 7 days with this bill'] };

interface ServedTemplate { version: number; header: string[]; footer: string[]; paperFormat?: string; ageHours: number }

describe('the published receipt template reaches the till through the real edge (M01-FR-02, §31)', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  const post = (path: string, u: string, key: string, body?: unknown) =>
    h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });

  /** The served till page, read over the box's loopback screens socket — with the REAL fetch, not the cloud stub. */
  const servedReceiptTemplate = async (port: number): Promise<ServedTemplate | undefined> => {
    const html = await (await savedFetch(`http://127.0.0.1:${port}/pos/`)).text();
    const m = /<script>window\.posReceiptTemplate = (.*?);<\/script>/.exec(html);
    return m === null ? undefined : JSON.parse(m[1]!) as ServedTemplate;
  };

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, PADMIN, 'platform_admin');
    await h.provisionRole(A, SYNC, 'cashier'); // the store box's sync identity: org.template.pull, no setup read

    // Head office puts a receipt template in force: draft → a second person approves → publish (the real routes).
    expect((await post(`${BASE}/receipt/versions`, OWNER, 'dt-1', { content: RECEIPT_V1, note: 'first bill layout' })).status).toBe(201);
    expect((await post(`${BASE}/receipt/versions/1/approve`, PADMIN, 'dt-2')).status).toBe(200);
    expect((await post(`${BASE}/receipt/versions/1/publish`, OWNER, 'dt-3')).status).toBe(200);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-templates-'));
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: SYNC, tenantId: A }),
  });

  it('the box pulls the version in force under its own identity, and the SERVED till page carries it — header, footer and the version to stamp', async () => {
    const edge = (await startEdge(env(), () => {}))!;
    try {
      // Before the pull: the till is told nothing about a template — it prints with its defaults and stamps no version.
      expect(await servedReceiptTemplate(edge.screens!.port)).toBeUndefined();
      const pull = await edge.refreshPublishedTemplates!();
      expect(pull).toMatchObject({ status: 'updated', receiptVersion: 1 });
      const served = await servedReceiptTemplate(edge.screens!.port);
      expect(served).toMatchObject({ version: 1, header: RECEIPT_V1.header, footer: RECEIPT_V1.footer, paperFormat: 'thermal-80' });
      expect(typeof served?.ageHours).toBe('number');
    } finally {
      await edge.stop();
    }
  });

  it('a reboot with the cable out restores the set from disk — the till keeps printing v1, and the box says so', async () => {
    online = false;
    const said: string[] = [];
    const edge = (await startEdge(env(), (l) => said.push(l)))!;
    try {
      expect(said.join('\n')).toContain('receipts print with template v1');
      expect(await servedReceiptTemplate(edge.screens!.port)).toMatchObject({ version: 1, header: RECEIPT_V1.header });
      // Offline, the pull keeps what is held and names it.
      const pull = await edge.refreshPublishedTemplates!();
      expect(pull).toMatchObject({ status: 'offline', receiptVersion: 1 });
    } finally {
      online = true;
      await edge.stop();
    }
  });

  it('a second version published at head office supersedes the first on the box — the till moves to v2', async () => {
    expect((await post(`${BASE}/receipt/versions`, PADMIN, 'dt-4', { content: RECEIPT_V2, note: 'returns line' })).status).toBe(201);
    expect((await post(`${BASE}/receipt/versions/2/approve`, OWNER, 'dt-5')).status).toBe(200);
    const published = await post(`${BASE}/receipt/versions/2/publish`, PADMIN, 'dt-6');
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ version: 2, state: 'published', supersededVersion: 1 });

    const edge = (await startEdge(env(), () => {}))!;
    try {
      expect(await servedReceiptTemplate(edge.screens!.port)).toMatchObject({ version: 1 }); // restored: still v1 until the pull
      const pull = await edge.refreshPublishedTemplates!();
      expect(pull).toMatchObject({ status: 'updated', receiptVersion: 2 });
      expect(await servedReceiptTemplate(edge.screens!.port)).toMatchObject({ version: 2, footer: RECEIPT_V2.footer });
      // The same set again is re-confirmed quietly, not re-announced.
      expect((await edge.refreshPublishedTemplates!()).status).toBe('unchanged');
    } finally {
      await edge.stop();
    }
  });

  it('the box\'s identity may read what is IN FORCE and nothing else — the setup register, drafts and names stay behind platform.setup.read', async () => {
    const inForce = await h.request({ method: 'GET', path: `${BASE}/published`, userId: SYNC, tenantId: A });
    expect(inForce.status).toBe(200);
    const body = inForce.body as { tenantId: string; templates: { kind: string; version: number; publishedAt: string }[] };
    expect(body.tenantId).toBe(A);
    expect(body.templates).toEqual([expect.objectContaining({ kind: 'receipt', version: 2 })]);
    expect(JSON.stringify(inForce.body)).not.toContain('u-owner'); // no names travel to the box
    expect((await h.request({ method: 'GET', path: BASE, userId: SYNC, tenantId: A })).status).toBe(403);
    expect((await h.request({ method: 'GET', path: `${BASE}/receipt`, userId: SYNC, tenantId: A })).status).toBe(403);
  });
});
