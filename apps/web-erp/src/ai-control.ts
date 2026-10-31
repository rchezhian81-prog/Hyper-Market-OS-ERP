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
//   • Switching an assistant on or off, and setting the shop's and each assistant's spending limit (re-audit 30 Oct 2026,
//     AI-SCREEN), are a PERSON's governance acts through head office's existing routes and permissions
//     (`ai.agent.enable`, `ai.budget.set`). Switching one on lets it run on its tested rules — it still only recommends
//     (hard rule 5). Nothing here lifts the shop-wide switch, connects a model or approves one: the live-model parts wait
//     for R8 behind the owner's switch and a cost cap (OB-382), and head office refuses a cap above D3's ₹15,000 itself.
//   • A draft's "to act" is said in plain words (observation O-2), never as a raw route.

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
  /** Switch an assistant on or off for the shop (`ai.agent.enable`) — the owner's governance act. */
  readonly enable: boolean;
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
    enable: holds(viewer, 'ai.agent.enable'),
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
  | { readonly ok: false; readonly refusal: ActRefusal; readonly detail: string };

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

export const ACT_REFUSAL_KINDS = ['nobody_is_named_at_this_desk', 'reason_needed', 'which_agent', 'same_person', 'not_yours', 'not_money', 'period_needed', 'already_so'] as const;
export type ActRefusal = (typeof ACT_REFUSAL_KINDS)[number];

// ── Switching assistants on and off; spending limits (AI-SCREEN, re-audit 30 Oct 2026) ─────────────────────────────

/**
 * Switch ONE assistant on or off. Head office's route takes the whole list of switched-on assistants
 * (`PUT /v1/ai/agents/enabled`), so the list is built from what head office said is switched on in `agents` — the page
 * re-reads it immediately before sending — with this one assistant added or taken away; nobody else's setting is touched.
 * Switching on lets it run on its rules: a stopped shop (the shop-wide switch, a kill switch) keeps it stopped.
 */
export function enableRequest(viewer: AiViewer, agents: readonly Pick<ControlAgent, 'agentId' | 'enabled'>[], agentId: AgentId, on: boolean): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'Switching an assistant on or off carries the name of whoever did it.' };
  const current = agents.find((a) => a.agentId === agentId);
  if (current === undefined || !(agentId in AGENTS)) return { ok: false, refusal: 'which_agent', detail: 'Choose an assistant head office knows.' };
  if (current.enabled === on) return { ok: false, refusal: 'already_so', detail: `${agentId} is already switched ${on ? 'on' : 'off'}.` };
  const enabled = agents.filter((a) => (a.agentId === agentId ? on : a.enabled)).map((a) => a.agentId).sort();
  return { ok: true, method: 'PUT', path: '/v1/ai/agents/enabled', body: { agents: enabled } };
}

/** Rupees as typed ("1,000", "250.50", "₹15000") → paise exactly from the text; undefined when it is not money. */
export function rupeesToPaise(text: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[,\s₹]/g, ''));
  return m === null ? undefined : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/**
 * The shop's AI spending limit for a period (`PUT /v1/ai/budget`). `periodEnds` is the instant the period ends (the page
 * turns the chosen day into the end of that day on the SHOP's clock). Only the shape is checked here — head office refuses
 * by name a limit above the ₹15,000 platform ceiling (D3) or below the assistants' own limits, and nothing is changed.
 * A limit only CAPS spending: it connects no model and approves none (OB-296 · OB-382).
 */
export function budgetRequest(viewer: AiViewer, input: { readonly cap: string; readonly periodEnds: string }): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'A spending limit carries the name of whoever set it.' };
  const capMinor = rupeesToPaise(input.cap);
  if (input.cap.trim() === '' || capMinor === undefined) return { ok: false, refusal: 'not_money', detail: 'The limit is an amount in rupees, such as 1000 or 1000.50.' };
  if (input.periodEnds.trim() === '' || Number.isNaN(Date.parse(input.periodEnds))) return { ok: false, refusal: 'period_needed', detail: 'Choose the day the limit runs until.' };
  return { ok: true, method: 'PUT', path: '/v1/ai/budget', body: { capMinor, periodEnds: input.periodEnds } };
}

/**
 * One assistant's own spending limit, and — when the owner wants one — its limit of requests an hour
 * (`PUT /v1/ai/agents/:agent/budget`). Head office refuses by name a limit that would take the assistants' limits together
 * over the shop's.
 */
export function agentBudgetRequest(viewer: AiViewer, agentId: AgentId, input: { readonly ceiling: string; readonly callsPerHour?: string }): ActCheck {
  if (viewer.userId === null) return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'A spending limit carries the name of whoever set it.' };
  if (!(agentId in AGENTS)) return { ok: false, refusal: 'which_agent', detail: 'Choose an assistant head office knows.' };
  const ceilingMinor = rupeesToPaise(input.ceiling);
  if (input.ceiling.trim() === '' || ceilingMinor === undefined) return { ok: false, refusal: 'not_money', detail: 'The limit is an amount in rupees, such as 200 or 200.50.' };
  const rate = (input.callsPerHour ?? '').trim();
  if (rate !== '' && !/^[1-9]\d*$/.test(rate)) return { ok: false, refusal: 'not_money', detail: 'Requests an hour is a whole number of at least 1, or blank for none.' };
  return { ok: true, method: 'PUT', path: `/v1/ai/agents/${encodeURIComponent(agentId)}/budget`, body: { ceilingMinor, ...(rate === '' ? {} : { callsPerHour: Number(rate) }) } };
}

// ── "To act on it", in plain words (observation O-2) ────────────────────────────────────────────────────────────────

/**
 * What a person does to act on a draft, said as an owner reads it — never the raw route the draft names. Each assistant's
 * draft names one ordinary route (`wouldRequire`); these are those routes' plain words, in English and Tamil. A route this
 * list does not know is still never shown raw: it gets the general words ("through its own screen, with its own checks").
 */
export const TO_ACT_WORDS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  purchase_order: { en: 'A buyer raises a purchase order; a second person approves it.', ta: 'வாங்குநர் கொள்முதல் ஆர்டர் போடுவார்; வேறு ஒருவர் அதை அங்கீகரிப்பார்.' },
  transfer: { en: 'A person makes a stock transfer between stores; other people send it and receive it.', ta: 'ஒருவர் கடைகளுக்கு இடையே சரக்கு மாற்றத்தை உருவாக்குவார்; வேறு நபர்கள் அதை அனுப்பிப் பெறுவார்கள்.' },
  markdown_or_transfer: { en: 'A manager marks the price down, or moves the stock to another store.', ta: 'மேலாளர் விலையைக் குறைப்பார், அல்லது சரக்கை வேறு கடைக்கு மாற்றுவார்.' },
  price_change: { en: 'A manager changes the price, with the usual price approval.', ta: 'மேலாளர் வழக்கமான விலை அனுமதியுடன் விலையை மாற்றுவார்.' },
  write_off: { en: 'A person writes the stock off, with the usual write-off approval.', ta: 'ஒருவர் வழக்கமான அனுமதியுடன் சரக்கைக் கழித்து எழுதுவார்.' },
  promotion: { en: 'A marketing approver tries the promotion out first, then launches it.', ta: 'சந்தைப்படுத்தல் அனுமதியாளர் முதலில் சலுகையைச் சோதித்து, பின் தொடங்குவார்.' },
  campaign: { en: 'A marketing approver reviews the campaign and launches it; nothing is sent automatically.', ta: 'சந்தைப்படுத்தல் அனுமதியாளர் பிரச்சாரத்தைச் சரிபார்த்துத் தொடங்குவார்; எதுவும் தானாக அனுப்பப்படாது.' },
  service_reply: { en: 'A service-desk person replies to the customer\'s case.', ta: 'சேவை மேசை ஊழியர் வாடிக்கையாளரின் புகாருக்குப் பதில் அளிப்பார்.' },
  alert: { en: 'A person acknowledges the system alert and looks into it.', ta: 'ஒருவர் அமைப்பு எச்சரிக்கையை ஏற்று அதை ஆராய்வார்.' },
  staff_task: { en: 'A person marks the staff task done when it is done.', ta: 'பணி முடிந்ததும் ஒருவர் ஊழியர் பணியை முடிந்ததாகக் குறிப்பார்.' },
  import_quality: { en: 'A buyer looks at the supplier\'s import quality report.', ta: 'வாங்குநர் சப்ளையரின் இறக்குமதித் தர அறிக்கையைப் பார்ப்பார்.' },
  loss_cases: { en: 'A person looks at the loss-prevention cases.', ta: 'ஒருவர் இழப்புத் தடுப்பு வழக்குகளைப் பார்ப்பார்.' },
  barcode: { en: 'A catalogue person adds the missing barcode to the product.', ta: 'பட்டியல் ஊழியர் பொருளுக்கு விடுபட்ட பார்கோடைச் சேர்ப்பார்.' },
  merge: { en: 'A catalogue steward checks the two products and merges them if they are the same.', ta: 'பட்டியல் பொறுப்பாளர் இரண்டு பொருட்களையும் சரிபார்த்து, ஒன்றே என்றால் இணைப்பார்.' },
  publish_mrp: { en: 'A catalogue person adds the missing MRP and publishes the product.', ta: 'பட்டியல் ஊழியர் விடுபட்ட MRP-ஐச் சேர்த்துப் பொருளை வெளியிடுவார்.' },
  customer_confirms: { en: 'The customer confirms any change to their cart in the app.', ta: 'வாடிக்கையாளர் தமது கூடையில் எந்த மாற்றத்தையும் செயலியில் உறுதிசெய்வார்.' },
  nothing: { en: 'Nothing to do in the system — it only points something out for a person to check.', ta: 'அமைப்பில் செய்ய எதுவும் இல்லை — ஒருவர் சரிபார்க்க ஒன்றைச் சுட்டிக்காட்டுகிறது மட்டுமே.' },
  general: { en: 'A person acts on it through its own screen, with its own checks and approvals.', ta: 'ஒருவர் அதன் சொந்தத் திரையில், அதன் சொந்தச் சரிபார்ப்புகள் மற்றும் அனுமதிகளுடன் செயல்படுவார்.' },
});

/** Which plain words fit a draft's `wouldRequire` — matched on the route it names, first match wins. Pure. */
export function toActKey(wouldRequire: string): keyof typeof TO_ACT_WORDS {
  const w = wouldRequire.trim();
  const rules: readonly (readonly [RegExp, string])[] = [
    [/^nothing\b/i, 'nothing'],
    [/customer confirms/i, 'customer_confirms'],
    [/campaign/i, 'campaign'],
    [/\/v1\/prices\/changes[\s\S]*\/v1\/warehouse\/transfers/, 'markdown_or_transfer'],
    [/\/v1\/purchase\/orders\b/, 'purchase_order'],
    [/\/v1\/warehouse\/transfers\b/, 'transfer'],
    [/\/v1\/prices\/changes\b/, 'price_change'],
    [/\/v1\/inventory\/write-off\b/, 'write_off'],
    [/\/v1\/promotions\//, 'promotion'],
    [/\/v1\/service\/cases\//, 'service_reply'],
    [/\/v1\/platform\/alerts\//, 'alert'],
    [/\/v1\/hr\/workforce\/tasks\//, 'staff_task'],
    [/\/v1\/purchase\/import-quality\b/, 'import_quality'],
    [/\/v1\/loss-prevention\/cases\b/, 'loss_cases'],
    [/\/v1\/catalogue\/products\/[^/\s]+\/barcodes\b/, 'barcode'],
    [/\/v1\/catalogue\/merges\b/, 'merge'],
    [/\/v1\/catalogue\/products\/[^/\s]+\/publish\b/, 'publish_mrp'],
  ];
  return rules.find(([re]) => re.test(w))?.[1] ?? 'general';
}

/** The plain words for a draft's `wouldRequire`, in the reader's language — never the raw route (O-2). */
export const toActWords = (wouldRequire: string, lang: 'en' | 'ta'): string => TO_ACT_WORDS[toActKey(wouldRequire)]![lang];

/** What the shop does without each agent — shown beside the switch (pulling it is a calm decision). */
export function withoutIt(agent: Pick<ControlAgent, 'agentId'>): string {
  const d = AGENTS[agent.agentId];
  return d.readOnly
    ? `${d.name} only reads and drafts — the figures behind it are computed without AI and stay on the screen.`
    : `${d.name} only proposes — the work carries on as it did before, decided by the ${d.approver.replace(/_/g, ' ')}.`;
}
