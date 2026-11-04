import { describe, it, expect } from 'vitest';
import { createComplianceRegistersSession, COMPLIANCE_REGISTERS_COPY, steadyWriter } from '../../apps/web-erp/src/compliance-registers-session';
import { createEprRecordsSession, EPR_RECORDS_COPY, milligramsOf, gramsOfMg } from '../../apps/web-erp/src/epr-records-session';
import { createLegalHoldsSession, LEGAL_HOLDS_COPY, shopDaysSpan } from '../../apps/web-erp/src/legal-holds-session';

/**
 * W5 (compliance, risk, EPR and audit registers): the DOM-free sessions behind
 *   • OB-212 — the EPR records a person keeps (answers confirmed, own-brand packaging, recyclers, the shop's own e-waste,
 *     bin counts, a disposed asset that was not e-waste);
 *   • M34-FR-03 — licences and certificates with their named person, evidence and gaps; M34-FR-04 — controls, incidents,
 *     remediations and dated checks; OB-331 — the security findings people raise;
 *   • M34-FR-01 / M34-FR-02 — legal holds, the keeping plan over the recorded trail, and the evidence pack.
 * Each refuses the cheap things before anything is sent, asks only with the permission its page holds, sends exactly what
 * head office's route reads, and — when the answer is lost — sends the SAME record again, never a second one.
 */

type Sent = { method: string; path: string; key: string | undefined; body: unknown };
function fakeHeadOffice(answer: (method: string, path: string, body: unknown) => { status?: number; body: unknown } | 'lost' = () => ({ body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ method: init.method, path, key: init.headers?.['idempotency-key'], body });
    const a = answer(init.method, path, body);
    if (a === 'lost') throw new Error('the link dropped');
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });
const writes = (sent: readonly Sent[]) => sent.filter((s) => s.method !== 'GET');

describe('every word has a Tamil twin', () => {
  it('in the three word tables', () => {
    for (const c of [COMPLIANCE_REGISTERS_COPY, EPR_RECORDS_COPY, LEGAL_HOLDS_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('a write whose answer was lost is the same record when sent again (hard rule #2)', () => {
  it('reuses the id and the key while the answer is lost; a new record once head office answered', async () => {
    let drop = true;
    const ho = fakeHeadOffice(() => (drop ? 'lost' : { body: {} }));
    const write = steadyWriter({ keyPrefix: 't', fetch: ho.fetch });
    const path = (id: string) => `/v1/x/${id}`;
    expect((await write('slot', 'r', path, { a: 1 })).result).toBe('lost_link');
    drop = false;
    expect((await write('slot', 'r', path, { a: 1 })).result).toBe('ok');
    expect(ho.sent[0]!.path).toBe(ho.sent[1]!.path);
    expect(ho.sent[0]!.key).toBe(ho.sent[1]!.key);
    await write('slot', 'r', path, { a: 1 });
    expect(ho.sent[2]!.path).not.toBe(ho.sent[1]!.path);
    expect(ho.sent[2]!.key).not.toBe(ho.sent[1]!.key);
  });
  it('a changed body after a lost answer is a new record', async () => {
    const ho = fakeHeadOffice(() => 'lost');
    const write = steadyWriter({ keyPrefix: 't', fetch: ho.fetch });
    await write('slot', 'r', (id) => `/v1/x/${id}`, { a: 1 });
    await write('slot', 'r', (id) => `/v1/x/${id}`, { a: 2 });
    expect(ho.sent[0]!.path).not.toBe(ho.sent[1]!.path);
  });
});

describe('OB-212 — the EPR records a person keeps', () => {
  it('grams are read by their digits into whole milligrams; nothing invented', () => {
    expect(milligramsOf('12.5')).toBe(12_500);
    expect(milligramsOf('0.1')).toBe(100);
    expect(milligramsOf('2')).toBe(2_000);
    for (const bad of ['', '0', '-1', '1.2345', 'abc', '0.000']) expect(milligramsOf(bad)).toBeUndefined();
    expect(gramsOfMg(12_500)).toBe('12.5');
    expect(gramsOfMg(2_000)).toBe('2');
  });

  it('confirms an answer only with epr.settings.configure, on the route\'s own key', async () => {
    const ho = fakeHeadOffice(() => ({ body: { changed: 'plasticRegistration' } }));
    const manager = createEprRecordsSession({ viewer: v('epr.register.read', 'epr.register.record'), fetch: ho.fetch });
    expect(await manager.confirmSetting('plasticRegistration', 'PWP-1', 'CA R. Kumar, letter 12')).toEqual({ result: 'invalid', why: 'cannotConfirm' });
    const ca = createEprRecordsSession({ viewer: v('epr.register.read', 'epr.settings.configure'), fetch: ho.fetch });
    expect(await ca.confirmSetting('plasticRegistration', '  ', 'x')).toEqual({ result: 'invalid', why: 'needSetting' });
    expect(await ca.confirmSetting('nonsense', 'x', 'y')).toEqual({ result: 'invalid', why: 'needSetting' });
    expect(ho.sent).toEqual([]);
    expect((await ca.confirmSetting('plasticRegistration', ' PWP-1 ', ' CA R. Kumar, letter 12 ')).result).toBe('ok');
    expect(writes(ho.sent).map((s) => [s.path, s.body])).toEqual([['/v1/compliance/epr/settings/plastic-registration', { value: 'PWP-1', confirmation: 'CA R. Kumar, letter 12' }]]);
  });

  it('declares own-brand packaging per category to the milligram; an empty row is no row; a half row is refused', async () => {
    const ho = fakeHeadOffice(() => ({ body: { packagingDeclared: true } }));
    const s = createEprRecordsSession({ viewer: v('epr.register.read', 'epr.register.record'), fetch: ho.fetch });
    expect(await s.declare({ productId: 'P-1', ownBrand: true, lines: [{ category: 'I', grams: '1.2345' }] })).toEqual({ result: 'invalid', why: 'needDeclaration' });
    expect(await s.declare({ productId: 'P-1', ownBrand: true, lines: [{ category: '', grams: '1.2' }] })).toEqual({ result: 'invalid', why: 'needDeclaration' });
    expect(ho.sent).toEqual([]);
    await s.declare({ productId: 'P-1', ownBrand: true, lines: [{ category: 'I', grams: '12.5', description: 'jar' }, { category: '', grams: '', description: '' }, { category: 'II', grams: '1.2' }] });
    expect(writes(ho.sent)[0]).toMatchObject({ path: '/v1/compliance/epr/own-brand/P-1', body: { ownBrand: true, packaging: [{ category: 'I', weightPerUnitMg: 12_500, description: 'jar' }, { category: 'II', weightPerUnitMg: 1_200 }] } });
    // A mark with no packaging is sent as it is — head office lists it as an exception, never counted as zero.
    await s.declare({ productId: 'P-2', ownBrand: true, lines: [] });
    expect(writes(ho.sent)[1]).toMatchObject({ path: '/v1/compliance/epr/own-brand/P-2', body: { ownBrand: true, packaging: [] } });
  });

  it('a recycler re-recorded under its own id gets its number; the shop\'s handover names the asset; a count says whether it differs', async () => {
    const ho = fakeHeadOffice((_m, path) => ({
      body: path.includes('/counts/') ? { count: { countId: 'c-1' }, exceptions: { stock: [{ countId: 'c-1', stockKey: 'e_waste' }] } }
        : path.includes('/handovers/') ? { handover: { registrationNumber: 'TN-1' } } : { registered: true },
    }));
    const s = createEprRecordsSession({ viewer: v('epr.register.read', 'epr.register.record'), fetch: ho.fetch });
    await s.saveRecycler({ recyclerId: 'r-none', name: 'Street collector', registrationNumber: 'TN-1' });
    expect(writes(ho.sent)[0]).toMatchObject({ path: '/v1/compliance/epr/recyclers/r-none', body: { name: 'Street collector', registrationNumber: 'TN-1' } });
    expect(await s.shopHandover({ kind: 'e_waste', recyclerId: 'r-none', description: 'Till 3', weightGrams: '9.5', note: 'HN-1' })).toEqual({ result: 'invalid', why: 'needShop' });
    expect(await s.shopHandover({ kind: 'battery', recyclerId: 'r-none', description: 'UPS', weightGrams: '9500', note: 'HN-1' })).toEqual({ result: 'invalid', why: 'needShop' });
    const out = await s.shopHandover({ kind: 'e_waste', recyclerId: 'r-none', description: 'Till 3', weightGrams: '9500', assetId: 'FA-TILL', note: 'HN-1' });
    expect(out).toEqual({ result: 'ok', value: { registrationNumber: 'TN-1' } });
    expect(writes(ho.sent)[1]!.path).toMatch(/^\/v1\/compliance\/epr\/handovers\/sh-/);
    expect(writes(ho.sent)[1]!.body).toEqual({ kind: 'e_waste', recyclerId: 'r-none', lines: [{ description: 'Till 3', weightGrams: 9500, assetId: 'FA-TILL' }], note: 'HN-1' });
    expect(await s.countBin({ kind: 'e_waste', countedGrams: '0' })).toEqual({ result: 'ok', value: { differs: true } });
    expect(writes(ho.sent)[2]!.body).toEqual({ kind: 'e_waste', countedGrams: 0 });
    expect(await s.notEWaste('FA-RACK', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
  });

  it('a reader who may not record is refused before anything is sent', async () => {
    const ho = fakeHeadOffice();
    const s = createEprRecordsSession({ viewer: v('epr.register.read'), fetch: ho.fetch });
    expect(await s.saveRecycler({ name: 'x' })).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(await createEprRecordsSession({ viewer: undefined, fetch: ho.fetch }).ownBrand()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent).toEqual([]);
  });
});

describe('M34-FR-03 — licences and certificates', () => {
  const READ = ['compliance.obligation.read', 'compliance.obligation.manage'];
  it('reads the register, the alerts and the gaps, and shows each with its named person', async () => {
    const ho = fakeHeadOffice((_m, path) => ({
      body: path === '/v1/compliance/obligations' ? { obligations: [{ obligationId: 'lic-1', kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', validFrom: '2026-01-01', expiresOn: '2026-11-20', responsible: { userId: 'u-mgr', name: 'Meena' }, status: 'active' }] }
        : path === '/v1/compliance/alerts' ? { asOf: '2026-11-03', alerts: [{ obligationId: 'lic-1', name: 'FSSAI licence', expiresOn: '2026-11-20', daysRemaining: 17, level: 'warning', responsible: { userId: 'u-mgr', name: 'Meena' }, evidenceMissing: true }] }
          : { obligations: [{ obligationId: 'lic-1' }] },
    }));
    const out = await createComplianceRegistersSession({ viewer: v(...READ), fetch: ho.fetch }).licences();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.obligations[0]).toMatchObject({ obligationId: 'lic-1', responsible: { userId: 'u-mgr', name: 'Meena' }, evidence: [], status: 'active' });
    expect(out.value.alerts[0]).toMatchObject({ level: 'warning', daysRemaining: 17, evidenceMissing: true });
    expect(out.value.gaps).toEqual(['lic-1']);
  });

  it('registers with a named person, re-states under its own id, files evidence and closes with a reason', async () => {
    const ho = fakeHeadOffice(() => ({ body: { obligationId: 'lic-1' } }));
    const s = createComplianceRegistersSession({ viewer: v(...READ), fetch: ho.fetch });
    const base = { kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', validFrom: '2026-01-01', personId: 'u-mgr', personName: 'Meena' };
    expect(await s.register({ ...base, personName: ' ' })).toEqual({ result: 'invalid', why: 'needRegister' });
    expect(await s.register({ ...base, expiresOn: '2026-02-30' })).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await s.fileEvidence('lic-1', 'DOC-1', ' ')).toEqual({ result: 'invalid', why: 'needEvidence' });
    expect(await s.close('lic-1', '')).toEqual({ result: 'invalid', why: 'needClose' });
    expect(ho.sent).toEqual([]);
    await s.register({ ...base, reference: '1234', expiresOn: '2026-12-31', obligationId: 'lic-1' });
    expect(writes(ho.sent)[0]).toEqual(expect.objectContaining({ path: '/v1/compliance/obligations/lic-1', body: { kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', reference: '1234', validFrom: '2026-01-01', expiresOn: '2026-12-31', responsible: { userId: 'u-mgr', name: 'Meena' } } }));
    await s.register(base);
    expect(writes(ho.sent)[1]!.path).toMatch(/^\/v1\/compliance\/obligations\/lic-/);
    await s.fileEvidence('lic-1', 'DOC-1', 'renewed licence copy');
    expect(writes(ho.sent)[2]).toEqual(expect.objectContaining({ path: '/v1/compliance/obligations/lic-1/evidence', body: { evidenceId: 'DOC-1', description: 'renewed licence copy' } }));
    await s.close('lic-1', 'store shut');
    expect(writes(ho.sent)[3]).toEqual(expect.objectContaining({ path: '/v1/compliance/obligations/lic-1/close', body: { reason: 'store shut' } }));
  });

  it('a reader may read but is refused recording before anything is sent', async () => {
    const ho = fakeHeadOffice();
    const s = createComplianceRegistersSession({ viewer: v('compliance.obligation.read'), fetch: ho.fetch });
    expect(s.may.write_licences).toBe(false);
    expect(await s.close('lic-1', 'x')).toEqual({ result: 'invalid', why: 'cannotWrite' });
    expect(ho.sent).toEqual([]);
  });
});

describe('M34-FR-04 — controls, incidents, remediations and dated checks', () => {
  const P = ['compliance.risk.read', 'compliance.risk.manage'];
  it('reads the registers and the health, and never sends a staleness number of its own (the owner\'s number)', async () => {
    const ho = fakeHeadOffice((_m, path) => ({
      body: path === '/v1/compliance/control-register' ? { controls: [{ controlId: 'c-1', title: 'Backups encrypted', implements: 'P-04', ownerUserId: 'u-it' }], incidents: [], remediations: [], attestations: [] }
        : path.startsWith('/v1/compliance/controls/health') ? { health: [{ controlId: 'c-1', incidentCount: 0, overdueRemediations: 0, needsAttestation: true }], asOf: '2026-11-03' } : { overdue: [] },
    }));
    const out = await createComplianceRegistersSession({ viewer: v(...P), fetch: ho.fetch }).controls();
    expect(ho.sent.map((s) => s.path).sort()).toEqual(['/v1/compliance/control-register', '/v1/compliance/controls/health', '/v1/compliance/remediations/overdue']);
    expect(out.result === 'ok' && out.value.health[0]).toEqual({ controlId: 'c-1', incidentCount: 0, overdueRemediations: 0 });
  });

  it('an incident reads its times on the SHOP\'s clock; a remediation needs an owner and a date; done is the same remediation with its time', async () => {
    const ho = fakeHeadOffice(() => ({ body: {} }));
    const s = createComplianceRegistersSession({ viewer: v(...P), fetch: ho.fetch, timeZone: 'Asia/Kolkata', now: () => '2026-11-03T10:00:00.000Z' });
    expect(await s.recordIncident({ title: 'x', severity: 'sev9', occurredAt: '2026-11-02T22:30', detectedAt: '2026-11-02T23:00', controlId: 'c-1' })).toEqual({ result: 'invalid', why: 'needIncident' });
    expect(await s.planRemediation({ incidentId: 'i-1', action: 'rotate key', ownerUserId: ' ', dueOn: '2026-11-10' })).toEqual({ result: 'invalid', why: 'needRemediation' });
    expect(ho.sent).toEqual([]);
    await s.recordIncident({ title: 'Backup left unencrypted', severity: 'sev2', occurredAt: '2026-11-02T22:30', detectedAt: '2026-11-02T23:00', controlId: 'c-1' });
    // 22:30 in the shop on 2 Nov is 17:00 UTC — never the device's own clock.
    expect(writes(ho.sent)[0]!.body).toEqual({ title: 'Backup left unencrypted', severity: 'sev2', occurredAt: '2026-11-02T17:00:00.000Z', detectedAt: '2026-11-02T17:30:00.000Z', controlId: 'c-1' });
    await s.markDone({ remediationId: 'rem-1', incidentId: 'i-1', action: 'rotate key', ownerUserId: 'u-it', dueOn: '2026-11-10' });
    expect(writes(ho.sent)[1]).toEqual(expect.objectContaining({ path: '/v1/compliance/remediations/rem-1', body: { incidentId: 'i-1', action: 'rotate key', ownerUserId: 'u-it', dueOn: '2026-11-10', completedAt: '2026-11-03T10:00:00.000Z' } }));
    // A check names only the control and what was checked: head office takes the checker from the sign-in and stamps the time.
    await s.attest('c-1', 'restored last night\'s backup to a spare disk');
    expect(writes(ho.sent)[2]!.body).toEqual({ controlId: 'c-1', statement: 'restored last night\'s backup to a spare disk' });
  });
});

describe('OB-331 — the security findings people raise', () => {
  const P = ['compliance.finding.read', 'compliance.finding.record'];
  it('records a pentest finding, names its owner, and records it fixed with evidence; a scanner finding is not a person\'s', async () => {
    const ho = fakeHeadOffice((m) => ({ body: m === 'GET' ? { findings: [{ findingId: 'sast-1', source: 'sast', title: 'x', severity: 'high', location: 'a.ts', status: 'open', overdue: false }, { findingId: 'pentest-1', source: 'pentest', title: 'y', severity: 'critical', location: '/login', status: 'open', overdue: true }] } : { finding: { findingId: 'pentest-1' } } }));
    const s = createComplianceRegistersSession({ viewer: v(...P), fetch: ho.fetch });
    const read = await s.findings();
    expect(read.result === 'ok' && read.value.findings.map((f) => [f.findingId, f.byPerson, f.overdue])).toEqual([['sast-1', false, false], ['pentest-1', true, true]]);
    expect(await s.raiseFinding({ source: 'sast', title: 'x', severity: 'high', location: 'y' })).toEqual({ result: 'invalid', why: 'needFinding' });
    await s.raiseFinding({ source: 'pentest', title: 'Login has no lockout', severity: 'high', location: '/login', ownerUserId: 'u-it' });
    expect(writes(ho.sent)[0]!.path).toMatch(/^\/v1\/compliance\/findings\/pentest-[A-Za-z0-9]+$/);
    expect(writes(ho.sent)[0]!.body).toEqual({ source: 'pentest', title: 'Login has no lockout', severity: 'high', location: '/login', ownerUserId: 'u-it' });
    expect(await s.nameOwner('pentest-1', ' ')).toEqual({ result: 'invalid', why: 'needOwner' });
    expect(await s.markFixed('pentest-1', '')).toEqual({ result: 'invalid', why: 'needFix' });
    await s.markFixed('pentest-1', 'lockout after 5 tries; tried 6');
    expect(writes(ho.sent)[1]).toEqual(expect.objectContaining({ path: '/v1/compliance/findings/pentest-1/fixed', body: { evidence: 'lockout after 5 tries; tried 6' } }));
  });
});

describe('M34-FR-01 / M34-FR-02 — legal holds, the keeping plan and the evidence pack', () => {
  it('a span of shop days runs from the shop\'s midnight to the shop\'s next midnight — never the UTC date', () => {
    expect(shopDaysSpan('2026-11-01', '2026-11-02', 'Asia/Kolkata')).toEqual({ from: '2026-10-31T18:30:00.000Z', until: '2026-11-02T18:30:00.000Z' });
    expect(shopDaysSpan('2026-11-03', '2026-11-02', 'Asia/Kolkata')).toBeUndefined();
    expect(shopDaysSpan('2026-02-30', '2026-03-01', 'Asia/Kolkata')).toBeUndefined();
  });

  it('places a hold with its id in the body and a reason, narrowed to shop days; lifts it with a reason; only with audit.hold.manage', async () => {
    const ho = fakeHeadOffice(() => ({ body: { holdId: 'h-1' } }));
    const reader = createLegalHoldsSession({ viewer: v('audit.retention.read'), fetch: ho.fetch, timeZone: 'Asia/Kolkata' });
    expect(await reader.place({ reason: 'dispute' })).toEqual({ result: 'invalid', why: 'cannotHold' });
    const s = createLegalHoldsSession({ viewer: v('audit.retention.read', 'audit.hold.manage'), fetch: ho.fetch, timeZone: 'Asia/Kolkata' });
    expect(await s.place({ reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.place({ reason: 'x', fromDay: '2026-11-05', untilDay: '2026-11-01' })).toEqual({ result: 'invalid', why: 'needDays' });
    expect(ho.sent).toEqual([]);
    await s.place({ reason: 'Customer dispute over bill 991', objectType: 'sale', fromDay: '2026-11-01', untilDay: '2026-11-01' });
    const placed = writes(ho.sent)[0]!;
    expect(placed.path).toBe('/v1/audit/legal-holds');
    expect(placed.body).toEqual({ holdId: expect.stringMatching(/^hold-/), reason: 'Customer dispute over bill 991', objectType: 'sale', from: '2026-10-31T18:30:00.000Z', until: '2026-11-01T18:30:00.000Z' });
    await s.lift('h-1', 'settled');
    expect(writes(ho.sent)[1]).toEqual(expect.objectContaining({ path: '/v1/audit/legal-holds/h-1/lift', body: { reason: 'settled' } }));
  });

  it('the plan is asked as of the SHOP\'s today and sends no policy of its own; the pack is the shop days asked for', async () => {
    const ho = fakeHeadOffice((_m, path) => ({
      body: path.endsWith('plan-produced') ? { asOf: '2026-11-04', recordsAssessed: 3, heldCount: 1, statutoryCount: 2, noPolicyCount: 0, eligibleForReview: [] }
        : { records: [{ sequence: 1 }], sourceIntact: true, exportedBy: 'u-x', exportedAt: '2026-11-03T19:00:00.000Z', from: 'f', until: 'u', chainHash: 'h' },
    }));
    // 19:00 UTC on 3 Nov is 00:30 on 4 Nov in the shop.
    const s = createLegalHoldsSession({ viewer: v('audit.retention.read'), fetch: ho.fetch, timeZone: 'Asia/Kolkata', now: () => '2026-11-03T19:00:00.000Z' });
    const plan = await s.plan();
    expect(ho.sent[0]).toEqual(expect.objectContaining({ method: 'POST', path: '/v1/audit/retention/plan-produced', body: { asOf: '2026-11-04' } }));
    expect(plan.result === 'ok' && plan.value).toMatchObject({ assessed: 3, held: 1, statutory: 2, noPolicy: 0, eligible: [] });
    expect(await s.pack('2026-11-02', '')).toEqual({ result: 'invalid', why: 'needDays' });
    const pack = await s.pack('2026-11-01', '2026-11-03');
    expect(ho.sent[1]!.body).toEqual({ from: '2026-10-31T18:30:00.000Z', until: '2026-11-03T18:30:00.000Z' });
    expect(pack.result === 'ok' && pack.value).toMatchObject({ records: 1, sourceIntact: true, fileName: 'evidence-pack-2026-11-01-to-2026-11-03.json' });
  });
});
