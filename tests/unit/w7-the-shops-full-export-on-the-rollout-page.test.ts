import { describe, it, expect } from 'vitest';
import { createRolloutSession, fullExportWords, rolloutWords, ROLLOUT_COPY } from '../../apps/web-erp/src/rollout-session';

// W7 · M36-FR-02 / M36-FR-03 · D12-FR-05 · P-06 (open and portable): "Download the shop's full export" on the
// Trial switches and shop account page. The session asks head office's OWN route (GET /v1/platform/export, permission
// platform.tenant.export — the closure section's permission), hands back the body EXACTLY as head office sent it (never
// re-written), says in words what it holds and when it was taken on the shop's clock, and asks nothing on a closed, sealed
// account (OB-367).

const OWNER = { userId: 'u-owner', permissions: ['platform.flag.read', 'platform.tenant.export'] };
// A body with its own spacing and key order — what is saved must be these bytes, not a re-serialisation of them.
const BODY = '{"export":{"exportId":"exp-abc/1","tenantId":"t-1","requestedBy":"u-owner","at":"2026-11-04T19:05:00.000Z","outcome":"complete","complete":true,'
  + '"domains":[{"domain":"identity","rows":2,"format":"jsonl","checksum":"x","bytes":10},{"domain":"inventory","rows":3,"format":"jsonl","checksum":"y","bytes":20}],'
  + '"missing":[],"totalRows":5,"totalBytes":30,"detail":""},   "data":{"identity":[],"inventory":[]}}';

const fetchOf = (status: number, body: string, seen: string[] = []): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

describe('W7 · M36-FR-03: the shop\'s full export from the office page', () => {
  it('asks head office\'s own export route and keeps the file byte for byte, named by the SHOP\'s date', async () => {
    const seen: string[] = [];
    const s = createRolloutSession({ viewer: OWNER, fetch: fetchOf(200, BODY, seen) });
    expect(s.may.closure).toBe(true); // the button rides on the route's own permission
    const out = await s.fullExport('active');
    expect(seen).toEqual(['GET /v1/platform/export']);
    if (out.result !== 'ok') throw new Error(JSON.stringify(out));
    expect(out.value.fileText).toBe(BODY); // never altered
    // 19:05 UTC on 4 Nov is 00:35 on 5 Nov at the shop — the file is named by the shop's date, never the UTC date.
    expect(out.value.fileName).toBe('shop-full-export-2026-11-05-exp-abc1.json');
    expect(out.value).toMatchObject({ exportId: 'exp-abc/1', complete: true, totalRows: 5, requestedBy: 'u-owner', missing: [] });
    expect(out.value.parts).toEqual([{ domain: 'identity', rows: 2 }, { domain: 'inventory', rows: 3 }]);
    const words = fullExportWords('en', out.value);
    expect(words).toContain('taken 2026-11-05 00:35 (shop\'s clock) by u-owner');
    expect(words).toContain('It holds 5 records in 2 parts: identity 2, inventory 3.');
    expect(words).toContain('Complete — every part of the shop is in it.');
    expect(fullExportWords('ta', out.value)).toContain('முழுமையானது');
  });

  it('an incomplete export is SAID to be incomplete, naming what is missing — never passed off as whole', async () => {
    const partial = BODY.replace('"outcome":"complete","complete":true', '"outcome":"missing_domains","complete":false').replace('"missing":[]', '"missing":["loyalty"]');
    const out = await createRolloutSession({ viewer: OWNER, fetch: fetchOf(200, partial) }).fullExport('active');
    if (out.result !== 'ok') throw new Error(JSON.stringify(out));
    expect(out.value.fileText).toBe(partial);
    expect(fullExportWords('en', out.value)).toContain('NOT complete — these parts are missing: loyalty');
  });

  it('a closed account is sealed (OB-367): nothing is asked of head office', async () => {
    const seen: string[] = [];
    expect(await createRolloutSession({ viewer: OWNER, fetch: fetchOf(200, BODY, seen) }).fullExport('closed')).toEqual({ result: 'invalid', why: 'closedSealed' });
    expect(seen).toEqual([]);
  });

  it('head office\'s refusal is shown in its own words; a lost link and a non-export say so', async () => {
    const refused = await createRolloutSession({ viewer: OWNER, fetch: fetchOf(403, '{"error":{"code":"forbidden","whatHappened":"You may not take the export."}}') }).fullExport();
    expect(refused).toEqual({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'You may not take the export.' });
    const lost = await createRolloutSession({ viewer: OWNER, fetch: (async () => { throw new Error('offline'); }) as typeof fetch }).fullExport();
    expect(lost).toEqual({ result: 'lost_link' });
    expect(await createRolloutSession({ viewer: OWNER, fetch: fetchOf(200, '{"hello":1}') }).fullExport()).toEqual({ result: 'invalid', why: 'notAnExport' });
    expect(createRolloutSession({ viewer: { userId: 'u-cash', permissions: ['platform.flag.read'] } }).may.closure).toBe(false);
  });

  it('every new word has its Tamil twin', () => {
    for (const k of ['exportH', 'exportLead', 'exportDownload', 'exportSaved', 'exportComplete', 'exportMissing', 'closedSealed', 'notAnExport']) {
      expect((ROLLOUT_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect(rolloutWords('ta', k)).not.toBe(rolloutWords('en', k));
    }
  });
});
