import { describe, it, expect } from 'vitest';
import {
  readQg10Note, NotAQg10NoteError, qg10NotVerified, qg10NoteKey, newestQg10First, qg10ComputerOfLogin, QG10_LOGIN_PREFIX,
  QG10_CHECKS, QG10_CHECK_STATES, QG10_OUTCOMES, QG10_NOT_A_DECISION, QG10_PASS_CONDITION, type Qg10EvidenceRecord,
} from '../../packages/compliance/src/index';
import { qg10Record, postQg10Note, registerAddressProblem, QG10_NOTE_PATH } from '../../scripts/lib/release-reconcile.mjs';
import { qg10EvidenceRoutes } from '../../services/api/src/qg10-evidence-adapters';
import { createGatesSession, qg10NoteView, GATES_COPY } from '../../apps/web-erp/src/gates-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * OB-423 (owner, 27 Oct 2026) · QG-10 — the release script's QG-10 line reaches head office's gate register. Pinned here,
 * without a network:
 *   • head office reads EXACTLY the line the script writes — every outcome the script can produce is read; any other
 *     shape (an extra field, a missing check, a "verified" the checks do not support, a line claiming a decision) is
 *     refused with every problem named;
 *   • the script's post: no key → NOT POSTED, said; not https / an address with a sign-in → NOT POSTED; head office's
 *     201, replay, "already", 409, 401/403, 400 and an unreachable head office each say what happened; the key travels
 *     only in the Authorization header and is never in what is said;
 *   • with no durable store the routes answer 503 by name; the Quality gates page's words and note view.
 */

const SHA = 'a'.repeat(40);
const PREV = 'b'.repeat(40);
const line = (over: Record<string, unknown> = {}) => ({
  ...qg10Record({
    sha: SHA, previous: PREV, at: '2026-10-27T05:00:00.000Z', by: 'octocat', run: 'gh-1', attempt: '1', box: 'demo-box', outcome: 'deployed',
    checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'not_run_on_this_box', rollback: 'ready' }, differences: [],
  }),
  ...over,
});
const problems = (input: unknown): readonly string[] => {
  try { readQg10Note(input); } catch (e) { if (e instanceof NotAQg10NoteError) return e.problems; throw e; }
  return [];
};

describe('head office reads exactly the release script\'s QG-10 line (OB-423)', () => {
  it('reads every outcome the script can produce, and re-computes verified from the checks', () => {
    for (const outcome of QG10_OUTCOMES) {
      const n = readQg10Note(line({ outcome }));
      expect(n.outcome).toBe(outcome);
      expect(n.decision).toBe(QG10_NOT_A_DECISION);
    }
    const n = readQg10Note(line());
    expect(n.verified).toBe(false);
    expect(n.notVerified).toEqual(['monitoring']);
    expect(n.passCondition).toBe(QG10_PASS_CONDITION);
    const all = readQg10Note(JSON.parse(JSON.stringify(qg10Record({ sha: SHA, previous: PREV, at: '2026-10-27T05:00:00.000Z', by: 'a', run: 'r', attempt: '1', box: 'b', outcome: 'deployed', checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'verified', rollback: 'exercised_ok' } }))));
    expect(all.verified).toBe(true);
    expect(all.notVerified).toEqual([]);
    // The two halves share one rule: what the script calls not verified, head office does too.
    for (const st of QG10_CHECK_STATES) {
      const checks = Object.fromEntries(QG10_CHECKS.map((c) => [c, st])) as Record<(typeof QG10_CHECKS)[number], string>;
      const rec = qg10Record({ sha: SHA, previous: PREV, at: 'x', by: 'a', run: 'r', attempt: '1', box: 'b', outcome: 'deployed', checks });
      expect(qg10NotVerified(checks), st).toEqual(rec.notVerified);
    }
  });

  it('refuses anything else, naming every problem — and never stores a line as written', () => {
    expect(problems(null)).toEqual(['it is not a QG-10 evidence line at all']);
    expect(problems([])).toEqual(['it is not a QG-10 evidence line at all']);
    expect(problems(line({ gate: 'QG-06' }))).toContain('gate is not QG-10');
    expect(problems(line({ extra: 1 })).join()).toMatch(/fields a QG-10 line does not have \(extra\)/);
    expect(problems(line({ release: 'main' }))).toContain('release is not a 40-character commit id');
    expect(problems(line({ previous: 'x' }))).toContain('previous is not a 40-character commit id');
    expect(problems(line({ at: 'yesterday' }))).toContain('at is not a UTC time');
    expect(problems(line({ by: 'a b' }))).toContain('by is not a readable name');
    expect(problems(line({ box: '' }))).toContain('box is not a readable host name');
    // OB-423 (a): every line names its attempt — the pipeline's attempt number, or the box's own local time stamp.
    const noAttempt: Record<string, unknown> = { ...line() };
    delete noAttempt['attempt'];
    expect(problems(noAttempt)).toContain('attempt is not a pipeline attempt number or a box-local attempt time');
    for (const bad of ['0', 'two', '1.5', 'local-yesterday', '']) expect(problems(line({ attempt: bad })), bad).toContain('attempt is not a pipeline attempt number or a box-local attempt time');
    for (const good of ['1', '2', '17', 'local-20261027T101500Z']) expect(problems(line({ attempt: good })), good).toEqual([]);
    expect(problems(line({ outcome: 'GO' })).join()).toMatch(/^outcome is not one of/);
    expect(problems(line({ checks: { health: 'verified' } })).join()).toMatch(/checks must be exactly/);
    expect(problems(line({ checks: { ...line().checks, smoke: 'fine' } }))).toContain('checks smoke not in a known state');
    expect(problems(line({ verified: true }))).toContain('verified does not follow from the checks');
    expect(problems(line({ notVerified: [] }))).toContain('notVerified does not follow from the checks');
    expect(problems(line({ differences: 'none' })).join()).toMatch(/differences is not a list/);
    expect(problems(line({ differences: Array.from({ length: 101 }, () => 'x') })).join()).toMatch(/differences is not a list/);
    expect(problems(line({ decision: 'GO' })).join()).toMatch(/evidence, never a decision/);
    expect(problems(line({ passCondition: 'whatever' })).join()).toMatch(/passCondition/);
    // Several problems at once are all named.
    expect(problems(line({ gate: 'x', release: 'y', decision: 'GO' })).length).toBe(3);
  });

  it('one note per release ATTEMPT per box (box + release + run + attempt); newest first', () => {
    const k = { release: SHA, box: 'a', run: '42', attempt: '1' };
    expect(qg10NoteKey(k)).toBe(`${SHA}|a|42|1`);
    expect(qg10NoteKey(k)).not.toBe(qg10NoteKey({ ...k, box: 'b' }));
    expect(qg10NoteKey(k)).not.toBe(qg10NoteKey({ ...k, attempt: '2' }));
    expect(qg10NoteKey(k)).not.toBe(qg10NoteKey({ ...k, run: '43' }));
    expect(qg10NoteKey(k)).not.toBe(qg10NoteKey({ ...k, release: 'c'.repeat(40) }));
    const r = (recordedAt: string) => ({ ...readQg10Note(line()), recordedBy: 'm', recordedAt, noteDigest: 'd' }) as Qg10EvidenceRecord;
    expect(newestQg10First([r('2026-10-01T00:00:00Z'), r('2026-10-03T00:00:00Z'), r('2026-10-02T00:00:00Z')]).map((x) => x.recordedAt))
      .toEqual(['2026-10-03T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z']);
    // The release attempt's own time comes first: two notes recorded in the same instant still read newest release first.
    const at = (when: string) => ({ ...readQg10Note(line({ at: when })), recordedBy: 'm', recordedAt: '2026-10-27T06:00:00.000Z', noteDigest: 'd' }) as Qg10EvidenceRecord;
    expect(newestQg10First([at('2026-10-27T04:00:00.000Z'), at('2026-10-27T05:00:00.000Z')]).map((x) => x.at)).toEqual(['2026-10-27T05:00:00.000Z', '2026-10-27T04:00:00.000Z']);
  });
});

describe('the release script\'s post of its QG-10 line (OB-423)', () => {
  const KEY = ['machine', 'key', 'for', 'the', 'test'].join('-');
  const text = JSON.stringify(line());
  const answering = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return { status, text: async () => JSON.stringify(body), headers: { get: (n: string) => headers[n] ?? null } };
    };
    return { calls, fetch };
  };
  const post = (fetch: unknown, over: Record<string, unknown> = {}) =>
    postQg10Note({ line: text, url: 'http://127.0.0.1:8081', token: KEY, idempotencyKey: 'qg10-note-1', fetch, ...over } as never);

  it('no key: NOT POSTED, said with the reason, nothing sent', async () => {
    const a = answering(201);
    const out = await post(a.fetch, { token: '' });
    expect(out).toMatchObject({ posted: false, outcome: 'no_key' });
    expect(out.words).toMatch(/^QG-10 note NOT POSTED to head office's gate register \(release a{40}, box demo-box, run gh-1, attempt 1\) — no key is configured on this box/);
    expect((await post(a.fetch, { token: ' ', noKeyBecause: 'the key file named by SRE_QG10_PUSH_TOKEN_FILE is empty' })).words).toContain('is empty');
    expect(a.calls).toEqual([]);
  });

  it('an address that is not https (or the box\'s loopback), or carries a sign-in, is refused before anything is sent', async () => {
    expect(registerAddressProblem('https://ho.example.test')).toBeUndefined();
    expect(registerAddressProblem('http://localhost:8081')).toBeUndefined();
    expect(registerAddressProblem('')).toMatch(/no register address/);
    expect(registerAddressProblem('http://ho.example.test')).toMatch(/neither https nor/);
    expect(registerAddressProblem(['https://u', ':p@ho.example.test'].join(''))).toMatch(/carries a sign-in/);
    expect(registerAddressProblem('::')).toMatch(/not an address/);
    const a = answering(201);
    expect(await post(a.fetch, { url: 'http://ho.example.test' })).toMatchObject({ posted: false, outcome: 'no_address' });
    expect(a.calls).toEqual([]);
  });

  it('posts the line as { note } with the key only in the Authorization header, and says what head office answered', async () => {
    const a = answering(201, { alreadyRecorded: false });
    const out = await post(a.fetch);
    expect(out).toEqual({ posted: true, outcome: 'posted', words: 'QG-10 note posted to head office\'s gate register (release aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, box demo-box, run gh-1, attempt 1).' });
    expect(a.calls[0]!.url).toBe(`http://127.0.0.1:8081${QG10_NOTE_PATH}`);
    expect(a.calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'idempotency-key': 'qg10-note-1' });
    expect(JSON.parse(a.calls[0]!.init.body)).toEqual({ note: line() });
    expect(a.calls[0]!.init.body).not.toContain(KEY);
    const cases: [number, unknown, Record<string, string>, string, boolean][] = [
      [201, {}, { 'idempotent-replay': 'true' }, 'already_recorded', true],
      [200, { alreadyRecorded: true }, {}, 'already_recorded', true],
      [409, { error: { code: 'qg10_note_already_recorded' } }, {}, 'refused_second_note', false],
      [403, { error: { code: 'not_the_release_evidence_identity' } }, {}, 'refused_key', false],
      [403, { error: { code: 'qg10_note_names_another_computer' } }, {}, 'refused_other_computer', false],
      [403, { error: { code: 'qg10_login_names_no_computer' } }, {}, 'refused_other_computer', false],
      [401, { error: { code: 'unauthenticated' } }, {}, 'refused_key', false],
      [400, { error: { code: 'not_readable_as_a_qg10_note' } }, {}, 'refused_note', false],
      [503, 'not json', {}, 'refused', false],
    ];
    for (const [status, body, headers, outcome, posted] of cases) {
      const r = await post(answering(status, body, headers).fetch);
      expect(r, String(status)).toMatchObject({ outcome, posted });
      expect(r.words).not.toContain(KEY);
      if (!posted) expect(r.words).toMatch(/^QG-10 note NOT POSTED/);
    }
    expect((await post(answering(409, { error: { code: 'qg10_note_already_recorded' } }).fetch)).words).toMatch(/already holds a different note from this box for this release attempt and keeps the first \(HTTP 409 qg10_note_already_recorded\)/);
    const down = await post(async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); });
    expect(down).toMatchObject({ posted: false, outcome: 'unreachable' });
    expect(down.words).not.toContain(KEY);
    expect((await post(a.fetch, { line: 'not json' })).outcome).toBe('no_line');
  });
});

describe('one machine login per computer (OB-423 (b))', () => {
  it('a QG-10 machine login names its computer: qg10-release-<box>; anything else names none', () => {
    expect(QG10_LOGIN_PREFIX).toBe('qg10-release-');
    expect(qg10ComputerOfLogin('qg10-release-demo-box')).toBe('demo-box');
    expect(qg10ComputerOfLogin('qg10-release-canary.box-2')).toBe('canary.box-2');
    for (const none of ['release-box', 'qg10-release-', 'qg10-release-a b', 'QG10-RELEASE-demo', 'x-qg10-release-demo-box']) expect(qg10ComputerOfLogin(none), none).toBeUndefined();
  });
});

describe('head office without its durable store (OB-423)', () => {
  it('answers 503 by name for the post and the read', async () => {
    const routes = qg10EvidenceRoutes({ store: undefined, now: () => '2026-10-27T00:00:00Z' });
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permission}`)).toEqual([
      'POST /v1/compliance/gate-register/qg10-evidence compliance.qg10.evidence.push',
      'GET /v1/compliance/gate-register/qg10-evidence compliance.gate.read',
    ]);
    for (const r of routes) {
      await expect(Promise.resolve().then(() => r.handler({ tenantId: 't', userId: 'u', params: {}, query: {}, body: { note: line() } } as never)))
        .rejects.toMatchObject({ status: 503, body: { code: 'register_store_not_available' } });
    }
  });
});

describe('the Quality gates page shows the QG-10 notes (OB-423)', () => {
  it('every new word has a Tamil twin', () => {
    const keys = Object.keys(GATES_COPY.en).filter((k) => /^(qg10|c_|o_|s_)/.test(k)) as (keyof typeof GATES_COPY.en)[];
    expect(keys.length).toBeGreaterThan(20);
    expect(bilingualGaps(GATES_COPY as never, keys as never)).toEqual({ en: [], ta: [] });
    for (const o of QG10_OUTCOMES) expect(GATES_COPY.en, o).toHaveProperty(`o_${o}`);
    for (const c of QG10_CHECKS) expect(GATES_COPY.en, c).toHaveProperty(`c_${c}`);
    for (const st of QG10_CHECK_STATES) expect(GATES_COPY.en, st).toHaveProperty(`s_${st}`);
  });

  it('a note reads as an icon AND words: ✓ all five verified, or ⚠ naming each check not verified, with its differences', () => {
    const rec = { ...readQg10Note(line({ outcome: 'rolled_back_on_reconcile', differences: ['the ledger lost event 7'] })), recordedAt: 'x' };
    const v = qg10NoteView('en', rec);
    expect(v.icon).toBe('⚠');
    expect(v.tone).toBe('error');
    expect(v.headline).toBe('aaaaaaaaaaaa · rolled back — the books did not reconcile · not verified: monitoring');
    expect(v.lines).toContain('Difference: the ledger lost event 7');
    expect(v.lines[0]).toBe('box: demo-box · run: gh-1 · attempt: 1 · merged by: octocat · at: 2026-10-27T05:00:00.000Z');
    expect(qg10NoteView('en', { ...rec, attempt: 'local-20261027T101500Z' }).lines[0]).toContain('attempt: by hand on this box, 2026-10-27 10:15:00 UTC');
    expect(qg10NoteView('ta', rec).lines[0]).toContain('முயற்சி: 1');
    expect(v.lines[1]).toBe('health: verified · smoke: verified · reconciliation: verified · monitoring: not run on this box · rollback: ready, not used');
    // A note read back from PostgreSQL (jsonb re-orders keys) still reads in QG-10's own order.
    const c = rec.checks;
    expect(qg10NoteView('en', { ...rec, checks: { smoke: c.smoke, health: c.health, rollback: c.rollback, monitoring: c.monitoring, reconciliation: c.reconciliation } }).lines[1]).toBe(v.lines[1]);
    expect(qg10NoteView('ta', rec).lines[1]).toContain('கண்காணிப்பு: இந்தக் கணினியில் செய்யப்படவில்லை');
    const ta = qg10NoteView('ta', rec);
    expect(ta.headline).toContain('சரிபார்க்கப்படாதவை: கண்காணிப்பு');
    const good = qg10NoteView('en', { ...rec, verified: true, notVerified: [], differences: [] });
    expect(good).toMatchObject({ icon: '✓', tone: 'ok' });
    expect(good.headline).toMatch(/all five verified$/);
  });

  it('the session reads the notes only for a named person who may read the register', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ notes: [], count: 0 }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect(await createGatesSession({ viewer: undefined, fetch }).readEvidence()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createGatesSession({ viewer: { userId: 'u', permissions: [] }, fetch }).readEvidence()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(calls).toEqual([]);
    expect(await createGatesSession({ viewer: { userId: 'u', permissions: ['compliance.gate.read'] }, fetch }).readEvidence()).toEqual({ result: 'ok', value: { notes: [], count: 0 } });
    expect(calls).toEqual(['/v1/compliance/gate-register/qg10-evidence']);
  });
});
