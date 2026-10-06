import { describe, it, expect, afterEach } from 'vitest';
import { laneOperator } from '../../apps/pos/src/browser-entry';

/**
 * **The till's sign-in calls say what happened, in the cashier's words (ADR-0020 · Wave 2b-v-a).**
 *
 * On the hosted copy the front answers for itself before the store computer is asked: a sign-in that has ended (401) or
 * a person who may not sell (403). Those must read as what they are — not as "cannot reach the store computer", which
 * sends a manager to look for a fault that is not there. A box that does not answer at all is said as that.
 */

const saved = globalThis.fetch;
afterEach(() => { globalThis.fetch = saved; });
const answer = (status: number, body: unknown = '') => {
  globalThis.fetch = (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
};

describe('laneOperator().signIn', () => {
  it('a person the front says may not sell is told so', async () => {
    answer(403);
    expect(await laneOperator(8090).signIn({})).toEqual({ signedIn: false, refusedBecause: 'no_till_authority', laneMessage: expect.stringMatching(/not allowed to work a till/) });
  });

  it('a sign-in that has ended is told to sign in again', async () => {
    answer(401);
    expect(await laneOperator(8090).signIn({})).toMatchObject({ signedIn: false, refusedBecause: 'not_signed_in' });
  });

  it('the box\'s own refusal is passed on as the box said it; a box that does not answer is said as that', async () => {
    answer(200, { signedIn: false, refusedBecause: 'wrong_staff_id_or_pin', laneMessage: 'That staff ID and PIN do not match.' });
    expect(await laneOperator(8090).signIn({ staffId: 'u-x', pin: '000000' })).toEqual({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin', laneMessage: 'That staff ID and PIN do not match.' });
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await laneOperator(8090).signIn({})).toMatchObject({ signedIn: false, refusedBecause: 'lane_unreachable', laneMessage: expect.stringMatching(/cannot reach its store computer/) });
  });

  it('a session the box opened comes back whole', async () => {
    answer(200, { signedIn: true, token: 't', userId: 'u-a', displayName: 'A', expiresAt: '2026-10-06T21:00:00.000Z', via: 'pin' });
    expect(await laneOperator(8090).signIn({ staffId: 'u-a', pin: '000000' })).toMatchObject({ signedIn: true, userId: 'u-a', token: 't' });
  });
});
