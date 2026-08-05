import { describe, it, expect } from 'vitest';
import {
  consentControls,
  raiseRequest,
  setConsent,
  RIGHTS_OFFERED,
  UnknownRightError,
  type ConsentPurposeSpec,
} from '../../apps/customer-app/src/privacy-centre';
import { canSend, hasConsent, type ConsentState } from '../../packages/customer/src/index';

/**
 * **The privacy centre (M16 · D07 · PRV · DPDP Act 2023).**
 *
 * The control this file exists to prove is section 6(6) of the Act: *the ease of withdrawing
 * consent must be comparable to the ease with which it was given.*
 *
 * It is the most common dark pattern in consumer software and it is never built deliberately. It
 * arrives one reasonable decision at a time — giving consent is a toggle at sign-up, and
 * withdrawing it becomes a settings page, then a confirmation, then a "tell us why", then an email
 * to support. Nobody decides to make it hard. It simply costs nothing to add a step on the way out
 * and something to add one on the way in.
 *
 * So the symmetry is asserted here as a property, not trusted to review.
 */

const PURPOSES: ConsentPurposeSpec[] = [
  { purpose: 'order_updates', channel: 'sms', required: true },
  { purpose: 'marketing', channel: 'sms' },
  { purpose: 'profiling', channel: 'app' },
];

const NONE: ConsentState = { grants: [] };
const AT = '2026-08-05T10:00:00.000Z';

describe('withdrawing consent is exactly as easy as giving it (DPDP s.6(6))', () => {
  it('is the SAME function in both directions, taking only the direction as an argument', () => {
    // The structural half. There is no `withdrawConsent` — a second function is where a reason
    // field, a confirmation flag and a "here is what you will miss" screen accumulate, none of
    // which would ever be added to the granting path.
    const on = setConsent(NONE, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;

    const off = setConsent(on.state, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.granted).toBe(false);
  });

  it('reports one action in each direction, so a screen cannot quietly disagree', () => {
    for (const control of consentControls(NONE, PURPOSES)) {
      expect(control.tapsToGrant).toBe(1);
      expect(control.tapsToWithdraw).toBe(1);
    }
  });

  it('takes effect immediately — a withdrawal blocks the very next message', () => {
    const on = setConsent(NONE, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: true });
    if (!on.ok) return;
    expect(canSend({ state: on.state, purpose: 'marketing', channel: 'sms' }).allowed).toBe(true);

    const off = setConsent(on.state, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: false });
    if (!off.ok) return;
    expect(canSend({ state: off.state, purpose: 'marketing', channel: 'sms' }))
      .toEqual({ allowed: false, reason: 'withdrawn' });
  });

  it('records a withdrawal as a withdrawal, rather than deleting the grant', () => {
    // Deleting the row would leave the shop unable to show what it had been permitted to do and
    // when — the record an auditor and the customer both need (M16-FR-02).
    const on = setConsent(NONE, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: true });
    if (!on.ok) return;
    const off = setConsent(on.state, PURPOSES, { purpose: 'marketing', channel: 'sms', granted: false });
    if (!off.ok) return;

    expect(off.state.grants).toHaveLength(1);
    expect(off.state.grants[0]).toMatchObject({ purpose: 'marketing', granted: false, withdrawn: true });
    expect(hasConsent(off.state, 'marketing', 'sms')).toBe(false);
  });

  it('can be turned back on again afterwards, without a trace of the old withdrawal blocking it', () => {
    // A withdrawal is not a ban. Somebody who changes their mind must not be stuck.
    let state: ConsentState = NONE;
    for (const granted of [true, false, true]) {
      const change = setConsent(state, PURPOSES, { purpose: 'marketing', channel: 'sms', granted });
      expect(change.ok).toBe(true);
      if (!change.ok) return;
      state = change.state;
    }
    expect(hasConsent(state, 'marketing', 'sms')).toBe(true);
    expect(canSend({ state, purpose: 'marketing', channel: 'sms' }).allowed).toBe(true);
  });
});

describe('a purpose that is genuinely necessary says so, rather than pretending to be a choice', () => {
  it('refuses to switch off a required purpose, with a reason', () => {
    expect(setConsent(NONE, PURPOSES, { purpose: 'order_updates', channel: 'sms', granted: false }))
      .toEqual({ ok: false, refusal: 'required_for_service' });
  });

  it('marks it required in the controls, so the screen can explain instead of just refusing', () => {
    // A necessary purpose that looks optional and then will not move is its own dark pattern.
    const controls = consentControls(NONE, PURPOSES);
    expect(controls.find((c) => c.purpose === 'order_updates')?.required).toBe(true);
    expect(controls.find((c) => c.purpose === 'marketing')?.required).toBe(false);
  });

  it('refuses a switch this tenant does not offer, rather than inventing one', () => {
    expect(setConsent(NONE, PURPOSES, { purpose: 'sell_to_third_parties', channel: 'sms', granted: true }))
      .toEqual({ ok: false, refusal: 'unknown_purpose' });
  });

  it('reads consent as OFF until it is granted — never as a default yes', () => {
    // Pre-ticked consent is not consent, and this is where that would be introduced.
    expect(consentControls(NONE, PURPOSES).every((c) => c.granted === false)).toBe(true);
  });
});

describe('a request that was RAISED is not a request that was DONE', () => {
  it('comes back raised and unverified, with the date the shop must answer by', () => {
    const raised = raiseRequest({
      requestId: 'DSR-1', tenantId: 't1', customerRef: 'c1', kind: 'access', at: AT, slaDays: 30,
    });
    expect(raised.request.state).toBe('raised');
    // Unverified is CORRECT, not a gap: a phone that verified itself would be no check at all,
    // and an unverified access request hands somebody else's shopping history over.
    expect(raised.request.verifiedBy).toBeUndefined();
    expect(raised.request.dueBy.slice(0, 10)).toBe('2026-09-04');
  });

  it('never says the data is gone', () => {
    for (const right of RIGHTS_OFFERED) {
      const raised = raiseRequest({
        requestId: 'DSR-2', tenantId: 't1', customerRef: 'c1', kind: right.kind, at: AT, slaDays: 30,
      });
      expect(raised.tellTheCustomer).not.toMatch(/have been deleted|has been deleted|is deleted|done/i);
      expect(raised.tellTheCustomer).toMatch(/we must answer by/i);
    }
  });

  it('says an erasure cannot be complete BEFORE it is asked for', () => {
    // Somebody who taps "delete everything" believing everything goes, and learns months later
    // that eight years of invoices remain, has been misled even though every later step was
    // accurate. So the limit is on the button, not in the reply.
    expect(RIGHTS_OFFERED.find((r) => r.kind === 'erasure')?.partialByLaw).toBe(true);
    const raised = raiseRequest({
      requestId: 'DSR-3', tenantId: 't1', customerRef: 'c1', kind: 'erasure', at: AT, slaDays: 30,
    });
    expect(raised.tellTheCustomer).toMatch(/invoices and tax records/i);
  });

  it('does not put that caveat on rights where it would be untrue', () => {
    // An "and we might not" hedge on every button is how people stop reading them.
    for (const kind of ['access', 'correction', 'export'] as const) {
      expect(RIGHTS_OFFERED.find((r) => r.kind === kind)?.partialByLaw).toBe(false);
      const raised = raiseRequest({
        requestId: 'DSR-4', tenantId: 't1', customerRef: 'c1', kind, at: AT, slaDays: 30,
      });
      expect(raised.tellTheCustomer).not.toMatch(/tax records/i);
    }
  });

  it('takes the answer-by window from the tenant, never from a constant here', () => {
    const fast = raiseRequest({
      requestId: 'DSR-5', tenantId: 't1', customerRef: 'c1', kind: 'access', at: AT, slaDays: 7,
    });
    expect(fast.request.dueBy.slice(0, 10)).toBe('2026-08-12');
  });

  it('offers all four rights the Act names, and refuses anything else', () => {
    expect(RIGHTS_OFFERED.map((r) => r.kind).sort())
      .toEqual(['access', 'correction', 'erasure', 'export']);
    expect(() => raiseRequest({
      requestId: 'DSR-6', tenantId: 't1', customerRef: 'c1',
      kind: 'sell_my_data' as never, at: AT, slaDays: 30,
    })).toThrow(UnknownRightError);
  });

  it('refuses a timestamp it cannot read rather than inventing a due date', () => {
    // A due date computed from a bad clock is a promise the shop does not know it has made.
    expect(() => raiseRequest({
      requestId: 'DSR-7', tenantId: 't1', customerRef: 'c1', kind: 'access',
      at: 'sometime tuesday', slaDays: 30,
    })).toThrow(RangeError);
  });
});
