import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { TEST_IDP } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { qg10Record, postQg10Note, QG10_NOTE_PATH } from '../../scripts/lib/release-reconcile.mjs';
import { MACHINE_IDENTITY_REFUSAL_CODE } from '../../services/identity/src/machine-identities';

// OB-423 (owner, 27 Oct 2026): the release script's QG-10 evidence line reaches head office's gate register through a new,
// limited machine identity (role qg10_release_evidence) that may ONLY add QG-10 release evidence — ONE machine login PER
// COMPUTER (owner's answer (b)): the login's user id names its computer (`qg10-release-<box>`), and a note is believed only
// when the box it names is that computer. Every release ATTEMPT is its own note (owner's answer (a)), keyed on the box, the
// release commit, the pipeline run and the attempt. The script's own post code (scripts/lib/release-reconcile.mjs
// postQg10Note) is driven here against the real API, in memory and on real PostgreSQL with a cold restart:
//   • two attempts of one release are BOTH recorded and both listed, newest first, and read back after a restart;
//   • the same attempt's note again is "already recorded" (idempotent — by key replay, and under a new key); a DIFFERENT
//     note claiming the same attempt is refused (409) and the first stands — nothing overwritten (hard rules #2, #6);
//   • box A's login posting box B's note is refused (403) by name; a role holder whose login names no computer is refused;
//   • no person posts — not the owner (who holds the right only to approve the grant), not a manager, not a person's
//     sign-in on the machine's own user id; the machine identity can never hold another role; a bad key is 401;
//   • a malformed note is refused (400) with its problems named, nothing recorded;
//   • the machine identity cannot read the register or decide a gate (least privilege); a cashier cannot read it.

const backings = useRestartableBackings();
const SHA = '1'.repeat(40);
const PREV = '2'.repeat(40);
const DEMO = 'qg10-release-demo-box';
const CANARY = 'qg10-release-canary-box';
const line = (over: Record<string, unknown> = {}): string => JSON.stringify({
  ...qg10Record({
    sha: SHA, previous: PREV, at: '2026-10-27T05:00:00.000Z', by: 'octocat', run: '42', attempt: '1', box: 'demo-box', outcome: 'deployed',
    checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'not_run_on_this_box', rollback: 'ready' },
  }),
  ...over,
});
const keyOf = (text: string) => `qg10-note-${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
type NoteRead = { release: string; box: string; run: string; attempt: string; recordedBy: string; outcome: string; verified: boolean; notVerified: string[]; decision: string };

describe.each(backings)('the release script posts its QG-10 note to the gate register (OB-423) — on $name', ({ harness }) => {
  it('every attempt recorded under its own computer\'s login; the same attempt idempotent; a conflicting attempt refused; another computer\'s note refused; no person posts; reads back after a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, DEMO, 'qg10_release_evidence');
    await h.provisionRole(T, CANARY, 'qg10_release_evidence');
    await h.provisionRole(T, 'release-box', 'qg10_release_evidence'); // a login that names no computer
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const machine = (sub: string) => TEST_IDP.issue({ sub, tenantId: T, authTimeFromNowSeconds: null, amr: null });
    const machineToken = machine(DEMO);
    const shim = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const res = await h.raw({ method: init.method as 'POST', path: new URL(url).pathname, token: init.headers['authorization']!.replace(/^Bearer /, ''), idempotencyKey: init.headers['idempotency-key'], body: JSON.parse(init.body) });
      return { status: res.status, text: async () => JSON.stringify(res.body), headers: { get: (n: string) => (res.headers as Record<string, string> | undefined)?.[n] ?? null } };
    }) as never;
    const post = (text: string, token = machineToken, idempotencyKey = keyOf(text)) =>
      postQg10Note({ line: text, url: 'http://127.0.0.1:8081', token, idempotencyKey, fetch: shim });
    const read = async (userId = 'u-mgr') => h.request({ method: 'GET', path: QG10_NOTE_PATH, userId, tenantId: T });
    const notes = async () => (await read()).body as { notes: NoteRead[]; count: number };

    // Nothing yet: an empty register says so (count 0), never a made-up line.
    expect((await read()).body).toMatchObject({ gate: 'QG-10', count: 0, notes: [] });

    const first = await post(line());
    expect(first).toMatchObject({ posted: true, outcome: 'posted' });
    expect(first.words).toBe(`QG-10 note posted to head office's gate register (release ${SHA}, box demo-box, run 42, attempt 1).`);
    expect(first.words).not.toContain(machineToken);

    h = harness(h); // ── cold restart ──
    const after = await notes();
    expect(after.count).toBe(1);
    expect(after.notes[0]).toMatchObject({ release: SHA, box: 'demo-box', run: '42', attempt: '1', recordedBy: DEMO, outcome: 'deployed', verified: false, notVerified: ['monitoring'] });
    expect(after.notes[0]!.decision).toMatch(/evidence for the owner's QG-10 decision/);

    // The same attempt's note again: replayed under the same key, "already recorded" under a new one — one note either way.
    expect(await post(line())).toMatchObject({ posted: true, outcome: 'already_recorded' });
    expect(await post(line(), machineToken, 'qg10-note-fresh-key')).toMatchObject({ posted: true, outcome: 'already_recorded' });
    expect((await notes()).count).toBe(1);

    // A SECOND ATTEMPT of the same release (the pipeline re-run): its own note — both recorded, both listed, newest first.
    const retry = await post(line({ outcome: 'rolled_back', attempt: '2', at: '2026-10-27T06:00:00.000Z', checks: { health: 'failed', smoke: 'not_run', reconciliation: 'verified', monitoring: 'not_run_on_this_box', rollback: 'exercised_ok' }, notVerified: ['health', 'smoke', 'monitoring'] }));
    expect(retry).toMatchObject({ posted: true, outcome: 'posted' });
    // And a run of its own (a new pipeline run for the same commit) is its own attempt too.
    expect(await post(line({ run: '43', attempt: '1', at: '2026-10-27T07:00:00.000Z' }))).toMatchObject({ posted: true, outcome: 'posted' });
    const three = await notes();
    expect(three.count).toBe(3);
    expect(three.notes.map((n) => `${n.run}/${n.attempt}:${n.outcome}`)).toEqual(['43/1:deployed', '42/2:rolled_back', '42/1:deployed']);

    // A DIFFERENT note claiming an attempt already recorded: refused (409), said, and the first stands — nothing overwritten.
    const conflicting = await post(line({ outcome: 'rolled_back', at: '2026-10-27T05:30:00.000Z' }));
    expect(conflicting).toMatchObject({ posted: false, outcome: 'refused_second_note' });
    expect(conflicting.words).toMatch(/run 42, attempt 1\) — head office already holds a different note from this box for this release attempt and keeps the first \(HTTP 409 qg10_note_already_recorded\)/);
    const kept = await notes();
    expect(kept.count).toBe(3);
    expect(kept.notes.find((n) => n.run === '42' && n.attempt === '1')!.outcome).toBe('deployed');

    // ONE MACHINE LOGIN PER COMPUTER: the canary box posts its own note with its own login…
    expect(await post(line({ box: 'canary-box' }), machine(CANARY))).toMatchObject({ posted: true, outcome: 'posted' });
    // …but the demo box's login posting the canary box's note is refused (403) by name, and so is the reverse.
    const crossed = await h.raw({ method: 'POST', path: QG10_NOTE_PATH, token: machineToken, idempotencyKey: 'cross-1', body: { note: JSON.parse(line({ box: 'canary-box', attempt: '9' })) } });
    expect(crossed.status).toBe(403);
    expect(JSON.stringify(crossed.body)).toContain('qg10_note_names_another_computer');
    expect(JSON.stringify(crossed.body)).toContain(`${DEMO} is the QG-10 machine login of computer demo-box, but this note names computer canary-box`);
    const crossedByTool = await post(line({ box: 'canary-box', attempt: '8' }));
    expect(crossedByTool).toMatchObject({ posted: false, outcome: 'refused_other_computer' });
    expect(crossedByTool.words).toMatch(/this box's QG-10 machine login belongs to another computer \(HTTP 403 qg10_note_names_another_computer\)/);
    expect((await post(line({ attempt: '7' }), machine(CANARY))).outcome).toBe('refused_other_computer');
    // A role holder whose login names no computer is refused too — no note is believed from a login shared between boxes.
    const unnamed = await h.raw({ method: 'POST', path: QG10_NOTE_PATH, token: machine('release-box'), idempotencyKey: 'unnamed-1', body: { note: JSON.parse(line({ box: 'release-box', attempt: '5' })) } });
    expect(unnamed.status).toBe(403);
    expect(JSON.stringify(unnamed.body)).toContain('qg10_login_names_no_computer');
    expect((await notes()).count).toBe(4);

    // A malformed note: 400, every problem named, nothing recorded.
    const bad = await h.raw({ method: 'POST', path: QG10_NOTE_PATH, token: machineToken, idempotencyKey: 'bad-1', body: { note: { ...JSON.parse(line()), verified: true, decision: 'GO', release: 'main' } } });
    expect(bad.status).toBe(400);
    const badBody = JSON.stringify(bad.body);
    expect(badBody).toContain('not_readable_as_a_qg10_note');
    expect(badBody).toMatch(/release is not a 40-character commit id/);
    expect(badBody).toMatch(/never a decision/);
    expect((await h.raw({ method: 'POST', path: QG10_NOTE_PATH, token: machineToken, idempotencyKey: 'bad-2', body: {} })).status).toBe(400);
    expect(((await read()).body as { count: number }).count).toBe(4);

    // No person posts. The owner holds the right only so he can approve the grant; a manager holds nothing of it.
    const asPerson = (userId: string, extra: Record<string, unknown> = {}) => h.request({ method: 'POST', path: QG10_NOTE_PATH, userId, tenantId: T, idempotencyKey: `p-${userId}-${JSON.stringify(extra)}`, body: { note: JSON.parse(line({ box: `by-${userId}`, attempt: '3' })) }, ...extra });
    const owner = await asPerson('u-owner');
    expect(owner.status).toBe(403);
    expect(JSON.stringify(owner.body)).toContain('not_the_release_evidence_identity');
    expect((await asPerson('u-mgr')).status).toBe(403);
    // A PERSON's sign-in (with interactive sign-in evidence) on the machine's own user id is not the machine credential.
    const personOnMachineId = await asPerson(DEMO, { authTimeFromNowSeconds: 30, amr: ['pwd', 'otp'] });
    expect(personOnMachineId.status).toBe(403);
    expect(JSON.stringify(personOnMachineId.body)).toContain('not_the_release_evidence_identity');
    // The machine identity is machine-only: it can never be given another role beside it.
    const mixed = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-mgr', tenantId: T, idempotencyKey: 'mix', body: { grantId: 'g-mix', userId: DEMO, roleId: 'cashier', branchScope: 'all', reason: 'x' } });
    expect(JSON.stringify(mixed.body)).toContain(MACHINE_IDENTITY_REFUSAL_CODE);
    // A bad key: 401, said, never thrown.
    expect(await post(line({ box: 'x-box' }), 'not-a-token')).toMatchObject({ posted: false, outcome: 'refused_key' });

    // Least privilege: the machine identity cannot read the register or decide a gate; a cashier cannot read the notes.
    expect((await h.raw({ method: 'GET', path: QG10_NOTE_PATH, token: machineToken })).status).toBe(403);
    expect((await h.raw({ method: 'GET', path: '/v1/compliance/gate-register', token: machineToken, query: { release: 'R5' } })).status).toBe(403);
    expect((await h.raw({ method: 'POST', path: '/v1/compliance/gate-decisions/QG-10/R5', token: machineToken, idempotencyKey: 'go', body: { decision: 'GO', evidence: [{ label: 'x', ref: 'y' }], rationale: 'z' } })).status).toBe(403);
    expect((await read('u-cash')).status).toBe(403);

    h = harness(h); // ── cold restart: still exactly the four notes — every attempt, nothing collapsed into "latest" ──
    const final = await notes();
    expect(final.count).toBe(4);
    expect(final.notes.map((n) => `${n.box} ${n.run}/${n.attempt}`)).toEqual(['demo-box 43/1', 'demo-box 42/2', 'canary-box 42/1', 'demo-box 42/1']);
    expect(final.notes.find((n) => n.box === 'canary-box')!.recordedBy).toBe(CANARY);
  }, 120_000);
});
