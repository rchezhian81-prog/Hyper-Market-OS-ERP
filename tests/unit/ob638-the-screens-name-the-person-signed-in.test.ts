import { describe, it, expect } from 'vitest';
import { operatorLabel } from '../../apps/pos/src/operator-label';
import { bootPos, type TillOperatorPort, type TillSignInOutcome } from '../../apps/pos/src/browser-entry';
import { createSelfCheckoutLane, type TillEngine } from '../../apps/self-checkout/src/self-checkout-lane';

// OB-638 (owner, 1 Nov 2026, option A): the till header and the self-checkout / queue screens name the person signed in —
// "Ravi (u-ravi)": the name the store computer gave at sign-in with the staff code beside it; the code alone when no name
// is known. Words only — the code is still what every record carries (`operator()`, the lane's `attendant`).

describe('OB-638: operatorLabel', () => {
  it('names the person with the code beside it, and falls back to the code alone', () => {
    expect(operatorLabel('u-ravi', 'Ravi')).toBe('Ravi (u-ravi)');
    expect(operatorLabel('u-ravi', '  Ravi Kumar ')).toBe('Ravi Kumar (u-ravi)');
    expect(operatorLabel('u-ravi', undefined)).toBe('u-ravi');
    expect(operatorLabel('u-ravi', null)).toBe('u-ravi');
    expect(operatorLabel('u-ravi', '   ')).toBe('u-ravi');
    expect(operatorLabel('u-ravi', 'u-ravi')).toBe('u-ravi'); // a box that echoes the code is not a name
    expect(operatorLabel('அருண்', 'அருண்')).toBe('அருண்');
    expect(operatorLabel('u-arun', 'அருண்')).toBe('அருண் (u-arun)');
    expect(operatorLabel(undefined, 'Ravi')).toBeUndefined(); // nobody signed in: never a name on its own
    expect(operatorLabel('', 'Ravi')).toBeUndefined();
  });
});

/** The store computer's operator calls, as a double: who it knows, with or without a name, and the live session. */
function box(people: Record<string, { pin: string; name?: string }>): TillOperatorPort {
  let live: { token: string; userId: string } | null = null;
  return {
    async status(token) {
      if (live === null || token !== live.token) return { signInBy: 'pin', signedIn: false };
      const name = people[live.userId]!.name;
      return { signInBy: 'pin', signedIn: true, userId: live.userId, ...(name === undefined ? {} : { displayName: name }), expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    async signIn({ staffId, pin }): Promise<TillSignInOutcome> {
      const p = staffId === undefined ? undefined : people[staffId];
      if (p === undefined || p.pin !== pin) return { signedIn: false, refusedBecause: 'wrong_pin', laneMessage: 'Not signed in.' };
      live = { token: `T-${staffId}`, userId: staffId! };
      // An older box gives no name: the outcome then carries the code where the name goes (as the type allows "").
      return { signedIn: true, token: live.token, userId: staffId!, displayName: p.name ?? '', expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    async signOut() { live = null; },
  };
}

describe('OB-638: the till session names the person the store computer named', () => {
  it('signs in → "Ravi (u-ravi)"; the record still carries the code; signs out → nobody; the next person never shows the last name', async () => {
    const lane = bootPos({ laneId: 'L1', operatorPort: box({ 'u-ravi': { pin: '111111', name: 'Ravi' }, 'u-old': { pin: '222222' } }) });
    expect(lane.operatorShown()).toBeUndefined();
    expect(await lane.signInAtTill({ staffId: 'u-ravi', pin: '111111' })).toMatchObject({ signedIn: true });
    expect(lane.operatorShown()).toBe('Ravi (u-ravi)');
    expect(lane.operator()).toBe('u-ravi'); // what every sale, refund and cash movement names — unchanged
    await lane.signOutAtTill();
    expect(lane.operatorShown()).toBeUndefined();
    // a person the box knows by code only: the code alone
    await lane.signInAtTill({ staffId: 'u-old', pin: '222222' });
    expect(lane.operatorShown()).toBe('u-old');
    // a wrong PIN changes nothing
    expect(await lane.signInAtTill({ staffId: 'u-ravi', pin: '000000' })).toMatchObject({ signedIn: false });
    expect(lane.operatorShown()).toBe('u-old');
  });

  it('after a reload the store computer\'s answer names the person again', async () => {
    const port = box({ 'u-ravi': { pin: '111111', name: 'Ravi' } });
    await port.signIn({ staffId: 'u-ravi', pin: '111111' });
    const lane = bootPos({ laneId: 'L1', operatorPort: port });
    expect(await lane.resumeAtTill('T-u-ravi')).toBe(true);
    expect(lane.operatorShown()).toBe('Ravi (u-ravi)');
  });

  it('a model-only sign-in (the stand-in path) names nobody by a name it was never given', () => {
    const lane = bootPos({ laneId: 'L1', operatorPort: box({}) });
    lane.signIn('u-cash');
    expect(lane.operatorShown()).toBe('u-cash');
  });
});

describe('OB-638: the self-checkout lane names its attendant', () => {
  function till(name?: string): TillEngine {
    let operator: string | undefined;
    return {
      scanBarcode: () => { throw new Error('not used'); },
      basket: () => [], payableMinor: () => 0, voidAtTill: async () => ({ ok: true, laneMessage: '' }),
      confirmAge: () => undefined, refuseAge: () => undefined, confirmPackDate: () => undefined, refusePackDate: () => undefined,
      signInAtTill: async ({ staffId, pin }) => (staffId === 'u-attend' && pin === '111111'
        ? (operator = staffId, { signedIn: true as const, userId: staffId, ...(name === undefined ? {} : { displayName: name }) })
        : { signedIn: false as const, refusedBecause: 'wrong_pin', laneMessage: 'no' }),
      signOutAtTill: async () => { operator = undefined; },
      operator: () => operator,
      nextReceipt: async () => 'R-1', startCardPayment: async () => ({ ok: false, laneMessage: '' }), answerCardPayment: async () => ({ ok: false, laneMessage: '' }),
      tenderCardOrUpi: async () => 'R-1', newSale: () => undefined, currentBillRef: () => 'B-1',
    };
  }
  const config = { switchOn: true, switchWhy: null, mirrorPilot: false, realTrading: false, now: () => '2026-11-01T10:00:00.000Z', recordBasket: async () => ({ recorded: true, laneMessage: '' }) };

  it('"Attendant (u-attend)" once opened, the code still the attendant on record; the code alone with no name; nobody once closed', async () => {
    const named = createSelfCheckoutLane(till('Attendant'), config);
    expect(named.view().attendantShown).toBeNull();
    await named.openLane('u-attend', '111111');
    expect(named.view()).toMatchObject({ attendant: 'u-attend', attendantShown: 'Attendant (u-attend)' });
    await named.closeLane();
    expect(named.view()).toMatchObject({ attendant: null, attendantShown: null });
    const unnamed = createSelfCheckoutLane(till(), config);
    await unnamed.openLane('u-attend', '111111');
    expect(unnamed.view().attendantShown).toBe('u-attend');
  });
});
