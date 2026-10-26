import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

// M25-FR-04 ("a cashier sees cashier SOPs; acknowledgement is recorded; help works offline") · D11-FR-06 (emergency
// procedures) · C17 / OB-323 (appointment letters: HR generates from the record, the signed scan kept as HR evidence).
// Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with cold restarts. Synthetic data.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const G1 = '33AABCS1429B1Z1';
/** A 1×1 PNG — the photo of the signed letter, synthetic. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe.each(backings)('the help centre, emergency procedures and appointment letters — on $name', ({ harness }) => {
  it('role-scoped help with its words, own acknowledgement, the box library; emergency contacts not set until entered; drills; letters from the record with the signed scan', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'box-1', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'box-1' ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/hr/workforce/employees/u-cash', 'u-mgr', { name: 'Asha', branchId: 'br-1', roles: ['cashier'], active: true, hourlyRateMinor: 12_500 }), 'employee');

    // ── the help centre (M25-FR-04) ──
    for (const id of ['SOP-01', 'SOP-03', 'SOP-04']) await ok(call('POST', `/v1/hr/workforce/help/built-in/${id}/publish`, 'u-mgr', {}), `publish ${id}`);
    // A procedure written on the help page (English and Tamil both), and an emergency procedure.
    const fire = { title: 'Fire: get everyone out', titleTa: 'தீ: அனைவரையும் வெளியேற்றுங்கள்', version: 1, forRoles: ['cashier', 'store_manager'], category: 'emergency', bodyEn: '1. Shout fire. 2. Open the front shutter. 3. Count everyone at the gate.', bodyTa: '1. தீ என்று கத்துங்கள். 2. முன் ஷட்டரைத் திறக்கவும். 3. வாயிலில் அனைவரையும் எண்ணுங்கள்.' };
    expect(codeOf(await call('POST', '/v1/hr/workforce/help/sops/EM-FIRE', 'u-mgr', { ...fire, bodyTa: '' }))).toBe('not_readable_as_an_sop');
    expect(codeOf(await call('POST', '/v1/hr/workforce/help/sops/SOP-01', 'u-mgr', fire))).toBe('built_in_sheet');
    expect((await call('POST', '/v1/hr/workforce/help/sops/EM-FIRE', 'u-cash', fire)).status).toBe(403);
    await ok(call('POST', '/v1/hr/workforce/help/sops/EM-FIRE', 'u-mgr', fire), 'fire procedure');
    expect(codeOf(await call('POST', '/v1/hr/workforce/help/sops/EM-FIRE', 'u-mgr', { ...fire, bodyEn: `${fire.bodyEn} 4. Ring 101.` }))).toBe('version_not_newer');

    h = harness(h); // ── COLD RESTART ──
    // A cashier sees the cashier SOPs — with their words — and nothing for the owner alone.
    const mine = (await ok(call('GET', '/v1/hr/workforce/help', 'u-cash'), 'help')).body as { roles: string[]; sops: { sopId: string; category: string; bodyEn: string; bodyTa: string; upToDate: boolean }[]; outstanding: number; emergencyContacts: { set: boolean } };
    expect(mine.roles).toEqual(['cashier']);
    expect(mine.sops.map((s) => [s.sopId, s.category, s.upToDate])).toEqual([['EM-FIRE', 'emergency', false], ['SOP-01', 'procedure', false], ['SOP-04', 'procedure', false]]);
    expect(mine.sops[1]!.bodyEn).toMatch(/^# Sheet 1 — The PC is down/);
    expect(mine.sops[1]!.bodyTa).toMatch(/^# தாள் 1/);
    expect([mine.outstanding, mine.emergencyContacts.set]).toEqual([3, false]);
    // The accountant has no SOP for their role yet — said, never someone else's.
    expect(((await ok(call('GET', '/v1/hr/workforce/help', 'u-acct'), 'help')).body as { sops: unknown[] }).sops).toEqual([]);
    // ?all=1 is a manager's: every role's.
    expect(((await ok(call('GET', '/v1/hr/workforce/help', 'u-mgr', undefined, { all: '1' }), 'all')).body as { sops: { sopId: string }[] }).sops.map((s) => s.sopId)).toEqual(['EM-FIRE', 'SOP-01', 'SOP-03', 'SOP-04']);
    expect(((await ok(call('GET', '/v1/hr/workforce/help', 'u-cash', undefined, { all: '1' }), 'all-cash')).body as { sops: unknown[] }).sops).toHaveLength(3);
    await ok(call('POST', '/v1/hr/workforce/sops/EM-FIRE/acknowledge', 'u-cash', { version: 1 }), 'ack fire');
    expect(((await ok(call('POST', '/v1/hr/workforce/sops/EM-FIRE/acknowledge', 'u-cash', { version: 1 }), 'again')).body as { alreadyAcknowledged: boolean }).alreadyAcknowledged).toBe(true);
    // The store computer's library for its offline help page: every SOP with its words, its people, their acknowledgements.
    expect((await call('GET', '/v1/hr/workforce/help-library', 'u-cash')).status).toBe(403);
    const lib = (await ok(call('GET', '/v1/hr/workforce/help-library', 'box-1', undefined, { storeId: 'br-1' }), 'library')).body as { sops: { sopId: string; bodyEn: string | null }[]; people: { employeeId: string; roles: string[] }[]; acknowledgements: { employeeId: string; sopId: string; version: number }[] };
    expect(lib.sops.map((s) => [s.sopId, s.bodyEn !== null])).toEqual([['EM-FIRE', true], ['SOP-01', true], ['SOP-03', true], ['SOP-04', true]]);
    expect([lib.people, lib.acknowledgements]).toEqual([[{ employeeId: 'u-cash', roles: ['cashier'] }], [{ employeeId: 'u-cash', sopId: 'EM-FIRE', version: 1 }]]);
    // A new version of the words: the old acknowledgement no longer counts as up to date.
    await ok(call('POST', '/v1/hr/workforce/help/sops/EM-FIRE', 'u-mgr', { ...fire, version: 2, bodyEn: `${fire.bodyEn} 4. Ring 101.`, bodyTa: `${fire.bodyTa} 4. 101-ஐ அழைக்கவும்.` }), 'fire v2');
    const after = (await ok(call('GET', '/v1/hr/workforce/help', 'u-cash'), 'help')).body as { sops: { sopId: string; version: number; acknowledgedVersion: number | null; upToDate: boolean }[] };
    expect(after.sops[0]).toMatchObject({ sopId: 'EM-FIRE', version: 2, acknowledgedVersion: 1, upToDate: false });

    // ── emergency contacts and drills (D11-FR-06) ──
    expect((await call('POST', '/v1/hr/workforce/emergency-contacts', 'u-mgr', { contacts: [] })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/emergency-contacts', 'u-owner', { contacts: [{ label: 'Fire' }] }))).toBe('not_readable_as_emergency_contacts');
    await ok(call('POST', '/v1/hr/workforce/emergency-contacts', 'u-owner', { contacts: [{ label: 'Fire service', labelTa: 'தீயணைப்பு', phone: '101' }, { label: 'Ambulance', labelTa: 'ஆம்புலன்ஸ்', phone: '108' }] }), 'contacts');
    const drill = { sopId: 'EM-FIRE', branchId: 'br-1', heldOn: new Date().toISOString().slice(0, 10), participants: ['u-cash', 'u-mgr'], findings: 'shutter stuck for a minute' };
    expect(codeOf(await call('POST', '/v1/hr/workforce/emergency-drills/DR-1', 'u-mgr', { ...drill, sopId: 'SOP-01' }))).toBe('not_an_emergency_procedure');
    expect(codeOf(await call('POST', '/v1/hr/workforce/emergency-drills/DR-1', 'u-mgr', { ...drill, heldOn: '2099-01-01' }))).toBe('drill_in_the_future');
    expect((await call('POST', '/v1/hr/workforce/emergency-drills/DR-1', 'u-cash', drill)).status).toBe(403);
    await ok(call('POST', '/v1/hr/workforce/emergency-drills/DR-1', 'u-mgr', drill), 'drill');

    h = harness(h); // ── COLD RESTART ──
    const drills = (await ok(call('GET', '/v1/hr/workforce/emergency-drills', 'u-mgr'), 'drills')).body as { drills: { drillId: string; recordedBy: string }[]; procedures: { sopId: string; lastHeldOn: string | null }[] };
    expect([drills.drills.map((d) => [d.drillId, d.recordedBy]), drills.procedures]).toEqual([[['DR-1', 'u-mgr']], [{ sopId: 'EM-FIRE', title: fire.title, titleTa: fire.titleTa, lastHeldOn: drill.heldOn }]]);
    expect(((await ok(call('GET', '/v1/hr/workforce/help', 'u-cash'), 'help')).body as { emergencyContacts: { set: boolean; contacts: { phone: string }[] } }).emergencyContacts).toMatchObject({ set: true, contacts: [{ phone: '101' }, { phone: '108' }] });

    // ── appointment letters (C17 · OB-323) ──
    expect(codeOf(await call('POST', '/v1/hr/workforce/employees/u-cash/appointment-letters/AL-1', 'u-mgr', { effectiveFrom: '2026-11-01' }))).toBe('letter_wording_not_set');
    expect((await ok(call('GET', '/v1/hr/workforce/appointment-letters/wording', 'u-mgr'), 'wording')).body).toEqual({ set: false });
    const wording = { bodyEn: '{{employerName}} appoints {{employeeName}} ({{employeeId}}) as {{roles}} at {{branch}} from {{effectiveFrom}}, at {{hourlyRate}}. Issued {{issuedOn}}.', bodyTa: '{{employerName}} — {{employeeName}} ({{employeeId}}) {{roles}} ஆக {{branch}} இல் {{effectiveFrom}} முதல், {{hourlyRate}}.' };
    expect((await call('POST', '/v1/hr/workforce/appointment-letters/wording', 'u-mgr', wording)).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/appointment-letters/wording', 'u-owner', { ...wording, bodyEn: '{{salaryGrade}}' }))).toBe('unknown_placeholder');
    await ok(call('POST', '/v1/hr/workforce/appointment-letters/wording', 'u-owner', wording), 'wording');
    // The employer's legal name is the shop's GST registration — not recorded yet, so the letter is refused by name.
    expect(codeOf(await call('POST', '/v1/hr/workforce/employees/u-cash/appointment-letters/AL-1', 'u-mgr', { effectiveFrom: '2026-11-01' }))).toBe('letter_field_not_on_record');
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${G1}`, 'u-it', { companyId: 'C1', legalName: 'SRE Hyper Market Private Limited' }), 'gst');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }), 'branch');
    expect((await call('POST', '/v1/hr/workforce/employees/u-cash/appointment-letters/AL-1', 'u-cash', { effectiveFrom: '2026-11-01' })).status).toBe(403);
    const made = (await ok(call('POST', '/v1/hr/workforce/employees/u-cash/appointment-letters/AL-1', 'u-mgr', { effectiveFrom: '2026-11-01' }), 'letter')).body as { letter: { textEn: string; textTa: string; wordingVersion: number } };
    expect(made.letter.textEn).toBe(`SRE Hyper Market Private Limited appoints Asha (u-cash) as cashier at br-1 from 2026-11-01, at ₹125.00 per hour. Issued ${shopDateIn(new Date().toISOString())}.`);
    expect(made.letter.textTa).toMatch(/^SRE Hyper Market Private Limited — Asha \(u-cash\) cashier ஆக br-1 இல்/);
    // The owner changes the words: the letter already made keeps the words it was made with (frozen).
    await ok(call('POST', '/v1/hr/workforce/appointment-letters/wording', 'u-owner', { bodyEn: 'New words for {{employeeName}}.', bodyTa: 'புதிய சொற்கள் {{employeeName}}.' }), 'wording v2');
    expect(((await ok(call('GET', '/v1/hr/workforce/appointment-letters/AL-1', 'u-mgr'), 'letter')).body as { letter: { textEn: string; wordingVersion: number } }).letter).toMatchObject({ wordingVersion: 1, textEn: made.letter.textEn });
    // The signed copy, checked against its SHA-256 and kept as HR evidence.
    const sha256 = createHash('sha256').update(PNG).digest('hex');
    expect(codeOf(await call('POST', '/v1/hr/workforce/appointment-letters/AL-1/signed-scan', 'u-mgr', { mediaType: 'image/png', contentBase64: PNG.toString('base64'), sha256: '0'.repeat(64) }))).toBe('scan_changed_on_the_way');
    expect(codeOf(await call('POST', '/v1/hr/workforce/appointment-letters/AL-1/signed-scan', 'u-mgr', { mediaType: 'image/jpeg', contentBase64: PNG.toString('base64'), sha256 }))).toBe('scan_not_an_image');
    expect(((await ok(call('GET', '/v1/hr/workforce/appointment-letters', 'u-mgr'), 'letters')).body as { awaitingSignedCopy: number }).awaitingSignedCopy).toBe(1);
    const kept = (await ok(call('POST', '/v1/hr/workforce/appointment-letters/AL-1/signed-scan', 'u-mgr', { mediaType: 'image/png', contentBase64: PNG.toString('base64'), sha256 }), 'scan')).body as { scan: { scanId: string; sha256: string; bytes: number } };
    expect([kept.scan.sha256, kept.scan.bytes]).toEqual([sha256, PNG.length]);

    h = harness(h); // ── COLD RESTART ──
    const letters = (await ok(call('GET', '/v1/hr/workforce/appointment-letters', 'u-mgr', undefined, { employeeId: 'u-cash' }), 'letters')).body as { letters: { letterId: string; signedCopyKept: boolean }[]; awaitingSignedCopy: number };
    expect([letters.letters.map((l) => [l.letterId, l.signedCopyKept]), letters.awaitingSignedCopy]).toEqual([[['AL-1', true]], 0]);
    const bytes = (await ok(call('GET', `/v1/hr/workforce/appointment-letters/AL-1/signed-scan/${kept.scan.scanId}`, 'u-mgr'), 'bytes')).body as { contentBase64: string };
    expect(Buffer.from(bytes.contentBase64, 'base64').equals(PNG)).toBe(true);
    const trail = (await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'hr.appointment_letter.signed_scan_kept' }), 'trail')).body as { matches: { actorId: string; after: Record<string, string> }[] };
    expect(trail.matches.map((m) => [m.actorId, m.after['sha256']])).toEqual([['u-mgr', sha256]]);
  }, 180_000);
});
