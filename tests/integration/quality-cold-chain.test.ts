import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M10-FR-02: the cold-chain verdict on a perishable batch, on the live API. Duration counts as much as
// peak, a breach quarantines automatically, and a cold-chain batch with no reading at all fails rather
// than passes — an unmeasured cold chain is an unproven one.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Milk: must stay 0.0–5.0 °C; up to 30 minutes out of range is tolerated.
const RULE = { minTenthsC: 0, maxTenthsC: 50, graceMinutes: 30 };
const reading = (readingId: string, tenthsC: number, at: string) =>
  ({ readingId, batchId: 'batch-milk', productId: 'prod-milk', tenthsC, at, source: 'probe-1', recordedBy: 'u-recv' });

const assess = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/quality/cold-chain/assess', userId, tenantId: A, idempotencyKey: key, body });

const base = { batchId: 'batch-milk', productId: 'prod-milk', rule: RULE };

describe('cold-chain assessment (M10-FR-02)', () => {
  it('passes a batch that stayed in range', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const readings = [reading('r1', 30, '2026-08-11T10:00:00Z'), reading('r2', 40, '2026-08-11T11:00:00Z')];
    const body = (await assess(h, 'u-owner', { ...base, readings }, 'cc-ok')).body as { severity: string; quarantine: boolean };
    expect(body.severity).toBe('within_range');
    expect(body.quarantine).toBe(false);
  });

  it('tolerates a brief excursion inside the grace window', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // 12.0 °C at 10:00, back to 3.0 °C by 10:10 — ten minutes out, within the 30-minute grace.
    const readings = [reading('r1', 120, '2026-08-11T10:00:00Z'), reading('r2', 30, '2026-08-11T10:10:00Z')];
    const body = (await assess(h, 'u-owner', { ...base, readings }, 'cc-brief')).body as { severity: string; quarantine: boolean; minutesOutOfRange: number };
    expect(body.severity).toBe('brief_excursion');
    expect(body.quarantine).toBe(false);
    expect(body.minutesOutOfRange).toBe(10);
  });

  it('quarantines a breach beyond grace — automatically', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // 12.0 °C held for a full hour — well past the 30-minute grace.
    const readings = [reading('r1', 120, '2026-08-11T10:00:00Z'), reading('r2', 130, '2026-08-11T11:00:00Z')];
    const body = (await assess(h, 'u-owner', { ...base, readings }, 'cc-breach')).body as { severity: string; quarantine: boolean; peakTenthsC: number };
    expect(body.severity).toBe('breach');
    expect(body.quarantine).toBe(true);
    expect(body.peakTenthsC).toBe(130); // the worst reading
  });

  it('fails a cold-chain batch with no reading at all', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await assess(h, 'u-owner', { ...base, readings: [] }, 'cc-none')).body as { severity: string; quarantine: boolean };
    expect(body.severity).toBe('breach');
    expect(body.quarantine).toBe(true);
  });

  it('refuses a missing/inverted rule, and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await assess(h, 'u-owner', { batchId: 'b', productId: 'p', readings: [] }, 'cc-norule')).status).toBe(400);
    expect((await assess(h, 'u-owner', { ...base, rule: { minTenthsC: 50, maxTenthsC: 0, graceMinutes: 30 }, readings: [] }, 'cc-inv')).status).toBe(400);
    expect((await assess(h, 'u-cash', { ...base, readings: [] }, 'cc-rbac')).status).toBe(403);
  });
});
