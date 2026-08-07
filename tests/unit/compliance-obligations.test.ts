import { describe, it, expect } from 'vitest';
import {
  registerObligation,
  closeObligation,
  expiryAlerts,
  missingEvidence,
  attachEvidence,
  isCompliant,
  MissingResponsiblePersonError,
  CannotDeleteObligationError,
  DEFAULT_ALERT_POLICY,
  type Obligation,
} from '../../packages/compliance/src/index';

// M34-FR-03 — a hypermarket runs on paper it did not write. The way a licence
// expires is always the same: nobody owned the date. So every obligation names a
// person, and an expired one keeps shouting instead of going quiet.

const TODAY = '2026-08-03';

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    obligationId: 'ob-1',
    tenantId: 't1',
    branchId: 'b1',
    kind: 'licence',
    name: 'FSSAI food licence',
    authority: 'FSSAI',
    reference: '12345678901234',
    validFrom: '2025-09-01',
    expiresOn: '2026-08-31',
    responsible: { userId: 'u-priya', name: 'Priya', escalatesToUserId: 'u-owner' },
    evidence: [{ evidenceId: 'e1', description: 'Scanned licence', recordedAt: '2025-09-02T10:00:00Z' }],
    status: 'active',
    ...over,
  };
}

describe('registerObligation — every obligation has a named person', () => {
  it('accepts an obligation with a named responsible person', () => {
    expect(registerObligation(obligation()).responsible.name).toBe('Priya');
  });

  it('refuses one that names nobody — an alert to a role reaches nobody', () => {
    expect(() =>
      registerObligation(obligation({ responsible: { userId: '', name: '' } })),
    ).toThrow(MissingResponsiblePersonError);
    expect(() =>
      registerObligation(obligation({ responsible: { userId: 'compliance', name: '  ' } })),
    ).toThrow(/reaches nobody/);
  });
});

describe('expiryAlerts — escalating, and never silent after the date', () => {
  it('says nothing while the licence is comfortably valid', () => {
    expect(expiryAlerts([obligation({ expiresOn: '2027-01-01' })], TODAY)).toEqual([]);
  });

  it('raises notice, warning and critical as the date approaches', () => {
    const levels = ['2026-10-15', '2026-09-15', '2026-08-10'].map(
      (expiresOn) => expiryAlerts([obligation({ expiresOn })], TODAY)[0]?.level,
    );
    expect(levels).toEqual(['notice', 'warning', 'critical']);
  });

  it('keeps shouting after it has expired — that is when systems go quiet', () => {
    const alert = expiryAlerts([obligation({ expiresOn: '2026-07-01' })], TODAY)[0];
    expect(alert?.level).toBe('expired');
    expect(alert?.daysRemaining).toBe(-33);
    expect(alert?.message).toContain('EXPIRED 33 days ago');
    expect(alert?.message).toContain('Priya must renew it now');
  });

  it('points every alert at a person by name (acceptance)', () => {
    const alert = expiryAlerts([obligation({ expiresOn: '2026-08-20' })], TODAY)[0];
    expect(alert?.responsible.name).toBe('Priya');
    expect(alert?.message).toContain('Priya');
  });

  it('escalates to the deputy once inside the escalation window', () => {
    const early = expiryAlerts([obligation({ expiresOn: '2026-08-20' })], TODAY)[0];
    expect(early?.escalatedToUserId).toBeUndefined();

    const late = expiryAlerts([obligation({ expiresOn: '2026-08-06' })], TODAY)[0];
    expect(late?.escalatedToUserId).toBe('u-owner');
  });

  it('orders the list worst-first, so it is read in the right order', () => {
    const alerts = expiryAlerts(
      [
        obligation({ obligationId: 'a', expiresOn: '2026-08-25' }),
        obligation({ obligationId: 'b', expiresOn: '2026-06-01' }),
        obligation({ obligationId: 'c', expiresOn: '2026-08-10' }),
      ],
      TODAY,
    );
    expect(alerts.map((a) => a.obligationId)).toEqual(['b', 'c', 'a']);
  });

  it('takes the tenant’s own thresholds', () => {
    const tight = expiryAlerts([obligation({ expiresOn: '2026-10-15' })], TODAY, {
      ...DEFAULT_ALERT_POLICY,
      noticeDays: 30,
    });
    expect(tight).toEqual([]);
  });

  it('flags an obligation with nothing on file to show an inspector', () => {
    const alert = expiryAlerts([obligation({ expiresOn: '2026-08-20', evidence: [] })], TODAY)[0];
    expect(alert?.evidenceMissing).toBe(true);
    expect(missingEvidence([obligation({ evidence: [] })])).toHaveLength(1);
    expect(missingEvidence([obligation()])).toHaveLength(0);
  });

  it('ignores an obligation with no expiry, and a closed one', () => {
    expect(expiryAlerts([obligation({ expiresOn: undefined })], TODAY)).toEqual([]);
    const closed = closeObligation(obligation({ expiresOn: '2026-06-01' }), 'branch shut', TODAY);
    expect(expiryAlerts([closed], TODAY)).toEqual([]);
  });
});

describe('closing and evidence — nothing is ever deleted (hard rule #6)', () => {
  it('closes an obligation with a reason, keeping the whole record', () => {
    const closed = closeObligation(obligation(), 'scale sold, no longer stamped', TODAY);
    expect(closed.status).toBe('closed');
    expect(closed.closedReason).toBe('scale sold, no longer stamped');
    expect(closed.closedAt).toBe(TODAY);
    // Everything about it is still there — the register is a history, not a to-do list.
    expect(closed.name).toBe('FSSAI food licence');
    expect(closed.evidence).toHaveLength(1);
  });

  it('refuses to close without a reason — the only way out is an explanation', () => {
    expect(() => closeObligation(obligation(), '   ', TODAY)).toThrow(CannotDeleteObligationError);
  });

  it('adds evidence without replacing what was already on file', () => {
    const updated = attachEvidence(obligation(), {
      evidenceId: 'e2',
      description: 'Renewal receipt',
      recordedAt: '2026-08-03T09:00:00Z',
    });
    expect(updated.evidence).toHaveLength(2);
    expect(updated.evidence?.[0]?.evidenceId).toBe('e1');
  });
});

describe('isCompliant — the one-line answer for the branch', () => {
  it('is true when everything is in date, false the day one lapses', () => {
    expect(isCompliant([obligation()], TODAY)).toBe(true);
    expect(isCompliant([obligation({ expiresOn: '2026-08-02' })], TODAY)).toBe(false);
  });

  it('scopes to a branch, and ignores obligations that were closed', () => {
    const lapsedElsewhere = obligation({ obligationId: 'x', branchId: 'b2', expiresOn: '2026-01-01' });
    expect(isCompliant([obligation(), lapsedElsewhere], TODAY, 'b1')).toBe(true);
    expect(isCompliant([obligation(), lapsedElsewhere], TODAY, 'b2')).toBe(false);
    expect(isCompliant([closeObligation(lapsedElsewhere, 'closed branch', TODAY)], TODAY, 'b2')).toBe(
      true,
    );
  });
});
