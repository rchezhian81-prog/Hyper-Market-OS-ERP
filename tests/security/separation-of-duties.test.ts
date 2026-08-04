import { describe, it, expect } from 'vitest';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/approvals';
import {
  grantDelegation, decideWithDelegation, effectiveAuthority, type Delegation,
} from '../../packages/approvals/src/delegation';
import { signControlTotal, type ControlTotal } from '../../packages/migration/src/reconcile';
import { proposeExclusion, approveExclusion } from '../../packages/migration/src/history';
import { activateKillSwitch, liftKillSwitch } from '../../packages/ai/src/budget';
import { commitProposal, reviewProposals } from '../../packages/ai/src/authority';

// SEC-03, §28 — separation of duties, swept across the WHOLE product rather than per module.
//
// Every module here has its own maker-cannot-be-checker test, and each of those proves the rule
// holds in one place. **None of them proves it holds everywhere**, and "everywhere" is the only
// interesting claim: a control that is enforced in eight of nine places is a control an attacker
// finds the ninth of. The ninth is never the obvious one — it is the module written last, by
// somebody in a hurry, where the check reads as bureaucracy because the maker is the owner and
// there is nobody else in the building at nine at night.
//
// So this file collects every place in the product where one person could otherwise authorise
// their own act, and asserts the refusal in one list. A new module that adds a ninth is a line
// added here, and a reviewer can see whether it was.

const AT = '2026-08-07T09:00:00Z';

/**
 * One row per place in the product where self-authorisation must be refused.
 *
 * The shape is deliberate: each entry runs the SAME act twice — once with two people, once with
 * one — so the test proves the refusal is about the identity and not about the call failing for
 * some unrelated reason. A refusal that would have happened anyway is not a control.
 */
const SELF_AUTHORISATION_ATTEMPTS: readonly {
  readonly what: string;
  readonly requirement: string;
  /** Two different people: must succeed. */
  readonly withTwoPeople: () => boolean;
  /** The same person on both sides: must be refused. */
  readonly withOnePerson: () => boolean;
}[] = [
  {
    what: 'approving your own approval request',
    requirement: '§28 / M02-FR-03',
    withTwoPeople: () => {
      const request = requestApproval({
        id: 'ap-1', subjectType: 'price_change', subjectRef: 'p-1',
        requestedBy: 'u-maker', branchId: 'br-main', value: money(50_000, 'INR'),
      });
      const approver: Approver = { userId: 'u-checker', branchScope: 'all', authorityLimit: null };
      return decide(request, approver, 'approved', 'checked against the supplier list', AT).ok;
    },
    withOnePerson: () => {
      const request = requestApproval({
        id: 'ap-2', subjectType: 'price_change', subjectRef: 'p-1',
        requestedBy: 'u-maker', branchId: 'br-main', value: money(50_000, 'INR'),
      });
      const approver: Approver = { userId: 'u-maker', branchScope: 'all', authorityLimit: null };
      return decide(request, approver, 'approved', 'checked against the supplier list', AT).ok;
    },
  },
  {
    what: 'signing a migration control total you loaded yourself',
    requirement: 'MG-06 / QG-07 / §28',
    withTwoPeople: () => signControlTotal({
      totals: [controlTotal()], totalId: 'ct-1', signedBy: 'u-checker', signerRole: 'store_manager',
      loadOperator: 'u-maker', statement: 'agreed to the legacy report', now: AT,
    }).ok,
    withOnePerson: () => signControlTotal({
      totals: [controlTotal()], totalId: 'ct-1', signedBy: 'u-maker', signerRole: 'store_manager',
      loadOperator: 'u-maker', statement: 'agreed to the legacy report', now: AT,
    }).ok,
  },
  {
    what: 'approving a migration exclusion you proposed yourself',
    requirement: 'MG-07 / OD-05',
    withTwoPeople: () => approveExclusion({
      exclusion: exclusion('u-maker'), decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
      ownerStatement: 'agreed — the CA confirms those years are closed', now: AT,
    }).ok,
    withOnePerson: () => approveExclusion({
      exclusion: exclusion('u-owner'), decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
      ownerStatement: 'agreed — the CA confirms those years are closed', now: AT,
    }).ok,
  },
  {
    what: 'lifting an AI kill switch you pulled yourself',
    requirement: 'Stage 17 / §28',
    withTwoPeople: () => liftKillSwitch({ killSwitch: killSwitch(), liftedBy: 'u-owner', at: AT }).lifted,
    withOnePerson: () => liftKillSwitch({ killSwitch: killSwitch(), liftedBy: 'u-maker', at: AT }).lifted,
  },
  {
    what: 'granting yourself a delegation of authority',
    requirement: '§28 / M02-FR-03',
    withTwoPeople: () => grantDelegation({
      delegation: delegation({ delegationId: 'dg-1', authorisedBy: 'u-custodian' }),
      granter: { userId: 'u-manager', branchScope: 'all', authorityLimit: money(100_000, 'INR') },
      today: '2026-08-07',
    }).created,
    withOnePerson: () => grantDelegation({
      // The granter signing off their own loan of authority.
      delegation: delegation({ delegationId: 'dg-2', authorisedBy: 'u-manager' }),
      granter: { userId: 'u-manager', branchScope: 'all', authorityLimit: money(100_000, 'INR') },
      today: '2026-08-07',
    }).created,
  },
];

function controlTotal(): ControlTotal {
  return {
    totalId: 'ct-1', tenantId: 't-1', kind: 'stock', name: 'Stock value', unit: 'minor_currency',
    legacyValue: 84_120_000, loadedValue: 84_120_000,
    legacyDerivation: 'SUM(value) over the sealed legacy stock extract',
    loadedDerivation: 'SUM(value) projected from loaded opening stock events',
  };
}

function exclusion(proposedBy: string) {
  return proposeExclusion({
    exclusionId: 'exc-1', tenantId: 't-1', scope: 'documents_before',
    description: 'Documents before the 2020 rate revision', recordCount: 18_400, valueMinor: 1_240_000,
    reason: 'their tax was struck under a superseded rate table and restating it rewrites filed returns',
    proposedBy, now: '2026-08-06T09:00:00Z',
  }).exclusion!;
}

function delegation(over: Partial<Delegation> = {}): Delegation {
  return {
    delegationId: 'dg-1', fromUserId: 'u-manager', toUserId: 'u-supervisor',
    fromDate: '2026-08-10', untilDate: '2026-08-20', subjectTypes: ['price_change'],
    valueCap: money(20_000, 'INR'), reason: 'covering annual leave',
    authorisedBy: 'u-custodian', ...over,
  };
}

function killSwitch() {
  return activateKillSwitch({
    switchId: 'ks-1', tenantId: 't-1', scope: 'customer_facing',
    reason: 'the shopping assistant is quoting the wrong return policy',
    activatedBy: 'u-maker', existing: [],
    customerFacingAgents: ['A04', 'A05'], allAgents: ['A01', 'A02', 'A03', 'A04', 'A05'],
    at: '2026-08-06T20:00:00Z',
  }).killSwitch!;
}

describe('one person can never authorise their own act, anywhere in the product', () => {
  it('refuses self-authorisation in EVERY place it is possible to attempt it', () => {
    const leaks: string[] = [];
    for (const attempt of SELF_AUTHORISATION_ATTEMPTS) {
      if (attempt.withOnePerson()) {
        leaks.push(`${attempt.what} (${attempt.requirement}) was ALLOWED with one person`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('and allows every one of them when two people are involved', () => {
    // Without this half, a module that simply refuses everything would pass the sweep above —
    // and a control that blocks the legitimate path gets switched off within a fortnight.
    const broken: string[] = [];
    for (const attempt of SELF_AUTHORISATION_ATTEMPTS) {
      if (!attempt.withTwoPeople()) {
        broken.push(`${attempt.what} (${attempt.requirement}) was REFUSED even with two people`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('covers every module where the product currently permits an authorisation', () => {
    // A ninth place is a line added here. If a module is built that authorises something and this
    // list does not grow, that is the module an attacker finds.
    const requirements = new Set(SELF_AUTHORISATION_ATTEMPTS.map((a) => a.requirement));
    expect(SELF_AUTHORISATION_ATTEMPTS.length).toBeGreaterThanOrEqual(5);
    expect(requirements.size).toBeGreaterThanOrEqual(4);
  });
});

describe('seniority is not a bypass', () => {
  it('refuses the OWNER approving their own delegation — the hardest case to argue with', () => {
    // On a single-owner business the temptation to collapse the two roles is constant, and the
    // argument is always reasonable: there is nobody else at nine at night. The refusal has to
    // hold precisely there, or it holds nowhere.
    const r = grantDelegation({
      delegation: delegation({
        delegationId: 'dg-owner', fromUserId: 'u-owner', toUserId: 'u-manager',
        subjectTypes: ['refund'], reason: 'I am away for a fortnight', authorisedBy: 'u-owner',
      }),
      granter: { userId: 'u-owner', branchScope: 'all', authorityLimit: null },
      today: '2026-08-07',
    });
    expect(r.created).toBe(false);
  });

  it('refuses the owner signing a TAX total — only the CA may, however senior (M23 / C-01)', () => {
    const tax: ControlTotal = { ...controlTotal(), totalId: 'ct-tax', kind: 'tax', name: 'Output tax' };
    expect(signControlTotal({
      totals: [tax], totalId: 'ct-tax', signedBy: 'u-owner', signerRole: 'owner',
      loadOperator: 'u-operator', statement: 'fine', now: AT,
    }).ok).toBe(false);
  });

  it('refuses a manager approving a migration exclusion — that one is the owner\'s (OD-05)', () => {
    expect(approveExclusion({
      exclusion: exclusion('u-operator'), decidedBy: 'u-manager', decidedByIsOwner: false,
      approve: true, ownerStatement: 'fine by me', now: AT,
    }).ok).toBe(false);
  });
});

describe('a delegation is not a way around the rule', () => {
  it('refuses a delegation FROM the maker used to approve the maker\'s own request', () => {
    // The subtle one: the maker delegates their authority to a colleague, who then approves the
    // maker's request using it. Two names appear in the record and it is still one decision —
    // a self-approval with an extra step.
    const granted = grantDelegation({
      delegation: delegation({
        delegationId: 'dg-loop', fromUserId: 'u-maker', toUserId: 'u-friend',
        fromDate: '2026-08-01', untilDate: '2026-08-20',
        reason: 'covering while I am on the shop floor',
      }),
      granter: { userId: 'u-maker', branchScope: 'all', authorityLimit: money(50_000, 'INR') },
      today: '2026-07-31',
    });
    expect(granted.created).toBe(true);

    const authority = effectiveAuthority({
      userId: 'u-friend', subjectType: 'price_change',
      delegations: [granted.delegation!], today: '2026-08-07',
    });
    expect(authority.onBehalfOf).toBe('u-maker');

    const request = requestApproval({
      id: 'ap-loop', subjectType: 'price_change', subjectRef: 'p-9',
      requestedBy: 'u-maker', branchId: 'br-main', value: money(15_000, 'INR'),
    });
    const outcome = decideWithDelegation({
      request, decidedBy: 'u-friend', decision: 'approved',
      reason: 'looks right to me', authority, at: AT,
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('the AI never becomes the second person', () => {
  it('refuses an agent as the approver of its own proposal', () => {
    // The cheapest possible bypass of separation of duties is a second "identity" that is not a
    // person. Hard rule #5 and AI-NFR-12: the human is the actor, the agent is the drafter.
    const reviews = reviewProposals({
      agentId: 'A03',
      proposals: [{ tool: 'suggest_markdown', arguments: { productId: 'p-1', percent: 30 }, rationale: 'expiring' }],
      grantedTools: ['suggest_markdown'],
      verifiedCitations: ['ev-stock'],
    });
    expect(reviews[0]?.accepted).toBe(true);

    // Named as an agent identity: refused as an agent, by name.
    const byAgent = commitProposal({
      proposalId: 'prop-1', agentId: 'A03', tool: 'suggest_markdown', review: reviews[0]!,
      approvedBy: 'A03', approverRole: 'manager',
      agentIdentities: ['A01', 'A02', 'A03', 'A04', 'A05'],
      proposedAt: '2026-08-07T09:00:00Z', at: '2026-08-07T09:05:00Z',
    });
    expect(byAgent.committed).toBe(false);
    expect(byAgent.outcome).toBe('agent_cannot_approve');
    expect(byAgent.detail).toContain('no identity in this system is both a drafter and an approver');

    // And when the caller FORGETS to supply the agent-identity list — which is the realistic
    // mistake, since it is an optional parameter — the role check still refuses it. Two
    // independent barriers, so forgetting one does not open the door.
    const listForgotten = commitProposal({
      proposalId: 'prop-1b', agentId: 'A03', tool: 'suggest_markdown', review: reviews[0]!,
      approvedBy: 'A03', approverRole: 'agent_supervisor',
      proposedAt: '2026-08-07T09:00:00Z', at: '2026-08-07T09:05:00Z',
    });
    expect(listForgotten.committed).toBe(false);
    expect(listForgotten.outcome).toBe('approver_wrong_role');

    const byPerson = commitProposal({
      proposalId: 'prop-2', agentId: 'A03', tool: 'suggest_markdown', review: reviews[0]!,
      approvedBy: 'u-manager', approverRole: 'manager',
      proposedAt: '2026-08-07T09:00:00Z', at: '2026-08-07T09:05:00Z',
    });
    expect(byPerson.committed).toBe(true);
  });
});
