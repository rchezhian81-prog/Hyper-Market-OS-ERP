import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { storeRules } from '../support/store-rules';

// D-026 (OB-800 THE PLAN fix batch 4b): through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with
// a cold restart. A label task names its item ("Marie biscuits 200 g", never only "p-bisc"). When a newer price for the same
// item at the same store is in force, the older open task is shown REPLACED by it — settled, not counted open, and it
// cannot be closed at its old price (that would print a label at a price no longer charged). Nothing is deleted: the older
// task is still on the list, saying which price replaced it.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
interface Row { taskId: string; productId: string; productName?: string; priceMinor: number; replacedBy: { taskId: string; priceMinor: number } | null; mayClose: boolean; done: unknown }

describe.each(backings)('a label task names its item and a newer price replaces it (D-026) — on $name', ({ harness }) => {
  it('named by the item; the ₹30 task is replaced by the ₹32 one, not open, not closable; the ₹32 one closes', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['br-1']);
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr' ? { branchId: 'br-1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    await storeRules(h, T, 'u-owner', 'br-1', 0);
    await ok(call('POST', '/v1/catalogue/tax-classes/19053100/rates/2017-07-01', 'u-owner', { rateBps: 1_800 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/p-bisc/publish', 'u-owner', { product: { sku: 'BISC-200', name: 'Marie biscuits 200 g', baseUom: 'each', primaryCategoryId: 'snacks', taxClass: '19053100', lifecycle: 'draft', mrpHistory: [{ value: { minor: 5_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'snacks', name: 'Snacks', parentId: null }] }), 'publish');

    const price = (priceMinor: number) => ok(call('POST', '/v1/prices/changes', 'u-owner', { productId: 'p-bisc', priceMinor, mrpMinor: 5_000, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 }), `price ${priceMinor}`);
    await price(3_000);
    await new Promise((r) => setTimeout(r, 20)); // a later moment for the later price
    await price(3_200);

    h = harness(h); // ── COLD RESTART ──
    const read = (await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr'), 'list')).body as { tasks: Row[]; open: number };
    const at30 = read.tasks.find((r) => r.priceMinor === 3_000)!;
    const at32 = read.tasks.find((r) => r.priceMinor === 3_200)!;
    expect(read.tasks.every((r) => r.productName === 'Marie biscuits 200 g')).toBe(true);
    expect(at32).toMatchObject({ replacedBy: null, mayClose: true, done: null });
    expect(at30).toMatchObject({ replacedBy: { taskId: at32.taskId, priceMinor: 3_200 }, mayClose: false, done: null });
    expect(read.open).toBe(1);
    expect(read.tasks.map((r) => r.priceMinor)).toEqual([3_200, 3_000]); // the one to do first; the replaced one after

    // The replaced task is not closed at its old price — refused by name, nothing recorded.
    const old = await call('POST', `/v1/pricing/relabel-tasks/${at30.taskId}/done`, 'u-mgr', { shelfPriceMinor: 3_000, evidenceRef: 'photo-old' });
    expect(old.status).toBe(409);
    expect((old.body as { error: { code: string } }).error.code).toBe('replaced_by_a_newer_price');
    // The newer one closes as before.
    await ok(call('POST', `/v1/pricing/relabel-tasks/${at32.taskId}/done`, 'u-mgr', { shelfPriceMinor: 3_200, evidenceRef: 'photo-new' }), 'close the ₹32 task');
    const after = (await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr'), 'after')).body as { tasks: Row[]; open: number };
    expect(after.open).toBe(0);
    expect(after.tasks.length).toBe(2); // nothing deleted: the replaced task is still on record
    expect(after.tasks.find((r) => r.taskId === at30.taskId)?.replacedBy?.taskId).toBe(at32.taskId);
  }, 120_000);
});
