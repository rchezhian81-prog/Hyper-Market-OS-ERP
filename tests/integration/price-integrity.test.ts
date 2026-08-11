import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Ratified R2 B25 (D06/D14): price integrity across shelf/POS/app/ESL on the live API. The till is the
// reference; a shelf showing LESS than the till is a legal exposure ranked FIRST regardless of value; a
// surface that has not confirmed is treated as stale rather than as agreeing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-08-11T12:00:00Z';

const audit = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/pricing/integrity/audit', userId, tenantId: A, idempotencyKey: key, body });

const shelf = (productId: string, priceMinor: number, at = NOW, extra: object = {}) =>
  ({ surface: 'shelf_label', productId, branchId: 'br-1', priceMinor, lastConfirmedAt: at, ...extra });

describe('price integrity audit (B25 / D06 / D14)', () => {
  it('ranks a shelf underpricing the till FIRST as a legal exposure, margin leaks second', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await audit(h, 'u-owner', {
      branchId: 'br-1',
      asAt: NOW,
      products: [
        { productId: 'prod-rice', name: 'Rice 5kg', posPriceMinor: 50000 }, // till ₹500
        { productId: 'prod-oil', name: 'Oil 1L', posPriceMinor: 20000 },    // till ₹200
      ],
      displayed: [
        shelf('prod-rice', 45000), // shelf ₹450 < till — customer offered less than charged: exposure
        shelf('prod-oil', 22000),  // shelf ₹220 > till — shop undercharges vs label: margin
      ],
    }, 'pi-asym')).body as { productsChecked: number; overchargeRisks: { productId: string; kind: string }[]; other: { kind: string }[] };

    expect(body.productsChecked).toBe(2);
    expect(body.overchargeRisks).toHaveLength(1);
    expect(body.overchargeRisks[0]!.productId).toBe('prod-rice');
    expect(body.overchargeRisks[0]!.kind).toBe('overcharge_risk');
    expect(body.other.some((f) => f.kind === 'undercharge')).toBe(true);
  });

  it('treats a surface silent past its freshness window as stale, not as agreeing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await audit(h, 'u-owner', {
      branchId: 'br-1',
      asAt: NOW,
      products: [{ productId: 'prod-milk', name: 'Milk 1L', posPriceMinor: 6000 }],
      // Same price as the till, but the ESL last confirmed ten days ago — showing whatever it was last told.
      displayed: [{ surface: 'esl', productId: 'prod-milk', branchId: 'br-1', priceMinor: 6000, lastConfirmedAt: '2026-08-01T12:00:00Z', deviceId: 'esl-77', shelfAddress: 'A3-04' }],
      requiredSurfaces: ['esl'],
    }, 'pi-stale')).body as { other: { kind: string; deviceId?: string }[] };

    // An ESL that lost its radio is reported esl_unreachable — the sharper case of "silence is not agreement".
    const staleFinding = body.other.find((f) => f.kind === 'esl_unreachable');
    expect(staleFinding).toBeDefined();
    expect(staleFinding!.deviceId).toBe('esl-77'); // named so somebody can walk to it
  });

  it('flags a product on sale with no required surface on file', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await audit(h, 'u-owner', {
      branchId: 'br-1',
      asAt: NOW,
      products: [{ productId: 'prod-bread', name: 'Bread', posPriceMinor: 4000 }],
      displayed: [],
      requiredSurfaces: ['shelf_label'],
    }, 'pi-missing')).body as { other: { kind: string }[] };

    expect(body.other.some((f) => f.kind === 'surface_missing')).toBe(true);
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await audit(h, 'u-owner', { asAt: NOW, products: [], displayed: [] }, 'pi-nobranch')).status).toBe(400);
    expect((await audit(h, 'u-cash', { branchId: 'br-1', asAt: NOW, products: [], displayed: [] }, 'pi-rbac')).status).toBe(403);
  });
});
