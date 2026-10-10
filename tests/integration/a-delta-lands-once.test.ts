import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **A migration delta lands as real stock, exactly once — on the REAL API over REAL PostgreSQL, across a restart
 * (audit GT-04 · MG-09 · QG-07).**
 *
 * The audit found the delta route counting changes as "applied" while applying nothing. Here a known delta (stock that
 * arrived at the old store after the final extract, and stock the old till sold) is posted; the stock is read back from
 * the inventory domain; the same delta is re-sent under a NEW HTTP idempotency key, and again after the API process is
 * stopped and a new one started over the same database — and the stock moved once. A change of a kind this version
 * cannot apply is refused by name, never counted.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const KEY = ['delta', 'lands', 'once', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';

describeOrSkip('a migration delta lands as real stock, once — real API, real PostgreSQL, across a restart (GT-04)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('applies the stock delta, reads it back, and a new-key retry and a restarted process change nothing', async () => {
    const tenantId = randomUUID();
    const first = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
    clouds.push(first);
    const changes = [
      { changeKey: 'd-in', entity: 'stock', legacyId: 'P-DAL', operation: 'update', changedAt: '2026-10-09T08:00:00.000Z', deltaQty: 20, locationId: 'S1', uom: 'ea', unitCostMinor: 12_000 },
      { changeKey: 'd-out', entity: 'stock', legacyId: 'P-DAL', operation: 'update', changedAt: '2026-10-09T09:00:00.000Z', deltaQty: -5, locationId: 'S1', uom: 'ea' },
      { changeKey: 'd-sale', entity: 'sale', legacyId: 'B-901', operation: 'insert', changedAt: '2026-10-09T09:30:00.000Z', deltaMinor: 60_000 },
    ];
    const send = (cloud: RealCloud, key: string) => cloud.request({ method: 'POST', path: '/v1/migration/deltas', userId: OWNER, idempotencyKey: key, body: { changes, extractCutoff: '2026-10-09T00:00:00.000Z' } });
    const onHand = async (cloud: RealCloud): Promise<number | undefined> =>
      ((await cloud.request({ method: 'GET', path: '/v1/inventory/availability?productId=P-DAL', userId: OWNER })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S1')?.onHandMinor;

    const applied = await send(first, 'delta-run-1');
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ applied: 2, refused: 1, appliedKeys: ['d-in', 'd-out'] });
    expect((applied.body as { lines: { changeKey: string; outcome: string }[] }).lines.find((l) => l.changeKey === 'd-sale')?.outcome).toBe('refused_unsupported_entity');
    expect(await onHand(first)).toBe(15);

    // A new HTTP key: head office's own record of what was applied decides — no second movement.
    const retry = await send(first, 'delta-run-2');
    expect(retry.body).toMatchObject({ applied: 0, duplicatesIgnored: 2 });
    expect(await onHand(first)).toBe(15);

    // A real restart: the API process stops; a new one starts over the same database.
    await first.stop();
    clouds.splice(clouds.indexOf(first), 1);
    const second = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
    clouds.push(second);
    const afterRestart = await send(second, 'delta-run-3');
    expect(afterRestart.body).toMatchObject({ applied: 0, duplicatesIgnored: 2 });
    expect(await onHand(second)).toBe(15);
    const valuation = (await second.request({ method: 'GET', path: '/v1/inventory/valuation?productId=P-DAL', userId: OWNER })).body as { rows: { value: { minor: number } }[] };
    expect(valuation.rows[0]?.value.minor).toBe(15 * 12_000);
    // The cutover's delta check reads head office's record of it (GT-03).
    const decision = (await second.request({ method: 'POST', path: '/v1/migration/cutover/decision', userId: OWNER, idempotencyKey: 'cut-1', body: { evidence: {} } })).body as { checks: { check: string; state: string }[] };
    expect(decision.checks.find((c) => c.check === 'delta_applied')?.state).toBe('passed');
  }, 120_000);
});
