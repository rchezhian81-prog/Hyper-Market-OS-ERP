import { describe, it, expect } from 'vitest';
import { createEslSession, readPushes, readLabels, pushStateOf, eslWords, ESL_COPY, fill } from '../../apps/web-erp/src/esl-session';

/**
 * **U6 (UI/UX gap audit §27 "Product — label/ESL" · D14-FR-05 · P-08): the Electronic shelf labels page's session.** It reads
 * head office's pushes into rows with an honest state per push (shown on every label · not on N · not on any · no label to
 * send to), counts the labels of the store, offers "send again" only to a person who holds the word, asks head office for
 * THIS store, and sends the same price again — never a new one. Every word in both languages; head office's sentences kept.
 */
const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pushBody = {
  branchId: 'store-1', notConfirmed: 1, rule: 'A shelf is known to match the till only once every label has echoed the new price back', hardware: 'built with a stand-in', asAt: '2026-11-07T12:00:00.000Z',
  pushes: [
    { push: { pushId: 'esl-chg-2-store-1', productId: 'p-soap', priceMinor: 4_500, because: 'price_change', at: '2026-11-07T11:50:00.000Z', commands: [{ deviceId: 'esl-1', accepted: true, detail: 'taken' }, { deviceId: 'esl-2', accepted: true, detail: 'taken' }] }, confirmed: ['esl-1'], unconfirmed: ['esl-2'], safeToChangeAtTill: false, detail: 'esl-2 has not confirmed' },
    { push: { pushId: 'esl-chg-1-store-1', productId: 'p-rice', priceMinor: 6_000, because: 'price_change', at: '2026-11-07T11:00:00.000Z', commands: [{ deviceId: 'esl-3', accepted: true, detail: 'taken' }] }, confirmed: ['esl-3'], unconfirmed: [], safeToChangeAtTill: true, detail: 'every label confirmed' },
    { push: { pushId: 'esl-chg-0-store-1', productId: 'p-oil', priceMinor: 1_000, because: 'price_change', at: '2026-11-07T10:00:00.000Z', commands: [] }, confirmed: [], unconfirmed: [], safeToChangeAtTill: false, detail: 'no label' },
  ],
};
const fleetBody = { devices: [
  { deviceId: 'esl-1', kind: 'esl_label', status: 'active', lastHeardAt: '2026-11-07T11:51:00.000Z' },
  { deviceId: 'esl-2', kind: 'esl_label', status: 'active', lastHeardAt: null },
  { deviceId: 'esl-9', kind: 'esl_label', status: 'blocked', lastHeardAt: null },
  { deviceId: 'rfid-1', kind: 'rfid_reader', status: 'active', lastHeardAt: null },
], hardware: 'built with a stand-in', asAt: '2026-11-07T12:00:00.000Z' };

describe('U6: the shelf labels page session', () => {
  it('reads the pushes into rows with an honest state each, and counts the labels only', () => {
    const p = readPushes(pushBody);
    expect(p.rows.map((r) => [r.pushId, r.state, r.labels, r.confirmed.length])).toEqual([
      ['esl-chg-2-store-1', 'partial', 2, 1], ['esl-chg-1-store-1', 'confirmed', 1, 1], ['esl-chg-0-store-1', 'no_labels', 0, 0],
    ]);
    expect(p.notConfirmed).toBe(1);
    expect(pushStateOf(2, 0)).toBe('unconfirmed');
    const l = readLabels(fleetBody);
    expect(l).toMatchObject({ total: 3, active: 2, blocked: 1, retired: 0, neverHeard: 1 });
    expect(readPushes(null).rows).toEqual([]);
    expect(readLabels({ devices: 'not a list' }).total).toBe(0);
  });

  it('asks head office for THIS store, offers what the person holds, and sends the same price again', async () => {
    const calls: { method: string; path: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url); calls.push({ method: init?.method ?? 'GET', path });
      if (path.startsWith('/v1/devices/esl/pushes?')) return answer(pushBody);
      if (path.startsWith('/v1/devices/floor?')) return answer(fleetBody);
      if (path === '/v1/devices/esl/pushes/esl-chg-2-store-1/retry') return answer({ pushId: 'esl-chg-2-store-1-r1', retryOf: 'esl-chg-2-store-1', retried: true, sentTo: ['esl-2'], detail: 'the same price was sent again' }, 201);
      return answer({ error: { code: 'not_found' } }, 404);
    }) as unknown as typeof globalThis.fetch;
    const s = createEslSession({ viewer: { userId: 'u-owner', permissions: ['price.integrity.audit', 'platform.health.read'] }, storeId: 'store-1', fetch });
    expect(s.may).toEqual({ named: true, read: true, labels: true });
    const p = await s.pushes(); expect(p.result).toBe('ok');
    const l = await s.labels(); expect(l.result).toBe('ok');
    expect(calls.map((c) => c.path)).toEqual(['/v1/devices/esl/pushes?branchId=store-1', '/v1/devices/floor?branchId=store-1']);
    const r = await s.retry('esl-chg-2-store-1');
    expect(r).toEqual({ result: 'ok', value: { pushId: 'esl-chg-2-store-1-r1', retried: true, sentTo: ['esl-2'], detail: 'the same price was sent again' } });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/v1/devices/esl/pushes/esl-chg-2-store-1/retry' });

    // The store manager holds the prices but not the device list: the labels' counts are "not known", said why.
    const m = createEslSession({ viewer: { userId: 'u-mgr', permissions: ['price.integrity.audit'] }, storeId: 'store-1', fetch });
    expect(m.may).toEqual({ named: true, read: true, labels: false });
    expect(await m.labels()).toEqual({ result: 'invalid', why: 'cannotLabels' });
    // A cashier reads nothing and sends nothing; nobody signed in is told so.
    const c = createEslSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch });
    expect(await c.pushes()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await c.retry('x')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createEslSession({ viewer: undefined, fetch }).pushes()).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('every word has a Tamil twin, distinct from the English; a refusal is the three-part words', () => {
    expect(Object.keys(ESL_COPY.ta).sort()).toEqual(Object.keys(ESL_COPY.en).sort());
    for (const k of Object.keys(ESL_COPY.en)) {
      if (k === 'lang') continue;
      expect(eslWords('ta', k), k).not.toBe(eslWords('en', k));
      expect(eslWords('ta', k).trim(), k).not.toBe('');
    }
    expect(fill(eslWords('en', 'st_partial'), { n: 2 })).toBe('Not on 2 label(s)');
    expect(eslWords('en', 'no_such_key')).toBe('no_such_key');
  });
});
