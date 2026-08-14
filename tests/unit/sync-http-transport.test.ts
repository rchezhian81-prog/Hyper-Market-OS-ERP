import { describe, it, expect } from 'vitest';
import { httpTransport, classify, EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';
import { makeEvent } from '../../packages/contracts/src/event';
import type { DomainEvent } from '../../packages/contracts/src/event';

// §31 · §31.1 · P-01 · P-08 · hard rules #1 #4 #6 #10.
//
// The wire between a shop with no internet and the cloud. `SyncTransport` was a port with no
// implementation, so until this existed the edge committed sales durably, queued them honestly,
// reported its unsent count truthfully — and had nowhere to send them.
//
// Nearly every test here is about one distinction: `retryable` versus `rejected`. They look almost
// identical in code and could not be more different in the shop. An unsent sale wrongly marked
// rejected stops being retried, and the money in the drawer has no record in the cloud until
// somebody works the dead-letter queue.

const TOKEN = ['store', 'edge', 'bearer', 'token'].join('-').padEnd(40, 'z');

const sale = (over: Record<string, unknown> = {}): DomainEvent => makeEvent({
  id: 'sale-1', type: 'SaleCommitted', occurredAt: '2026-08-05T10:00:00.000Z',
  idempotencyKey: 'sale-t1-S-001', source: 'edge',
  payload: { saleId: 'S-001', totalMinor: 64_000, ...over },
});

/** A fetch that answers with one status, and records what it was asked. */
function fakeFetch(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const transportOn = (fetchFn: typeof globalThis.fetch, timeoutMs = 10_000) =>
  httpTransport({ baseUrl: 'https://api.example.test/', token: TOKEN, fetch: fetchFn, timeoutMs });

describe('a sale goes through the same door as one that synced immediately', () => {
  it('posts a SaleCommitted to the sales endpoint, not to a generic ingest', () => {
    // A generic ingest would skip the price check against the published pack, the receipt-number
    // clash, the future-dated commit — the whole exception path — and land in the ledger having
    // been examined by nothing. A sale that syncs late still needs looking at.
    const { fn, calls } = fakeFetch(202);
    void transportOn(fn).send(sale());
    expect(calls[0]?.url).toBe('https://api.example.test/v1/sales');
    expect(Object.values(EVENT_ROUTES)).not.toContain('/v1/ingest');
  });

  it('carries the EVENT\'s idempotency key, not one minted for this attempt', async () => {
    // A key minted per attempt makes every retry a new sale, and the server doing everything right
    // banks all of them. The key was minted when the sale was committed at the lane.
    const { fn, calls } = fakeFetch(202);
    await transportOn(fn).send(sale());
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('sale-t1-S-001');
  });

  it('fills a route parameter from the payload', async () => {
    const { fn, calls } = fakeFetch(201);
    await transportOn(fn).send(makeEvent({
      id: 'c-1', type: 'ConsentRecorded', occurredAt: '2026-08-05T10:00:00.000Z',
      idempotencyKey: 'consent-1', source: 'edge',
      payload: { customerId: 'C-001', given: true },
    }));
    expect(calls[0]?.url).toBe('https://api.example.test/v1/customers/C-001/consent');
  });

  it('REJECTS an event type with no endpoint, by name, rather than posting it somewhere', async () => {
    const r = await transportOn(fakeFetch(200).fn).send(makeEvent({
      id: 'x-1', type: 'SomethingNobodyWiredUp', occurredAt: '2026-08-05T10:00:00.000Z',
      idempotencyKey: 'x-1', source: 'edge', payload: {},
    }));
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && r.reason).toContain('kept for a person rather than dropped');
  });
});

// A resolver route, not a fixed template: the target depends on the DOCUMENT (e-invoice vs e-way-bill) AND the
// ACTION (poll vs verify), so a drained GST-reconciliation command reaches the very route that would have
// handled it online. Only these two idempotent, non-governance actions are relayed under the store's token.
describe('a drained portal-action command reaches the poll/verify route it would have online', () => {
  const portal = (payload: Record<string, unknown>): DomainEvent => makeEvent({
    id: 'pk', type: 'GstPortalActionRequested', occurredAt: '2026-08-14T10:00:00.000Z',
    idempotencyKey: 'gst-portal|poll|e_invoice|INV-1|unknown', source: 'web-erp/gst-reconciliation', payload,
  });

  it('routes an e-invoice poll to the invoice poll route, and verify to verify', async () => {
    const poll = fakeFetch(200);
    await transportOn(poll.fn).send(portal({ documentType: 'e_invoice', id: 'INV-1', action: 'poll' }));
    expect(poll.calls[0]?.url).toBe('https://api.example.test/v1/finance/e-invoice/invoices/INV-1/poll');
    const verify = fakeFetch(200);
    await transportOn(verify.fn).send(portal({ documentType: 'e_invoice', id: 'INV-1', action: 'verify' }));
    expect(verify.calls[0]?.url).toBe('https://api.example.test/v1/finance/e-invoice/invoices/INV-1/verify');
  });

  it('routes an e-way-bill poll and verify to the movement routes', async () => {
    const poll = fakeFetch(200);
    await transportOn(poll.fn).send(portal({ documentType: 'e_way_bill', id: 'MV-1', action: 'poll' }));
    expect(poll.calls[0]?.url).toBe('https://api.example.test/v1/finance/e-way-bill/movements/MV-1/poll');
    const verify = fakeFetch(200);
    await transportOn(verify.fn).send(portal({ documentType: 'e_way_bill', id: 'MV-1', action: 'verify' }));
    expect(verify.calls[0]?.url).toBe('https://api.example.test/v1/finance/e-way-bill/movements/MV-1/verify');
  });

  it('carries the command\'s own idempotency key, so a replay collapses to one effect', async () => {
    const { fn, calls } = fakeFetch(200);
    await transportOn(fn).send(portal({ documentType: 'e_invoice', id: 'INV-1', action: 'poll' }));
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('gst-portal|poll|e_invoice|INV-1|unknown');
  });

  it('REJECTS a governance action (approve/submit/reissue) — those are NEVER relayed under the store token', async () => {
    // reissue/approve/submit have no resolver path → rejected by name → dead-lettered for a person (rule #6).
    for (const action of ['reissue', 'approve', 'submit', 'investigate']) {
      const r = await transportOn(fakeFetch(200).fn).send(portal({ documentType: 'e_invoice', id: 'INV-1', action }));
      expect(r.status, `${action} should not route`).toBe('rejected');
    }
  });

  it('REJECTS an unknown document type or a missing id, rather than posting to a wrong URL', async () => {
    const noDoc = await transportOn(fakeFetch(200).fn).send(portal({ documentType: 'mystery', id: 'X', action: 'poll' }));
    expect(noDoc.status).toBe('rejected');
    const noId = await transportOn(fakeFetch(200).fn).send(portal({ documentType: 'e_invoice', id: '', action: 'poll' }));
    expect(noId.status).toBe('rejected');
  });

  it('the GOVERNANCE command GstReturnActionRequested has NO route — it dead-letters, never applied as the store', async () => {
    // Draining approve/submit under the store token would break maker ≠ checker (§28); until a dedicated
    // relayed-actor route exists, the honest outcome is a visible dead-letter (hard rule #6), not a wrong apply.
    const r = await transportOn(fakeFetch(200).fn).send(makeEvent({
      id: 'r-1', type: 'GstReturnActionRequested', occurredAt: '2026-08-14T10:00:00.000Z',
      idempotencyKey: 'gst-return|approve|062026|previewed', source: 'web-erp/gst-returns',
      payload: { period: '062026', action: 'approve', requestedBy: 'u-fin', observedState: 'previewed' },
    }));
    expect(r.status).toBe('rejected');
  });
});

describe('retryable versus rejected — the distinction that decides whether a sale survives', () => {
  it('treats a TIMEOUT as retryable, because a slow line says nothing about the sale', async () => {
    // A shop on a rural line times out several times a day. This is the branch that decides
    // whether it keeps its sales.
    const hangs = ((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    })) as unknown as typeof globalThis.fetch;

    const r = await transportOn(hangs, 20).send(sale());
    expect(r.status).toBe('retryable');
    expect(r.status === 'retryable' && r.reason).toContain('still queued');
  });

  it('treats an unreachable cloud as retryable, never as a bad sale', async () => {
    const refused = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;
    const r = await transportOn(refused).send(sale());
    expect(r.status).toBe('retryable');
  });

  it('treats every 5xx as retryable — the cloud is having a bad minute, not judging the payload', () => {
    for (const status of [500, 502, 503, 504]) expect(classify(status)).toBe('retryable');
  });

  it('treats 408, 425 and 429 as retryable — 4xx by number, transient by meaning', () => {
    for (const status of [408, 425, 429]) expect(classify(status)).toBe('retryable');
  });

  it('treats 401 as retryable and 403 as rejected, which is not the same question', () => {
    // An expired token is renewed by the next restart or refresh, so the sale should still be
    // waiting when it is. A permission the till does not hold will not appear by itself.
    expect(classify(401)).toBe('retryable');
    expect(classify(403)).toBe('rejected');
  });

  it('treats a permanent 4xx as rejected, so it does not bury everything behind it', () => {
    for (const status of [400, 404, 422]) expect(classify(status)).toBe('rejected');
  });

  it('treats 409 as ACCEPTED — the receiver already had it, which is what idempotency is for', () => {
    expect(classify(409)).toBe('accepted');
  });

  it('never answers "accepted" on an outcome it did not see', () => {
    // If we do not know whether it landed, we send it again and the receiver dedupes. Guessing
    // accepted loses the sale silently, which is the one outcome with no way back.
    for (const status of [0, 100, 301, 302, 399]) expect(classify(status)).not.toBe('accepted');
  });
});

describe('nothing it says can be pasted into a support thread by mistake', () => {
  it('never puts the token in a reason, on any path', async () => {
    const reasons: string[] = [];
    for (const status of [400, 403, 500, 503]) {
      const r = await transportOn(fakeFetch(status).fn).send(sale());
      if (r.status !== 'accepted') reasons.push(r.reason);
    }
    const refused = (() => Promise.reject(new Error(`connect failed using ${TOKEN}`))) as unknown as typeof globalThis.fetch;
    const r = await transportOn(refused).send(sale());
    if (r.status !== 'accepted') reasons.push(r.reason);

    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).not.toContain(TOKEN);
  });

  it('does not echo the response body, which can contain the request that carried the header', async () => {
    const echoes = (() => Promise.resolve(new Response(
      JSON.stringify({ received: { authorization: `Bearer ${TOKEN}` } }), { status: 400 },
    ))) as unknown as typeof globalThis.fetch;
    const r = await transportOn(echoes).send(sale());
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && r.reason).not.toContain(TOKEN);
  });

  it('sends the token, so the guard above is about the messages and not about it being absent', async () => {
    const { fn, calls } = fakeFetch(202);
    await transportOn(fn).send(sale());
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
  });
});
