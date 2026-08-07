import { describe, it, expect } from 'vitest';
import * as caseModule from '../../packages/service-desk/src/service-cases';
import {
  assessSla,
  assessFirstResponse,
  grantCompensation,
  approveDraft,
  serviceReport,
  type ServiceCase,
  type AiDraft,
} from '../../packages/service-desk/src/service-cases';

// M21-FR-03 acceptance: "a compensation NEEDS A SEPARATE APPROVER; a complaint follows
// SLA; AN AI-DRAFTED REPLY IS NOT SENT UNTIL A HUMAN APPROVES." M21-FR-04: "an SLA breach
// escalates and is visible."

const CASE: ServiceCase = {
  caseId: 'CASE-1',
  tenantId: 't-1',
  kind: 'complaint',
  customerRef: 'c-1',
  openedAt: '2026-08-04T09:00:00Z',
  assignedTo: 'u-agent',
  priority: 'normal',
  state: 'open',
  summary: 'Delivered milk was sour',
  orderRef: 'O-4471',
};

describe('the SLA clock pauses while the shop waits on the customer (M21-FR-04)', () => {
  it('reports time remaining while inside the target', () => {
    const view = assessSla({ serviceCase: CASE, now: '2026-08-04T12:00:00Z' });
    expect(view.status).toBe('within');
    expect(view.elapsedMinutes).toBe(180);
    expect(view.targetMinutes).toBe(4_320);
  });

  it('flags at risk before it breaches', () => {
    const view = assessSla({
      serviceCase: { ...CASE, priority: 'urgent' },
      now: '2026-08-04T12:20:00Z', // 200 of 240 minutes
    });
    expect(view.status).toBe('at_risk');
    expect(view.shouldEscalate).toBe(false);
  });

  it('ESCALATES A BREACH VISIBLY rather than leaving it amber in a queue', () => {
    const view = assessSla({ serviceCase: { ...CASE, priority: 'urgent' }, now: '2026-08-04T14:00:00Z' });
    expect(view.status).toBe('breached');
    expect(view.shouldEscalate).toBe(true);
    expect(view.detail).toContain('a breach that sits in a queue is a breach nobody owns');
  });

  it('EXCLUDES TIME WAITING ON THE CUSTOMER — otherwise every slow photo is our failure', () => {
    const waited = assessSla({
      serviceCase: { ...CASE, priority: 'urgent', waitingOnCustomerMinutes: 3_000 },
      now: '2026-08-06T12:00:00Z', // 51 hours gross
    });
    // 3060 gross − 3000 waiting = 60 working minutes, inside the 240-minute target.
    expect(waited.elapsedMinutes).toBe(60);
    expect(waited.status).toBe('within');

    const notWaited = assessSla({
      serviceCase: { ...CASE, priority: 'urgent' },
      now: '2026-08-06T12:00:00Z',
    });
    expect(notWaited.status).toBe('breached');
  });

  it('records whether a resolved case met its target, and stops escalating', () => {
    const met = assessSla({
      serviceCase: { ...CASE, state: 'resolved', resolvedAt: '2026-08-04T11:00:00Z' },
      now: '2026-08-10T00:00:00Z',
    });
    expect(met.status).toBe('met');
    expect(met.shouldEscalate).toBe(false);
    expect(met.detail).toContain('resolved in 120 working minutes');

    const late = assessSla({
      serviceCase: { ...CASE, priority: 'urgent', state: 'resolved', resolvedAt: '2026-08-04T18:00:00Z' },
      now: '2026-08-10T00:00:00Z',
    });
    expect(late.status).toBe('breached');
    expect(late.shouldEscalate).toBe(false);
  });

  it('uses the tenant\'s own targets', () => {
    const view = assessSla({
      serviceCase: CASE,
      now: '2026-08-04T10:00:00Z',
      policy: { resolutionMinutes: { normal: 30 } },
    });
    expect(view.status).toBe('breached');
  });
});

describe('first response is a different promise from resolution (M21-FR-04)', () => {
  it('SEPARATES the wait a customer feels from slow resolution', () => {
    // Resolution target for an urgent case is 240 minutes; first response is 30.
    const unanswered = { ...CASE, priority: 'urgent' as const };
    const at60 = '2026-08-04T10:00:00Z';

    // Comfortably inside the resolution target...
    expect(assessSla({ serviceCase: unanswered, now: at60 }).status).toBe('within');
    // ...and already a first-response breach, which is what the customer notices.
    const response = assessFirstResponse({ serviceCase: unanswered, now: at60 });
    expect(response.status).toBe('breached');
    expect(response.shouldEscalate).toBe(true);
    expect(response.detail).toContain('this is the wait a customer actually feels');
  });

  it('records a first reply that landed inside the target', () => {
    const view = assessFirstResponse({
      serviceCase: { ...CASE, priority: 'urgent', firstRespondedAt: '2026-08-04T09:20:00Z' },
      now: '2026-08-06T00:00:00Z',
    });
    expect(view.status).toBe('met');
    expect(view.elapsedMinutes).toBe(20);
    expect(view.shouldEscalate).toBe(false);
  });

  it('records a late first reply by how much longer the customer waited', () => {
    const view = assessFirstResponse({
      serviceCase: { ...CASE, priority: 'urgent', firstRespondedAt: '2026-08-04T11:00:00Z' },
      now: '2026-08-06T00:00:00Z',
    });
    expect(view.status).toBe('breached');
    expect(view.detail).toContain('waited 90 minutes longer than promised');
  });

  it('does NOT pause the first-response clock for the customer — we have not spoken yet', () => {
    const view = assessFirstResponse({
      serviceCase: { ...CASE, priority: 'urgent', waitingOnCustomerMinutes: 5_000 },
      now: '2026-08-04T11:00:00Z',
    });
    expect(view.elapsedMinutes).toBe(120);
    expect(view.status).toBe('breached');
  });

  it('honours the tenant\'s own first-response target', () => {
    const view = assessFirstResponse({
      serviceCase: CASE,
      now: '2026-08-04T09:20:00Z',
      policy: { firstResponseMinutes: { normal: 10 } },
    });
    expect(view.status).toBe('breached');
  });
});

describe('compensation is money leaving the business (§28)', () => {
  const base = {
    serviceCase: CASE,
    kind: 'goodwill_credit' as const,
    grantedBy: 'u-agent',
    reason: 'sour milk delivered, customer inconvenienced',
    agentAuthorityMinor: 20_000,
    at: '2026-08-04T10:00:00Z',
  };

  it('lets an agent act within their own authority — with a reason', () => {
    const result = grantCompensation({ ...base, amountMinor: 15_000 });
    expect(result.granted).toBe(true);
    expect(result.detail).toContain('within their own authority');
  });

  it('DEMANDS A REASON even below the authority limit', () => {
    const result = grantCompensation({ ...base, amountMinor: 5_000, reason: '   ' });
    expect(result.granted).toBe(false);
    expect(result.detail).toContain('"goodwill" explains nothing three months later');
  });

  it('NEEDS A SEPARATE APPROVER above the agent\'s authority', () => {
    const unapproved = grantCompensation({ ...base, amountMinor: 50_000 });
    expect(unapproved.granted).toBe(false);
    expect(unapproved.outcome).toBe('needs_approval');

    const selfApproved = grantCompensation({
      ...base,
      amountMinor: 50_000,
      approval: { subjectRef: 'CASE-1', status: 'approved', decidedBy: 'u-agent', reason: 'angry customer' },
    });
    expect(selfApproved.outcome).toBe('self_approved');

    const proper = grantCompensation({
      ...base,
      amountMinor: 50_000,
      approval: { subjectRef: 'CASE-1', status: 'approved', decidedBy: 'u-manager', reason: 'repeat complaint' },
    });
    expect(proper.granted).toBe(true);
    expect(proper.approvedBy).toBe('u-manager');
  });

  it('refuses above the tenant\'s absolute ceiling, whoever approves', () => {
    const result = grantCompensation({
      ...base,
      amountMinor: 900_000,
      policyCapMinor: 200_000,
      approval: { subjectRef: 'CASE-1', status: 'approved', decidedBy: 'u-manager', reason: 'very angry' },
    });
    expect(result.granted).toBe(false);
    expect(result.detail).toContain('a management decision, not a desk one');
  });
});

describe('AI drafts, a human sends (hard rule #5)', () => {
  const DRAFT: AiDraft = {
    draftId: 'DR-1',
    caseId: 'CASE-1',
    text: 'We are sorry the milk was sour. We have refunded it and added a credit to your account.',
    modelRef: 'gw/model-a',
    generatedAt: '2026-08-04T09:30:00Z',
    evidenceRefs: ['CASE-1', 'O-4471'],
    approved: false,
  };

  it('EXPORTS NOTHING THAT SENDS AN UNAPPROVED DRAFT — the absence is the control', () => {
    const api = Object.keys(caseModule);
    expect(api.filter((n) => /^send|autoSend|dispatchDraft|autoReply/i.test(n))).toEqual([]);
    expect(api).toContain('approveDraft');
  });

  it('makes a draft sendable only through a named human', () => {
    const approved = approveDraft({ draft: DRAFT, decision: 'approved', approvedBy: 'u-agent', at: '2026-08-04T09:40:00Z' });
    expect(approved.sendable).toBe(true);
    if (!approved.sendable) throw new Error('unreachable');
    expect(approved.approvedBy).toBe('u-agent');
    expect(approved.modelRef).toBe('gw/model-a');
  });

  it('REFUSES an unnamed approver', () => {
    const result = approveDraft({ draft: DRAFT, decision: 'approved', approvedBy: '  ', at: 'x' });
    expect(result.sendable).toBe(false);
    if (result.sendable) throw new Error('unreachable');
    expect(result.detail).toContain("a model does not answer a customer on the shop's behalf");
  });

  it('refuses a draft that cites no evidence — there is nothing to check it against', () => {
    const result = approveDraft({
      draft: { ...DRAFT, evidenceRefs: [] },
      decision: 'approved', approvedBy: 'u-agent', at: 'x',
    });
    expect(result.sendable).toBe(false);
  });

  it('records an EDIT as an edit, so the shop can see how often the model is rewritten', () => {
    const edited = approveDraft({
      draft: DRAFT,
      decision: 'edited_and_approved',
      finalText: 'We are sorry. We have refunded the milk. No credit has been added.',
      approvedBy: 'u-agent',
      at: '2026-08-04T09:45:00Z',
    });
    expect(edited.sendable).toBe(true);
    if (!edited.sendable) throw new Error('unreachable');
    expect(edited.decision).toBe('edited_and_approved');
    expect(edited.text).toContain('No credit has been added');
  });

  it('refuses a rejected draft and an empty edit', () => {
    expect(approveDraft({ draft: DRAFT, decision: 'rejected', approvedBy: 'u-agent', at: 'x' }).sendable).toBe(false);
    expect(
      approveDraft({ draft: DRAFT, decision: 'edited_and_approved', finalText: '   ', approvedBy: 'u-agent', at: 'x' }).sendable,
    ).toBe(false);
  });
});

describe('CSAT is reported with its response rate', () => {
  it('states how few people actually replied', () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({ ...CASE, caseId: `C-${i}`, state: 'resolved' as const }));
    const report = serviceReport({
      cases,
      slaViews: [
        { caseId: 'C-1', status: 'breached', elapsedMinutes: 9_000, targetMinutes: 4_320, remainingMinutes: -4_680, shouldEscalate: true, detail: '' },
      ],
      scores: [
        { caseId: 'C-1', customerRef: 'c-1', score: 5, at: 'x' },
        { caseId: 'C-2', customerRef: 'c-2', score: 4, at: 'x' },
      ],
      firstResponseViews: [
        { caseId: 'C-3', status: 'breached', elapsedMinutes: 900, targetMinutes: 480, remainingMinutes: -420, shouldEscalate: true, detail: '' },
        { caseId: 'C-4', status: 'met', elapsedMinutes: 20, targetMinutes: 480, remainingMinutes: 460, shouldEscalate: false, detail: '' },
      ],
    });
    expect(report.cases).toBe(20);
    expect(report.resolved).toBe(20);
    expect(report.breached).toBe(1);
    expect(report.breachedValue).toEqual(['C-1']);
    // Counted separately: slow to resolve and never answered are different failures.
    expect(report.firstResponseBreached).toBe(1);
    expect(report.detail).toContain('1 never answered in time');
    expect(report.csatHundredths).toBe(450); // 4.50
    expect(report.responseRateBps).toBe(1_000); // 10%
    expect(report.detail).toContain('the ones who reply are rarely the ones who left quietly');
  });

  it('says "no responses" rather than reporting a score of zero', () => {
    const report = serviceReport({ cases: [CASE], slaViews: [], scores: [] });
    expect(report.csatHundredths).toBe('no_responses');
    expect(report.detail).toContain('no satisfaction responses yet');
  });

  it('handles an empty desk without dividing by zero', () => {
    const report = serviceReport({ cases: [], slaViews: [], scores: [] });
    expect(report.responseRateBps).toBe('not_meaningful');
  });
});
