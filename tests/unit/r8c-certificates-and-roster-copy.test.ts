import { describe, it, expect } from 'vitest';
import { foodHandlingVerdict, isFoodHandlingKind, CERTIFICATE_KINDS, FOOD_HANDLING_CERTIFICATE } from '../../packages/workforce/src/food-handling';
import { createCertificatesSession, standingOf, kindWords, certificatesOutcomeWords, CERTIFICATES_COPY } from '../../apps/web-erp/src/certificates-session';
import { createRosteringSession, rosterAgeWords, ROSTERING_COPY, type RosteringData } from '../../apps/web-erp/src/rostering-session';
import { rosteringViewFor, readRosteringWorklist, bootRostering } from '../../apps/web-erp/src/browser-entry';
import { rosterCopyOnBox, foodHandlingOnBox } from '../../edge/store-edge/src/workforce-pack';
import { rosteringPayload } from '../../edge/store-edge/src/screen-data';
import { known, emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { Certification, Employee } from '../../packages/workforce/src/workforce';

// Round 8 · R8-C — OB-522 (an office screen to record staff certificates; FoSTaC counts as food handling) and OB-531 (the
// manager's rostering screen shows the store computer's copy read-only when head office cannot be reached). Synthetic people.

const KUMAR: Employee = { employeeId: 'E-K', name: 'Kumar', branchId: 'S1', roles: ['cook'], active: true };
const cert = (over: Partial<Certification> = {}): Certification => ({ certificationId: 'C1', employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-01-01', validUntil: '2026-12-31', verifiedBy: 'u-mgr', ...over });
const TODAY = '2026-10-28';

describe('OB-522 · FoSTaC counts as the same food-handling certificate (OB-502)', () => {
  it('every spelling of food handling and of FoSTaC is a food-handling kind; another kind is not', () => {
    for (const k of ['food-handling', 'Food handling', 'FOOD_HANDLING', 'fostac', 'FoSTaC', ' Fostac ']) expect(isFoodHandlingKind(k), k).toBe(true);
    for (const k of ['forklift', 'first-aid', 'fos-tac-x', '']) expect(isFoodHandlingKind(k), k).toBe(false);
  });
  it('a verified FoSTaC certificate in date lets food-handling work through; an expired one blocks it; an unverified one counts as none on file (not blocked — only an expired certificate blocks)', () => {
    expect(foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert()], today: TODAY, task: 'production_run' })).toEqual({ allowed: true, validUntil: '2026-12-31' });
    const expired = foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ validUntil: '2026-10-01' })], today: TODAY, task: 'weighed_run' });
    expect(expired.allowed === false && expired.code).toBe('food_handling_certificate_expired');
    const unverified = foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ verifiedBy: undefined })], today: TODAY, task: 'production_run' });
    expect(unverified).toMatchObject({ allowed: true, noCertificateOnFile: true });
    // A different kind never counts — an expired forklift licence is not an expired food-handling certificate.
    const other = foodHandlingVerdict({ personId: 'E-K', employee: KUMAR, certifications: [cert({ kind: 'forklift', validUntil: '2026-01-01' })], today: TODAY, task: 'production_run' });
    expect(other).toMatchObject({ allowed: true, noCertificateOnFile: true });
  });
  it('the store computer judges a FoSTaC certificate from the signed pack the same way, offline', () => {
    const pack: StorePack = {
      ...emptyPack(),
      roster: known({ storeId: 'S1', asAt: '2026-10-28T03:00:00.000Z', employees: [{ employeeId: 'E-K', name: 'Kumar', roles: ['cook'], active: true }], shifts: [], assignments: [], published: [] }),
      certifications: known({ asAt: '2026-10-28T03:00:00.000Z', certifications: [cert()] }),
    } as StorePack;
    expect(foodHandlingOnBox(pack, 'E-K', 'production_run', TODAY).allowed).toBe(true);
    expect(foodHandlingOnBox(pack, 'E-K', 'production_run', '2027-01-01').allowed).toBe(false);
  });
  it('the pick-list is short, every kind on it is food handling, and each has English and Tamil words', () => {
    expect(CERTIFICATE_KINDS.map((k) => k.kind)).toEqual([FOOD_HANDLING_CERTIFICATE, 'fostac']);
    for (const k of CERTIFICATE_KINDS) { expect(k.foodHandling).toBe(true); expect(isFoodHandlingKind(k.kind)).toBe(true); expect(k.ta).toMatch(/[஀-௿]/); }
  });
});

describe('OB-522 · the Staff certificates session (apps/web-erp/src/certificates-session.ts)', () => {
  type Sent = { method: string; path: string; body: unknown };
  const fake = (answers: Record<string, { status: number; body: unknown }>, sent: Sent[] = []): typeof fetch => (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    sent.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const a = answers[`${method} ${path.split('?')[0]}`] ?? (method === 'POST' ? { status: 200, body: { certification: JSON.parse(String(init?.body ?? '{}')) } } : { status: 404, body: {} });
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const manager = { userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'] };
  const reader = { userId: 'u-clerk', permissions: ['workforce.roster.read'] };
  const NOW = () => '2026-10-28T06:00:00.000Z';

  it('says what each person may do today: a verified FoSTaC → allowed; EXPIRED → blocked, in both languages; unverified or none on file → allowed, said (only an expired certificate blocks)', async () => {
    const s = createCertificatesSession({ viewer: manager, now: NOW, fetch: fake({
      'GET /v1/hr/workforce/roster': { status: 200, body: { employees: [KUMAR, { employeeId: 'E-D', name: 'Devi', branchId: 'S1', roles: ['cook'], active: true }, { employeeId: 'E-R', name: 'Rani', branchId: 'S1', roles: ['cashier'], active: true }, { employeeId: 'E-A', name: 'Arun', branchId: 'S1', roles: ['cook'], active: true }] } },
      'GET /v1/hr/workforce/certifications': { status: 200, body: { certifications: [cert(), cert({ certificationId: 'C0', validUntil: '2025-12-31' }), cert({ certificationId: 'C2', employeeId: 'E-D', kind: 'food-handling', verifiedBy: undefined }), cert({ certificationId: 'C3', employeeId: 'E-A', validUntil: '2026-10-01' })] } },
    }) });
    const out = await s.load();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.today).toBe('2026-10-28');
    const [arun, devi, kumar, rani] = out.value.people;
    expect(kumar).toMatchObject({ name: 'Kumar', food: { allowed: true, validUntil: '2026-12-31' } });
    expect(kumar!.certificates.map((c) => [c.certificationId, c.standing, c.foodHandling])).toEqual([['C1', 'valid', true], ['C0', 'expired', true]]);
    expect(arun!.food.allowed).toBe(false);
    if (!arun!.food.allowed) { expect(arun!.food.words.en).toContain("Arun's food-handling certificate expired on 2026-10-01"); expect(arun!.food.words.ta).toMatch(/[஀-௿]/); }
    expect(devi!.food).toMatchObject({ allowed: true, noCertificateOnFile: true, validUntil: '—' });
    expect(devi!.certificates[0]!.standing).toBe('unverified');
    expect(rani!.food).toMatchObject({ allowed: true, noCertificateOnFile: true });
    if ('words' in rani!.food) { expect(rani!.food.words.en).toContain('There is no verified food-handling certificate on file for Rani'); expect(rani!.food.words.ta).toMatch(/[஀-௿]/); }
  });

  it('records a certificate from the pick-list only, verified in MY name when I saw it; never my own; dates must make sense', async () => {
    const sent: Sent[] = [];
    const s = createCertificatesSession({ viewer: manager, now: NOW, fetch: fake({}, sent), newCertificateId: () => 'CERT-NEW' });
    expect(await s.record({ employeeId: 'E-K', kind: 'forklift', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: true })).toEqual({ result: 'invalid', why: 'needRecord' });
    expect(await s.record({ employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2026-10-01', seen: true })).toEqual({ result: 'invalid', why: 'needRecord' });
    expect(await s.record({ employeeId: '', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: true })).toEqual({ result: 'invalid', why: 'needRecord' });
    expect(await s.record({ employeeId: 'u-mgr', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: true })).toEqual({ result: 'invalid', why: 'selfVerify' });
    expect(sent).toEqual([]);
    const ok = await s.record({ employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: true });
    expect(ok.result).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/hr/workforce/certifications/CERT-NEW', body: { employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2027-10-27', verifiedBy: 'u-mgr' } }]);
    expect(certificatesOutcomeWords('en', ok, 'record')).toBe('Recorded and verified at head office in your name.');
    // Not seen → recorded unverified (it does not count until someone who saw it verifies it).
    await s.record({ employeeId: 'E-K', kind: 'food-handling', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: false });
    expect(sent[1]!.body).toEqual({ employeeId: 'E-K', kind: 'food-handling', issuedOn: '2026-10-28', validUntil: '2027-10-27' });
  });

  it('verifies somebody else\'s unverified certificate by re-recording it in my name; my own is refused before any call', async () => {
    const sent: Sent[] = [];
    const s = createCertificatesSession({ viewer: manager, now: NOW, fetch: fake({}, sent) });
    expect(await s.verify(cert({ employeeId: 'u-mgr', verifiedBy: undefined }))).toEqual({ result: 'invalid', why: 'selfVerify' });
    expect(sent).toEqual([]);
    const out = await s.verify(cert({ verifiedBy: undefined }));
    expect(out.result).toBe('ok');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/hr/workforce/certifications/C1', body: { employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-01-01', validUntil: '2026-12-31', verifiedBy: 'u-mgr' } }]);
    expect(certificatesOutcomeWords('ta', out, 'verify')).toBe(CERTIFICATES_COPY.ta.verified);
  });

  it('least privilege and errors: a reader cannot record or verify; nobody named reads nothing; refusals and a lost link are said', async () => {
    const sent: Sent[] = [];
    const r = createCertificatesSession({ viewer: reader, fetch: fake({}, sent) });
    expect(r.may).toMatchObject({ read: true, manage: false });
    expect(await r.record({ employeeId: 'E-K', kind: 'fostac', issuedOn: '2026-10-28', validUntil: '2027-10-27', seen: true })).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await r.verify(cert())).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(sent).toEqual([]);
    expect(await createCertificatesSession({ viewer: undefined }).load()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createCertificatesSession({ viewer: { userId: 'u-x', permissions: [] } }).load()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const refused = await createCertificatesSession({ viewer: manager, fetch: fake({ 'POST /v1/hr/workforce/certifications/C1': { status: 422, body: { error: { code: 'self_verification', whatHappened: 'A certificate cannot be verified by the person it belongs to.' } } } }) }).verify(cert({ verifiedBy: undefined }));
    expect(certificatesOutcomeWords('en', refused)).toBe('Head office refused: A certificate cannot be verified by the person it belongs to.');
    const down = await createCertificatesSession({ viewer: manager, fetch: (async () => { throw new TypeError('network'); }) as typeof fetch }).load();
    expect(certificatesOutcomeWords('en', down)).toBe('Head office cannot be reached — nothing was read or saved.');
    expect(certificatesOutcomeWords('ta', down)).toBe(CERTIFICATES_COPY.ta.unreachable);
  });

  it('standing and kind words', () => {
    expect([standingOf(cert(), TODAY), standingOf(cert({ validUntil: '2026-10-27' }), TODAY), standingOf(cert({ verifiedBy: undefined }), TODAY), standingOf(cert({ issuedOn: '2026-11-01' }), TODAY)]).toEqual(['valid', 'expired', 'unverified', 'not_yet']);
    expect(standingOf(cert({ validUntil: TODAY }), TODAY)).toBe('valid'); // the last valid day is inclusive
    expect(kindWords('en', 'Food handling')).toBe('Food handling');
    expect(kindWords('ta', 'fostac')).toContain('FoSTaC');
    expect(kindWords('en', 'forklift')).toBe('Recorded as "forklift"');
    for (const key of Object.keys(CERTIFICATES_COPY.en)) expect((CERTIFICATES_COPY.ta as Record<string, string>)[key], key).toBeTruthy();
  });
});

describe('OB-531 · the rostering screen shows the store computer\'s copy read-only when head office cannot be reached', () => {
  const asAt = '2026-10-28T03:30:00.000Z'; // 09:00 in the shop
  const NOW = '2026-10-28T06:30:00.000Z'; // 12:00 in the shop — three hours later
  const shifts = [
    { shiftId: 'SH-OLD', branchId: 'S1', startsAt: '2026-10-20T00:30:00.000Z', endsAt: '2026-10-20T08:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 1 }] },
    { shiftId: 'SH-1', branchId: 'S1', startsAt: '2026-10-29T00:30:00.000Z', endsAt: '2026-10-29T08:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 2 }] },
  ];
  const packWith = (roster: unknown): StorePack => ({ ...emptyPack(), roster: known(roster), rosteringPolicy: known({ userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'] }) } as StorePack);
  const ROSTER = { storeId: 'S1', asAt, employees: [{ employeeId: 'E-R', name: 'Rani', roles: ['cashier'], active: true }, { employeeId: 'E-A', name: 'Asha', roles: ['cashier'], active: true }], shifts, assignments: [{ shiftId: 'SH-1', employeeId: 'E-R', role: 'cashier' }], published: [] };

  it('the box puts its copy of the roster, with the gaps folded by head office\'s engine, on the rostering payload', () => {
    const payload = rosteringPayload({ pack: packWith(ROSTER) } as Parameters<typeof rosteringPayload>[0])!;
    const copy = payload['boxRoster'] as ReturnType<typeof rosterCopyOnBox>;
    expect(copy).toMatchObject({ storeId: 'S1', asAt });
    expect(copy!.gaps.map((g) => [g.shiftId, g.role, g.short])).toEqual([['SH-OLD', 'cashier', 1], ['SH-1', 'cashier', 1]]);
    expect(JSON.stringify(copy)).not.toMatch(/hourlyRate/);
    // No roster in the pack → null (said), never an empty rota.
    expect(rosteringPayload({ pack: { ...packWith(ROSTER), roster: undefined } } as unknown as Parameters<typeof rosteringPayload>[0])!['boxRoster']).toBeNull();
    expect(rosterCopyOnBox({ roster: known({ ...ROSTER, asAt: 'yesterday' }) } as StorePack)).toBeNull(); // malformed → not told
  });

  it('a lost link or a head-office outage reads as "cannot be reached"; any other refusal as a refusal; a good answer as live', async () => {
    expect(await readRosteringWorklist((async () => { throw new TypeError('network'); }) as typeof fetch)).toEqual({ kind: 'unreachable' });
    const answer = (status: number) => (async () => new Response(JSON.stringify({ employees: [], shifts: [], assignments: [], gaps: [] }), { status })) as typeof fetch;
    expect(await readRosteringWorklist(answer(503))).toEqual({ kind: 'unreachable' });
    expect(await readRosteringWorklist(answer(403))).toEqual({ kind: 'refused', status: 403 });
    expect((await readRosteringWorklist(answer(200))).kind).toBe('live');
  });

  const sessionFor = (read: Parameters<typeof rosteringViewFor>[1], data: Parameters<typeof rosteringViewFor>[0]) => {
    const shown = rosteringViewFor(data, read);
    return createRosteringSession({ userId: 'u-mgr', ...shown.config, now: () => NOW }, {
      worklist: () => shown.worklist, mayRead: () => true, mayManage: () => true, assignPort: () => ({ post: async () => 'assigned' as const }),
    });
  };
  const copyData = () => {
    const c = rosterCopyOnBox({ roster: known(ROSTER) } as StorePack)!;
    return { userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'], boxRoster: c };
  };

  it('head office down → the store computer\'s copy, said plainly with its time and age, READ-ONLY (no assign; assign refused)', async () => {
    const s = sessionFor({ kind: 'unreachable' }, copyData());
    const v = s.view('en');
    expect(v.source).toBe('box_copy');
    expect(v.heldWords).toBe("Head office cannot be reached. This is the STORE COMPUTER'S COPY of the roster, as head office last sent it at 2026-10-28 09:00 (3 hour(s) old). It may be out of date.");
    expect(v.readOnlyWords).toBe('Read-only: changing the roster needs head office. Try again when the connection is back.');
    expect(v.mayManage).toBe(false);
    expect(v.gapCount).toBe(2);
    // The rota from today on, with who is on each shift (the shop's own clock).
    expect(v.rota).toEqual([{ shiftId: 'SH-1', startsAt: shifts[1]!.startsAt, when: '2026-10-29 06:00 – 14:00', people: 'Rani (cashier)' }]);
    expect(await s.assign('SH-1', 'E-A', 'cashier')).toBe('refused');
    const ta = s.view('ta');
    expect(ta.heldWords).toContain('கடைக் கணினி நகல்');
    expect(ta.heldWords).toContain('3 மணி நேரம் பழையது');
  });

  it('head office down with no copy → said, never "no gaps"; refused → said; loading → said; live → assign offered as before', async () => {
    const none = sessionFor({ kind: 'unreachable' }, { userId: 'u-mgr', permissions: ['workforce.roster.read'], boxRoster: null }).view('en');
    expect([none.source, none.gapCount, none.mayManage, none.screenState.label]).toEqual(['unreachable', 0, false, ROSTERING_COPY.en.unreachableNoCopy]);
    const refused = sessionFor({ kind: 'refused', status: 403 }, copyData()).view('en');
    expect([refused.source, refused.heldWords, refused.screenState.label]).toEqual(['refused', '', ROSTERING_COPY.en.hoRefused]);
    const loading = bootRostering({ userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'] })!.view('en');
    expect([loading.source, loading.screenState.label, loading.mayManage]).toEqual(['loading', ROSTERING_COPY.en.loading, false]);
    const live: RosteringData = { gaps: [], employees: [], shifts: [], assignments: [] };
    const l = sessionFor({ kind: 'live', worklist: live }, copyData()).view('en');
    expect([l.source, l.heldWords, l.readOnlyWords, l.mayManage, l.rota]).toEqual(['head_office', '', '', true, []]);
  });

  it('age words', () => {
    expect(rosterAgeWords('en', NOW, NOW)).toBe('just now');
    expect(rosterAgeWords('en', '2026-10-28T06:00:00.000Z', NOW)).toBe('30 minute(s) old');
    expect(rosterAgeWords('en', '2026-10-25T06:30:00.000Z', NOW)).toBe('3 day(s) old');
  });
});
