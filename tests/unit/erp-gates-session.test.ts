import { describe, it, expect } from 'vitest';
import { createGatesSession, GATES_COPY, GATE_NAMES, stateView, gatesWords, RELEASES } from '../../apps/web-erp/src/gates-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { QUALITY_GATES, RELEASES as ENGINE_RELEASES } from '../../packages/compliance/src/index';

/**
 * QG-12 (roadmap §22; OB-288 gates lane) — the Quality gates page's session: what it refuses before asking head office,
 * what it asks, that every word has a Tamil twin, and that every state reads as an icon AND words.
 */

function recorder(status = 200, body: unknown = {}) {
  const calls: { url: string; method: string; body: unknown; key: string | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: headers['idempotency-key'] });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const viewer = (...permissions: string[]) => ({ userId: 'u-owner', permissions });
const good = { gate: 'QG-06', release: 'R5', decision: 'HOLD', evidenceLabel: 'pentest not done', evidenceRef: 'docs/security/pentest.md', rationale: ' waiting for the tester ' };

describe('the Quality gates words', () => {
  it('every English word has a Tamil twin, and the detector bites', () => {
    const keys = Object.keys(GATES_COPY.en) as (keyof typeof GATES_COPY.en)[];
    const gaps = bilingualGaps(GATES_COPY as never, keys as never);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
    expect(bilingualGaps({ en: { a: 'x' }, ta: { a: '' } } as never, ['a'] as never).ta).toEqual(['a']);
  });

  it('names all twelve gates in both languages, and the releases match head office\'s', () => {
    for (const g of QUALITY_GATES) {
      expect(GATE_NAMES[g.gate]?.en).toBe(g.name);
      expect((GATE_NAMES[g.gate]?.ta ?? '').length).toBeGreaterThan(0);
    }
    expect(RELEASES).toEqual(ENGINE_RELEASES);
  });

  it('every state is an icon AND words AND a tone; undecided says silence is not approval', () => {
    for (const s of ['undecided', 'GO', 'HOLD', 'REWORK', 'GO_NOW_BLOCKED'] as const) {
      for (const lang of ['en', 'ta'] as const) {
        const v = stateView(lang, s);
        expect(v.icon.trim()).not.toBe('');
        expect(v.words.trim()).not.toBe('');
      }
    }
    expect(stateView('en', 'undecided').words).toBe('Not decided — silence is not approval');
    expect(stateView('ta', 'undecided').words).toBe('முடிவு இல்லை — மௌனம் ஒப்புதல் அல்ல');
    expect(stateView('en', 'GO_NOW_BLOCKED').tone).toBe('error');
    expect(gatesWords('ta', 'unknown-key')).toBe('unknown-key');
  });
});

describe('the Quality gates session', () => {
  it('asks nothing when nobody is named, without the read right, or without a release', async () => {
    const r = recorder();
    expect(await createGatesSession({ viewer: undefined, fetch: r.fetch }).read('R5')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createGatesSession({ viewer: viewer(), fetch: r.fetch }).read('R5')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createGatesSession({ viewer: viewer('compliance.gate.read'), fetch: r.fetch }).read('')).toEqual({ result: 'invalid', why: 'noRelease' });
    expect(r.calls).toEqual([]);
  });

  it('reads the register for the chosen release with a GET', async () => {
    const r = recorder(200, { release: 'R5', gates: [] });
    const out = await createGatesSession({ viewer: viewer('compliance.gate.read'), fetch: r.fetch }).read('R5');
    expect(out.result).toBe('ok');
    expect(r.calls).toEqual([{ url: '/v1/compliance/gate-register?release=R5', method: 'GET', body: undefined, key: undefined }]);
  });

  it('offers deciding only to someone who holds compliance.gate.decide', () => {
    expect(createGatesSession({ viewer: viewer('compliance.gate.read') }).may).toEqual({ named: true, read: true, decide: false });
    expect(createGatesSession({ viewer: viewer('compliance.gate.read', 'compliance.gate.decide') }).may.decide).toBe(true);
    expect(createGatesSession({ viewer: undefined }).may).toEqual({ named: false, read: false, decide: false });
  });

  it('refuses a decision locally with no right, no release, no gate, no decision word, no evidence or no reason — and sends nothing', async () => {
    const r = recorder();
    const owner = createGatesSession({ viewer: viewer('compliance.gate.read', 'compliance.gate.decide'), fetch: r.fetch });
    expect(await createGatesSession({ viewer: viewer('compliance.gate.read'), fetch: r.fetch }).decide(good)).toEqual({ result: 'invalid', why: 'cannotDecide' });
    expect(await owner.decide({ ...good, release: 'R9' })).toEqual({ result: 'invalid', why: 'noRelease' });
    expect(await owner.decide({ ...good, gate: 'QG-13' })).toEqual({ result: 'invalid', why: 'noGate' });
    expect(await owner.decide({ ...good, decision: 'MAYBE' })).toEqual({ result: 'invalid', why: 'noDecision' });
    expect(await owner.decide({ ...good, evidenceRef: ' ' })).toEqual({ result: 'invalid', why: 'noEvidence' });
    expect(await owner.decide({ ...good, rationale: '' })).toEqual({ result: 'invalid', why: 'noReason' });
    expect(r.calls).toEqual([]);
  });

  it('posts the trimmed decision with its evidence and an idempotency key — and never a decider', async () => {
    const r = recorder(201, { decision: { decision: 'HOLD', decidedBy: 'u-owner' } });
    const out = await createGatesSession({ viewer: viewer('compliance.gate.read', 'compliance.gate.decide'), fetch: r.fetch, newKey: () => 'k-1' }).decide(good);
    expect(out).toEqual({ result: 'ok', value: { decision: { decision: 'HOLD', decidedBy: 'u-owner' } } });
    expect(r.calls).toEqual([{
      url: '/v1/compliance/gate-decisions/QG-06/R5', method: 'POST', key: 'k-1',
      body: { decision: 'HOLD', evidence: [{ label: 'pentest not done', ref: 'docs/security/pentest.md' }], rationale: 'waiting for the tester' },
    }]);
  });

  it('shows head office\'s refusal in its own words', async () => {
    const r = recorder(422, { error: { code: 'go_refused_while_blocked', whatHappened: 'QG-06 cannot be GO while 1 thing(s) block it' } });
    const out = await createGatesSession({ viewer: viewer('compliance.gate.read', 'compliance.gate.decide'), fetch: r.fetch }).decide({ ...good, decision: 'GO' });
    expect(out).toEqual({ result: 'refused', status: 422, code: 'go_refused_while_blocked', whatHappened: 'QG-06 cannot be GO while 1 thing(s) block it' });
  });
});
