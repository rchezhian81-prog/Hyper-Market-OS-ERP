import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The box pulls its own catalogue** (SYNC-01 inc 2, audit GAP-SYNC-01).
 *
 * The outbox drain carried sales UP; nothing carried prices/recalls DOWN, so the box read its pack
 * from a file once at boot and never again. This wires the inbound pull (`pullPack`) into the same
 * poll loop as the drain: the box fetches the signed pack, the lane decides whether to trust it
 * (`acceptPack`), a newer verified pack is adopted and persisted atomically, and — the property that
 * matters — whatever happens, the lane keeps trading on the last pack it trusted (P-01).
 *
 * Driven through `edge.refreshPack()`, which is the same code the timer calls, exposed so this proves
 * one real pull without waiting fifteen seconds.
 */

const KEY = ['box', 'pulls', 'catalogue', 'signing', 'key'].join('-').padEnd(48, '0');
const SIGNER = hmacSigner(KEY);
const TENANT = 't-sre';
const TOKEN = ['edge', 'cloud', 'token'].join('-').padEnd(40, 'w');

function signedPack(version: number, tenantId = TENANT): SignedPack {
  const snapshot: CatalogueSnapshot = {
    tenantId, version, builtAt: `2026-08-0${version}T09:00:00Z`,
    products: [{ productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: SIGNER, publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

// A tiny stand-in cloud that serves GET /v1/catalogue/pack from a mutable response.
let served: { status: number; body: string } = { status: 200, body: JSON.stringify(signedPack(1)) };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/catalogue/pack') {
      res.writeHead(served.status, { 'content-type': 'application/json' });
      res.end(served.body);
      return;
    }
    res.writeHead(404); res.end(); // the drain posts to /v1/sales; the outbox is empty here
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr !== null ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-box-pull-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const envFor = (dataDir: string, cloudUrl = baseUrl) => ({
  EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
  EDGE_CAPACITY_BYTES: '10485760', CLOUD_API_URL: cloudUrl, CLOUD_API_TOKEN: TOKEN,
});

describe('the box pulls its catalogue (SYNC-01 inc 2)', () => {
  it('fetches a signed pack, adopts it, and persists it — surviving a reboot', async () => {
    served = { status: 200, body: JSON.stringify(signedPack(2)) };
    const dir = await tempDir();
    const said: string[] = [];
    const edge = (await startEdge(envFor(dir), (l) => said.push(l)))!;

    const outcome = await edge.refreshPack!();
    expect(outcome.status).toBe('updated');
    expect(outcome.heldVersion).toBe(2);
    expect(edge.node.pack()?.snapshot.version).toBe(2); // the lane really moved
    expect(said.join('\n')).toContain('Catalogue updated to v2');
    await edge.stop();

    // Reboot on the SAME disk: the pack is restored, no pull needed.
    const said2: string[] = [];
    const rebooted = (await startEdge(envFor(dir), (l) => said2.push(l)))!;
    expect(rebooted.node.pack()?.snapshot.version).toBe(2);
    expect(said2.join('\n')).toContain('catalogue pack v2 restored from disk');
    await rebooted.stop();
  });

  it('keeps the last good pack when the offered one does not verify', async () => {
    served = { status: 200, body: JSON.stringify({ ...signedPack(2), signature: 'deadbeef'.repeat(8) }) };
    const dir = await tempDir();
    const edge = (await startEdge(envFor(dir), () => {}))!;
    const outcome = await edge.refreshPack!();
    expect(outcome.status).toBe('kept'); // a forged pack was refused
    expect(edge.node.pack()).toBeUndefined(); // and nothing was adopted
    await edge.stop();
  });

  it('reports none_published on a 404, keeping any held pack', async () => {
    served = { status: 404, body: '' };
    const dir = await tempDir();
    const edge = (await startEdge(envFor(dir), () => {}))!;
    expect((await edge.refreshPack!()).status).toBe('none_published');
    await edge.stop();
  });

  it('stays on the last good pack when the cloud is unreachable', async () => {
    // First adopt v1 from the live server, then point a fresh box at a dead port.
    served = { status: 200, body: JSON.stringify(signedPack(1)) };
    const dir = await tempDir();
    const primed = (await startEdge(envFor(dir), () => {}))!;
    await primed.refreshPack!();
    await primed.stop();

    // Reboot pointing at a port nothing listens on: the restored pack is kept, the pull is 'offline'.
    const edge = (await startEdge(envFor(dir, 'http://127.0.0.1:1'), () => {}))!;
    expect(edge.node.pack()?.snapshot.version).toBe(1); // restored from disk
    const outcome = await edge.refreshPack!();
    expect(outcome.status).toBe('offline');
    expect(edge.node.pack()?.snapshot.version).toBe(1); // unchanged — kept trading (P-01)
    await edge.stop();
  });

  it('starts from no pack when the file on disk is tampered, rather than trusting it', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'signed-pack.json'), JSON.stringify({ ...signedPack(2), signature: 'deadbeef'.repeat(8) }));
    const edge = (await startEdge(envFor(dir, 'http://127.0.0.1:1'), () => {}))!;
    expect(edge.node.pack()).toBeUndefined(); // a bad on-disk pack is not a baseline
    await edge.stop();
  });
});
