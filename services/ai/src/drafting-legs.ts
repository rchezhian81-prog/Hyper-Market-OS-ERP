// The model-backed DRAFTING legs of three agents (round 8 · roadmap §7 · AI-NFR-01..08 · P-05 · hard rule #5):
//
//   • A05 Service — drafts a reply to ONE service case. The draft is recorded on the case's draft register; a NAMED
//     person approves, edits or rejects it, and a person SENDS it (services/customer/src/service-cases.ts). The model
//     never replies to anybody.
//   • A09 Marketing — drafts the words of ONE campaign message template from the audiences its deterministic leg found
//     within consent and margin. The words are recorded as a DRAFT version on the very template register the PA-08
//     queue sends from; nothing can be sent with it until a DIFFERENT person approves it there (§28, the existing
//     two-person template approval).
//   • A07 Security/Fraud — summarises the open anomalies (investigations and the rule breaches the store's own rules
//     raised) and suggests an order to look at them. Recorded as a summary a security officer reads; NO sanction, no case
//     action, ever.
//
// Every leg goes through `governedModelCall`: admission (kill switch, the agent enabled by name, the budget) BEFORE the
// transport is touched, reservation and metering, and one hash-chained audit record per call. The EVIDENCE is read here,
// on the server, from the domain's own records — the caller names only what to draft (a case, a template, a summary);
// any free text that came from a customer or a person is fenced to the model as UNTRUSTED input, never evidence. A draft
// that cites none of the shop's evidence is NOT recorded (a reply grounded on nothing cannot be reviewed). Tools the agent
// was never granted are dropped by the gateway; the ones it was granted come back as SUGGESTIONS, never executed.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { EvidenceItem, ModelResponse, AgentId } from '../../../packages/ai/src/index';
import type { ServiceCase, AiDraft } from '../../../packages/service-desk/src/index';
import { governedModelCall, type ModelGatewayDeps, type ModelCallAudit } from './model-gateway';

/** A template draft version as the PA-08 register keeps it — the subset this leg writes (see notification-queue.ts). */
export interface AiTemplateDraft {
  readonly templateId: string;
  readonly version: number;
  readonly purpose: 'marketing' | 'transactional';
  readonly channel: 'sms' | 'whatsapp' | 'email' | 'push';
  readonly body: string;
  readonly state: 'draft';
  readonly draftedBy: string;
  readonly draftedAt: string;
  /** Who wrote the words: the assistant, through this governed call — so the approver knows what they are approving. */
  readonly aiDraft: { readonly agent: 'A09'; readonly callId: string; readonly auditHash: string; readonly citedEvidenceIds: readonly string[] };
}

/** An A07 anomaly summary — what a security officer reads. Commits nothing. */
export interface AnomalySummary {
  readonly summaryId: string;
  readonly text: string;
  readonly citedEvidenceIds: readonly string[];
  /** The investigations the model suggested looking at first — SUGGESTIONS (`prioritise_investigation`), never acted on. */
  readonly suggestedOrder: readonly string[];
  readonly evidenceCount: number;
  readonly requestedBy: string;
  readonly callId: string;
  readonly auditHash: string;
  readonly at: string;
  readonly committedAnything: false;
}

export interface DraftingLegDeps {
  readonly gateway: ModelGatewayDeps;
  readonly now: () => string;
  // A05 — the case register and its draft register (the same ones the service desk reads).
  readonly serviceCase: (tenantId: string, caseId: string) => Promise<ServiceCase | undefined> | ServiceCase | undefined;
  readonly caseDraft: (tenantId: string, caseId: string, draftId: string) => Promise<AiDraft | undefined> | AiDraft | undefined;
  readonly recordCaseDraft: (tenantId: string, caseId: string, draft: AiDraft, key: string) => Promise<void> | void;
  /** The order a case is about, as the order register holds it — evidence for the reply. */
  readonly orderFacts?: (tenantId: string, orderId: string) => Promise<string | undefined> | string | undefined;
  /** The shop's own service policies as words (compensation limits, return window) — evidence for the reply. */
  readonly servicePolicyFacts?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  // A09 — the template register the PA-08 queue sends from.
  readonly templateVersions: (tenantId: string) => Promise<readonly { readonly templateId: string; readonly version: number }[]>;
  readonly recordTemplateDraft: (tenantId: string, draft: AiTemplateDraft) => Promise<void> | void;
  // A07 — the summaries register.
  readonly anomalySummaries: (tenantId: string) => Promise<readonly AnomalySummary[]> | readonly AnomalySummary[];
  readonly recordAnomalySummary: (tenantId: string, s: AnomalySummary) => Promise<void> | void;
  /** The open rule breaches (PF-07) as evidence lines, beside the A07 investigations the gateway's reader gives. */
  readonly raisedExceptionFacts?: (tenantId: string) => Promise<readonly EvidenceItem[]> | readonly EvidenceItem[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const CHANNELS = ['sms', 'whatsapp', 'email', 'push'] as const;
const PURPOSES = ['marketing', 'transactional'] as const;

/** The admission refusal as the gateway route answers it — the refusal is on the audit, nothing called or spent. */
function refusedAdmission(audit: ModelCallAudit): never {
  throw apiError(audit.admission.outcome === 'killed' ? 503 : 429, {
    code: audit.admission.outcome, whatHappened: audit.admission.detail, wasItSaved: 'saved',
    nextSafeAction: 'Nothing was called and nothing was spent; the refusal itself is on the assistant\'s audit record. A person can do this without the assistant.',
  });
}

/** A call that did not produce citable words: nothing is recorded but the audit, and the reply says why in words. */
function notDrafted(response: ModelResponse, audit: ModelCallAudit, what: string): { status: number; body: unknown } {
  const why = response.outcome !== 'answered' || response.text === undefined || response.text.trim() === ''
    ? `the assistant did not draft ${what} (${response.outcome}: ${response.detail})`
    : `the assistant's words cite none of the shop's own records, so they cannot be reviewed and were not kept`;
  return { status: 200, body: { drafted: false, outcome: response.outcome, detail: why, callId: audit.callId, auditHash: audit.hash, committedAnything: false } };
}

export function draftingLegRoutes(deps: DraftingLegDeps): readonly Route[] {
  const call = (ctx: { tenantId: string; userId: string; idempotencyKey?: string }, agent: AgentId, leg: string, instruction: string, evidence: readonly EvidenceItem[], callerText?: string) =>
    governedModelCall(deps.gateway, {
      tenantId: ctx.tenantId, agent, requestedBy: ctx.userId, callId: `call-${agent}-${leg}-${ctx.idempotencyKey ?? deps.now()}`,
      instruction, evidence, evidenceFrom: 'domain_readers', ...(callerText === undefined ? {} : { callerText }),
      tier: 'small', maxOutputTokens: 600, timeoutMs: 4_000,
    });

  return [
    {
      // A05: draft a reply to one case. Body: { draftId, note? } — `note` is the desk person's own words for the
      // assistant (fenced as untrusted, with the case's summary). Records an AI draft on the case — approved=false; a
      // named person decides on it (…/drafts/:draftId/decision) and a person sends it (…/send).
      api: 'API-13', method: 'POST', path: '/v1/service/cases/:caseId/ai-drafts',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const draftId = typeof b['draftId'] === 'string' ? b['draftId'].trim() : '';
        if (draftId === '' || (b['note'] !== undefined && (typeof b['note'] !== 'string' || b['note'].length > 1_000))) {
          throw apiError(400, { code: 'not_readable_as_a_draft_request', whatHappened: 'Asking the assistant for a reply needs { draftId, note? (≤ 1,000 characters) }. The case and its evidence are read by head office.', wasItSaved: 'not_saved', nextSafeAction: 'Name the draft. Nothing was called or spent.' });
        }
        const c = await deps.serviceCase(ctx.tenantId, caseId);
        if (c === undefined) throw notFound(`service case ${caseId}`);
        if (await deps.caseDraft(ctx.tenantId, caseId, draftId) !== undefined) {
          throw apiError(409, { code: 'draft_already_recorded', whatHappened: `A draft "${draftId}" already exists on case ${caseId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new draft id, or decide on the existing one. Nothing was called or spent.' });
        }
        // The evidence — the shop's own records about this case, read here.
        const evidence: EvidenceItem[] = [{
          evidenceId: `case:${caseId}`, source: 'service case register', untrusted: false,
          content: `case ${caseId}: a ${c.kind}, priority ${c.priority}, ${c.state}, opened ${c.openedAt}${c.orderRef === undefined ? '' : `, about order ${c.orderRef}`}; first reply ${c.firstRespondedAt ?? 'not given yet'}${c.resolution === undefined ? '' : `; resolved: ${c.resolution}`}`,
        }];
        if (c.orderRef !== undefined && deps.orderFacts !== undefined) {
          const order = await deps.orderFacts(ctx.tenantId, c.orderRef);
          if (order !== undefined) evidence.push({ evidenceId: `order:${c.orderRef}`, source: 'order register', content: order, untrusted: false });
        }
        for (const [i, p] of (await deps.servicePolicyFacts?.(ctx.tenantId) ?? []).entries()) {
          evidence.push({ evidenceId: `policy:${i + 1}`, source: 'the shop\'s service policy', content: p, untrusted: false });
        }
        // What the customer said (as the desk typed it) and the desk's note — the customer's words, never evidence.
        const callerText = [`Customer's words as recorded: ${c.summary}`, ...(isStr(b['note']) ? [`Desk note: ${b['note']}`] : [])].join('\n');
        const instruction = `A05 draft-case-response for case ${caseId}: draft a short, polite reply to the customer about this ${c.kind}. `
          + 'Use only the evidence. Do not promise a refund, compensation or a date the evidence does not give — a person decides those. '
          + 'If the evidence does not answer the customer, say a colleague will look into it.';
        const { response, audit } = await call(ctx, 'A05', `case-${caseId}`, instruction, evidence, callerText);
        if (!audit.admission.allowed) refusedAdmission(audit);
        if (response.outcome !== 'answered' || response.text === undefined || response.citedEvidenceIds.length === 0) return notDrafted(response, audit, 'a reply');
        const draft: AiDraft = {
          draftId, caseId, text: response.text, modelRef: `model-call:${audit.callId}#${audit.hash.slice(0, 16)}`,
          generatedAt: deps.now(), evidenceRefs: response.citedEvidenceIds, approved: false,
        };
        await deps.recordCaseDraft(ctx.tenantId, caseId, draft, `${caseId}-${draftId}`);
        return {
          status: 201,
          body: {
            drafted: true, draftId, caseId, text: draft.text, evidenceRefs: draft.evidenceRefs, approved: false, sendable: false,
            suggestions: response.proposals.map((p) => ({ tool: p.tool, rationale: p.rationale })),
            callId: audit.callId, auditHash: audit.hash, costMinor: audit.actualCostMinor, committedAnything: false,
            nextSafeAction: 'A named person approves, edits or rejects the draft; only a person sends it.',
          },
        };
      },
    },
    {
      // A09: draft the words of one campaign message. Body: { purpose (marketing/transactional), channel, brief? }.
      // Recorded as a DRAFT version of the template on the PA-08 register, drafted by the person who asked and marked as
      // the assistant's words; a DIFFERENT person approves it (POST /v1/notifications/templates/:templateId/approval).
      api: 'API-13', method: 'POST', path: '/v1/ai/marketing/campaign-drafts/:templateId',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = (ctx.params['templateId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (templateId === '' || !PURPOSES.includes(b['purpose'] as typeof PURPOSES[number]) || !CHANNELS.includes(b['channel'] as typeof CHANNELS[number])
          || (b['brief'] !== undefined && (typeof b['brief'] !== 'string' || b['brief'].length > 1_000))) {
          throw apiError(400, { code: 'not_readable_as_a_campaign_draft_request', whatHappened: `A campaign draft needs { purpose (${PURPOSES.join('/')}), channel (${CHANNELS.join('/')}), brief? (≤ 1,000 characters) }. The audiences are read by head office.`, wasItSaved: 'not_saved', nextSafeAction: 'Name the template, purpose and channel. Nothing was called or spent.' });
        }
        const evidence = deps.gateway.evidenceFor === undefined ? [] : await deps.gateway.evidenceFor(ctx.tenantId, 'A09');
        const instruction = `A09 draft-campaign-message for template ${templateId} (${b['purpose'] as string}, ${b['channel'] as string}): `
          + 'draft the words of one short message for the audiences in the evidence, only to customers who consented. '
          + 'Do not state a price, discount or date the evidence does not give; use {offer} where the offer goes.';
        const { response, audit } = await call(ctx, 'A09', `template-${templateId}`, instruction, evidence, isStr(b['brief']) ? `Marketing brief: ${b['brief']}` : undefined);
        if (!audit.admission.allowed) refusedAdmission(audit);
        if (response.outcome !== 'answered' || response.text === undefined || response.citedEvidenceIds.length === 0) return notDrafted(response, audit, 'the campaign message');
        const all = await deps.templateVersions(ctx.tenantId);
        const version = Math.max(0, ...all.filter((v) => v.templateId === templateId).map((v) => v.version)) + 1;
        const draft: AiTemplateDraft = {
          templateId, version, purpose: b['purpose'] as AiTemplateDraft['purpose'], channel: b['channel'] as AiTemplateDraft['channel'],
          body: response.text.trim(), state: 'draft', draftedBy: ctx.userId, draftedAt: deps.now(),
          aiDraft: { agent: 'A09', callId: audit.callId, auditHash: audit.hash, citedEvidenceIds: response.citedEvidenceIds },
        };
        await deps.recordTemplateDraft(ctx.tenantId, draft);
        return {
          status: 201,
          body: {
            drafted: true, template: draft, suggestions: response.proposals.map((p) => ({ tool: p.tool, rationale: p.rationale })),
            costMinor: audit.actualCostMinor, committedAnything: false,
            nextSafeAction: 'A different person with template authority approves it before anything can be sent with it; the send still checks each customer\'s consent and the frequency cap.',
          },
        };
      },
    },
    {
      // A07: summarise the open anomalies and suggest which to look at first. Body: { summaryId, focus? }. Recorded for
      // the security officer; it opens, closes or sanctions nothing.
      api: 'API-13', method: 'POST', path: '/v1/ai/security/anomaly-summaries',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const summaryId = typeof b['summaryId'] === 'string' ? b['summaryId'].trim() : '';
        if (summaryId === '' || (b['focus'] !== undefined && !(isStr(b['focus']) && b['focus'].length <= 100))) {
          throw apiError(400, { code: 'not_readable_as_a_summary_request', whatHappened: 'An anomaly summary needs { summaryId, focus? (≤ 100 characters) }. The anomalies are read by head office.', wasItSaved: 'not_saved', nextSafeAction: 'Name the summary. Nothing was called or spent.' });
        }
        if ((await deps.anomalySummaries(ctx.tenantId)).some((s) => s.summaryId === summaryId)) {
          throw apiError(409, { code: 'summary_already_recorded', whatHappened: `A summary "${summaryId}" already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new summary id. Nothing was called or spent.' });
        }
        const investigations = deps.gateway.evidenceFor === undefined ? [] : await deps.gateway.evidenceFor(ctx.tenantId, 'A07');
        const raised = deps.raisedExceptionFacts === undefined ? [] : await deps.raisedExceptionFacts(ctx.tenantId);
        const focus = isStr(b['focus']) ? b['focus'].trim().toLowerCase() : undefined;
        const evidence = [...investigations, ...raised].filter((e) => focus === undefined || `${e.evidenceId} ${e.content}`.toLowerCase().includes(focus));
        const instruction = 'A07 summarise-anomalies: summarise the open investigations and rule breaches in the evidence, biggest exposure first, '
          + 'and suggest which to look at first. Suggest only — no sanction, no case action, no accusation beyond what the evidence says.';
        const { response, audit } = await call(ctx, 'A07', `summary-${summaryId}`, instruction, evidence);
        if (!audit.admission.allowed) refusedAdmission(audit);
        if (response.outcome !== 'answered' || response.text === undefined || response.citedEvidenceIds.length === 0) return notDrafted(response, audit, 'a summary');
        const summary: AnomalySummary = {
          summaryId, text: response.text, citedEvidenceIds: response.citedEvidenceIds,
          suggestedOrder: response.proposals.filter((p) => p.tool === 'prioritise_investigation')
            .flatMap((p) => (Array.isArray(p.arguments['order']) ? (p.arguments['order'] as unknown[]).filter((x): x is string => typeof x === 'string') : [])),
          evidenceCount: evidence.length, requestedBy: ctx.userId, callId: audit.callId, auditHash: audit.hash, at: deps.now(), committedAnything: false,
        };
        await deps.recordAnomalySummary(ctx.tenantId, summary);
        return { status: 201, body: { drafted: true, summary, costMinor: audit.actualCostMinor, committedAnything: false, nextSafeAction: 'A security officer reads it and decides what to investigate; the assistant opens and closes nothing.' } };
      },
    },
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/security/anomaly-summaries',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const summaries = [...await deps.anomalySummaries(ctx.tenantId)].sort((a, b) => b.at.localeCompare(a.at));
        return { status: 200, body: { summaries, count: summaries.length, committedAnything: false } };
      },
    },
  ];
}
