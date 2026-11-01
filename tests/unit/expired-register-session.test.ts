import { describe, it, expect } from 'vitest';
import { createExpiredRegisterSession, expiredRowView, expiredWords, EXPIRED_REGISTER_COPY } from '../../apps/web-erp/src/expired-register-session';

// The Expiry page's "Taken off sale" tab (M10-FR-01 · Round 4b): head office's expired register, worded in the item's own unit
// with its name when the store computer was told them; a read only. The connected proof is
// tests/e2e/the-expiry-page-shows-what-was-taken-off-sale.e2e.ts.

const ROW = { productId: 'RICE', locationId: 'br-1', batchId: null, expiry: '2026-10-05', onHandMinor: 2_500, shopDay: '2026-10-06', movedAt: '2026-10-06T00:30:00Z', remainingMinor: 500, toBin: true, writeOffs: [{ id: 'wo-1', qtyRemoved: 2_000, at: '2026-10-06T09:00:00Z' }] };

describe('the expired register (M10-FR-01)', () => {
  it('words a kg batch in kg, with its name, what is still to throw away and the write-offs', () => {
    const v = expiredRowView('en', ROW, { RICE: 'Ponni rice' }, { RICE: 'kg' });
    expect(v.heading).toBe('Ponni rice · no batch number · expired 2026-10-05 · at br-1');
    expect(v.figures).toBe('Taken off sale 2.500 kg (2026-10-06, by the daily expiry check) · Still on the shelf 0.500 kg');
    expect(v.state).toMatch(/^⚠ still on the shelf/);
    expect(v.writeOffs).toBe('Write-offs: 2.000 kg (2026-10-06)');
    expect(expiredRowView('en', { ...ROW, productId: 'X', toBin: false, writeOffs: [] }, {}, {}).heading).toMatch(/^X · /);
  });
  it('reads one place or all, refuses a nobody and a role without the stock read before any call; every word has a Tamil twin', async () => {
    const paths: string[] = [];
    const fetch = (async (p: string) => { paths.push(p); return { ok: true, status: 200, json: async () => ({ batches: [] }) }; }) as unknown as typeof globalThis.fetch;
    const s = createExpiredRegisterSession({ viewer: { userId: 'u', permissions: ['inventory.availability.read'] }, fetch });
    await s.read(''); await s.read(' br 1 ');
    expect(paths).toEqual(['/v1/inventory/expired-batches', '/v1/inventory/expired-batches?locationId=br%201']);
    expect(await createExpiredRegisterSession({ viewer: undefined, fetch }).read('')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createExpiredRegisterSession({ viewer: { userId: 'q', permissions: ['quality.recall.read'] }, fetch }).read('')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(paths).toHaveLength(2);
    for (const k of Object.keys(EXPIRED_REGISTER_COPY.en)) expect(expiredWords('ta', k), k).not.toBe(expiredWords('en', k));
  });
});
