import { describe, it, expect } from 'vitest';
import { boxLoginGate, BoxLoginRefusedError } from '../../edge/store-edge/src/box-login-gate';

/**
 * **OB-429 (owner, 28 Oct 2026, option B): the store computer stops calling head office the moment head office refuses its
 * own login.** Head office locks an address after five failed sign-ins, and the people signing in to head office on the store
 * PC leave from the same address as the box's own calls — so a box that kept trying a refused login locked its own shop out.
 * The gate closes on the first `401 unauthenticated` only: a permission (403), a lock (429), a fault (5xx) or a 401 head
 * office did not word leaves it open. Once closed, nothing leaves the box until it is restarted.
 */

const AT = '2026-10-28T09:00:00.000Z';
const worded = (status: number, code: string): Response => new Response(JSON.stringify({ error: { code, whatHappened: 'x' } }), { status });

const counting = (answer: () => Response): { fetch: typeof globalThis.fetch; calls: () => number } => {
  let n = 0;
  return { fetch: (async () => { n += 1; return answer(); }) as unknown as typeof globalThis.fetch, calls: () => n };
};

describe('OB-429 — the box login gate', () => {
  it('open, it passes every call and answer through unchanged', async () => {
    const head = counting(() => new Response('{"ok":true}', { status: 200 }));
    const gate = boxLoginGate(head.fetch, { now: () => AT });
    const res = await gate.fetch('https://ho.example.test/v1/catalogue/pack');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(gate.state()).toEqual({ refused: false, refusedAt: null });
  });

  it('the first 401 unauthenticated closes it: that answer still reaches its caller, and no later call leaves the box', async () => {
    const head = counting(() => worded(401, 'unauthenticated'));
    const said: string[] = [];
    const gate = boxLoginGate(head.fetch, { now: () => AT, onRefused: (at) => { said.push(at); } });
    const first = await gate.fetch('https://ho.example.test/v1/sync/events');
    expect(first.status).toBe(401);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe('unauthenticated'); // the body is not consumed by the gate
    expect(gate.state()).toEqual({ refused: true, refusedAt: AT });
    for (let i = 0; i < 10; i += 1) await expect(gate.fetch('https://ho.example.test/v1/catalogue/pack')).rejects.toBeInstanceOf(BoxLoginRefusedError);
    expect(head.calls()).toBe(1); // head office counted ONE failed sign-in from this address — never the five that lock it
    expect(said).toEqual([AT]);   // said once
  });

  it.each([
    ['a permission the box does not hold', 403, 'forbidden'],
    ['head office\'s own lock or flood limit', 429, 'too_many_sign_in_attempts'],
    ['a step-up the route wants', 401, 'reauthentication_required'],
    ['head office having a bad minute', 503, 'unavailable'],
  ])('%s does not close it', async (_why, status, code) => {
    const head = counting(() => worded(status, code));
    const gate = boxLoginGate(head.fetch, { now: () => AT });
    await gate.fetch('https://ho.example.test/v1/x');
    await gate.fetch('https://ho.example.test/v1/x');
    expect(head.calls()).toBe(2);
    expect(gate.state().refused).toBe(false);
  });

  it('a 401 head office did not word (a proxy, a captive portal) does not close it', async () => {
    const head = counting(() => new Response('<html>sign in to the Wi-Fi</html>', { status: 401 }));
    const gate = boxLoginGate(head.fetch, { now: () => AT });
    await gate.fetch('https://ho.example.test/v1/x');
    expect(gate.state().refused).toBe(false);
  });

  it('a lost link does not close it either — it fails as it always did', async () => {
    const gate = boxLoginGate((async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch);
    await expect(gate.fetch('https://ho.example.test/v1/x')).rejects.toThrow('ENETUNREACH');
    expect(gate.state().refused).toBe(false);
  });

  it('the refusal error carries no token or address — only what happened', () => {
    const e = new BoxLoginRefusedError();
    expect(e.message).toMatch(/login was refused.*renewed.*nothing was sent/);
    expect(e.message).not.toMatch(/https?:|Bearer/);
  });
});
