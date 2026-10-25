import { describe, it, expect } from 'vitest';
import {
  decideRollout, rolloutBoard, rolloutHistory, rolloutSection, laneRollout, laneSwitchOn, type RolloutChange,
} from '../../packages/platform/src/rollout';
import { posRolloutOf } from '../../apps/pos/src/lane-rollout';
import { assessUpgrade, releaseContract, currentSurfaceOf, operationOf, RELEASED_CONTRACT_FORMAT, type ReleasedContract } from '../../services/platform/src/upgrade-compatibility';
import {
  buildConsentExport, readConsentImport, judgeImport, importEvidence, CONSENT_RECORD_FORMAT, type LedgerConsent,
} from '../../packages/customer/src/consent-manager-format';
import { usageRecordsOf, PRICE_NOT_SET, type UsageSnapshot } from '../../services/platform/src/metering';
import { readVolumeWatch, runVolumeWatch, type DataVolumeDeps, type VolumeThreshold } from '../../services/customer/src/data-volume-watch';
import { createRolloutSession, rolloutWords, rupees } from '../../apps/web-erp/src/rollout-session';

// OB-288 P4 — the pure rules: rollout per branch and lane (R8-9 · OB-316), upgrade compatibility (M36-FR-03), the
// consent-manager record (C8 · OB-324), the usage meter's records (M36-FR-01 · OB-321) and the volume watch (C9 · OB-324).

const at = (n: number): string => `2026-10-2${n}T10:00:00.000Z`;
const ch = (c: Partial<RolloutChange> & Pick<RolloutChange, 'key' | 'branchId' | 'enabled'>, n = 1): RolloutChange => ({ reason: `step ${n}`, changedBy: 'u-it', changedAt: at(n), ...c });

describe('rollout per branch and per lane (R8-9 · OB-316)', () => {
  const changes = [
    ch({ key: 'self_checkout', branchId: 'B1', laneId: 'lane-7', enabled: true }, 1),
    ch({ key: 'esl', branchId: 'B1', enabled: true }, 2),
    ch({ key: 'esl', branchId: 'B1', laneId: 'lane-2', enabled: false }, 3),
    ch({ key: 'esl', branchId: 'B1', enabled: false }, 4),
    ch({ key: 'esl', branchId: 'B1', enabled: true }, 5),
  ];

  it('a switch nobody set is off; the lane\'s own setting beats its branch\'s; each answer names its source', () => {
    expect(decideRollout(changes, 'self_checkout', { branchId: 'B1', laneId: 'lane-7' })).toMatchObject({ on: true, source: 'lane', version: 1 });
    expect(decideRollout(changes, 'self_checkout', { branchId: 'B1', laneId: 'lane-1' })).toMatchObject({ on: false, source: 'never_set', version: null });
    expect(decideRollout(changes, 'self_checkout', { branchId: 'B2' })).toMatchObject({ on: false, source: 'never_set' });
    expect(decideRollout(changes, 'esl', { branchId: 'B1', laneId: 'lane-1' })).toMatchObject({ on: true, source: 'branch', version: 3 });
    expect(decideRollout(changes, 'esl', { branchId: 'B1', laneId: 'lane-2' })).toMatchObject({ on: false, source: 'lane', version: 1 });
    expect(decideRollout(changes, 'esl', { branchId: 'B2', laneId: 'lane-1' }).on).toBe(false);
  });

  it('every change at a place is its own numbered version, oldest first — nothing overwritten', () => {
    expect(rolloutHistory(changes, 'esl', { branchId: 'B1' }).map((v) => [v.version, v.enabled])).toEqual([[1, true], [2, false], [3, true]]);
    expect(rolloutBoard(changes).map((r) => [r.key, r.branchId, r.laneId, r.enabled, r.version])).toEqual([
      ['esl', 'B1', null, true, 3], ['esl', 'B1', 'lane-2', false, 1], ['self_checkout', 'B1', 'lane-7', true, 1],
    ]);
  });

  it('the pack section carries a store\'s settings only; the till resolves its own lane offline; not told is off', () => {
    const s = rolloutSection(changes, 'B1');
    expect(s).toEqual({ format: 'sre-rollout/1', branchId: 'B1', switches: [
      { key: 'esl', branch: { enabled: true, version: 3 }, lanes: [{ laneId: 'lane-2', enabled: false, version: 1 }] },
      { key: 'self_checkout', branch: null, lanes: [{ laneId: 'lane-7', enabled: true, version: 1 }] },
    ] });
    expect(rolloutSection(changes, 'B2').switches).toEqual([]);
    const lane7 = laneRollout(s, 'lane-7');
    expect(lane7).toEqual({ known: true, laneId: 'lane-7', switches: { esl: { on: true, source: 'branch', version: 3 }, self_checkout: { on: true, source: 'lane', version: 1 } } });
    expect(laneSwitchOn(lane7, 'self_checkout')).toBe(true);
    expect(laneSwitchOn(laneRollout(s, 'lane-2'), 'esl')).toBe(false);
    expect(laneSwitchOn(laneRollout(s, 'lane-2'), 'self_checkout')).toBe(false);
    // Not told: no section, no lane, a malformed section — every trial feature off, and said.
    expect(laneRollout(undefined, 'lane-7')).toMatchObject({ known: false });
    expect(laneRollout(s, undefined)).toMatchObject({ known: false, why: expect.stringContaining('which lane') });
    expect(laneRollout({ format: 'other', switches: [] }, 'lane-7').known).toBe(false);
    expect(laneSwitchOn(laneRollout(undefined, 'lane-7'), 'esl')).toBe(false);
    // A malformed entry is left out, never guessed.
    expect(laneRollout({ format: 'sre-rollout/1', switches: [{ key: 'Bad Key', branch: { enabled: true, version: 1 } }, { key: 'x', branch: { enabled: 'yes', version: 1 } }] }, 'l')).toEqual({ known: true, laneId: 'l', switches: {} });
  });

  it('the till reads what the box sent: on only when told; unreadable is "not told"', () => {
    const told = posRolloutOf(laneRollout(rolloutSection(changes, 'B1'), 'lane-7'));
    expect([told.known, told.why, told.on, told.isOn('self_checkout'), told.isOn('rfid')]).toEqual([true, null, ['esl', 'self_checkout'], true, false]);
    const not = posRolloutOf({ known: false, why: 'the store pack carries no rollout switches — every trial feature is off on this lane' });
    expect([not.known, not.isOn('esl'), not.why]).toEqual([false, false, 'the store pack carries no rollout switches — every trial feature is off on this lane']);
    expect(posRolloutOf(undefined)).toMatchObject({ known: false, on: [] });
    expect(posRolloutOf({ known: true, laneId: 'l', switches: { esl: { on: 'true', source: 'lane', version: 1 } } }).isOn('esl')).toBe(false);
  });
});

describe('an upgrade never takes away what was released (M36-FR-03 · M36-FR-04)', () => {
  const released: ReleasedContract = {
    format: RELEASED_CONTRACT_FORMAT, apiVersion: 'v1',
    operations: ['GET /v1/products', 'GET /v1/products/{}', 'POST /v1/sales'], partnerEvents: ['SaleCommitted'],
    deprecations: [{ surface: 'GET /v1/products/{}', deprecatedOn: '2026-01-01', replacement: 'GET /v1/catalogue/products/{}' }],
  };
  it('names a path the way the contract does (parameters unnamed — renaming one breaks nobody)', () => {
    expect(operationOf({ method: 'GET', path: '/v1/products/:productId' })).toBe('GET /v1/products/{}');
    expect(currentSurfaceOf([{ method: 'GET', path: '/v1/a/:x' }, { method: 'GET', path: '/v1/a/:y' }], ['B', 'A'])).toEqual({ operations: ['GET /v1/a/{}'], partnerEvents: ['A', 'B'] });
  });
  it('adding is safe; removing without an elapsed deprecation is breaking; an elapsed window lets it go', () => {
    const all = { operations: ['GET /v1/products', 'GET /v1/products/{}', 'GET /v1/new', 'POST /v1/sales'], partnerEvents: ['InventoryMoved', 'SaleCommitted'] };
    expect(assessUpgrade({ released, current: all, today: '2026-10-24' })).toMatchObject({ safeToDeploy: true, removed: [], added: { operations: 1, partnerEvents: 1 } });
    const noSales = { operations: ['GET /v1/products', 'GET /v1/products/{}'], partnerEvents: [] };
    const v = assessUpgrade({ released, current: noSales, today: '2026-10-24' });
    expect(v.safeToDeploy).toBe(false);
    expect(v.removed.map((r) => [r.contract, r.verdict])).toEqual([['POST /v1/sales', 'breaking'], ['webhook SaleCommitted', 'breaking']]);
    // The deprecated product read: pending at 100 days, gone safely after 180.
    const noProduct = { operations: ['GET /v1/products', 'POST /v1/sales'], partnerEvents: ['SaleCommitted'] };
    expect(assessUpgrade({ released, current: noProduct, today: '2026-04-11' }).removed[0]).toMatchObject({ verdict: 'deprecation_pending', safeToDeploy: false });
    expect(assessUpgrade({ released, current: noProduct, today: '2026-10-24' })).toMatchObject({ safeToDeploy: true });
  });
  it('a release keeps everything released, and lets a deprecated item go only once its window ran', () => {
    const next = releaseContract({ released, current: { operations: ['GET /v1/products', 'GET /v1/new', 'POST /v1/sales'], partnerEvents: ['SaleCommitted'] }, apiVersion: 'v1', today: '2026-10-24' });
    expect(next.operations).toEqual(['GET /v1/new', 'GET /v1/products', 'POST /v1/sales']);
    expect(next.deprecations).toEqual([]);
    const early = releaseContract({ released, current: { operations: ['GET /v1/products'], partnerEvents: [] }, apiVersion: 'v1', today: '2026-03-01' });
    expect(early.operations).toEqual(['GET /v1/products', 'GET /v1/products/{}', 'POST /v1/sales']);
    expect(early.partnerEvents).toEqual(['SaleCommitted']);
  });
});

describe('the consent record in the consent-manager layout (C8 · OB-324)', () => {
  const T = 'shop-1';
  const ledger: LedgerConsent[] = [
    { eventId: 'e1', customerId: 'C-1', purpose: 'marketing', channel: 'sms', given: true, recordedAt: at(1), evidence: 'signed form at the desk' },
    { eventId: 'e2', customerId: 'C-1', purpose: 'marketing', channel: 'sms', given: false, recordedAt: at(3), evidence: 'asked at the till to stop' },
    { eventId: 'e3', customerId: 'C-2', purpose: 'profiling', channel: 'email', given: false, recordedAt: at(2), evidence: 'said no at sign-up' },
  ];
  it('exports given / withdrawn / denied in order, with what the ledger does not record said plainly', () => {
    const doc = buildConsentExport({ tenantId: T, fiduciaryName: 'SRE Hyper Market Pvt Ltd', ledger, generatedAt: at(4), generatedBy: 'u-owner' });
    expect(doc.format).toBe(CONSENT_RECORD_FORMAT);
    expect(doc.keepForAtLeastYears).toBe(7);
    expect(doc.records.map((r) => [r.dataPrincipalRef, r.action, r.artefactId, r.capturedVia, r.noticeReference])).toEqual([
      ['C-1', 'given', 'sre:e1', 'this shop', null], ['C-1', 'withdrawn', 'sre:e2', 'this shop', null], ['C-2', 'denied', 'sre:e3', 'this shop', null],
    ]);
    expect(doc.counts).toEqual({ records: 3, dataPrincipals: 2, given: 1, denied: 1, withdrawn: 1 });
    expect(doc.notRecorded).toHaveLength(2);
    expect(buildConsentExport({ tenantId: T, fiduciaryName: 'x', ledger, dataPrincipalRef: 'C-2', generatedAt: at(4), generatedBy: 'u' }).records).toHaveLength(1);
    // A fact that came from a consent manager is exported as that manager's artefact.
    const imported = buildConsentExport({ tenantId: T, fiduciaryName: 'x', ledger: [{ eventId: 'e9', customerId: 'C-3', purpose: 'marketing', channel: 'email', given: true, recordedAt: at(1), evidence: importEvidence('CM-REG-1', 'ART-9', 'N-2') }], generatedAt: at(4), generatedBy: 'u' });
    expect(imported.records[0]).toMatchObject({ artefactId: 'ART-9', capturedVia: 'consent manager CM-REG-1', noticeReference: 'N-2' });
  });
  it('reads an import whole or not at all — the manager named, addressed to this shop, every record readable', () => {
    const good = { format: CONSENT_RECORD_FORMAT, consentManager: { id: 'CM-REG-1', name: 'Consent Co' }, dataFiduciary: { tenantId: T, name: 'x' }, records: [{ artefactId: 'A1', dataPrincipalRef: 'C-1', purpose: 'marketing', channel: 'sms', action: 'given', at: at(4) }] };
    expect(readConsentImport(good, { tenantId: T, now: at(5) })).toMatchObject({ ok: true, consentManager: { id: 'CM-REG-1' } });
    expect(readConsentImport({ ...good, format: 'csv' }, { tenantId: T, now: at(5) })).toMatchObject({ ok: false, reason: 'not_a_consent_record_document' });
    expect(readConsentImport({ ...good, consentManager: undefined }, { tenantId: T, now: at(5) })).toMatchObject({ ok: false, reason: 'no_consent_manager_named' });
    expect(readConsentImport({ ...good, dataFiduciary: { tenantId: 'other', name: 'x' } }, { tenantId: T, now: at(5) })).toMatchObject({ ok: false, reason: 'wrong_shop' });
    expect(readConsentImport({ ...good, records: [...good.records, { ...good.records[0], purpose: 'selling_lists' }] }, { tenantId: T, now: at(5) })).toMatchObject({ ok: false, reason: 'bad_record' });
    expect(readConsentImport({ ...good, records: [{ ...good.records[0], at: '2099-01-01T00:00:00Z' }] }, { tenantId: T, now: at(5) })).toMatchObject({ ok: false, reason: 'bad_record' });
  });
  it('withdrawals apply at once; a grant applies only when newer; a grant older than a withdrawal is an exception, never applied', () => {
    const rec = (action: 'given' | 'denied' | 'withdrawn', when: string, artefactId = 'A1') => ({ artefactId, dataPrincipalRef: 'C-1', purpose: 'marketing' as const, channel: 'sms' as const, action, at: when, noticeReference: null });
    expect(judgeImport(rec('withdrawn', at(0)), 'CM', ledger)).toEqual({ kind: 'apply', given: false });
    expect(judgeImport(rec('given', at(5)), 'CM', ledger)).toEqual({ kind: 'apply', given: true });
    expect(judgeImport(rec('given', at(2)), 'CM', ledger)).toMatchObject({ kind: 'exception', detail: expect.stringContaining('later withdrawal') });
    expect(judgeImport(rec('given', at(0)), 'CM', ledger.slice(0, 1))).toEqual({ kind: 'already_reflected' });
    const withImport = [...ledger, { eventId: 'e4', customerId: 'C-1', purpose: 'marketing', channel: 'sms', given: true, recordedAt: at(5), evidence: importEvidence('CM', 'A1', null) }];
    expect(judgeImport(rec('given', at(5)), 'CM', withImport)).toEqual({ kind: 'already_imported' });
  });
});

describe('the usage meter and the volume watch (M36-FR-01 · OB-321 · C9 · OB-324)', () => {
  it('a month\'s hourly records become the plans engine\'s peaks; the price is "not set"', () => {
    const s = (hour: string, stores: number, lanes: number, users: number): UsageSnapshot => ({ tenantId: 'T', hour, stores, lanes, users, aiSpendMinor: 0, at: `${hour}:00:00.000Z` });
    const recs = usageRecordsOf('T', [s('2026-10-01T09', 1, 4, 12), s('2026-10-02T09', 1, 5, 11), s('2026-09-30T09', 2, 9, 99)], '2026-10');
    expect(recs).toHaveLength(6);
    expect(recs.filter((r) => r.dimension === 'lanes').map((r) => r.units)).toEqual([4, 5]);
    expect(PRICE_NOT_SET).toMatchObject({ set: false, words: 'not set' });
  });
  it('the watch says "not set" and never fires until the CA sets a threshold; then fires once when reached', async () => {
    const thresholds: VolumeThreshold[] = [];
    const raised: string[] = [];
    const deps: DataVolumeDeps = {
      thresholds: async () => thresholds, recordThreshold: async () => {},
      sources: async () => [{ source: 'loyalty members', refs: ['m1', 'm2', 'm3'] }, { source: 'online', refs: ['m3', 'o1'] }],
      raiseOwnerAlert: async (_t, a) => { if (raised.includes(a.alertId)) return false; raised.push(a.alertId); return true; },
      clearOwnerAlert: async () => 0, now: () => at(4),
    };
    const unset = await readVolumeWatch(deps, 'T');
    expect([unset.threshold, unset.crossed, unset.volume.principals]).toEqual([{ set: false, words: 'not set' }, null, 4]);
    expect((await runVolumeWatch(deps, 'T', at(4))).raised).toBe(false);
    expect(raised).toEqual([]);
    thresholds.push({ principals: 5, basis: 'CA advice letter 1', version: 1, setBy: 'u-ca', setAt: at(4) });
    expect((await runVolumeWatch(deps, 'T', at(4))).watch.crossed).toBe(false);
    thresholds.push({ principals: 4, basis: 'CA advice letter 2', version: 2, setBy: 'u-ca', setAt: at(4) });
    expect((await runVolumeWatch(deps, 'T', at(4))).raised).toBe(true);
    expect((await runVolumeWatch(deps, 'T', at(4))).raised).toBe(false);
    expect(raised).toEqual(['dpdp-volume:v2']);
  });
});

describe('the Trial switches and shop account page session (OB-288 P4)', () => {
  it('shapes the page by what the viewer holds, refuses an unfilled change before any call, and sends exactly the change', async () => {
    const calls: { url: string; method: string; body?: string; key?: string }[] = [];
    const fetch = (async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      calls.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }), ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) });
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;
    const it_ = createRolloutSession({ viewer: { userId: 'u-it', permissions: ['platform.flag.read', 'platform.flag.write', 'platform.metering.read'] }, fetch, newKey: () => 'k1' });
    expect(it_.may).toEqual({ named: true, open: true, change: true, meter: true, watch: false, consent: false, closure: false });
    expect(createRolloutSession({ viewer: undefined }).may.named).toBe(false);
    expect(await it_.save({ key: 'self_checkout', branchId: 'br-1', laneId: 'lane-7', enabled: true, reason: ' ', approvalId: '' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await it_.preview({ key: 'Bad Key', branchId: 'br-1', laneId: '', enabled: true, reason: '', approvalId: '' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await it_.importConsent('not json')).toEqual({ result: 'invalid', why: 'notJson' });
    expect(calls).toEqual([]);
    await it_.save({ key: 'self_checkout', branchId: 'br-1', laneId: 'lane-7', enabled: true, reason: 'trial', approvalId: '' });
    await it_.rollback('self_checkout', { branchId: 'br-1' }, 1, 'back', '');
    expect(calls.map((c) => [c.method, c.url, c.body, c.key])).toEqual([
      ['PUT', '/v1/platform/rollout/self_checkout', JSON.stringify({ branchId: 'br-1', laneId: 'lane-7', enabled: true, reason: 'trial' }), 'k1'],
      ['POST', '/v1/platform/rollout/self_checkout/rollback', JSON.stringify({ branchId: 'br-1', toVersion: 1, reason: 'back' }), 'k1'],
    ]);
    expect([rolloutWords('ta', 'notSet'), rolloutWords('en', 'notSet'), rupees(2_000)]).toEqual(['அமைக்கப்படவில்லை', 'not set', '₹20.00']);
  });

  it('OB-367: the closure section is a read for whoever may take the export — and every word has its Tamil twin', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string, init: { method: string }) => { urls.push(`${init.method} ${url}`); return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof globalThis.fetch;
    const owner = createRolloutSession({ viewer: { userId: 'u-owner', permissions: ['platform.flag.read', 'platform.tenant.export'] }, fetch });
    expect(owner.may.closure).toBe(true);
    expect(createRolloutSession({ viewer: { userId: 'u-cash', permissions: ['platform.flag.read'] } }).may.closure).toBe(false);
    await owner.closure();
    expect(urls).toEqual(['GET /v1/platform/tenant/closure']);
    for (const k of ['closureH', 'closureState', 'active', 'closed', 'exportTaken', 'noExport', 'complete', 'notComplete', 'lawKeeps', 'sealedH', 'schedule', 'closureBlockers', 'whoCloses', 'indefinitely', 'until']) {
      expect(rolloutWords('en', k).length, k).toBeGreaterThan(0);
      expect(rolloutWords('ta', k), k).toMatch(/[\u0B80-\u0BFF]/);
    }
  });
});
