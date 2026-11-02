import { describe, it, expect } from 'vitest';
import {
  createOldSystemSession, OLD_SYSTEM_COPY, oldSystemWords, readSource, readEntry, readSeen, paiseOf, approvedTableFile,
  SOURCE_KINDS, VOLUME_BASES, MAPPING_DOMAINS, EXCLUSION_SCOPES,
} from '../../apps/web-erp/src/old-system-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * W3 · MG-01 · MG-03 · MG-07 · MG-08 · MG-09 · MG-11 · MG-12 — the Old system checks page's session: what it refuses before
 * asking head office, exactly what it sends (never the person's name; never the items a reversal takes back; never a
 * typed tenant), and that every word has a Tamil twin. Synthetic values only.
 */

function recorder(reply: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: { url: string; method: string; body: unknown; key: string | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: headers['idempotency-key'] });
    const r = reply(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const ALL = ['migration.discovery.read', 'migration.mapping.read', 'migration.mapping.approve', 'migration.reconciliation.read', 'migration.exclusion.propose', 'migration.exclusion.approve', 'migration.cleaning.read', 'migration.exception.record', 'migration.parallel.read', 'migration.cutover.decide', 'migration.retirement.assess'];
const owner = (fetch: typeof globalThis.fetch) => createOldSystemSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch });

describe('the Old system checks words', () => {
  it('every English word has a Tamil twin (and every kind, basis, code kind and scope has words)', () => {
    const keys = Object.keys(OLD_SYSTEM_COPY.en) as (keyof typeof OLD_SYSTEM_COPY.en)[];
    const gaps = bilingualGaps(OLD_SYSTEM_COPY as never, keys as never);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
    for (const k of SOURCE_KINDS) expect(oldSystemWords('ta', `k_${k}`)).not.toBe(`k_${k}`);
    for (const k of VOLUME_BASES) expect(oldSystemWords('ta', `b_${k}`)).not.toBe(`b_${k}`);
    for (const k of MAPPING_DOMAINS) expect(oldSystemWords('ta', `d_${k}`)).not.toBe(`d_${k}`);
    for (const k of EXCLUSION_SCOPES) expect(oldSystemWords('ta', `s_${k}`)).not.toBe(`s_${k}`);
    for (const k of ['retention_not_elapsed', 'restore_never_verified', 'cutover_not_accepted', 'open_assessment']) expect(oldSystemWords('ta', `r_${k}`)).not.toBe(`r_${k}`);
  });
});

describe('the pure checks before asking', () => {
  it('a source: a missing owner, row count or keeping period is SENT as absent (that is the gap head office names)', () => {
    const d = { sourceId: 'old-erp', name: 'The old shop program', kind: 'erp_database', ownerUserId: '', rowCount: '', volumeBasis: 'unknown', retentionYears: '', extractable: true };
    expect(readSource(d)).toEqual({ sourceId: 'old-erp', name: 'The old shop program', kind: 'erp_database', volumeBasis: 'unknown', extractable: true });
    expect(readSource({ ...d, ownerUserId: ' u-it ', rowCount: '1200', volumeBasis: 'counted', retentionYears: '8' })).toMatchObject({ ownerUserId: 'u-it', rowCount: 1200, retentionYears: 8 });
    expect(readSource({ ...d, sourceId: 'a b' })).toEqual({ result: 'invalid', why: 'noSourceId' });
    expect(readSource({ ...d, kind: 'cloud' })).toEqual({ result: 'invalid', why: 'noKind' });
    expect(readSource({ ...d, rowCount: '12.5' })).toEqual({ result: 'invalid', why: 'noRows' });
    expect(readSource({ ...d, volumeBasis: '' })).toEqual({ result: 'invalid', why: 'noBasis' });
  });
  it('a mapping entry needs a kind, both codes and a reason; a seen value its row count; rupees read to paise exactly', () => {
    expect(readEntry({ domain: 'tax_code', legacyValue: ' T5 ', targetValue: '0500', rationale: '5% GST' })).toEqual({ domain: 'tax_code', legacyValue: 'T5', targetValue: '0500', rationale: '5% GST' });
    expect(readEntry({ domain: 'tax_code', legacyValue: 'T5', targetValue: '0500', rationale: ' ' })).toEqual({ result: 'invalid', why: 'noWhy' });
    expect(readSeen({ domain: 'uom', value: 'KG', rows: 'many' })).toEqual({ result: 'invalid', why: 'noSeenRows' });
    expect(paiseOf('1,250.5')).toBe(125_050);
    expect(paiseOf('12')).toBe(1_200);
    expect(paiseOf('1.234')).toBeUndefined();
  });
  it('the approved table is kept as a file named by its id and version', () => {
    const f = approvedTableFile({ mappingId: 'tax-map', tenantId: 't', version: 2, status: 'approved', entries: [], approvedBy: 'u-owner', approvedAt: 'x' });
    expect(f.name).toBe('tax-map-v2-approved.json');
    expect(decodeURIComponent(f.href.split(',')[1]!)).toContain('"approvedBy": "u-owner"');
  });
});

describe('the Old system checks session', () => {
  it('asks nothing for nobody or without the right; offers each step only with its permission', async () => {
    const r = recorder();
    expect(await createOldSystemSession({ viewer: undefined, fetch: r.fetch }).discover([])).toEqual({ result: 'invalid', why: 'nobody' });
    const mgr = createOldSystemSession({ viewer: { userId: 'u-mgr', permissions: ['migration.reconciliation.read', 'migration.exclusion.propose'] }, fetch: r.fetch });
    expect(mgr.may).toMatchObject({ exclusionsRead: true, propose: true, decideExclusion: false, cutoverDecide: false, mapApprove: false });
    expect(await mgr.decideExclusion('x', 'approve', 'ok')).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(await mgr.approveReversal('load-1')).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(await mgr.nightCheck()).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(r.calls).toEqual([]);
  });

  it('MG-01 / MG-03: discovery sends the list; a mapping is built for the signed-in shop (its tenant read from head office, never typed)', async () => {
    const r = recorder((url) => (url === '/v1/identity/me' ? { status: 200, body: { tenantId: 'tenant-from-head-office', userId: 'u-owner' } }
      : url === '/v1/migration/mapping/approve' ? { status: 200, body: { approvedBy: 'u-owner', status: 'approved' } } : { status: 200, body: {} }));
    const s = owner(r.fetch);
    expect(await s.discover([])).toEqual({ result: 'invalid', why: 'noSources' });
    await s.discover([{ sourceId: 'old-erp', name: 'x', kind: 'erp_database', volumeBasis: 'counted', extractable: true, rowCount: 3 }]);
    const entries = [{ domain: 'tax_code', legacyValue: 'T5', targetValue: '0500', rationale: '5% GST' }];
    expect(await s.coverage([{ domain: 'tax_code', value: 'T5', rows: 9 }])).toEqual({ result: 'invalid', why: 'approveFirst' });
    expect(await s.approveMapping({ mappingId: 'tax-map', version: '0', entries })).toEqual({ result: 'invalid', why: 'noVersion' });
    expect(await s.approveMapping({ mappingId: 'tax-map', version: '1', entries: [] })).toEqual({ result: 'invalid', why: 'noEntries' });
    await s.approveMapping({ mappingId: 'tax-map', version: '1', entries });
    expect(await s.coverage([])).toEqual({ result: 'invalid', why: 'noSeen' });
    await s.coverage([{ domain: 'tax_code', value: 'T5', rows: 9 }]);
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/migration/discovery', 'GET /v1/identity/me', 'POST /v1/migration/mapping/approve', 'POST /v1/migration/mapping/coverage']);
    const table = { mappingId: 'tax-map', tenantId: 'tenant-from-head-office', version: 1, status: 'draft', entries };
    expect(r.calls[2]!.body).toEqual({ table }); // no approver in the body: head office takes the signed-in person
    // Coverage is measured with the table head office APPROVED — exactly as it came back.
    expect(r.calls[3]!.body).toEqual({ table: { approvedBy: 'u-owner', status: 'approved' }, observed: [{ domain: 'tax_code', value: 'T5', rows: 9 }] });
  });

  it('MG-07: a proposal in paise with a reason; the owner\'s decision in writing — approve or reject, never blank', async () => {
    const r = recorder();
    const s = owner(r.fetch);
    expect(await s.proposeExclusion({ exclusionId: 'scans', scope: 'named_records', description: 'scans', recordCount: '40', value: 'lots', reason: 'r' })).toEqual({ result: 'invalid', why: 'noValue' });
    expect(await s.decideExclusion('scans', '', 'fine')).toEqual({ result: 'invalid', why: 'noChoice' });
    expect(await s.decideExclusion('scans', 'reject', ' ')).toEqual({ result: 'invalid', why: 'noStatement' });
    await s.proposeExclusion({ exclusionId: 'scans', scope: 'named_records', description: ' unreadable scans ', recordCount: '40', value: '1250.50', reason: ' the files are corrupt ' });
    await s.decideExclusion('scans', 'reject', ' keep them ');
    expect(r.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/v1/migration/history/exclusions', { exclusionId: 'scans', scope: 'named_records', description: 'unreadable scans', recordCount: 40, valueMinor: 125_050, reason: 'the files are corrupt' }],
      ['POST', '/v1/migration/history/exclusions/scans/decision', { approve: false, ownerStatement: 'keep them' }],
    ]);
  });

  it('MG-09: both files and every required column named, from head office\'s own field list; a blank optional column is left out', async () => {
    const r = recorder();
    const s = owner(r.fetch);
    const domains = [{ domain: 'items', words: { en: 'Items', ta: 'பொருட்கள்' }, fields: [{ key: 'item_code', required: true, words: { en: 'Item code', ta: 'x' } }, { key: 'uom', required: false, words: { en: 'Unit', ta: 'y' } }] }];
    const files = { baseline: { csv: 'Code\nA', label: 'a.csv' }, latest: { csv: 'Code\nB', label: 'b.csv' } };
    expect(await s.runExportDiff({ diffId: 'd1', domain: 'items', columns: {}, ...files }, [])).toEqual({ result: 'invalid', why: 'domainsFirst' });
    expect(await s.runExportDiff({ diffId: 'd1', domain: 'items', columns: { item_code: 'Code' }, baseline: null, latest: files.latest }, domains)).toEqual({ result: 'invalid', why: 'noFiles' });
    expect(await s.runExportDiff({ diffId: 'd1', domain: 'items', columns: { uom: 'U' }, ...files }, domains)).toEqual({ result: 'invalid', why: 'noColumns' });
    await s.runExportDiff({ diffId: 'd1', domain: 'items', columns: { item_code: ' Code ', uom: '' }, ...files }, domains);
    expect(r.calls.map((c) => [c.url, c.body])).toEqual([['/v1/migration/export-diffs/d1', { domain: 'items', mapping: { item_code: 'Code' }, ...files }]]);
  });

  it('MG-08 / MG-11: a reversal names only which cutover and why — never the items; the approval sends nothing; the night check is one click', async () => {
    const r = recorder();
    const s = owner(r.fetch);
    expect(await s.askReversal('load-1', 'C-1', '')).toEqual({ result: 'invalid', why: 'noReverseReason' });
    await s.window('C-1');
    await s.nightCheck();
    await s.askReversal(' load-1 ', ' C-1 ', ' the stock file was the wrong day ');
    await s.approveReversal('load-1');
    await s.reversal('load-1');
    expect(r.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/v1/migration/cutover/windows/C-1', undefined],
      ['POST', '/v1/migration/cutover/night-check', {}],
      ['POST', '/v1/migration/opening-reversals/load-1', { cutoverId: 'C-1', reason: 'the stock file was the wrong day' }],
      ['POST', '/v1/migration/opening-reversals/load-1/approval', {}],
      ['GET', '/v1/migration/opening-reversals/load-1', undefined],
    ]);
  });

  it('MG-12: the archive is sent read-only with its dates; an empty restore day is sent as never verified', async () => {
    const r = recorder();
    const s = owner(r.fetch);
    const d = { archiveId: 'arch-1', sourceId: 'old-erp', digest: 'abc123', rowCount: '1200', archivedOn: '2026-11-01', retentionYears: '8', earliestRecordDate: '2019-04-01', latestRecordDate: '2026-10-31', restoreVerifiedOn: '', cutoverAccepted: false, openAssessments: '0' };
    expect(await s.assessRetirement({ ...d, rowCount: 'x' })).toEqual({ result: 'invalid', why: 'noArchive' });
    expect(await s.assessRetirement({ ...d, openAssessments: '' })).toEqual({ result: 'invalid', why: 'noOpen' });
    await s.assessRetirement(d);
    expect(r.calls[0]!.body).toEqual({
      archive: { archiveId: 'arch-1', sourceId: 'old-erp', digest: 'abc123', rowCount: 1200, archivedAt: '2026-11-01T00:00:00.000Z', retentionYears: 8, earliestRecordDate: '2019-04-01', latestRecordDate: '2026-10-31', readOnly: true },
      cutoverAccepted: false, openAssessments: 0,
    });
  });
});
