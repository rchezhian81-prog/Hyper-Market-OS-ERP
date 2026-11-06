import { describe, it, expect } from 'vitest';
import { createProductionRepackSession, PRODUCTION_REPACK_COPY } from '../../apps/web-erp/src/production-repack-session';

/** Round 4d (M11-FR-03): the Production page's repack form refuses the cheap mistakes first and sends what the route reads. */

function fakeHeadOffice() {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 201, json: async () => ({ expiresAt: '2030-12-01' }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const R = { departmentId: 'deli', productId: 'CHEESE', locationId: 'store-1', sourceBatchId: 'CH-1', newBatchId: 'CH-1-R1', qty: '1.25', uom: 'kg' };

describe('the repack session', () => {
  it('every word has a Tamil twin', () => { expect(Object.keys(PRODUCTION_REPACK_COPY.ta).sort()).toEqual(Object.keys(PRODUCTION_REPACK_COPY.en).sort()); });
  it('sends kg as grams with the source and the new batch; says the expiry head office gave', async () => {
    const ho = fakeHeadOffice();
    const s = createProductionRepackSession({ viewer: { userId: 'u-mgr', permissions: ['production.plan.commit'] }, fetch: ho.fetch });
    expect(await s.repack(R)).toEqual({ result: 'ok', value: { newBatchId: 'CH-1-R1', expiresAt: '2030-12-01' } });
    expect(ho.sent[0]!.path).toMatch(/^\/v1\/production\/repacks\/rp-/);
    expect(ho.sent[0]!.body).toEqual({ departmentId: 'deli', productId: 'CHEESE', locationId: 'store-1', sourceBatchId: 'CH-1', newBatchId: 'CH-1-R1', quantityMinor: 1250, uom: 'kg' });
  });
  it('refuses before sending: the same batch code, a fourth decimal of a kg, a missing field, a role that may not', async () => {
    const ho = fakeHeadOffice();
    const s = createProductionRepackSession({ viewer: { userId: 'u-mgr', permissions: ['production.plan.commit'] }, fetch: ho.fetch });
    expect(await s.repack({ ...R, newBatchId: 'CH-1' })).toEqual({ result: 'invalid', why: 'sameBatch' });
    expect(await s.repack({ ...R, qty: '1.2345' })).toEqual({ result: 'invalid', why: 'badQty' });
    expect(await s.repack({ ...R, productId: ' ' })).toEqual({ result: 'invalid', why: 'needField' });
    expect(await createProductionRepackSession({ viewer: { userId: 'u-x', permissions: ['production.read'] }, fetch: ho.fetch }).repack(R)).toEqual({ result: 'invalid', why: 'cannotRepack' });
    expect(ho.sent).toHaveLength(0);
  });
});
