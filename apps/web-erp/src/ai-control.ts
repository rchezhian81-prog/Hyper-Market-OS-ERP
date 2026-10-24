// AI control, fed by head office (OB-288 lane 4 · P1 · roadmap §27 "AI control": agent registry, tools/authority,
// model/provider, prompts/retrieval, evaluations, usage/cost, incidents, kill switch).
//
// The screen used to bind a session built from `window.aiData`, which nothing supplied — so it always showed sample
// data, and its kill switch changed a list in the tab and reached no server. This module is the tested view model of
// the REAL screen: it shapes ONE server read (`GET /v1/ai/control`, in the person's own session) into what each tab
// shows, and it CHECKS an act before the page sends it to head office — where the same rules run again and decide.
// It holds no figure of its own (P-08), commits nothing, and never stands in for the server's answer.
//
//   • Stopped assistants first — somebody who opens this screen in a hurry has come to stop something.
//   • Absent is not nought: an agent never evaluated, a ceiling never set, a cap of nought, no provider — each is said.
//   • Nothing commits here. A proposal's "approve" records a person's decision; the act itself is the ordinary route.

import { AGENTS, FORBIDDEN_TOOLS, type AgentId, type KillScope } from '../../../packages/ai/src/index';

/** Who is looking — from the identity the page was given. `permissions: null` = not told (the server decides). */
export interface AiViewer {
  readonly userId: string | null;
  readonly permissions: readonly string[] | null;
}

export interface ControlAgent {
  readonly agentId: AgentId; readonly name: string; readonly purpose: string; readonly approver: string;
  readonly readOnly: boolean; readonly customerFacing: boolean; readonly tools: readonly string[];
  readonly enabled: boolean; readonly stopped: boolean; readonly stoppedBecause: 'master' | 'kill_switch' | 'not_enabled' | null;
  readonly spentMinor: number; readonly ceilingMinor: number | null; readonly callsPerHour: number | null;
  readonly evaluationCases: number;
  readonly lastEvaluation: { readonly runId: string; readonly at: string; readonly passed: number; readonly total: number; readonly unsafe: number; readonly complete: boolean; readonly fitToFacePeople: boolean; readonly detail: string } | null;
  readonly awaitingDecision: number;
}
export interface ControlSwitch {
  readonly switchId: string; readonly scope: KillScope; readonly agentId?: AgentId; readonly reason: string;
  readonly activatedBy: string; readonly activatedAt: string; readonly liftedBy?: string; readonly liftedAt?: string;
}
export interface ControlProposal {
  readonly proposalId: string; readonly agent: AgentId; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { readonly source: string; readonly reference: string; readonly summary: string }[];
  readonly createdAt: string;
  readonly confidence: { readonly band: 'high' | 'medium' | 'low'; readonly basis: string; readonly uncertainty: string };
  readonly outcome: { readonly decision: 'approved' | 'rejected'; readonly by: string; readonly at: string; readonly reason?: string } | null;
}
export interface ControlRead {
  readonly agents: readonly ControlAgent[];
  readonly forbidden: readonly string[];
  readonly killSwitch: { readonly masterOn: boolean; readonly active: readonly ControlSwitch[]; readonly history: readonly ControlSwitch[] };
  readonly budget: { readonly capMinor: number; readonly spentMinor: number; readonly periodEnds: string; readonly platformCeilingMinor: number; readonly ceilingsTotalMinor: number };
  readonly provider: { readonly configured: boolean; readonly said: string };
  readonly models: readonly { readonly modelId: string; readonly adapterId: string; readonly tier: string; readonly dataResidency: string; readonly approvedBy: string; readonly approvedAt: string; readonly state: string; readonly evaluationRunId: string; readonly withdrawnReason?: string }[];
  readonly freeText: { readonly enabled: boolean };
  readonly evaluations: { readonly setVersion: number };
  readonly incidents: { readonly open: number; readonly list: readonly { readonly incidentId: string; readonly kind: string; readonly agent?: AgentId; readonly summary: string; readonly raisedBy: string; readonly raisedAt: string; readonly state: string; readonly owner?: string; readonly closeReason?: string }[] };
  readonly proposals: { readonly awaitingDecision: number; readonly list: readonly ControlProposal[] };
  readonly modelCalls: { readonly count: number; readonly chain: { readonly ok: boolean }; readonly recent: readonly { readonly callId: string; readonly agent: AgentId; readonly at: string; readonly outcome: string; readonly calledAModel: boolean; readonly instruction: string; readonly evidenceFrom: string | null; readonly evidenceCount: number; readonly modelId: string | null; readonly piiRemoved: readonly string[]; readonly blockedTools: readonly string[] }[] };
  readonly decisions: Readonly<Record<string, string>>;
  readonly asAt: string;
}

/** What a person may do on this screen — offered, never granted (the server re-checks every act). */
export interface AiMay {
  readonly stop: boolean; readonly decide: boolean; readonly approveModel: boolean; readonly evaluate: boolean;
  readonly manageIncidents: boolean; readonly setBudget: boolean;
}

export type CostView =
  | { readonly known: false; readonly why: 'no_cap_set' }
  | { readonly known: true; readonly capMinor: number; readonly spentMinor: number; readonly platformCeilingMinor: number; readonly usedBps: number; readonly rows: readonly { readonly agentId: AgentId; readonly spentMinor: number; readonly ceilingMinor: number | null; readonly usedBps: number | null; readonly callsPerHour: number | null }[] };

export interface AiControlView {
  readonly nobodyNamed: boolean;
  readonly may: AiMay;
  /** Stopped first, then by id. */
  readonly agents: readonly ControlAgent[];
  readonly forbidden: readonly string[];
  readonly kill: { readonly masterOn: boolean; readonly stoppedCount: number; readonly active: readonly ControlSwitch[]; readonly history: readonly ControlSwitch[] };
  /** Waiting for a decision first, newest first; each says whether THIS person may decide it. */
  readonly queue: readonly (ControlProposal & { readonly agentName: string; readonly mayDecide: boolean })[];
  readonly cost: CostView;
  readonly provider: ControlRead['provider'];
  readonly models: ControlRead['models'];
  readonly freeTextOn: boolean;
  readonly incidents: ControlRead['incidents'];
  readonly modelCalls: ControlRead['modelCalls'];
  readonly decisions: ControlRead['decisions'];
  readonly asAt: string;
}

const holds = (viewer: AiViewer, permission: string): boolean =>
  viewer.userId !== null && (viewer.permissions === null || viewer.permissions.includes(permission));

/** Shape the server's control read for the screen. */
export function aiControlView(control: ControlRead, viewer: AiViewer): AiControlView {
  const may: AiMay = {
    stop: holds(viewer, 'ai.killswitch.set'), decide: holds(viewer, 'ai.proposal.decide'),
    approveModel: holds(viewer, 'ai.model.approve'), evaluate: holds(viewer, 'ai.evaluation.run'),
    manageIncidents: holds(viewer, 'ai.incident.manage'), setBudget: holds(viewer, 'ai.budget.set'),
  };
  const agents = [...control.agents].sort((a, b) => Number(b.stopped) - Number(a.stopped) || a.agentId.localeCompare(b.agentId));
  const queue = [...control.proposals.list]
    .sort((a, b) => Number(a.outcome !== null) - Number(b.outcome !== null) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((p) => ({ ...p, agentName: AGENTS[p.agent]?.name ?? p.agent, mayDecide: may.decide && p.outcome === null }));
  const bps = (n: number, d: number): number => (d === 0 ? 0 : Math.floor((n * 10_000) / d));
  const cost: CostView = control.budget.capMinor === 0
    ? { known: false, why: 'no_cap_set' }
    : {
      known: true, capMinor: control.budget.capMinor, spentMinor: control.budget.spentMinor, platformCeilingMinor: control.budget.platformCeilingMinor,
      usedBps: bps(control.budget.spentMinor, control.budget.capMinor),
      rows: agents.map((a) => ({ agentId: a.agentId, spentMinor: a.spentMinor, ceilingMinor: a.ceilingMinor, usedBps: a.ceilingMinor === null ? null : bps(a.spentMinor, a.ceilingMinor), callsPerHour: a.callsPerHour })).sort((x, y) => y.spentMinor - x.spentMinor || x.agentId.localeCompare(y.agentId)),
    };
  return {
    nobodyNamed: viewer.userId === null, may, agents, forbidden: control.forbidden.length > 0 ? control.forbidden : FORBIDDEN_TOOLS,
    kill: { masterOn: control.killSwitch.masterOn, stoppedCount: agents.filter((a) => a.stopped).length, active: control.killSwitch.active, history: control.killSwitch.history },
    queue, cost, provider: control.provider, models: control.models, freeTextOn: control.freeText.enabled,
    incidents: control.incidents, modelCalls: control.modelCalls, decisions: control.decisions, asAt: control.asAt,
  };
}

export type ActCheck =
  | { readonly ok: true; readonly method: 'POST' | 'PUT'; readonly path: string; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly refusal: 'nobody_is_named_at_this_desk' | 'reason_needed' | 'which_agent' | 'same_person' | 'not_yours'; readonly detail: string };

/** Pulling a switch: instant, no approval — but a name and a reason (AI-NFR-10). The server runs the same check. */
export function pullRequest(viewer: AiViewer, input: { readonly scope: KillScope; readonly agentId?: AgentId; readonly reason: string }): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'Stopping the AI carries the name of whoever stopped it.' };
  if (input.reason.trim() === '') return { ok: false, refusal: 'reason_needed', detail: 'Say why, so it can be reviewed afterwards.' };
  if (input.scope === 'single_agent' && input.agentId === undefined) return { ok: false, refusal: 'which_agent', detail: 'Choose the assistant to stop.' };
  return { ok: true, method: 'POST', path: '/v1/ai/kill-switches', body: { scope: input.scope, ...(input.scope === 'single_agent' ? { agentId: input.agentId } : {}), reason: input.reason.trim() } };
}

/** Lifting a switch: a separate act, with a reason, by somebody OTHER than the person who pulled it (§28). */
export function liftRequest(viewer: AiViewer, killSwitch: ControlSwitch, reason: string): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'Starting an assistant again carries a name.' };
  if (viewer.userId === killSwitch.activatedBy) return { ok: false, refusal: 'same_person', detail: `${killSwitch.activatedBy} stopped it, so somebody else decides it may start again.` };
  if (reason.trim() === '') return { ok: false, refusal: 'reason_needed', detail: 'Say what was wrong and why it is safe now.' };
  return { ok: true, method: 'POST', path: `/v1/ai/kill-switches/${encodeURIComponent(killSwitch.switchId)}/lift`, body: { reason: reason.trim() } };
}

/** A person's decision on a proposal: approve (they will act through the ordinary route) or reject with a reason. */
export function decisionRequest(viewer: AiViewer, proposal: ControlProposal, decision: 'approved' | 'rejected', reason: string): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'A decision carries the name of whoever made it.' };
  if (proposal.outcome !== null) return { ok: false, refusal: 'not_yours', detail: `Already ${proposal.outcome.decision} by ${proposal.outcome.by}.` };
  if (decision === 'rejected' && reason.trim() === '') return { ok: false, refusal: 'reason_needed', detail: 'Say why it is rejected.' };
  return { ok: true, method: 'POST', path: `/v1/ai/proposals/${encodeURIComponent(proposal.proposalId)}/outcome`, body: { decision, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) } };
}

export const ACT_REFUSAL_KINDS = ['nobody_is_named_at_this_desk', 'reason_needed', 'which_agent', 'same_person', 'not_yours'] as const;

/** What the shop does without each agent — shown beside the switch (pulling it is a calm decision). */
export function withoutIt(agent: Pick<ControlAgent, 'agentId'>): string {
  const d = AGENTS[agent.agentId];
  return d.readOnly
    ? `${d.name} only reads and drafts — the figures behind it are computed without AI and stay on the screen.`
    : `${d.name} only proposes — the work carries on as it did before, decided by the ${d.approver.replace(/_/g, ' ')}.`;
}
