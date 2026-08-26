import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Packing & dispatch, end to end (M19-FR-02 / D09 / M10-FR-02, API-08). Between the shelf and the van the
// shop can catch a mistake for free or make an expensive one: a weighed line's final price is captured AT
// PACK (never guessed at the doorstep), a cold item packed warm or unmeasured does not go on the van, a crate
// cannot mix incompatible handling, and the dispatch manifest is derived from what was PACKED — never from
// what was ordered, which is why the pack is recorded and the dispatch reads it back. Gated
// fulfilment.pack.record (write) / .read (reads).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const line = (over: Record<string, unknown>) => ({
  lineId: 'l1', productId: 'p1', name: 'item', handling: 'ambient',
  orderedMinor: 1, pickedMinor: 1, uom: 'each', unitPriceMinor: 1000, ...over,
});
const pack = (h: ApiHarness, u: string, orderId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/fulfilment/orders/${orderId}/pack`, userId: u, tenantId: A, idempotencyKey: key ?? `pack-${orderId}`, body });
const dispatch = (h: ApiHarness, u: string, orderId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/fulfilment/orders/${orderId}/dispatch`, userId: u, tenantId: A, idempotencyKey: key ?? `disp-${orderId}`, body });
const getPack = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/fulfilment/orders/${orderId}/pack`, userId: u, tenantId: A });
const getManifest = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/fulfilment/orders/${orderId}/manifest`, userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type PackBody = { packed: boolean; outcome: string; totalMinor: number; lines: { lineId: string; finalPriceMinor: number }[]; refused: { lineId: string; reason: string }[] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // fulfilment.pack.record + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('fulfilment packing: price at pack, cold-chain crate rules, manifest from what was packed (M19-FR-02)', () => {
  it('prices a weighed line at its packed weight, dispatches a sealed load, and the manifest survives a restart', async () => {
    const h = await cast();
    const res = await pack(h, 'u-mgr', 'o1', {
      lines: [
        line({ lineId: 'chicken', productId: 'p-chk', name: 'chicken', handling: 'raw_meat', weighed: true, packedGrams: 1187, packTenthsC: 20, unitPriceMinor: 20000 }),
        line({ lineId: 'atta', productId: 'p-atta', name: 'atta 5kg', handling: 'ambient', orderedMinor: 2, pickedMinor: 2, unitPriceMinor: 5000 }),
      ],
      crateAssignment: { chicken: 'crate-1', atta: 'crate-2' },
    });
    expect(res.status).toBe(200);
    const body = res.body as PackBody;
    expect(body).toMatchObject({ packed: true, outcome: 'packed' });
    expect(body.refused).toHaveLength(0);
    // Exact integer price from the packed grams: 20000 per kg × 1187 g = 23740, never a float.
    expect(body.lines.find((l) => l.lineId === 'chicken')?.finalPriceMinor).toBe(23740);
    expect(body.totalMinor).toBe(23740 + 10000);

    const disp = await dispatch(h, 'u-mgr', 'o1', { manifestId: 'm1', locationId: 'store-01', seals: { 'crate-1': 'seal-a', 'crate-2': 'seal-b' } });
    expect(disp.status).toBe(200);
    expect(disp.body).toMatchObject({ dispatched: true, outcome: 'dispatched' });

    // The manifest is derived from what was PACKED, is event-sourced, and survives a cold restart.
    const restarted = apiHarness({ store: h.store });
    const man = await getManifest(restarted, 'u-owner', 'o1');
    expect(man.status).toBe(200);
    const manifest = man.body as { orderId: string; totalMinor: number; crates: string[]; lines: { lineId: string; quantityMinor: number }[]; detail: string };
    expect(manifest).toMatchObject({ orderId: 'o1', totalMinor: 33740 });
    expect(manifest.crates).toEqual(['crate-1', 'crate-2']);
    expect(manifest.detail).toContain('what was packed');
  });

  it('refuses an unmeasured cold chain, an incompatible crate and a weightless weighed line — the rest still packs', async () => {
    const h = await cast();
    const body = (await pack(h, 'u-mgr', 'o2', {
      lines: [
        line({ lineId: 'milk', name: 'milk', handling: 'chilled' }), // no packTenthsC → temperature_not_taken
        line({ lineId: 'icecream', name: 'ice cream', handling: 'frozen', packTenthsC: -180 }),
        line({ lineId: 'rice', name: 'rice', handling: 'ambient' }), // frozen + ambient share crate-x → incompatible
        line({ lineId: 'fish', name: 'fish', handling: 'raw_meat', weighed: true, packTenthsC: 0 }), // weighed, no packedGrams
        line({ lineId: 'tin', name: 'tinned beans', handling: 'ambient', pickedMinor: 3, orderedMinor: 3, unitPriceMinor: 4000 }), // clean
      ],
      crateAssignment: { milk: 'crate-cold', icecream: 'crate-x', rice: 'crate-x', fish: 'crate-fish', tin: 'crate-dry' },
    })).body as PackBody;

    const reasons = new Set(body.refused.map((r) => r.reason));
    expect(reasons.has('temperature_not_taken')).toBe(true);
    expect(reasons.has('incompatible_crate')).toBe(true);
    expect(reasons.has('weight_not_captured')).toBe(true);
    // One bad crate never stops the rest — the clean tin still packed.
    expect(body.lines.find((l) => l.lineId === 'tin')?.finalPriceMinor).toBe(12000);
    expect(body.packed).toBe(true);
  });

  it('refuses to dispatch an unresolved short line, an unsealed crate, or an order never packed', async () => {
    const h = await cast();
    // Never packed → nothing to dispatch.
    expect(codeOf(await dispatch(h, 'u-mgr', 'ghost', { manifestId: 'm', locationId: 's', seals: {} }))).toBe('no_pack_recorded');

    // Pack with a short line (ordered 5, picked 3).
    await pack(h, 'u-mgr', 'o3', {
      lines: [line({ lineId: 'short', name: 'apples', orderedMinor: 5, pickedMinor: 3, unitPriceMinor: 3000 })],
      crateAssignment: { short: 'crate-1' },
    });
    // The customer has not been told about the short line → the doorstep is the worst place for that talk.
    expect(codeOf(await dispatch(h, 'u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: { 'crate-1': 'seal' } }, 'd3a'))).toBe('unresolved_lines');
    // Resolve it, but leave the crate unsealed → still refused.
    expect(codeOf(await dispatch(h, 'u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: {}, resolvedLineIds: ['short'] }, 'd3b'))).toBe('unsealed_crate');
    // Resolve AND seal → it goes.
    const ok = await dispatch(h, 'u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: { 'crate-1': 'seal' }, resolvedLineIds: ['short'] }, 'd3c');
    expect(ok.body).toMatchObject({ dispatched: true });
  });

  it('is gated to fulfilment staff and refuses a malformed pack', async () => {
    const h = await cast();
    const good = { lines: [line({})], crateAssignment: { l1: 'crate-1' } };
    expect((await pack(h, 'u-cash', 'o4', good)).status).toBe(403);
    expect((await dispatch(h, 'u-cash', 'o4', { manifestId: 'm', locationId: 's', seals: {} })).status).toBe(403);
    expect((await getPack(h, 'u-cash', 'o4')).status).toBe(403);
    // A pack with no lines is not readable — nothing saved.
    expect(codeOf(await pack(h, 'u-mgr', 'o5', { lines: [], crateAssignment: {} }))).toBe('not_readable_as_a_pack');
  });
});
