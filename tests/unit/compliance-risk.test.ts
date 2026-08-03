import { describe, it, expect } from 'vitest';
import {
  recordIncident,
  recordRemediation,
  acceptRisk,
  blockedGates,
  gateCanPass,
  controlHealth,
  overdueRemediations,
  UnlinkedIncidentError,
  UnownedRemediationError,
  UnjustifiedAcceptanceError,
  type Attestation,
  type Control,
  type Incident,
  type Remediation,
  type Risk,
} from '../../packages/compliance/src/index';

// M34-FR-04 — the registers exist so that when something goes wrong you can answer
// three questions at once: which control failed, who is fixing it, and did anyone
// ever check the control worked.

const TODAY = '2026-08-03';

const CONTROLS: Control[] = [
  { controlId: 'c-sod', title: 'Separation of duties on refunds', implements: '§28', ownerUserId: 'u-mgr' },
  { controlId: 'c-backup', title: 'Nightly verified backup', implements: 'QG-08', ownerUserId: 'u-it' },
];

function incident(over: Partial<Incident> = {}): Incident {
  return {
    incidentId: 'inc-1',
    title: 'Cashier approved own refund',
    severity: 'sev2',
    occurredAt: '2026-07-20T18:00:00Z',
    detectedAt: '2026-07-21T09:00:00Z',
    controlId: 'c-sod',
    ...over,
  };
}

function risk(over: Partial<Risk> = {}): Risk {
  return {
    riskId: 'r-1',
    title: 'Refund fraud at the till',
    severity: 'critical',
    status: 'open',
    controlIds: ['c-sod'],
    ownerUserId: 'u-mgr',
    blocksGates: ['QG-06'],
    ...over,
  };
}

describe('recordIncident — every incident names the control it defeated', () => {
  it('accepts an incident linked to a real control', () => {
    expect(recordIncident(incident(), CONTROLS).controlId).toBe('c-sod');
  });

  it('refuses one that links to nothing — it would teach nothing', () => {
    expect(() => recordIncident(incident({ controlId: 'c-ghost' }), CONTROLS)).toThrow(
      UnlinkedIncidentError,
    );
  });
});

describe('recordRemediation — an owner and a date, or it is a wish', () => {
  const remediation: Remediation = {
    remediationId: 'rem-1',
    incidentId: 'inc-1',
    action: 'Enforce approver ≠ raiser in the refund flow',
    ownerUserId: 'u-dev',
    dueOn: '2026-07-31',
  };

  it('accepts remediation with an owner and a due date', () => {
    expect(recordRemediation(remediation).ownerUserId).toBe('u-dev');
  });

  it('refuses remediation with no owner or no date', () => {
    expect(() => recordRemediation({ ...remediation, ownerUserId: '  ' })).toThrow(
      UnownedRemediationError,
    );
    expect(() => recordRemediation({ ...remediation, dueOn: '' })).toThrow(/not a plan/);
  });

  it('reports what is late and still not done', () => {
    const late = overdueRemediations(
      [remediation, { ...remediation, remediationId: 'rem-2', dueOn: '2026-09-30' }],
      TODAY,
    );
    expect(late.map((r) => r.remediationId)).toEqual(['rem-1']);

    const done = overdueRemediations([{ ...remediation, completedAt: '2026-07-30T10:00:00Z' }], TODAY);
    expect(done).toEqual([]);
  });
});

describe('risk acceptance and the quality gates', () => {
  it('an open critical risk blocks its gate (M34-FR-04 acceptance)', () => {
    const blocks = blockedGates([risk()]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.gate).toBe('QG-06');
    expect(blocks[0]?.reason).toContain('u-mgr owns it');
    expect(gateCanPass('QG-06', [risk()])).toBe(false);
    expect(gateCanPass('QG-08', [risk()])).toBe(true);
  });

  it('a non-critical or already-mitigated risk does not block anything', () => {
    expect(blockedGates([risk({ severity: 'high' })])).toEqual([]);
    expect(blockedGates([risk({ status: 'mitigated' })])).toEqual([]);
  });

  it('an accepted risk stops blocking — because acceptance is a signed decision', () => {
    const accepted = acceptRisk(risk(), 'u-owner', 'Compensating manual check until R3');
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedBy).toBe('u-owner');
    expect(gateCanPass('QG-06', [accepted])).toBe(true);
  });

  it('refuses to accept a risk anonymously or without a reason', () => {
    expect(() => acceptRisk(risk(), '', 'because')).toThrow(UnjustifiedAcceptanceError);
    expect(() => acceptRisk(risk(), 'u-owner', '   ')).toThrow(/decisions have authors/);
  });
});

describe('controlHealth — has anyone actually checked this works?', () => {
  const ATTESTATIONS: Attestation[] = [
    {
      attestationId: 'att-1',
      controlId: 'c-sod',
      attestedBy: 'u-mgr',
      attestedAt: '2026-07-01T10:00:00Z',
      statement: 'Tested with a dummy refund; approver ≠ raiser enforced',
    },
  ];

  it('counts the incidents a control failed to hold, and the late fixes', () => {
    const health = controlHealth({
      controls: CONTROLS,
      incidents: [incident(), incident({ incidentId: 'inc-2' })],
      remediations: [
        { remediationId: 'rem-1', incidentId: 'inc-1', action: 'fix', ownerUserId: 'u-dev', dueOn: '2026-07-31' },
      ],
      attestations: ATTESTATIONS,
      asOfDate: TODAY,
      attestationValidDays: 90,
    });
    const sod = health.find((h) => h.controlId === 'c-sod');
    expect(sod?.incidentCount).toBe(2);
    expect(sod?.overdueRemediations).toBe(1);
    expect(sod?.lastAttestedAt).toBe('2026-07-01T10:00:00Z');
    expect(sod?.needsAttestation).toBe(false);
  });

  it('says plainly when a control has never been checked by anyone', () => {
    const health = controlHealth({
      controls: CONTROLS,
      incidents: [],
      remediations: [],
      attestations: ATTESTATIONS,
      asOfDate: TODAY,
      attestationValidDays: 90,
    });
    const backup = health.find((h) => h.controlId === 'c-backup');
    // An untested control is an assumption, not a control.
    expect(backup?.lastAttestedAt).toBeUndefined();
    expect(backup?.needsAttestation).toBe(true);
  });

  it('treats an attestation older than the tenant’s window as stale', () => {
    const health = controlHealth({
      controls: CONTROLS,
      incidents: [],
      remediations: [],
      attestations: ATTESTATIONS,
      asOfDate: TODAY,
      attestationValidDays: 20, // 1 July is more than 20 days ago
    });
    expect(health.find((h) => h.controlId === 'c-sod')?.needsAttestation).toBe(true);
  });
});
