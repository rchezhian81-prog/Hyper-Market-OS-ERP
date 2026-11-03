import { describe, it, expect } from 'vitest';
import { createDispatchSession, dispatchWords, dispatchOutcomeWords, manifestIdFor, DISPATCH_COPY } from '../../apps/web-erp/src/dispatch-session';

// W4 · M19-FR-02 — "dispatch with a manifest" on the Dispatch page: the page reads the order's recorded pack, takes a tamper
// seal typed for every crate and the short or refused lines the customer has been told about, asks head office to dispatch
// (head office builds the manifest from the pack, never from the order) and shows the manifest. Each route's own word is
// asked: reading packs and manifests (fulfilment.pack.read), dispatching (fulfilment.pack.record). Head office's refusal is
// said in its own words. Synthetic data.

interface Call { method: string; path: string; body: unknown; key?: string }
function fakeFetch(reply: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetch = (async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body), ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) };
    calls.push(c);
    const r = reply(c);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const PACKER = { userId: 'u-packer', permissions: ['fulfilment.pack.read', 'fulfilment.pack.record'] };

describe('W4 — the Dispatch page dispatches a packed order and shows its manifest (M19-FR-02)', () => {
  it('asks each route\'s own word: a reader of packs may look but not dispatch; a cashier is offered neither; nothing is asked', async () => {
    const f = fakeFetch();
    const reader = createDispatchSession({ viewer: { userId: 'u-read', permissions: ['fulfilment.pack.read'] }, fetch: f.fetch });
    expect(reader.may).toMatchObject({ readPacks: true, sendOrders: false });
    expect(await reader.dispatchOrder({ orderId: 'ORD-1', storeId: 'br-1', seals: { C1: 'SEAL-1' } })).toEqual({ result: 'invalid', why: 'cannotSend' });
    const cashier = createDispatchSession({ viewer: { userId: 'u-cash', permissions: ['pos.sale.read'] }, fetch: f.fetch });
    expect(await cashier.orderPack('ORD-1')).toEqual({ result: 'invalid', why: 'cannotPack' });
    expect(await cashier.manifest('ORD-1')).toEqual({ result: 'invalid', why: 'cannotPack' });
    const nobody = createDispatchSession({ viewer: undefined, fetch: f.fetch });
    expect(await nobody.orderPack('ORD-1')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(f.calls).toEqual([]);
  });

  it('refuses on the page before asking: no order, no store, a crate with no seal', async () => {
    const f = fakeFetch();
    const s = createDispatchSession({ viewer: PACKER, fetch: f.fetch });
    expect(await s.orderPack('  ')).toEqual({ result: 'invalid', why: 'needOrder' });
    expect(await s.dispatchOrder({ orderId: 'ORD-1', storeId: '', seals: { C1: 'S' } })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await s.dispatchOrder({ orderId: 'ORD-1', storeId: 'br-1', seals: { C1: 'SEAL-1', C2: '  ' } })).toEqual({ result: 'invalid', why: 'needSeals' });
    expect(await s.dispatchOrder({ orderId: 'ORD-1', storeId: 'br-1', seals: {} })).toEqual({ result: 'invalid', why: 'needSeals' });
    expect(f.calls).toEqual([]);
    expect(dispatchWords('en', 'needSeals')).toBe('Type the tamper seal on every crate.');
  });

  it('asks head office exactly: the pack, then the dispatch (one manifest per order, the seals, the told lines, idempotent), then the manifest', async () => {
    const f = fakeFetch((c) => ({ status: 200, body: c.path.endsWith('/dispatch') ? { dispatched: true, outcome: 'dispatched', detail: '1 line(s) in 1 crate(s)', manifest: { manifestId: 'MF-ORD 1' } } : {} }));
    const s = createDispatchSession({ viewer: PACKER, fetch: f.fetch, newKey: () => 'k-1' });
    expect((await s.orderPack(' ORD 1 ')).result).toBe('ok');
    expect((await s.dispatchOrder({ orderId: 'ORD 1', storeId: ' br-1 ', seals: { C1: ' SEAL-1 ' }, resolvedLineIds: ['l2'] })).result).toBe('ok');
    expect((await s.dispatchOrder({ orderId: 'ORD 1', storeId: 'br-1', seals: { C1: 'SEAL-1' } })).result).toBe('ok');
    expect((await s.manifest('ORD 1')).result).toBe('ok');
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/fulfilment/orders/ORD%201/pack', 'POST /v1/fulfilment/orders/ORD%201/dispatch', 'POST /v1/fulfilment/orders/ORD%201/dispatch', 'GET /v1/fulfilment/orders/ORD%201/manifest',
    ]);
    expect(f.calls[1]!.body).toEqual({ manifestId: 'MF-ORD 1', locationId: 'br-1', seals: { C1: 'SEAL-1' }, resolvedLineIds: ['l2'] });
    expect(f.calls[2]!.body).toEqual({ manifestId: 'MF-ORD 1', locationId: 'br-1', seals: { C1: 'SEAL-1' } });
    expect(f.calls[1]!.key).toBeDefined();
    expect(manifestIdFor(' ORD 1 ')).toBe('MF-ORD 1');
  });

  it('says head office\'s refusal in its own words — an unsealed crate or an untold line leaves nothing dispatched', async () => {
    const whatHappened = 'crate(s) C2 have no tamper seal — an unsealed crate cannot be shown to have arrived as it left';
    const f = fakeFetch(() => ({ status: 409, body: { error: { code: 'unsealed_crate', whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Seal every crate and dispatch again.' } } }));
    const s = createDispatchSession({ viewer: PACKER, fetch: f.fetch });
    const out = await s.dispatchOrder({ orderId: 'ORD-1', storeId: 'br-1', seals: { C1: 'SEAL-1' } });
    expect(out.result).toBe('refused');
    expect(dispatchOutcomeWords('en', out)).toContain(whatHappened);
    expect(dispatchOutcomeWords('en', out)).toContain(DISPATCH_COPY.en.refused);
  });

  it('every new word has a Tamil twin', () => {
    for (const k of ['sendH', 'orderL', 'showPack', 'dispatchOrder', 'showManifest', 'needOrder', 'needSeals', 'cannotPack', 'cannotSend', 'crateK', 'sealL', 'packedK', 'refusedLineK', 'customerToldL', 'dispatchedK', 'manifestK', 'cratesK', 'sealsK', 'tempK', 'dispatchedByK']) {
      expect(DISPATCH_COPY.en[k as keyof typeof DISPATCH_COPY.en], k).toBeDefined();
      expect(dispatchWords('ta', k), k).not.toBe(DISPATCH_COPY.en[k as keyof typeof DISPATCH_COPY.en]);
    }
  });
});
