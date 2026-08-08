import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Warehouse put-away & bin movements (M09-FR-01, API-04) end to end through the real API. A movement is
// applied against the current bins and their PROJECTED contents (never a stored balance): a double scan
// is a no-op that says so; an unknown bin is refused (not invented); a full bin and an over-draw are
// refused (a negative bin poisons every count after it); and quarantined/expired/damaged stock can never
// be put into a PICKABLE bin. Put-away suggestions keep a product together and never send bad stock to a
// pickable bin. The rules are the pure `applyMovement`/`suggestPutAway` engine — this proves it is wired.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const bin = (h: ApiHarness, t: string, u: string, binId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/bins/${binId}`, userId: u, tenantId: t, idempotencyKey: `bin-${binId}`, body });
const move = (h: ApiHarness, t: string, u: string, commandId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/movements/${commandId}`, userId: u, tenantId: t, idempotencyKey: key ?? `mv-${commandId}`, body });
const readBin = (h: ApiHarness, t: string, u: string, binId: string) =>
  h.request({ method: 'GET', path: `/v1/warehouse/bins/${binId}`, userId: u, tenantId: t });
const suggest = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/put-away/suggest`, userId: u, tenantId: t, idempotencyKey: key ?? `pa-${String(body.tag ?? '')}`, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const binOf = (res: { body: unknown }): string | undefined => (res.body as { binId?: string }).binId;
const putAway = (toBinId: string, productId: string, qty: number, extra: Record<string, unknown> = {}) =>
  ({ kind: 'put_away', storeId: 'S1', productId, batchId: null, quantityMinor: qty, uom: 'EA', fromBinId: null, toBinId, ...extra });
interface BinBody { occupancyMinor: number; held: { key: string; quantityMinor: number }[] }

describe('warehouse bins: put-away, capacity/negative/quarantine refusals, projected contents (M09-FR-01)', () => {
  it('registers a bin, puts away, projects the contents, and treats a double scan as a no-op', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await bin(h, A, 'u-owner', 'B1', { storeId: 'S1', capacityMinor: 100, pickable: true })).status).toBe(201);

    expect((await move(h, A, 'u-owner', 'm1', putAway('B1', 'P1', 30))).status).toBe(201);
    const b1 = (await readBin(h, A, 'u-owner', 'B1')).body as BinBody;
    expect(b1.occupancyMinor).toBe(30);
    expect(b1.held.find((x) => x.key === 'B1|P1|')?.quantityMinor).toBe(30);

    // The same command id, a fresh transport key so it reaches the handler → a no-op that says so.
    const again = await move(h, A, 'u-owner', 'm1', putAway('B1', 'P1', 30), 'mv-m1-again');
    expect(again.status).toBe(200);
    expect((again.body as { outcome: string }).outcome).toBe('duplicate_ignored');
    expect(((await readBin(h, A, 'u-owner', 'B1')).body as BinBody).occupancyMinor).toBe(30);   // not 60
  });

  it('refuses a full bin, an over-draw, an unknown bin, and bad stock into a pickable bin', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bin(h, A, 'u-owner', 'B1', { storeId: 'S1', capacityMinor: 50, pickable: true });
    await move(h, A, 'u-owner', 'm1', putAway('B1', 'P1', 40));

    expect(codeOf(await move(h, A, 'u-owner', 'm2', putAway('B1', 'P1', 20)))).toBe('movement_bin_full');          // 40+20 > 50
    expect(codeOf(await move(h, A, 'u-owner', 'm3', { kind: 'pick', storeId: 'S1', productId: 'P1', batchId: null, quantityMinor: 50, uom: 'EA', fromBinId: 'B1', toBinId: null }))).toBe('movement_insufficient_in_bin'); // holds 40
    expect(codeOf(await move(h, A, 'u-owner', 'm4', putAway('GHOST', 'P1', 1)))).toBe('movement_unknown_bin');
    expect(codeOf(await move(h, A, 'u-owner', 'm5', putAway('B1', 'P1', 1, { stockState: 'quarantine' })))).toBe('movement_not_pickable_state');
  });

  it('moves stock bin-to-bin, updating both bins', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bin(h, A, 'u-owner', 'B1', { storeId: 'S1', capacityMinor: 100, pickable: true });
    await bin(h, A, 'u-owner', 'B2', { storeId: 'S1', capacityMinor: 100, pickable: true });
    await move(h, A, 'u-owner', 'm1', putAway('B1', 'P1', 30));

    expect((await move(h, A, 'u-owner', 'm2', { kind: 'bin_to_bin', storeId: 'S1', productId: 'P1', batchId: null, quantityMinor: 20, uom: 'EA', fromBinId: 'B1', toBinId: 'B2' })).status).toBe(201);
    expect(((await readBin(h, A, 'u-owner', 'B1')).body as BinBody).occupancyMinor).toBe(10);
    expect(((await readBin(h, A, 'u-owner', 'B2')).body as BinBody).occupancyMinor).toBe(20);
  });

  it('suggests a put-away that keeps a product together, and never a pickable bin for bad stock', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bin(h, A, 'u-owner', 'B1', { storeId: 'S1', capacityMinor: 100, pickable: true });
    await bin(h, A, 'u-owner', 'B2', { storeId: 'S1', capacityMinor: 100, pickable: true });
    await bin(h, A, 'u-owner', 'HOLD', { storeId: 'S1', capacityMinor: 100, pickable: false, zone: 'quarantine' });
    await move(h, A, 'u-owner', 'm1', putAway('B1', 'P1', 10));   // P1 already lives in B1

    expect(binOf(await suggest(h, A, 'u-owner', { productId: 'P1', quantityMinor: 5, tag: 'same' }))).toBe('B1');
    // Quarantined stock must go to a holding bin, never a pickable one.
    expect(binOf(await suggest(h, A, 'u-owner', { productId: 'P1', quantityMinor: 5, state: 'quarantine', tag: 'bad' }))).toBe('HOLD');
  });

  it('is authorized (move vs read) and per-tenant, and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // registers/moves and reads
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither
    await bin(h, A, 'u-mgr', 'B1', { storeId: 'S1', capacityMinor: 100, pickable: true });

    expect((await bin(h, A, 'u-cash', 'B2', { storeId: 'S1', capacityMinor: 100, pickable: true })).status).toBe(403);
    expect((await move(h, A, 'u-cash', 'mx', putAway('B1', 'P1', 1))).status).toBe(403);
    expect((await readBin(h, A, 'u-cash', 'B1')).status).toBe(403);   // cashier holds no inventory read
    expect((await readBin(h, A, 'u-owner', 'GHOST')).status).toBe(404);
    expect((await bin(h, A, 'u-owner', 'B-bad', { storeId: 'S1', pickable: true })).status).toBe(400);   // no capacity

    await h.seedOwner(B, 'u-owner-b');
    expect((await readBin(h, B, 'u-owner-b', 'B1')).status).toBe(404);
  });
});
