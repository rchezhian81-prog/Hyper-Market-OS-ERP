import { describe, it, expect } from 'vitest';
import { voiceSearchLink, voiceQuery, fakeVoiceSearch, builtInRecogniser, customerVoiceSwitch, recognitionError, VOICE_SEARCH_SWITCHED_ON, VOICE_SWITCH_KEY, type RecognitionConstructor } from '../../apps/customer-app/src/voice-search';
import { signupSmsCodeRoutes, SIGNUP_SMS_CODE_SWITCHED_ON, type SignupSmsSender } from '../../services/customer/src/signup-sms-code';
import { ApiError, type Route } from '../../services/kernel/src/index';

/**
 * D08 voice search (OB-322: the phone's built-in recogniser, switchable off — replacing OB-222 for voice) and M16-FR-01
 * SMS code at sign-up (still a SWITCHED-OFF link, OB-222). Voice: off by the customer's own switch, nothing listens; on,
 * the words heard become an ordinary search. SMS: nothing leaves the shop; with the stand-in (tests only) a code is
 * checked once.
 */

describe('D08 — voice search is the phone\'s own recogniser, switchable off (OB-322)', () => {
  it('a switched-off link (the build switch, or the customer\'s own switch) cannot listen and never starts an engine', async () => {
    expect(VOICE_SEARCH_SWITCHED_ON).toBe(true);
    const engine = fakeVoiceSearch([{ heard: true, transcript: 'milk' }]);
    const offBuild = voiceSearchLink({ switchedOn: false, engine });
    expect(offBuild.available()).toBe(false);
    expect(await offBuild.listen('en')).toEqual({ heard: false, why: 'not_supported' });
    // The customer's switch: off → nothing listens; back on → it listens. Kept on the phone.
    const kept = new Map<string, string>();
    const sw = customerVoiceSwitch({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } });
    const link = voiceSearchLink({ switchedOn: VOICE_SEARCH_SWITCHED_ON, engine, offByCustomer: sw.off });
    expect(link.available()).toBe(true);
    sw.set(false);
    expect(kept.get(VOICE_SWITCH_KEY)).toBe('off');
    expect(link.available()).toBe(false);
    expect(await link.listen('en')).toEqual({ heard: false, why: 'not_supported' });
    expect(link.listensSent()).toBe(0);
    expect(engine.asked).toEqual([]);
    sw.set(true);
    expect(link.available()).toBe(true);
    // Storage that throws reads as ON (the default) and the switch still works for the visit.
    const broken = customerVoiceSwitch({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(broken.off()).toBe(false);
    broken.set(false);
    expect(broken.off()).toBe(true);
  });

  it('the built-in recogniser listens once in Indian English or Tamil, and says why when it hears nothing', async () => {
    const made: { lang: string }[] = [];
    const script: ((r: { onresult: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; onend: (() => void) | null }) => void)[] = [
      (r) => r.onresult?.({ results: [[{ transcript: 'Aavin milk' }]] }),
      (r) => r.onerror?.({ error: 'not-allowed' }),
      (r) => r.onend?.(),
    ];
    class FakeRecognition {
      lang = ''; interimResults = true; maxAlternatives = 5; continuous = true;
      onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null;
      start(): void { made.push({ lang: this.lang }); const next = script.shift()!; queueMicrotask(() => next(this)); }
    }
    const engine = builtInRecogniser(FakeRecognition as unknown as RecognitionConstructor);
    expect(engine.available()).toBe(true);
    expect(await engine.listen('ta')).toEqual({ heard: true, transcript: 'Aavin milk' });
    expect(await engine.listen('en')).toEqual({ heard: false, why: 'permission_denied' });
    expect(await engine.listen('en')).toEqual({ heard: false, why: 'nothing_heard' });
    expect(made.map((m) => m.lang)).toEqual(['ta-IN', 'en-IN', 'en-IN']);
    expect(builtInRecogniser(undefined).available()).toBe(false);
    expect(await builtInRecogniser(undefined).listen('en')).toEqual({ heard: false, why: 'not_supported' });
    expect([recognitionError('no-speech'), recognitionError('network'), recognitionError('service-not-allowed')]).toEqual(['nothing_heard', 'engine_failed', 'permission_denied']);
  });

  it('with the test stand-in behind it, what is heard becomes an ordinary search — nothing reaches a basket', async () => {
    const engine = fakeVoiceSearch([{ heard: true, transcript: 'Please add Aavin MILK!' }]);
    const link = voiceSearchLink({ switchedOn: true, engine });
    expect(link.available()).toBe(true);
    const q = voiceQuery(await link.listen('ta'));
    expect(q).toEqual({ query: 'aavin milk' });
    expect(engine.asked).toEqual(['ta']);
    // The link has no basket: its whole surface is listen / available / name / switchedOn / listensSent.
    expect(Object.keys(link).sort()).toEqual(['available', 'listen', 'listensSent', 'name', 'switchedOn']);
  });
});

const ctx = (body: unknown, challengeId = 'ch-1') => ({ tenantId: 't1', userId: 'u-desk', branchId: null, params: { challengeId }, query: {}, body, idempotencyKey: 'k', traceId: 'tr' });
const call = async (routes: readonly Route[], method: string, path: string, body: unknown, challengeId?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = routes.find((x) => x.method === method && x.path === path)!;
  try {
    const out = await r.handler(ctx(body, challengeId) as never);
    return { status: out.status, body: out.body as Record<string, unknown> };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: e.body as unknown as Record<string, unknown> };
    throw e;
  }
};

describe('M16-FR-01 — the SMS code at sign-up is switched off (OB-222)', () => {
  it('off: asking for a code sends NOTHING and says the desk check works', async () => {
    expect(SIGNUP_SMS_CODE_SWITCHED_ON).toBe(false);
    const sent: unknown[] = [];
    const sender: SignupSmsSender = { name: 'stand-in', send: async (x) => { sent.push(x); } };
    const routes = signupSmsCodeRoutes({ now: () => '2026-10-19T05:00:00.000Z', link: { switchedOn: SIGNUP_SMS_CODE_SWITCHED_ON, sender } });
    const status = await call(routes, 'GET', '/v1/loyalty/sign-up/sms-code', undefined);
    expect(status.body).toMatchObject({ switchedOn: false, deskCheck: 'seen_on_phone' });
    const ask = await call(routes, 'POST', '/v1/loyalty/sign-up/sms-code/:challengeId', { mobile: '9000000011' });
    expect([ask.status, ask.body['code']]).toEqual([409, 'sms_code_switched_off']);
    expect(String(ask.body['whatHappened'])).toMatch(/nothing was sent/);
    expect(sent).toEqual([]);
  });

  it('with the test stand-in: a code is sent to the stand-in, kept only as a hash, and checked once', async () => {
    const sent: { mobile: string; code: string }[] = [];
    const routes = signupSmsCodeRoutes({ now: () => '2026-10-19T05:00:00.000Z', link: { switchedOn: true, sender: { name: 'stand-in', send: async (x) => { sent.push(x); } } } });
    expect((await call(routes, 'POST', '/v1/loyalty/sign-up/sms-code/:challengeId', { mobile: '+91 90000 00011' })).status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mobile).toBe('9000000011');
    expect((await call(routes, 'POST', '/v1/loyalty/sign-up/sms-code/:challengeId/verify', { code: '000000x' })).body).toMatchObject({ verified: false, outcome: 'wrong_code' });
    expect((await call(routes, 'POST', '/v1/loyalty/sign-up/sms-code/:challengeId/verify', { code: sent[0]!.code })).body).toMatchObject({ verified: true });
    expect((await call(routes, 'POST', '/v1/loyalty/sign-up/sms-code/:challengeId/verify', { code: sent[0]!.code })).body).toMatchObject({ verified: false, outcome: 'already_used' });
  });
});
