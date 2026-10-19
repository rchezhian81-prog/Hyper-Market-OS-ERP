import { describe, it, expect } from 'vitest';
import { voiceSearchLink, voiceQuery, fakeVoiceSearch, VOICE_SEARCH_SWITCHED_ON } from '../../apps/customer-app/src/voice-search';
import { signupSmsCodeRoutes, SIGNUP_SMS_CODE_SWITCHED_ON, type SignupSmsSender } from '../../services/customer/src/signup-sms-code';
import { ApiError, type Route } from '../../services/kernel/src/index';

/**
 * R4 · D08 voice search and M16-FR-01 SMS code at sign-up — both built as SWITCHED-OFF links with a test stand-in
 * (OB-222). Off: nothing is sent — no voice leaves the phone, no code leaves the shop. With the stand-in (tests only):
 * the words heard become an ordinary search, and a code is checked once.
 */

describe('D08 — voice search is switched off (OB-222)', () => {
  it('the product\'s link is off: it cannot listen (so the microphone is not shown) and never starts an engine', async () => {
    expect(VOICE_SEARCH_SWITCHED_ON).toBe(false);
    const engine = fakeVoiceSearch([{ heard: true, transcript: 'milk' }]);
    // Even handed an engine, a switched-off link does not use it.
    const link = voiceSearchLink({ switchedOn: VOICE_SEARCH_SWITCHED_ON, engine });
    expect(link.available()).toBe(false);
    expect(await link.listen('en')).toEqual({ heard: false, why: 'not_supported' });
    expect(link.listensSent()).toBe(0);
    expect(engine.asked).toEqual([]);
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
