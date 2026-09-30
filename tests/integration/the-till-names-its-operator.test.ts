import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';

/**
 * **Every sale names who rang it, on which lane, on which day — and head office checks the name (SP-4b · W02 · audit
 * finding F09 · M12-FR-01 · M02 · §28 · hard rule #4).**
 *
 * Before SP-4b the served till wrote cashier `cashier`, lane `lane-1` and trading day `1970-01-01` on every sale. This
 * proves the three sources that replace the placeholders, on real services: the store BOX knows which lane it is
 * (`EDGE_LANE_ID`) and tells the served till, together with the shop's trading-day cut-off; the box also stamps its lane
 * on a record that names none, exactly as it stamps the store; and the CLOUD re-verifies the cashier a sale names from
 * their grants — an unknown or unauthorised name, a blank cashier, lane or day is a material finding on the sale, never a
 * refusal of a sale that happened. Synthetic data (hard rule #7); the browser leg is `the-served-till-takes-a-sale.e2e.ts`.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T09:00:00.000Z';
const KEY = ['till', 'names', 'its', 'operator', 'signing', 'key'].join('-').padEnd(48, '0');

interface Banked { banked: boolean; exceptions: { kind: string; severity: string }[] }
const kinds = (res: { body: unknown }): string[] => (res.body as Banked).exceptions.map((e) => e.kind);

const sale = (over: Record<string, unknown> = {}) => ({
  saleId: 'S-1', receiptNumber: 'R-0001', laneId: 'lane-7', cashierId: 'u-meena', tradingDay: '2026-09-30', committedAt: AT,
  totalMinor: 16_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 16_000, lineTotalMinor: 16_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amountMinor: 16_000 }],
  ...over,
});
const bank = (h: ApiHarness, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: key, body });

/** The cast: a real cashier, a person with no till authority, the box's sync identity; the catalogue the till priced from. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-meena', 'cashier');   // rings sales — holds pos.sale.sync
  await h.provisionRole(A, 'u-box', 'cashier');     // the store box's sync identity
  await h.provisionRole(A, 'u-visitor', 'customer'); // a known person with NO till authority
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [{ productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false }],
        barcodes: [],
      },
    },
  }));
  return h;
}

describe('the cloud re-verifies who rang the sale (F09 · §28 · hard rule #4)', () => {
  it('a sale by a provisioned cashier carries no attribution finding; an unknown name, a person with no till authority, and a blank cashier are each a material finding — and the sale is banked either way', async () => {
    const h = await seeded();
    const clean = await bank(h, sale(), 'k1');
    expect(clean.status).toBe(202);
    expect((clean.body as Banked).banked).toBe(true);
    expect(kinds(clean)).not.toEqual(expect.arrayContaining(['cashier_unknown', 'cashier_lacks_authority', 'sale_names_no_cashier']));

    const ghost = await bank(h, sale({ saleId: 'S-2', receiptNumber: 'R-0002', cashierId: 'u-ghost' }), 'k2');
    expect((ghost.body as Banked).banked).toBe(true);
    expect(kinds(ghost)).toContain('cashier_unknown');

    const visitor = await bank(h, sale({ saleId: 'S-3', receiptNumber: 'R-0003', cashierId: 'u-visitor' }), 'k3');
    expect(kinds(visitor)).toContain('cashier_lacks_authority');

    const nobody = await bank(h, sale({ saleId: 'S-4', receiptNumber: 'R-0004', cashierId: '', laneId: '', tradingDay: '' }), 'k4');
    expect((nobody.body as Banked).banked).toBe(true);
    expect(kinds(nobody)).toEqual(expect.arrayContaining(['sale_names_no_cashier', 'sale_names_no_lane', 'sale_names_no_trading_day']));
    for (const e of (nobody.body as Banked).exceptions) expect(['material', 'critical', 'informational']).toContain(e.severity);

    // The findings are on the register the manager reads.
    const open = await h.request({ method: 'GET', path: '/v1/sales/exceptions', userId: 'u-owner', tenantId: A });
    expect(open.status).toBe(200);
    const summary = open.body as { critical: { kind: string; saleId: string }[]; material: { kind: string; saleId: string }[] };
    const listed = [...summary.critical, ...summary.material];
    expect(listed.some((e) => e.kind === 'cashier_unknown' && e.saleId === 'S-2')).toBe(true);
    expect(listed.some((e) => e.kind === 'sale_names_no_cashier' && e.saleId === 'S-4')).toBe(true);
  });
});

describe('the box knows which lane it is and says so (F09)', () => {
  it('stamps its lane on a record that names none, keeps a lane the till named, and stamps nothing it does not know', () => {
    const record = { id: 'S-1', number: 'R-1', cashierId: 'u-meena', tradingDay: '2026-09-30', committedAt: AT, total: 100, lines: [], tenders: [] };
    expect(toCloudSale(record, 3, 'store-1', 'lane-9').laneId).toBe('lane-9');
    expect(toCloudSale({ ...record, laneId: 'lane-2' }, 3, 'store-1', 'lane-9').laneId).toBe('lane-2');
    expect(toCloudSale(record, 3, 'store-1').laneId).toBe('');
  });

  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const box = async (env: Record<string, string>): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-operator-'));
    dirs.push(dir);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...env,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const posLaneOf = async (edge: EdgeProcess): Promise<Record<string, unknown>> => {
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const m = /<script>window\.posLane = (.*?);<\/script>/.exec(html);
    expect(m, 'the served till carries window.posLane').not.toBeNull();
    return JSON.parse(m![1]!) as Record<string, unknown>;
  };

  it('tells the served till its lane and the shop\'s cut-off from the store pack — never a cashier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-operator-pack-'));
    dirs.push(dir);
    const packFile = join(dir, 'pack.json');
    await writeFile(packFile, JSON.stringify({ version: 3, policies: { storeId: 'store-1', branchId: null, branchName: 'Tirunelveli', tradingDayCutoff: '02:00' } }), 'utf8');
    const edge = await box({ EDGE_LANE_ID: 'lane-9', EDGE_PACK_FILE: packFile });
    const lane = await posLaneOf(edge);
    expect(lane).toMatchObject({ laneId: 'lane-9', tradingDayCutoff: '02:00', tradingDayCutoffKnown: true, storeId: 'store-1' });
    expect(typeof lane['tradingDay']).toBe('string');
    expect(JSON.stringify(lane)).not.toMatch(/cashier/i);
  });

  it('a box never told its lane says so (null), and one with no pack says the cut-off is a default, not a fact', async () => {
    const edge = await box({});
    expect(await posLaneOf(edge)).toMatchObject({ laneId: null, tradingDayCutoff: '00:00', tradingDayCutoffKnown: false, storeId: null });
  });
});
