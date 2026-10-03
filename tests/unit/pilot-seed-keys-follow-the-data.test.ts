import { describe, it, expect } from 'vitest';
import { applyPilotCatalogue, applyPilotTradingPartners, type SeedClient } from '../../db/seed/pilot/apply';
import { PILOT_CATALOGUE, PILOT_TRADING_PARTNERS } from '../../db/seed/pilot/dataset';

// H-14 (3 Oct 2026): the demo products were seeded with units the till cannot price. Correcting the dataset was not
// enough — the seed's product key was fixed per product, so a re-run on the box REPLAYED the first publish and the
// correction never landed. The key now carries a digest of what is published: unchanged → replay; changed → a new
// version through the real route (never an overwrite, hard rule #2). This proves the key moves with the data and
// only with the data.
function recordingClient(): { client: SeedClient; keys: Map<string, string> } {
  const keys = new Map<string, string>();
  const client: SeedClient = {
    async request(req) {
      if (req.idempotencyKey !== undefined) keys.set(`${req.method} ${req.path}`, req.idempotencyKey);
      return { status: 201, body: {} };
    },
    async seedOwner() { /* not exercised by the catalogue step */ },
    async provisionRole() { /* not exercised by the catalogue step */ },
    async enableFeature() { /* not exercised by the catalogue step */ },
  };
  return { client, keys };
}

describe('the pilot seed\'s idempotency keys follow the data', () => {
  it('the same dataset twice → the very same keys (a re-run replays, nothing moves)', async () => {
    const a = recordingClient(); const b = recordingClient();
    await applyPilotCatalogue(a.client, PILOT_CATALOGUE, 'pilot-owner');
    await applyPilotCatalogue(b.client, PILOT_CATALOGUE, 'pilot-owner');
    expect([...a.keys.entries()]).toEqual([...b.keys.entries()]);
    expect(a.keys.size).toBeGreaterThan(0);
  });

  it('a corrected unit on one product changes that product\'s publish key — and nothing else\'s', async () => {
    const before = recordingClient(); const after = recordingClient();
    await applyPilotCatalogue(before.client, PILOT_CATALOGUE, 'pilot-owner');
    const [first, ...rest] = PILOT_CATALOGUE.products;
    const corrected = { ...PILOT_CATALOGUE, products: [{ ...first!, baseUom: 'each' }, ...rest] };
    await applyPilotCatalogue(after.client, corrected, 'pilot-owner');

    const publish = `POST /v1/catalogue/products/${encodeURIComponent(first!.productId)}/publish`;
    expect(after.keys.get(publish)).not.toBe(before.keys.get(publish));
    expect(after.keys.get(publish)).toMatch(new RegExp(`^seed-product-${first!.productId}-[0-9a-f]{12}$`));
    for (const [step, key] of before.keys) {
      if (step !== publish) expect(after.keys.get(step), step).toBe(key);
    }
  });

  it('the pack key follows the pack, not the product', async () => {
    const before = recordingClient(); const after = recordingClient();
    await applyPilotCatalogue(before.client, PILOT_CATALOGUE, 'pilot-owner');
    const withPack = PILOT_CATALOGUE.products.find((p) => p.pack !== undefined)!;
    const corrected = {
      ...PILOT_CATALOGUE,
      products: PILOT_CATALOGUE.products.map((p) => (p === withPack ? { ...p, pack: { ...p.pack!, baseUom: 'each' } } : p)),
    };
    await applyPilotCatalogue(after.client, corrected, 'pilot-owner');
    const pack = `POST /v1/catalogue/products/${encodeURIComponent(withPack.productId)}/pack`;
    const publish = `POST /v1/catalogue/products/${encodeURIComponent(withPack.productId)}/publish`;
    expect(after.keys.get(pack)).not.toBe(before.keys.get(pack));
    expect(after.keys.get(publish)).toBe(before.keys.get(publish));
  });
});

describe('a step under a fixed key whose dataset text changed after it landed', () => {
  const refusing = (code: string): SeedClient => ({
    async request(req) {
      const aboutTheReceipt = req.path.includes('grn-demo-001') || JSON.stringify(req.body ?? '').includes('grn-demo-001');
      if (aboutTheReceipt) return { status: 409, body: { error: { code, whatHappened: 'refused' } } };
      return { status: 201, body: {} };
    },
    async seedOwner() { /* not exercised */ },
    async provisionRole() { /* not exercised */ },
    async enableFeature() { /* not exercised */ },
  });

  it('is reported as landed earlier and left as it is — history is never re-done, and the seed stays re-runnable', async () => {
    const report = await applyPilotTradingPartners(refusing('idempotency_key_reused'), PILOT_TRADING_PARTNERS, 'pilot-owner');
    const receipt = report.steps.find((s) => s.what.includes('grn-demo-001'))!;
    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe(409);
    expect(receipt.detail).toContain('landed earlier');
    expect(report.ok).toBe(true);
  });

  it('any other refusal of the same step stays a failure', async () => {
    const report = await applyPilotTradingPartners(refusing('receipt_already_posted_differently'), PILOT_TRADING_PARTNERS, 'pilot-owner');
    const receipt = report.steps.find((s) => s.what.includes('grn-demo-001'))!;
    expect(receipt.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});
