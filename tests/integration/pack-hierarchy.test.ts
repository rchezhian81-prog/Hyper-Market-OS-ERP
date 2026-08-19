import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-02: pack hierarchy + UOM conversion on the live API — "a case of 24 becomes 24 singles, exactly".
// A pack is DEFINED with the tested validatePack gate, so an inexact one (a base level that is not one base
// unit, a fractional count of the level below, two levels sharing a name, no levels at all) is refused at
// definition time — before it can make a stock figure wrong at the back door. Once defined, converting a
// quantity up to base units or back down is exact and reversible. Defining is gated catalogue.pack.publish;
// reads and conversions are catalogue.pack.read. The hierarchy is event-sourced, so it survives a restart.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// each=1 → inner=6 → case=4, so a case holds 6*4 = 24 base units.
const LEVELS = [
  { level: 'each', containsMinor: 1 },
  { level: 'inner', containsMinor: 6 },
  { level: 'case', containsMinor: 4 },
];

const define = (h: ApiHarness, u: string, productId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/pack`, userId: u, tenantId: A, idempotencyKey: key, body });
const readPack = (h: ApiHarness, u: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}/pack`, userId: u, tenantId: A });
const convert = (h: ApiHarness, u: string, productId: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}/pack/convert`, userId: u, tenantId: A, query });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // catalogue.pack.read, NOT catalogue.pack.publish
  return h;
}

describe('pack hierarchy + UOM conversion (M03-FR-02)', () => {
  it('defines a valid pack and reads it back', async () => {
    const h = await cast();
    const res = await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: LEVELS }, 'k1');
    expect(res.status).toBe(201);
    const got = await readPack(h, 'u-owner', 'p-salt');
    expect(got.status).toBe(200);
    expect((got.body as { pack: { baseUom: string; levels: unknown[] } }).pack).toMatchObject({ baseUom: 'each' });
    expect((got.body as { pack: { levels: unknown[] } }).pack.levels).toHaveLength(3);
  });

  it('converts up to base units exactly, and back down to whole packs + a remainder', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: LEVELS }, 'k1');
    // 2 cases = 48 base units (a case holds 24), and one of that level holds 24; the round-trip is exact.
    const up = await convert(h, 'u-owner', 'p-salt', { level: 'case', quantity: '2', direction: 'to-base' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ baseUnits: 48, unitsPerLevel: 24, reversible: true });
    // 50 base units = 2 whole cases with 2 singles left over — never a fraction of a case.
    const down = await convert(h, 'u-owner', 'p-salt', { level: 'case', quantity: '50', direction: 'from-base' });
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ packs: 2, remainderBaseUnits: 2 });
  });

  it('refuses an INEXACT pack at definition time (the whole point of the gate)', async () => {
    const h = await cast();
    // Base level must be exactly one base unit.
    const badBase = await define(h, 'u-owner', 'p-a', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 2 }] }, 'k1');
    expect(badBase.status).toBe(422);
    expect(codeOf(badBase)).toBe('pack_hierarchy_is_not_exact');
    // A pack must hold a WHOLE number of the level below.
    expect((await define(h, 'u-owner', 'p-b', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'case', containsMinor: 2.5 }] }, 'k2')).status).toBe(422);
    // Two levels cannot share a name.
    expect((await define(h, 'u-owner', 'p-c', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'each', containsMinor: 6 }] }, 'k3')).status).toBe(422);
    // No levels at all.
    expect((await define(h, 'u-owner', 'p-d', { baseUom: 'each', levels: [] }, 'k4')).status).toBe(422);
    // Nothing was stored — the product has no pack.
    expect((await readPack(h, 'u-owner', 'p-a')).status).toBe(404);
  });

  it('refuses a malformed body (400) distinctly from an inexact pack (422)', async () => {
    const h = await cast();
    // No levels[] array at all, or no baseUom.
    expect((await define(h, 'u-owner', 'p-x', { baseUom: 'each' }, 'k1')).status).toBe(400);
    // A level missing its count.
    const bad = await define(h, 'u-owner', 'p-y', { baseUom: 'each', levels: [{ level: 'each' }] }, 'k2');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_pack');
  });

  it('refuses a conversion for an unknown level (422) and a malformed query (400)', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: LEVELS }, 'k1');
    const unknown = await convert(h, 'u-owner', 'p-salt', { level: 'pallet', quantity: '1', direction: 'to-base' });
    expect(unknown.status).toBe(422);
    expect(codeOf(unknown)).toBe('unknown_pack_level');
    // Missing quantity, a negative quantity, or an unknown direction.
    expect((await convert(h, 'u-owner', 'p-salt', { level: 'case', direction: 'to-base' })).status).toBe(400);
    expect((await convert(h, 'u-owner', 'p-salt', { level: 'case', quantity: '-1', direction: 'to-base' })).status).toBe(400);
    expect((await convert(h, 'u-owner', 'p-salt', { level: 'case', quantity: '1', direction: 'sideways' })).status).toBe(400);
  });

  it('gates defining on catalogue.pack.publish; a manager may read and convert but not define', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: LEVELS }, 'k1');
    // The manager cannot define a pack (no catalogue.pack.publish)...
    expect((await define(h, 'u-mgr', 'p-new', { baseUom: 'each', levels: LEVELS }, 'k2')).status).toBe(403);
    // ...but can read it and run a conversion (catalogue.pack.read).
    expect((await readPack(h, 'u-mgr', 'p-salt')).status).toBe(200);
    expect((await convert(h, 'u-mgr', 'p-salt', { level: 'case', quantity: '1', direction: 'to-base' })).status).toBe(200);
  });

  it('is a 404 for a product whose pack was never defined', async () => {
    const h = await cast();
    expect((await readPack(h, 'u-owner', 'p-unknown')).status).toBe(404);
    expect((await convert(h, 'u-owner', 'p-unknown', { level: 'case', quantity: '1', direction: 'to-base' })).status).toBe(404);
  });

  it('a re-definition is a new version, and the pack survives a restart', async () => {
    const h = await cast();
    await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: LEVELS }, 'k1');
    // Re-define with a bigger case (6*5 = 30) — a new version, not an overwrite in place.
    await define(h, 'u-owner', 'p-salt', { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'inner', containsMinor: 6 }, { level: 'case', containsMinor: 5 }] }, 'k2');
    // A fresh harness over the SAME store is a cold start — the current pack is folded from events.
    const restarted = apiHarness({ store: h.store });
    const up = await convert(restarted, 'u-owner', 'p-salt', { level: 'case', quantity: '1', direction: 'to-base' });
    expect(up.body).toMatchObject({ baseUnits: 30 }); // the latest definition wins
  });
});
