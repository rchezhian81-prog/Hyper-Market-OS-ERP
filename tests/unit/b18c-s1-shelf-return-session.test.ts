import { describe, it, expect } from 'vitest';
import { createShelfReturnSession, shelfReturnBody, SHELF_RETURN_WORDS } from '../../apps/web-erp/src/shelf-return-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/** S1 · batch 18c (OB-872): the Return to supplier box's model — what it sends, and when. */

const viewer = { userId: 'u-mgr', permissions: ['inventory.movement.append'] };
const form = { productId: 'OIL', locationId: 'br-1', batchId: 'B-1', qty: '6', supplierId: 'sup-1', reason: 'damaged', note: 'torn' };

function fake(answers: Record<string, HttpAnswer[]>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const http: HeadOfficeHttp = {
    get: async (path) => { calls.push({ method: 'GET', path }); return answers[path.split('?')[0]!]?.shift() ?? { result: 'lost_link' }; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); const k = path.startsWith('/v1/inventory/shelf-returns/') ? 'shelf' : path; return answers[k]?.shift() ?? { result: 'lost_link' }; },
  };
  return { http, calls };
}

describe('S1: the Return to supplier box', () => {
  it('builds the body head office reads, and refuses an incomplete form without sending', async () => {
    expect(shelfReturnBody(form)).toEqual({ productId: 'OIL', locationId: 'br-1', qty: 6, uom: 'ea', supplierId: 'sup-1', reason: 'damaged', batchId: 'B-1', note: 'torn' });
    expect(shelfReturnBody({ ...form, qty: '0' })).toBeNull();
    expect(shelfReturnBody({ ...form, reason: 'bored' })).toBeNull();
    const { http, calls } = fake({});
    const s = createShelfReturnSession(viewer, http, () => 'rts-1');
    expect(await s.send({ ...form, supplierId: '' })).toEqual({ kind: 'invalid' });
    expect(calls).toEqual([]);
    expect(createShelfReturnSession({ permissions: [] }, http).may).toBe(false);
  });

  it('asks for approval at head office\'s own value, then sends the SAME return with the approval', async () => {
    const { http, calls } = fake({
      shelf: [
        { result: 'refused', status: 422, code: 'shelf_return_needs_approval', whatHappened: 'This return is worth ₹900.00.' },
        { result: 'ok', status: 201, body: { shelfReturn: { returnId: 'rts-1', documentNumber: 'RTS1/26-27/00002', productId: 'OIL', quantityMinor: 6, supplierId: 'sup-1', reason: 'damaged', valueMinor: 90_000, debitNote: { number: 'SDN/26-27/00007' }, at: 't', approvedBy: 'u-owner' } } },
      ],
      '/v1/inventory/write-off-value': [{ result: 'ok', status: 200, body: { valueMinor: 90_000 } }],
      '/v1/approvals/requests': [{ result: 'ok', status: 201, body: { requestId: 'req-9' } }],
    });
    const s = createShelfReturnSession(viewer, http, () => 'rts-1');
    const first = await s.send(form);
    expect(first.kind).toBe('needs_approval');
    expect(s.outcomeWords('en', first)).toMatch(/Ask for approval/);
    expect((await s.askApproval(form, 'Return 6 OIL')).kind).toBe('asked');
    const ask = calls.find((c) => c.path === '/v1/approvals/requests')!;
    expect(ask.body).toMatchObject({ kind: 'stock_write_off', subjectRef: 'rts-1', valueMinor: 90_000, details: { productId: 'OIL', qty: 6, returnId: 'rts-1' } });
    const done = await s.send(form);
    expect(done.kind).toBe('returned');
    const posts = calls.filter((c) => c.path.startsWith('/v1/inventory/shelf-returns/'));
    expect(posts.map((p) => p.path)).toEqual(['/v1/inventory/shelf-returns/rts-1', '/v1/inventory/shelf-returns/rts-1']);
    expect(posts[1]!.body).toMatchObject({ approvalId: 'req-9' });
    expect(s.outcomeWords('en', done)).toMatch(/RTS1\/26-27\/00002 · debit note SDN\/26-27\/00007 · ₹900\.00/);
    expect(Object.keys(SHELF_RETURN_WORDS.ta).sort()).toEqual(Object.keys(SHELF_RETURN_WORDS.en).sort());
  });
});
