import { describe, it, expect } from 'vitest';
import { createScorecardSession, ratingWords, SCORECARD_COPY } from '../../apps/web-erp/src/supplier-scorecard-session';
import { createCorrelationSession, CORRELATION_COPY } from '../../apps/web-erp/src/lp-correlation-session';
import { createBaysSession, bayScoreWords, BAYS_COPY } from '../../apps/web-erp/src/planogram-bays-session';

// R4 Lane 4 — the two new page sessions (D-10 Supplier scorecard, D-21 "Seen together"): they refuse only the cheap things
// before a request, say "not rated" with its reason (never a number), send nothing a person did not ask for, and carry a
// Tamil twin for every word.

const recorder = () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('Supplier scorecard session (D-10)', () => {
  it('asks only with the read permission, a supplier and a forward period; "not rated" is said with its reason', async () => {
    const r = recorder();
    const s = createScorecardSession({ viewer: { userId: 'u', permissions: ['purchase.commitment.read'] }, fetch: r.fetch });
    expect(await s.scorecard(' ', '', '')).toEqual({ result: 'invalid', why: 'needSupplier' });
    expect(await s.scorecard('s-1', '2026-09-30', '2026-09-01')).toEqual({ result: 'invalid', why: 'backwards' });
    expect((await s.scorecard('s 1', '2026-09-01', '2026-09-30')).result).toBe('ok');
    expect(r.calls).toEqual([{ url: '/v1/purchase/suppliers/s%201/scorecard?from=2026-09-01&to=2026-09-30', method: 'GET' }]);
    const none = createScorecardSession({ viewer: { userId: 'u', permissions: [] }, fetch: r.fetch });
    expect(await none.scorecard('s-1', '', '')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ratingWords('en', { kind: 'not_rated', because: 'no delivery in the period' })).toBe('Not rated — no delivery in the period');
    expect(ratingWords('en', { kind: 'rated', bp: 6_667 })).toBe('66.7%');
    expect(Object.keys(SCORECARD_COPY.ta).sort()).toEqual(Object.keys(SCORECARD_COPY.en).sort());
  });
});

describe('"Seen together" session (D-21)', () => {
  it('reads with lp.case.read; opens a case and adds CCTV only with lp.case.manage — and the CCTV body carries no video', async () => {
    const r = recorder();
    const reader = createCorrelationSession({ viewer: { userId: 'u', permissions: ['lp.case.read'] }, fetch: r.fetch, newKey: () => 'k', newId: () => 'ev-1' });
    expect((await reader.view('product', 'p-ghee', '2026-10-01', '2026-10-31')).result).toBe('ok');
    expect(await reader.view('product', 'p-ghee', '2026-10-31', '2026-10-01')).toEqual({ result: 'invalid', why: 'backwards' });
    const p = { propose: true, because: '', raisedFromRef: 'lp-correlation:product:p-ghee:2026-10-01:2026-10-31', subjectRef: 'product:p-ghee', summary: 's', valueMinor: 5 };
    expect(await reader.open('case-1', p, 'u-mgr')).toEqual({ result: 'invalid', why: 'cannotManage' });
    const manager = createCorrelationSession({ viewer: { userId: 'u', permissions: ['lp.case.read', 'lp.case.manage'] }, fetch: r.fetch, newKey: () => 'k', newId: () => 'ev-1' });
    expect(await manager.open('case-1', p, ' ')).toEqual({ result: 'invalid', why: 'needAll' });
    await manager.open('case-1', p, 'u-mgr');
    await manager.cctv('case-1', { cameraId: 'CAM-3', from: '2026-10-11T10:00:00Z', to: '2026-10-11T10:20:00Z', collectedBy: 'u-mgr' });
    expect(await manager.cctv('case-1', { cameraId: 'CAM-3', from: 'not a time', to: '2026-10-11T10:20:00Z', collectedBy: 'u-mgr' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/loss-prevention/correlation?productId=p-ghee&from=2026-10-01&to=2026-10-31',
      'POST /v1/loss-prevention/cases/case-1',
      'POST /v1/loss-prevention/cases/case-1/cctv/ev-1',
    ]);
    expect(Object.keys(r.calls[2]!.body as object).sort()).toEqual(['cameraId', 'collectedBy', 'from', 'to']);
    expect(Object.keys(CORRELATION_COPY.ta).sort()).toEqual(Object.keys(CORRELATION_COPY.en).sort());
  });
});

describe('Shelf compliance by bay session (D-13)', () => {
  it('reads with planogram.compliance.read; keeps a photo only with shelf.count.record, of an allowed type and size', async () => {
    const r = recorder();
    const s = createBaysSession({ viewer: { userId: 'u', permissions: ['planogram.compliance.read', 'shelf.count.record'] }, fetch: r.fetch, newKey: () => 'k', newId: () => 'ph-1' });
    expect((await s.bays('br-1')).result).toBe('ok');
    const photo = { storeId: 'br-1', aisle: 1, rack: 1, bay: 1, mediaType: 'image/png', bytes: 10, contentBase64: 'AA==' };
    expect(await s.keepPhoto({ ...photo, mediaType: 'image/gif' })).toEqual({ result: 'invalid', why: 'typeNotAllowed' });
    expect(await s.keepPhoto({ ...photo, bytes: 700 * 1024 + 1 })).toEqual({ result: 'invalid', why: 'tooLarge' });
    expect((await s.keepPhoto(photo)).result).toBe('ok');
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/merchandising/planogram-compliance/bays?storeId=br-1', 'POST /v1/merchandising/shelf-photos/ph-1']);
    const reader = createBaysSession({ viewer: { userId: 'u', permissions: ['planogram.compliance.read'] }, fetch: r.fetch });
    expect(await reader.keepPhoto(photo)).toEqual({ result: 'invalid', why: 'cannotRecord' });
    const base = { bayKey: 'A1-R1-B1', aisle: 1, rack: 1, bay: 1, planned: 2, observed: 0, compliant: 0, gaps: [], photos: [], measuredBy: 'counted by staff' };
    expect(bayScoreWords('en', { ...base, score: { kind: 'not_scored', because: 'nothing counted' } })).toBe('Not scored — nothing counted');
    expect(bayScoreWords('en', { ...base, observed: 2, compliant: 1, score: { kind: 'scored', bp: 5_000 } })).toBe('50% (1/2 counted, 2 facings planned)');
    expect(Object.keys(BAYS_COPY.ta).sort()).toEqual(Object.keys(BAYS_COPY.en).sort());
  });
});
