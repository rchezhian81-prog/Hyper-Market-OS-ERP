// Agent authority boundaries — A01…A10 (Stage 17 / AI-NFR-01…12 / §7.1 / §28 / P-05).
//
// **AI-NFR-12, absolute:** no autonomous payment, refund, purchase commitment, price change,
// stock adjustment or user-privilege change. The language model never writes directly to a
// business database.
//
// That rule is easy to write in a document and hard to keep in code, because the pressure runs
// one way: every quarter somebody has a good reason why *this* agent should just apply the
// markdown itself. So the rule is enforced structurally rather than by discipline:
//
//   • **FORBIDDEN TOOLS ARE A CLOSED LIST WITH NO OVERRIDE.** Not a per-agent setting, not a
//     tenant option, not a feature flag. A constant, checked on every grant, with an
//     absence-test proving no function exists that could add to an agent's tools at runtime.
//   • **AN AGENT'S TOOLS ARE AN ALLOWLIST.** Default-deny, like everything else here. A tool
//     nobody granted is not available, including one invented after this file was written.
//   • **EVERY WRITE PROPOSAL NEEDS A NAMED HUMAN**, and the human is recorded as the actor.
//     The agent is recorded as the *drafter*. An audit trail that says "the AI did it" is an
//     audit trail with nobody in it.
//   • **READ-ONLY MEANS READ-ONLY.** A01 (Owner Intelligence) proposes nothing at all in its
//     initial authority; it answers questions and drafts a brief. That is deliberate — the
//     agent closest to the owner is the one with the least power.
//
// Pure and deterministic: no I/O, no clock beyond what is injected.

import type { ToolProposal } from './gateway';

export type AgentId = 'A01' | 'A02' | 'A03' | 'A04' | 'A05' | 'A06' | 'A07' | 'A08' | 'A09' | 'A10';

export type ApprovalRole =
  | 'none'
  | 'owner'
  | 'buyer'
  | 'manager'
  | 'customer'
  | 'agent_supervisor'
  | 'operator'
  | 'security_officer'
  | 'data_steward'
  | 'marketing_approver';

export interface AgentDefinition {
  readonly agentId: AgentId;
  readonly name: string;
  /** Exactly what this agent may ask for. Default-deny: anything absent is refused. */
  readonly allowedTools: readonly string[];
  /** Who must approve before any proposal from this agent takes effect. */
  readonly approver: ApprovalRole;
  /** True when the agent may only read and answer — it proposes nothing. */
  readonly readOnly: boolean;
  /** Every answer must cite evidence. An uncited claim from an agent is refused. */
  readonly requiresEvidence: boolean;
  /** Faces people outside the business, so its inputs are untrusted by default. */
  readonly customerFacing: boolean;
  readonly purpose: string;
}

/**
 * Tools no agent may ever be granted (AI-NFR-12).
 *
 * **There is no override anywhere in this codebase** — not a flag, not a tenant setting, not a
 * parameter. `tests/unit/ai-authority.test.ts` reads the module's exports to prove no function
 * exists that could grant one.
 */
export const FORBIDDEN_TOOLS: readonly string[] = [
  'commit_payment',
  'issue_refund',
  'commit_purchase_order',
  'commit_price_change',
  'commit_stock_adjustment',
  'grant_privilege',
  'revoke_privilege',
  'delete_audit',
  'write_database',
  'execute_sql',
  'close_period',
  'approve_own_proposal',
];

/** The ten agents, in the roadmap's own authority order. */
export const AGENTS: Readonly<Record<AgentId, AgentDefinition>> = {
  A01: {
    agentId: 'A01',
    name: 'Owner Intelligence',
    // The agent closest to the owner has the LEAST power. Deliberate.
    allowedTools: ['read_kpi', 'read_sales_summary', 'read_margin_summary', 'read_cash_summary', 'draft_brief'],
    approver: 'none',
    readOnly: true,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'KPI questions, the daily brief, hypotheses and an action list — read-only initially',
  },
  A02: {
    agentId: 'A02',
    name: 'Purchase',
    allowedTools: ['read_stock_position', 'read_supplier_performance', 'read_price_history', 'draft_purchase_order', 'compare_quotations'],
    approver: 'buyer',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'forecast, reorder, quotation comparison and a DRAFT purchase order — a buyer commits it',
  },
  A03: {
    agentId: 'A03',
    name: 'Inventory',
    allowedTools: ['read_stock_position', 'read_expiry', 'read_movement_history', 'suggest_transfer', 'suggest_markdown'],
    approver: 'manager',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'stockout, overstock and expiry prediction; transfer and markdown SUGGESTIONS — a manager commits',
  },
  A04: {
    agentId: 'A04',
    name: 'Customer Shopping',
    allowedTools: ['search_catalogue', 'read_availability', 'suggest_alternatives', 'draft_cart'],
    approver: 'customer',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: true,
    purpose: 'search, list-to-cart and alternatives — the CUSTOMER confirms the cart',
  },
  A05: {
    agentId: 'A05',
    name: 'Service',
    allowedTools: ['read_policy', 'read_order_status', 'draft_case_response', 'escalate_case'],
    approver: 'agent_supervisor',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: true,
    purpose: 'policy and order answers, DRAFT case responses — exceptions escalate to a person',
  },
  A06: {
    agentId: 'A06',
    name: 'Operations',
    allowedTools: ['read_sync_status', 'read_dead_letters', 'read_integration_health', 'recommend_runbook'],
    approver: 'operator',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'explain sync and integration incidents and recommend a runbook — an OPERATOR executes it',
  },
  A07: {
    agentId: 'A07',
    name: 'Security and Fraud',
    allowedTools: ['read_fraud_signals', 'read_audit_summary', 'summarise_anomalies', 'prioritise_investigation'],
    approver: 'security_officer',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'summarise anomalies and prioritise investigation — NO autonomous sanctions, ever',
  },
  A08: {
    agentId: 'A08',
    name: 'Data Quality',
    allowedTools: ['read_master_data', 'read_import_history', 'detect_duplicates', 'suggest_mapping'],
    approver: 'data_steward',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'detect duplicates, missing attributes and suspicious mappings — a steward approves',
  },
  A09: {
    agentId: 'A09',
    name: 'Marketing',
    allowedTools: ['read_segments', 'read_consent', 'read_margin_summary', 'draft_campaign', 'draft_offer'],
    approver: 'marketing_approver',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'DRAFT segments, campaigns and offers within consent and margin — marketing approves',
  },
  A10: {
    agentId: 'A10',
    name: 'Workforce and SOP',
    allowedTools: ['read_sop', 'read_roster_gaps', 'read_task_list', 'guide_task'],
    approver: 'manager',
    readOnly: false,
    requiresEvidence: true,
    customerFacing: false,
    purpose: 'role-aware guidance and task assistance — NO HR decisions',
  },
};

export type GrantOutcome = 'granted' | 'agent_disabled' | 'tenant_disabled' | 'unknown_agent';

export interface ToolGrant {
  readonly agentId: AgentId;
  readonly granted: boolean;
  readonly outcome: GrantOutcome;
  /** Exactly the tools this call may offer the model. Never more. */
  readonly tools: readonly string[];
  readonly detail: string;
}

/**
 * What tools may this agent be offered on this call?
 *
 * The intersection of the agent's own allowlist and the tenant's entitlement — and then
 * **`FORBIDDEN_TOOLS` is subtracted regardless**, so even a definition edited badly in future
 * cannot smuggle one through. Belt, braces, and a third check at proposal time.
 */
export function grantTools(input: {
  readonly agentId: AgentId;
  readonly tenantEnabled: boolean;
  readonly agentEnabled: boolean;
  /** Tools this tenant has switched off, e.g. because they do not run deliveries. */
  readonly tenantDisabledTools?: readonly string[];
}): ToolGrant {
  const definition = AGENTS[input.agentId];
  if (definition === undefined) {
    return { agentId: input.agentId, granted: false, outcome: 'unknown_agent', tools: [], detail: 'no such agent' };
  }
  if (!input.tenantEnabled) {
    return {
      agentId: input.agentId, granted: false, outcome: 'tenant_disabled', tools: [],
      detail: 'AI is switched off for this tenant — every agent is off, instantly, from one setting',
    };
  }
  if (!input.agentEnabled) {
    return {
      agentId: input.agentId, granted: false, outcome: 'agent_disabled', tools: [],
      detail: `${definition.name} is switched off for this tenant; the others are unaffected`,
    };
  }

  const disabled = new Set(input.tenantDisabledTools ?? []);
  const tools = definition.allowedTools
    .filter((t) => !disabled.has(t))
    // Subtracted regardless of what the definition says. No override exists.
    .filter((t) => !FORBIDDEN_TOOLS.includes(t));

  return {
    agentId: input.agentId,
    granted: true,
    outcome: 'granted',
    tools,
    detail: `${definition.name} may use ${tools.length} tool(s); nothing it commits takes effect without ${definition.approver === 'none' ? 'anybody, because it commits nothing' : `a ${definition.approver.replace(/_/g, ' ')}`}`,
  };
}

export type ProposalVerdict =
  | 'accepted_for_approval'
  | 'forbidden_tool'
  | 'tool_not_granted'
  | 'read_only_agent'
  | 'no_evidence'
  | 'no_rationale';

export interface ReviewedProposal {
  readonly agentId: AgentId;
  readonly tool: string;
  readonly verdict: ProposalVerdict;
  readonly accepted: boolean;
  /** Who must approve it. Nothing happens until they do (§28, P-05). */
  readonly approver: ApprovalRole;
  /** True when this looks like an attempt rather than a mistake — always audited. */
  readonly securityEvent: boolean;
  readonly detail: string;
}

/**
 * Review a model's proposals against the agent's authority.
 *
 * This runs **after** the gateway has already dropped ungranted tools. Two checks in series
 * for the same rule is not redundancy — the gateway protects against a confused model, and
 * this protects against a future edit that widens an agent's allowlist by mistake. The one
 * that must never pass is `FORBIDDEN_TOOLS`, and it is checked here **first**, before anything
 * else, including before the read-only check.
 */
export function reviewProposals(input: {
  readonly agentId: AgentId;
  readonly proposals: readonly ToolProposal[];
  readonly grantedTools: readonly string[];
  /** Evidence ids the model actually cited and that were verified as real. */
  readonly verifiedCitations: readonly string[];
}): readonly ReviewedProposal[] {
  const definition = AGENTS[input.agentId];

  return input.proposals.map((p): ReviewedProposal => {
    const base = { agentId: input.agentId, tool: p.tool, approver: definition?.approver ?? 'owner' };

    if (FORBIDDEN_TOOLS.includes(p.tool)) {
      return {
        ...base,
        verdict: 'forbidden_tool',
        accepted: false,
        securityEvent: true,
        detail: `"${p.tool}" is on the absolute forbidden list (AI-NFR-12) — no agent, no tenant and no setting can grant it, and the attempt is recorded`,
      };
    }
    if (definition?.readOnly === true) {
      return {
        ...base,
        verdict: 'read_only_agent',
        accepted: false,
        securityEvent: false,
        detail: `${definition.name} is read-only and proposes nothing — it answers questions and drafts, and that is its whole authority`,
      };
    }
    if (!input.grantedTools.includes(p.tool)) {
      return {
        ...base,
        verdict: 'tool_not_granted',
        accepted: false,
        securityEvent: true,
        detail: `"${p.tool}" was not granted to ${definition?.name ?? input.agentId} on this call`,
      };
    }
    if (p.rationale.trim() === '') {
      return { ...base, verdict: 'no_rationale', accepted: false, securityEvent: false, detail: 'an unexplained proposal cannot be reviewed' };
    }
    if (definition?.requiresEvidence === true && input.verifiedCitations.length === 0) {
      return {
        ...base,
        verdict: 'no_evidence',
        accepted: false,
        securityEvent: false,
        detail: `${definition.name} must cite evidence — a confident answer with nothing behind it is the failure mode people trust most`,
      };
    }

    return {
      ...base,
      verdict: 'accepted_for_approval',
      accepted: true,
      securityEvent: false,
      detail: `queued for a ${base.approver.replace(/_/g, ' ')} to approve — the agent has proposed, and NOTHING has happened yet`,
    };
  });
}

export type CommitOutcome =
  | 'committed'
  | 'not_approved'
  | 'approver_wrong_role'
  | 'agent_cannot_approve'
  | 'proposal_not_accepted'
  | 'stale_proposal';

export interface AiCommitRecord {
  readonly proposalId: string;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly committed: boolean;
  readonly outcome: CommitOutcome;
  /** The HUMAN. This is the actor in the audit trail (§28). */
  readonly actor?: string;
  /** The agent is recorded as the DRAFTER, never as the actor. */
  readonly draftedBy: AgentId;
  readonly at?: string;
  readonly detail: string;
}

/**
 * Commit an approved AI proposal — **in a human's name**.
 *
 * The audit record names the person as the actor and the agent as the drafter. That ordering
 * is the point: *"the AI did it"* is an audit trail with nobody in it, and the first time
 * something goes wrong the question is always "who decided this?"
 *
 * An agent can never be the approver of its own or another agent's proposal. There is no
 * identity in this system that is both.
 */
export function commitProposal(input: {
  readonly proposalId: string;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly review: ReviewedProposal;
  readonly approvedBy: string;
  readonly approverRole: ApprovalRole;
  /** Ids known to be agents. An agent may never approve anything. */
  readonly agentIdentities?: readonly string[];
  /** Minutes after which a proposal must be regenerated against fresh data. Default 60. */
  readonly staleAfterMinutes?: number;
  readonly proposedAt: string;
  readonly at: string;
}): AiCommitRecord {
  const definition = AGENTS[input.agentId];
  const base = { proposalId: input.proposalId, agentId: input.agentId, tool: input.tool, draftedBy: input.agentId };

  if (!input.review.accepted) {
    return { ...base, committed: false, outcome: 'proposal_not_accepted', detail: input.review.detail };
  }
  if ((input.agentIdentities ?? []).includes(input.approvedBy)) {
    return {
      ...base,
      committed: false,
      outcome: 'agent_cannot_approve',
      detail: 'an agent cannot approve a proposal — no identity in this system is both a drafter and an approver (P-05)',
    };
  }
  if (input.approvedBy.trim() === '') {
    return {
      ...base,
      committed: false,
      outcome: 'not_approved',
      detail: 'nothing an agent proposes takes effect without a named person',
    };
  }
  if (definition !== undefined && input.approverRole !== definition.approver) {
    return {
      ...base,
      committed: false,
      outcome: 'approver_wrong_role',
      detail: `${definition.name} needs a ${definition.approver.replace(/_/g, ' ')}, and ${input.approvedBy} is acting as ${input.approverRole.replace(/_/g, ' ')}`,
    };
  }

  const ageMinutes = Math.floor((Date.parse(input.at) - Date.parse(input.proposedAt)) / 60_000);
  const stale = input.staleAfterMinutes ?? 60;
  if (ageMinutes > stale) {
    return {
      ...base,
      committed: false,
      outcome: 'stale_proposal',
      detail: `this was drafted ${ageMinutes} minutes ago against figures that have moved — regenerate it rather than approve yesterday's reasoning`,
    };
  }

  return {
    ...base,
    committed: true,
    outcome: 'committed',
    // The person. Always.
    actor: input.approvedBy,
    at: input.at,
    detail: `committed by ${input.approvedBy}, drafted by ${definition?.name ?? input.agentId} — the person is the actor and the agent is the drafter`,
  };
}
