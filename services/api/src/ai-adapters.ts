// The AI adapter (API-13 · AI-NFR-01…12 · hard rule #5), moved out of adapters.ts as the full-roadmap audit asked
// (OB-288 lane 4 · P1). The bodies below are the ones adapters.ts held, unchanged: the agents' governed deps
// (`aiAdapter`), the governed model call's store (`modelGatewayAdapter`) and the small fold helpers they read with.
// adapters.ts re-exports both, so every existing import keeps working.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { ProductRecord, BarcodeAssignment, DataQualityFinding, SuggestionDisposition } from '../../../packages/product/src/index';
import { BarcodeRegistry, assessProductDataQuality, buildDataQualityWorklist } from '../../../packages/product/src/index';
import type { ExpiryActionItem } from '../../../packages/fefo/src/index';
import type { NearExpiryDeps } from '../../inventory/src/near-expiry';
import type { InvestigationCase } from '../../../packages/loss-prevention/src/cases';
import { buildOpenCaseWorklist, type OpenCaseWorklist } from '../../../packages/loss-prevention/src/worklist';
import type { DailyTask as WfDailyTask, TaskAssessment as WfTaskAssessment } from '../../../packages/workforce/src/workforce';
import { assessDailyTasks, taskGuidanceFindings } from '../../../packages/workforce/src/workforce';
import type { ImportJobRecord } from '../../purchase/src/import-quality';
import { assessMappingQuality, type MappingQualityFinding } from '../../../packages/import/src/index';
import type { LiveAlert } from '../../platform/src/alert-lifecycle';
import { recommendOperationsRunbooks, type OperationsFinding } from '../../../packages/ops/src/index';
import { draftMarketingAudiences } from '../../../packages/customer/src/index';
import type { CustomerProfile as SegCustomerProfile, CustomerConsent as SegCustomerConsent, MarketingAudienceDraft } from '../../../packages/customer/src/index';
import type { ServiceCase } from '../../customer/src/service-cases';
import type { ModelGatewayDeps, ModelCallAudit } from '../../ai/src/model-gateway';
import type { ModelTransport, ModelTier, TierPricing } from '../../../packages/ai/src/index';
import type { SlaView } from '../../../packages/service-desk/src/index';
import { assessFirstResponse } from '../../../packages/service-desk/src/index';
import type { AgentId, Budget, Proposal, EvidenceItem as AiEvidenceItem, AiDeps, InboxEntry } from '../../ai/src/index';
import { FACT_CONFIDENCE, RULE_CONFIDENCE } from '../../ai/src/index';
import { STREAM, streamName } from './adapters';
import { aiGovernanceStore, aiIncidentStore, modelRegistryStore, stoppedAgentsNow } from './ai-governance-stores';
import { approvedModelFor } from '../../ai/src/model-registry';
import { forecastReorders, quotationComparisons, inventoryPredictions } from './ai-predictions';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { aiGovernanceRoutes } from '../../ai/src/governance';
import { aiIncidentRoutes } from '../../ai/src/ai-incidents';
import { modelRegistryRoutes } from '../../ai/src/model-registry';
import { evaluationRoutes } from '../../ai/src/evaluations';
import { aiControlRoutes } from '../../ai/src/control';
import { evaluationStore } from './ai-governance-stores';
import { customerAdapter, serviceCaseAdapter, inventoryAdapter } from './adapters';
import type { PlacedOrder } from '../../orders/src/index';
import { latestLimits } from '../../ai/src/governance';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

// The fold helpers adapters.ts keeps private — the same few lines, so the moved bodies read exactly as they did.
const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;
async function allOf<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  const events = await store.readStream(tenantId, stream, { type });
  return events.map((e) => payloadOf<T>(e));
}
async function latest<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T | undefined> {
  const found = await store.latestOfType(tenantId, stream, type);
  return found === undefined ? undefined : payloadOf<T>(found);
}
function keyedEventId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}


/** The alerts still in play — a cleared one (PA-12) is history, not an incident to advise on. */
function liveNotCleared<T extends { readonly state: string }>(alerts: readonly T[]): readonly (T & { readonly state: 'open' | 'acknowledged' | 'escalated' })[] {
  return alerts.filter((a): a is T & { readonly state: 'open' | 'acknowledged' | 'escalated' } => a.state !== 'cleared');
}

/**
 * The domain endpoint a person calls to ACT on a data-quality finding — named, never invoked from
 * here. The AI drafts; a data steward acts through the ordinary catalogue route, which applies its
 * own permissions, approvals and audit (hard rule #5, P-05).
 */
const DATA_QUALITY_ROUTE: Readonly<Record<DataQualityFinding['kind'], string>> = {
  missing_barcode: 'POST /v1/catalogue/products/:productId/barcodes/:code',
  suspected_duplicate: 'POST /v1/catalogue/merges/:mergeId',
  missing_mrp: 'POST /v1/catalogue/products/:productId/publish',
};

/**
 * Turn A08's product data-quality findings into DRAFT proposals — each carrying the real product(s)
 * as evidence and naming the endpoint a human would call. No proposal here commits anything; the
 * run route stamps `committed: false` and the reply says `committedAnything: false`.
 */
function dataQualityProposals(findings: readonly DataQualityFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    // Deterministic from the finding — the same master yields the same proposal id.
    proposalId: f.findingId,
    agent: 'A08',
    summary: f.headline,
    wouldRequire: DATA_QUALITY_ROUTE[f.kind],
    // AI-NFR-04: a missing barcode or MRP is a recorded fact; two records LOOKING alike is an inference a steward confirms.
    confidence: f.kind === 'suspected_duplicate' ? { ...RULE_CONFIDENCE, uncertainty: 'Two records look alike by name, brand and size. They may still be genuinely different products — a steward checks before merging.' } : FACT_CONFIDENCE,
    evidence: f.evidence.map((e): AiEvidenceItem => ({
      source: 'product master',
      reference: e.sku.trim() === '' ? e.productId : e.sku,
      summary: `${e.name} — ${e.note}`,
    })),
    createdAt: now,
  }));
}

/**
 * Turn A08's suspicious-mapping findings into DRAFT proposals — each citing the SOURCE + column its rejection
 * history fingerprints, and naming where a steward reviews it. The action itself (re-map, agree a code list
 * with the supplier, fix the template) is off-system; the proposal points at the source's import-quality
 * review, and its evidence carries the count, the share and the corrective action. Commits nothing.
 */
function mappingQualityProposals(findings: readonly MappingQualityFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    proposalId: f.findingId,
    agent: 'A08',
    summary: f.headline,
    // Where a steward looks to act — the source's import-quality review (the fix is with the source, off-system).
    wouldRequire: 'GET /v1/purchase/import-quality/:sourceId',
    confidence: { ...RULE_CONFIDENCE, uncertainty: 'A pattern in this source\'s rejected rows points at one column. The cause may be the supplier\'s file, not the mapping — a steward checks.' },
    evidence: [{
      source: 'import history',
      reference: f.sourceId,
      summary: `"${f.column}": ${f.count} row(s) rejected (${Math.round(f.shareBps / 100)}% of this source's failures) — ${f.action}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A06's operational-incident findings into DRAFT proposals — each explaining a live incident and naming
 * its runbook, citing the real persisted alert as evidence. A06 recommends; an OPERATOR acknowledges the alert
 * (taking ownership) and runs the runbook. Commits nothing (hard rule #5 / P-05).
 */
function operationsProposals(findings: readonly OperationsFinding[], now: string): Omit<Proposal, 'committed'>[] {
  return findings.map((f): Omit<Proposal, 'committed'> => ({
    proposalId: f.findingId,
    agent: 'A06',
    summary: f.headline,
    // The governance action a person takes: acknowledge the alert (take ownership), then run the runbook.
    wouldRequire: 'POST /v1/platform/alerts/:alertId/acknowledge',
    confidence: { ...FACT_CONFIDENCE, uncertainty: 'The alert is open on the board. The runbook is the usual fix; the operator checks it fits before running it.' },
    evidence: [{
      source: 'operational alerts',
      reference: f.alertId,
      summary: `${f.component} ${f.status} (owner ${String(f.evidence['owner'] ?? 'unassigned')}) — Runbook: ${f.runbook}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A07's open investigations into prioritised DRAFT proposals — highest exposure first — each citing the
 * real case (its opaque SUBJECT REFERENCE, never a name — P-04) as evidence. A07 SUMMARISES and PRIORITISES;
 * it takes NO autonomous sanction (its whole authority forbids it). A security officer works the case through
 * the ordinary loss-prevention surface. Commits nothing (hard rule #5 / P-05).
 */
function investigationProposals(worklist: OpenCaseWorklist, now: string): Omit<Proposal, 'committed'>[] {
  return worklist.cases.map((c): Omit<Proposal, 'committed'> => ({
    proposalId: `sec-investigation:${c.caseId}`,
    agent: 'A07',
    summary: `Prioritise open investigation on ${c.subjectRef}: ${c.summary}`,
    // Where a security officer works it — the open-investigations worklist (the fix is casework, not an AI act).
    wouldRequire: 'GET /v1/loss-prevention/cases',
    confidence: { ...RULE_CONFIDENCE, uncertainty: 'Ordered by the money at stake. Whether anything was wrong at all is for the security officer to find out — this is not a finding of guilt.' },
    evidence: [{
      source: 'loss-prevention cases',
      reference: c.caseId,
      summary: `subject ${c.subjectRef}: ${c.summary} — ${Math.round(c.valueMinor / 100)} at stake, ${c.evidenceCount} evidence item(s), open since ${shopDateIn(c.openedAt)}, assigned to ${c.assignedTo}`,
    }],
    createdAt: now,
  }));
}

/**
 * Turn A03's near-expiry stock into DRAFT proposals — a markdown for a batch close to its use-by, a disposal
 * for one already expired, worst-first (the order the tested `nearExpiryStock` already returns). Each cites the
 * real batch on the cloud ledger (id, product, net-of-sales quantity on hand, expiry, days left) as evidence.
 * A03 SUGGESTS; a **manager** commits the money action the proposal names — a markdown through the price-change
 * approval path (`POST /v1/prices/changes`), a disposal through the write-off path — never the agent (hard rule
 * #5 / P-05). A markdown is a price change and a disposal removes stock, so neither is ever committed here.
 */
function inventoryProposals(items: readonly ExpiryActionItem[], now: string): Omit<Proposal, 'committed'>[] {
  return items.map((i): Omit<Proposal, 'committed'> => {
    const dispose = i.action === 'dispose';
    return {
      proposalId: `inv-${i.action}:${i.batchId}`,
      agent: 'A03',
      summary: dispose
        ? `Dispose batch ${i.batchId} of ${i.productId} — expired ${i.expiry}, ${i.qty} still on hand`
        : `Mark down batch ${i.batchId} of ${i.productId} — expires ${i.expiry} in ${i.daysToExpiry} day(s), ${i.qty} on hand`,
      // The governance action a manager commits — the AI only recommends it (hard rule #5).
      wouldRequire: dispose ? 'POST /v1/inventory/write-off/:writeOffId' : 'POST /v1/prices/changes',
      confidence: { ...FACT_CONFIDENCE, uncertainty: 'The batch, its quantity and its expiry date are on record. Whether a markdown will sell it in time is not known — the manager judges.' },
      evidence: [{
        source: 'near-expiry stock (cloud ledger)',
        reference: i.batchId,
        summary: `${i.productId} batch ${i.batchId}: ${i.qty} on hand, expiry ${i.expiry} (${i.status}, ${i.daysToExpiry} day(s) to expiry) → ${i.action}`,
      }],
      createdAt: now,
    };
  });
}

/**
 * Turn A10's daily-task assessment into DRAFT guidance proposals — the ESCALATED (critical + overdue) and
 * OVERDUE tasks that need a person's attention, worst-first (the order `assessDailyTasks` already returns).
 * A10 gives role-aware guidance and takes NO HR decision (its whole authority forbids it): it flags what
 * needs attention; a MANAGER assigns or completes the task through the ordinary workforce route. Commits
 * nothing (hard rule #5 / P-05).
 */
function workforceGuidanceProposals(assessments: readonly WfTaskAssessment[], now: string): Omit<Proposal, 'committed'>[] {
  return assessments
    .filter((a) => a.status === 'escalated' || a.status === 'overdue')
    .map((a): Omit<Proposal, 'committed'> => ({
      proposalId: `wf-guidance:${a.status}:${a.taskId}`,
      agent: 'A10',
      summary: a.status === 'escalated'
        ? `Escalate: "${a.description}" (${a.forRole}) is CRITICAL and ${a.overdueByMinutes ?? 0} min overdue — needs the manager on duty`
        : `Overdue: "${a.description}" (${a.forRole}) is ${a.overdueByMinutes ?? 0} min overdue — assign someone`,
      // The governance action a MANAGER takes — complete/assign the task; the AI only flags it (hard rule #5).
      wouldRequire: 'POST /v1/hr/workforce/tasks/:taskId/complete',
      confidence: { ...FACT_CONFIDENCE, uncertainty: 'The task board says it is overdue. It may have been done and not ticked — the manager checks on the floor.' },
      evidence: [{
        source: 'workforce daily tasks',
        reference: a.taskId,
        summary: `${a.description} — role ${a.forRole}${a.branchId === undefined ? '' : `, branch ${a.branchId}`}: ${a.detail}`,
      }],
      createdAt: now,
    }));
}

/**
 * Turn A09's drafted marketing audiences into DRAFT campaign-idea proposals — the segments worth a campaign,
 * best-margin-first (the order `draftMarketingAudiences` already returns). A09 DRAFTS segments within consent
 * and margin and takes NO commercial action (its authority forbids it): it names an audience worth targeting
 * and STATES the reach honestly — the contactable count and the number excluded for want of consent (P-08) —
 * and a MARKETING APPROVER builds and sends any campaign. Commits nothing (hard rule #5 / P-05); there is no
 * auto-send, and the per-channel consent check still binds at send time.
 */
function marketingGuidanceProposals(audiences: readonly MarketingAudienceDraft[], now: string): Omit<Proposal, 'committed'>[] {
  return audiences.map((a): Omit<Proposal, 'committed'> => ({
    proposalId: `mkt-audience:${a.segment}`,
    agent: 'A09',
    summary: `Campaign idea: the "${a.segment}" audience — ${a.contactable} contactable customer(s), ~${a.marginMinor} in lifetime margin`
      + (a.excludedForConsent > 0 ? ` (${a.excludedForConsent} more match but have not consented and are not contactable)` : ''),
    // The governance action a MARKETING APPROVER takes — build and send the campaign; the AI only drafts the
    // audience (hard rule #5). No campaign route is auto-called: a person reviews consent, offer and margin.
    wouldRequire: 'a marketing approver reviews and launches a campaign to this audience (no auto-send)',
    confidence: { ...RULE_CONFIDENCE, uncertainty: 'The reach counts the customers who have consented today. Consent can be withdrawn before a send — it is checked again for every message.' },
    evidence: [{ source: 'customer segments', reference: a.segment, summary: a.detail }],
    createdAt: now,
  }));
}

/**
 * A09's `draft_offer` leg (OB-288 lane 4 · P1 · roadmap §7 "offers within consent/margin rules"): for each audience its
 * deterministic leg found within consent, a DRAFT offer for a marketing approver to build through the promotion route —
 * which SIMULATES the margin first and lets a margin-losing offer launch only with a second person's approval (§28,
 * services/pricing/src/promotions.ts). No discount is invented here: what to offer, and how much, is the approver's;
 * the margin check is the promotion route's, never this draft's. Commits nothing; there is no auto-launch.
 */
function offerProposals(audiences: readonly MarketingAudienceDraft[], now: string): Omit<Proposal, 'committed'>[] {
  return audiences.map((a): Omit<Proposal, 'committed'> => ({
    proposalId: `mkt-offer:${a.segment}`,
    agent: 'A09',
    summary: `Offer idea for the "${a.segment}" audience (${a.contactable} consented customer(s)): build an offer they would value, simulate its margin, and launch it only if the margin check passes — or with a second person's approval if it loses margin`,
    wouldRequire: 'POST /v1/promotions/:promotionId/simulate then POST /v1/promotions/:promotionId/launch, by a marketing approver (§28)',
    evidence: [{ source: 'customer segments (consent checked)', reference: a.segment, summary: a.detail }],
    createdAt: now,
    confidence: { ...RULE_CONFIDENCE, uncertainty: 'The audience is the consented customers today. Whether any offer keeps its margin is not known until the promotion route simulates it.' },
  }));
}

/**
 * Turn A05's first-response SLA assessment into DRAFT service proposals — the OPEN cases nobody has replied
 * to yet that are past (breached) or near (at-risk) their first-response promise, worst-first. A05 answers
 * policy/order questions and DRAFTS case responses, and EXCEPTIONS ESCALATE to a person (its purpose): it
 * flags which customer is waiting and by how long, and a SERVICE AGENT replies (a supervisor approves any
 * AI-drafted reply). Commits nothing (hard rule #5 / P-05) — the first-response clock is the wait a customer
 * actually feels, so surfacing it is exactly the help without ever answering on the shop's behalf.
 */
function serviceGuidanceProposals(views: readonly { readonly serviceCase: ServiceCase; readonly sla: SlaView }[], now: string): Omit<Proposal, 'committed'>[] {
  return views.map(({ serviceCase: c, sla }): Omit<Proposal, 'committed'> => ({
    proposalId: `svc-case:${sla.status}:${c.caseId}`,
    agent: 'A05',
    summary: sla.shouldEscalate
      ? `Escalate: case ${c.caseId} ("${c.summary}", ${c.priority} ${c.kind}) has BREACHED its first-response SLA — ${sla.detail}`
      : `Reply soon: case ${c.caseId} ("${c.summary}", ${c.priority} ${c.kind}) is at risk of breaching — ${sla.detail}`,
    // The governance action a SERVICE AGENT takes — reply to the customer; the AI only flags it (hard rule #5).
    wouldRequire: 'POST /v1/service/cases/:caseId/first-response',
    confidence: { ...FACT_CONFIDENCE, uncertainty: 'The case and its clock are on record. A reply given off the system (a phone call) is not known here.' },
    evidence: [{ source: 'service desk cases', reference: c.caseId, summary: `${c.kind} from ${c.customerRef}: ${sla.detail}` }],
    createdAt: now,
  }));
}

/**
 * EA-09: annotate a shared-inbox entry from the SAME draft proposal a run of the agent raises for that finding (the ids
 * are the same by construction) — its evidence and the route a person acts through — and the branch of the governed
 * record behind it (`null` = shop-wide). An entry with no matching proposal carries no evidence, so the inbox withholds it.
 */
function annotateInbox<E extends { readonly finding: { readonly findingId: string } }>(
  proposals: readonly Omit<Proposal, 'committed'>[], branchOf: (entry: E) => string | null,
): (entry: E) => InboxEntry<E> {
  const byId = new Map(proposals.map((p) => [p.proposalId, p]));
  return (entry) => {
    const p = byId.get(entry.finding.findingId);
    return { ...entry, branchId: branchOf(entry), evidence: p?.evidence ?? [], wouldRequire: p?.wouldRequire ?? '', confidence: p?.confidence ?? RULE_CONFIDENCE };
  };
}

export function aiAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * The live product master and its barcode register, for the Data Quality agent (A08). Optional:
   * without them A08 finds nothing rather than throwing — the same shape as every other agent whose
   * data source is not yet wired. The readers are the tested product/barcode folds, reused verbatim.
   */
  readonly products?: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly barcodes?: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
  /**
   * The tenant's import history (M30-FR-04), for A08's suspicious-mapping leg. Optional, same shape as the
   * others: without it A08 simply raises no mapping findings. The tested import-quality fold, reused verbatim.
   */
  readonly importHistory?: (tenantId: string) => Promise<readonly ImportJobRecord[]> | readonly ImportJobRecord[];
  /**
   * The tenant's live operational alerts (M35-FR-04), for the Operations agent (A06). Optional, same shape as
   * the others: without it A06 recommends nothing. The tested alert-lifecycle fold, reused verbatim.
   */
  readonly operationsAlerts?: (tenantId: string) => Promise<readonly LiveAlert[]> | readonly LiveAlert[];
  /**
   * The tenant's loss-prevention investigation cases (M15-FR-04), for the Security/Fraud agent (A07).
   * Optional, same shape as the others: without it A07 prioritises nothing. The tested LP case fold, reused
   * verbatim; the worklist ordering is the tested `buildOpenCaseWorklist`.
   */
  readonly investigations?: (tenantId: string) => Promise<readonly InvestigationCase[]> | readonly InvestigationCase[];
  /**
   * The tenant's stored daily tasks (M25-FR-02), for the Workforce/SOP guidance agent (A10). Optional, same
   * shape as the others: without it A10 recommends nothing. The tested task-store fold, reused verbatim — the
   * same DailyTask list the tasks board runs `assessDailyTasks` over, so A10 flags the same tasks a human sees.
   */
  readonly dailyTasks?: (tenantId: string) => Promise<readonly WfDailyTask[]> | readonly WfDailyTask[];
  /**
   * The tenant's marketing-draft inputs (M16-FR-02), for the Marketing agent (A09): a profile per known
   * customer (marketing purpose) + each customer's folded consent, from the SAME stored facts + consent
   * ledger the stateful segmentation reads (`marketingDraftInputs`). Optional, same shape as the others:
   * without it A09 drafts nothing. `draftMarketingAudiences` runs here over what it returns.
   */
  readonly marketingDraft?: (tenantId: string) => Promise<{ readonly profiles: readonly SegCustomerProfile[]; readonly consents: readonly SegCustomerConsent[] }>;
  /** EA-08: the Customer Shopping agent's (A04) in-stock alternatives, from the product master, pack and stock ledger. */
  readonly shoppingAlternatives?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  /**
   * The tenant's service-desk cases (M21), for the Service agent (A05). Optional, same shape as the others:
   * without it A05 surfaces nothing. The tested serviceCases fold the desk board reads; A05 runs the tested
   * assessFirstResponse over the OPEN, unanswered ones, so it flags the same waiting customers a human sees.
   */
  readonly serviceCases?: (tenantId: string) => Promise<readonly ServiceCase[]> | readonly ServiceCase[];
  /**
   * The tenant's near-expiry stock (M10-FR-01 · ADR-0015), for the Inventory agent (A03). Optional, same shape
   * as the others: without it A03 suggests nothing. The tested `nearExpiryStock` fold over the cloud ledger —
   * the SAME reader the `/v1/inventory/near-expiry` route uses (`nearExpiryAdapter(...).nearExpiry`).
   */
  readonly nearExpiry?: NearExpiryDeps['nearExpiry'];
  /** EA-08 — A01's read-only insights and A02's stock-out reorder drafts, from the governed readers (ai-insights.ts). */
  readonly ownerInsights?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  readonly purchaseSuggestions?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
  /** Round 8 — A03's transfer-suggestion leg: out at a selling place, held elsewhere (ai-insights.ts `transferSuggestions`). */
  readonly transferSuggestions?: (tenantId: string) => Promise<Omit<Proposal, 'committed'>[]>;
}): AiDeps {
  return {
    now: input.now,

    /**
     * Default **on** — the safe direction, and the opposite of every other default here.
     *
     * Everywhere else in this file the absence of a record means "we cannot say". Here it means
     * "stopped", because the kill switch is the one control whose failure mode is asymmetric: a
     * switch that defaults off is an agent running because nobody has told it not to.
     */
    killSwitchOn: async (tenantId, agent) => {
      // One row. This folded every kill-switch change ever made to look at the last one.
      const master = (await latest<{ readonly on: boolean }>(input.store, tenantId, STREAM.ai, 'AiKillSwitchSet'))?.on ?? true;
      if (master || agent === undefined) return master;
      // AI-NFR-10 (OB-288 lane 4 · P1): and the scoped switches — all AI, the customer-facing ones, or this one agent.
      return (await stoppedAgentsNow(input.store, tenantId)).includes(agent);
    },

    setKillSwitch: async (tenantId, on, by, at, reason) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('kill', `kill-${tenantId}-${at}-${String(on)}`),
        type: 'AiKillSwitchSet',
        occurredAt: at,
        idempotencyKey: `kill-${tenantId}-${at}-${String(on)}`,
        source: 'api/ai',
        payload: { on, by, at, ...(reason === undefined ? {} : { reason }) },
      }));
    },

    // AI-NFR-10: each agent's own ceiling against its own metered spend, and the total the shop cap must cover.
    agentCeiling: async (tenantId, agent) => {
      const gov = aiGovernanceStore({ store: input.store, now: input.now });
      const l = latestLimits(await gov.agentLimits(tenantId)).get(agent);
      if (l === undefined) return undefined;
      return { ceilingMinor: l.ceilingMinor, spentMinor: (await gov.spendByAgent(tenantId))[agent] ?? 0 };
    },
    agentCeilingsTotal: async (tenantId) =>
      [...latestLimits(await aiGovernanceStore({ store: input.store, now: input.now }).agentLimits(tenantId)).values()].reduce((t, l) => t + l.ceilingMinor, 0),
    proposalOutcomes: async (tenantId) => aiGovernanceStore({ store: input.store, now: input.now }).proposalOutcomes(tenantId),

    /** No budget granted means nothing may be spent. Zero is the honest starting point here. */
    budget: async (tenantId) => {
      const cap = await latest<Budget>(input.store, tenantId, STREAM.ai, 'AiBudgetSet');
      // Spend genuinely is a sum, and it is bounded by the budget period rather than by history.
      const spent = await allOf<{ readonly costMinor: number }>(
        input.store, tenantId, STREAM.ai, 'AiRunCosted',
      );
      return {
        capMinor: cap?.capMinor ?? 0,
        spentMinor: spent.reduce((t, s) => t + s.costMinor, 0),
        periodEnds: cap?.periodEnds ?? input.now(),
      };
    },

    setBudget: async (tenantId, budget, by, at) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ai-budget', `ai-budget-${tenantId}-${at}`),
        type: 'AiBudgetSet',
        occurredAt: at,
        // Keyed on the moment it was set — a later cap is the owner changing the limit, latest wins;
        // the same set re-sent (a retry) collapses.
        idempotencyKey: `ai-budget-${tenantId}-${at}`,
        source: 'api/ai',
        payload: { capMinor: budget.capMinor, periodEnds: budget.periodEnds, by, at },
      }));
    },

    /** Nothing is enabled until somebody enables it, by name (AID-01…10). */
    enabledAgents: async (tenantId) =>
      (await latest<{ readonly agents: readonly AgentId[] }>(
        input.store, tenantId, STREAM.ai, 'AiAgentsEnabled',
      ))?.agents ?? [],

    setEnabledAgents: async (tenantId, agents, by, at) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ai-enabled', `ai-enabled-${tenantId}-${at}`),
        type: 'AiAgentsEnabled',
        occurredAt: at,
        // The enabled SET as of this moment — latest wins, so enabling is declarative (the new list is
        // the whole truth), not additive; a re-sent identical change collapses.
        idempotencyKey: `ai-enabled-${tenantId}-${at}`,
        source: 'api/ai',
        payload: { agents, by, at },
      }));
    },

    /**
     * A run READS and DRAFTS — it commits nothing and, for A08, writes nothing to any store.
     *
     * The Data Quality agent (A08) is deterministic and needs no model: it scans the tenant's live
     * product master for the gaps that can actually occur — a sellable item with no barcode, two
     * records that look like the same thing, an item with no printed MRP — and returns each as a
     * DRAFT proposal citing the real product(s). A person acts through the ordinary catalogue
     * endpoint the proposal names; nothing here changes any product (hard rule #5, P-05).
     *
     * Every other agent still returns nothing — it becomes reachable when its own data source is
     * wired (and, for a model-backed agent, a provider is chosen, OB-02).
     */
    // EA-08: every run is recorded — the run, its server-metered cost, and each accepted proposal onto the register —
    // in ONE atomic write, idempotent on the run id.
    recordRun: async (tenantId, run) => {
      await input.store.appendBatch(tenantId, [
        { stream: STREAM.ai, event: makeEvent({ id: `ai-run-${run.runId}`, type: 'AiRunRecorded', occurredAt: run.at, idempotencyKey: `ai-run-${tenantId}-${run.runId}`, source: 'api/ai', payload: run }) },
        { stream: STREAM.ai, event: makeEvent({ id: `ai-cost-${run.runId}`, type: 'AiRunCosted', occurredAt: run.at, idempotencyKey: `ai-cost-${tenantId}-${run.runId}`, source: 'api/ai', payload: { runId: run.runId, agent: run.agent, costMinor: run.costMinor, calledAModel: run.calledAModel } }) },
        ...run.proposals.map((p) => ({ stream: STREAM.ai, event: makeEvent({ id: `ai-proposal-${p.proposalId}`, type: 'AiProposalRaised', occurredAt: run.at, idempotencyKey: `ai-proposal-${tenantId}-${p.proposalId}`, source: 'api/ai', payload: p }) })),
      ]);
    },

    run: async (tenantId, agent) => {
      const now = input.now();
      // A01 Owner Intelligence — read-only insights from the governed reports; proposes no action (EA-08).
      if (agent === 'A01') return input.ownerInsights === undefined ? [] : input.ownerInsights(tenantId);
      // A02 Purchase — stock-outs with recent demand, as DRAFTS for a buyer; no quantity invented, no order raised.
      // OB-288 lane 4 · P1: and the D-1 forecast leg (likely to run out within seven days) and the quotation comparison.
      if (agent === 'A02') {
        if (input.purchaseSuggestions === undefined) return [];
        return [...await input.purchaseSuggestions(tenantId), ...await forecastReorders(input.store, tenantId, now), ...await quotationComparisons(input.store, tenantId, now)];
      }
      // A04 Customer Shopping — in-stock alternatives for what has run out, as DRAFTS the customer confirms (EA-08).
      if (agent === 'A04') return input.shoppingAlternatives === undefined ? [] : input.shoppingAlternatives(tenantId);
      // A08 Data Quality — the product master + import history.
      if (agent === 'A08') {
        const proposals: Omit<Proposal, 'committed'>[] = [];
        // Leg 1+2 — the product master: missing barcode / suspected duplicate / missing MRP.
        if (input.products !== undefined && input.barcodes !== undefined) {
          const findings = assessProductDataQuality({
            products: await input.products(tenantId),
            barcodes: new BarcodeRegistry(await input.barcodes(tenantId)),
          });
          proposals.push(...dataQualityProposals(findings, now));
        }
        // Leg 3 — suspicious mappings from import history: a source that keeps failing on one column.
        // An independent data source, so it runs whether or not the product master is wired.
        if (input.importHistory !== undefined) {
          const findings = assessMappingQuality({ jobs: await input.importHistory(tenantId) });
          proposals.push(...mappingQualityProposals(findings, now));
        }
        return proposals;
      }
      // A06 Operations — explain the live operational incidents and recommend a runbook for each.
      if (agent === 'A06') {
        if (input.operationsAlerts === undefined) return [];
        const findings = recommendOperationsRunbooks(liveNotCleared(await input.operationsAlerts(tenantId)));
        return operationsProposals(findings, now);
      }
      // A07 Security/Fraud — prioritise the open investigations by exposure. NO autonomous sanctions.
      if (agent === 'A07') {
        if (input.investigations === undefined) return [];
        const worklist = buildOpenCaseWorklist(await input.investigations(tenantId));
        return investigationProposals(worklist, now);
      }
      // A03 Inventory — the near-expiry stock now on hand: mark down before it expires, dispose what already has.
      // Round 8: and the transfer leg — out at a selling place while another place of the company holds it (a manager decides).
      if (agent === 'A03') {
        const items = input.nearExpiry === undefined ? [] : await input.nearExpiry(tenantId, { asOf: shopDateIn(now), nearExpiryDays: 7 }); // R1c: the shop's today
        const transfers = input.transferSuggestions === undefined ? [] : await input.transferSuggestions(tenantId);
        // OB-288 lane 4 · P1: the prediction legs — a forecast stock-out with stock to spare elsewhere, overstock, and a
        // batch that will not sell before its expiry at the rate it sells.
        const predicted = input.transferSuggestions === undefined ? [] : await inventoryPredictions(input.store, tenantId, now, input.nearExpiry);
        return [...inventoryProposals(items, now), ...transfers, ...predicted];
      }
      // A10 Workforce/SOP guidance — the day's tasks that need attention (escalated + overdue), role-aware.
      // NO HR decision (its authority forbids it): it flags, a manager assigns/completes. The SAME tested
      // `assessDailyTasks` over the SAME stored tasks the workforce board reads.
      if (agent === 'A10') {
        if (input.dailyTasks === undefined) return [];
        const report = assessDailyTasks({ tasks: await input.dailyTasks(tenantId), now });
        return workforceGuidanceProposals(report.assessments, now);
      }
      // A09 Marketing — the segments worth a campaign, within consent and by margin, best-margin-first. NO
      // commercial action (its authority forbids it): it drafts the audience, a marketing approver launches.
      // The SAME tested segmentation over the SAME stored facts + consent the audience board reads (M16-FR-02).
      if (agent === 'A09') {
        if (input.marketingDraft === undefined) return [];
        const { profiles, consents } = await input.marketingDraft(tenantId);
        const audiences = draftMarketingAudiences({ profiles, consents });
        // OB-288 lane 4 · P1: and a draft OFFER per audience, for the promotion route's margin check and a marketing approver.
        return [...marketingGuidanceProposals(audiences, now), ...offerProposals(audiences, now)];
      }
      // A05 Service — the open cases nobody has answered yet that are breaching/at-risk on first response,
      // worst-first. Exceptions escalate; a service agent replies (hard rule #5). The SAME tested
      // assessFirstResponse over the SAME stored cases the service-desk board reads.
      if (agent === 'A05') {
        if (input.serviceCases === undefined) return [];
        const views = (await input.serviceCases(tenantId))
          .filter((c) => c.state === 'open' && c.firstRespondedAt === undefined)
          .map((c) => ({ serviceCase: c, sla: assessFirstResponse({ serviceCase: c, now }) }))
          .filter((v) => v.sla.status === 'breached' || v.sla.status === 'at_risk')
          .sort((a, b) =>
            Number(b.sla.shouldEscalate) - Number(a.sla.shouldEscalate) // breached (escalate) before at-risk
            || a.sla.remainingMinutes - b.sla.remainingMinutes          // most overdue / least time left first
            || a.serviceCase.caseId.localeCompare(b.serviceCase.caseId));
        return serviceGuidanceProposals(views, now);
      }
      return [];
    },

    openProposals: (tenantId) => allOf<Proposal>(input.store, tenantId, STREAM.ai, 'AiProposalRaised'),

    /**
     * The Data Quality steward's inbox — the live A08 findings folded with the stewards' dismissals.
     * A pure READ: it re-derives the findings from the current master (so a fixed gap leaves the list
     * on its own) and folds the dismissals latest-per-finding. Nothing is written here.
     */
    dataQualityWorklist: async (tenantId) => {
      // One dismissal ledger serves BOTH legs — a steward's judgement is keyed by findingId, and the
      // two families of id never collide (`dq-*` for product gaps, `dq-mapping:*` for suspicious
      // mappings), so a single latest-per-id fold applies each decision to whichever finding it names.
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiDataQualityDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const dispositions = [...latest.values()];

      // Leg 1+2 — the product master.
      const productFindings = (input.products === undefined || input.barcodes === undefined)
        ? []
        : assessProductDataQuality({
            products: await input.products(tenantId),
            barcodes: new BarcodeRegistry([...(await input.barcodes(tenantId))]),
          });
      const productWL = buildDataQualityWorklist({ findings: productFindings, dispositions });

      // Leg 3 — suspicious mappings from import history (an independent source; absent → nothing here).
      const mappingFindings = input.importHistory === undefined
        ? []
        : assessMappingQuality({ jobs: await input.importHistory(tenantId) });
      const mappingWL = buildDataQualityWorklist({ findings: mappingFindings, dispositions });

      // Merge the two folds into one worklist, each entry tagged by its source so the screen can label
      // it. Product suggestions lead (the everyday catalogue gaps), then the mapping suggestions.
      // EA-09: both legs rest on shop-wide records (one product master, P-02; import sources are head office's), so
      // their branch is null — every reader sees them, only a company-wide steward sets one aside.
      const now = input.now();
      const product = annotateInbox<{ readonly source: 'product' } & (typeof productWL.open)[number]>(dataQualityProposals(productFindings, now), () => null);
      const mapping = annotateInbox<{ readonly source: 'mapping' } & (typeof mappingWL.open)[number]>(mappingQualityProposals(mappingFindings, now), () => null);
      const open = [
        ...productWL.open.map((i) => product({ source: 'product' as const, ...i })),
        ...mappingWL.open.map((i) => mapping({ source: 'mapping' as const, ...i })),
      ];
      const dismissed = [
        ...productWL.dismissed.map((i) => product({ source: 'product' as const, ...i })),
        ...mappingWL.dismissed.map((i) => mapping({ source: 'mapping' as const, ...i })),
      ];
      return { open, dismissed, openCount: open.length, dismissedCount: dismissed.length };
    },

    /**
     * A steward's judgement that a suggestion is (not) a problem — a HUMAN write, recorded in the
     * human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins;
     * a reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6).
     */
    recordDataQualityDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('dq-disposition', `dq-disposition-${tenantId}-${key}`),
        type: 'AiDataQualityDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `dq-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },

    /**
     * The Operations operator's inbox (A06) — the live incident recommendations folded with the operators'
     * dismissals. A pure READ: it RE-DERIVES the recommendations from the live alerts (the SAME tested
     * recommendOperationsRunbooks the run uses), so an incident that has been acknowledged/cleared leaves the
     * list on its own; the inbox never drifts from the live alert board. Dismissals fold latest-per-finding.
     * Nothing is written here. Without an alerts reader wired, the list is simply empty.
     */
    operationsWorklist: async (tenantId) => {
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiOperationsDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const findings = input.operationsAlerts === undefined
        ? []
        : recommendOperationsRunbooks(liveNotCleared(await input.operationsAlerts(tenantId)));
      const wl = buildDataQualityWorklist({ findings, dispositions: [...latest.values()] });
      // EA-09: the branch is the one the alert's rule watches (a store computer's own component); none = shop-wide.
      const annotate = annotateInbox<(typeof wl.open)[number]>(operationsProposals(findings, input.now()), (e) => e.finding.branchId ?? null);
      return { ...wl, open: wl.open.map(annotate), dismissed: wl.dismissed.map(annotate) };
    },

    /**
     * An operator's judgement that a recommendation is (not) worth acting on — a HUMAN write, recorded in the
     * human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins; a
     * reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6).
     */
    recordOperationsDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('ops-disposition', `ops-disposition-${tenantId}-${key}`),
        type: 'AiOperationsDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `ops-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },

    /**
     * The Workforce/SOP manager's inbox (A10) — the day's escalated/overdue task guidance folded with the
     * managers' dismissals. A pure READ: it RE-DERIVES the guidance from the live daily tasks (the SAME tested
     * assessDailyTasks the run uses, at the current clock so "overdue" is measured now), so a task that has
     * been completed/assigned leaves the list on its own; the inbox never drifts from the task board.
     * Dismissals fold latest-per-finding. Nothing is written here. Without a tasks reader wired, the list is
     * simply empty.
     */
    workforceWorklist: async (tenantId) => {
      const latest = new Map<string, SuggestionDisposition>();
      for (const d of await allOf<SuggestionDisposition>(input.store, tenantId, STREAM.ai, 'AiWorkforceDismissed')) {
        latest.set(d.findingId, d); // occurrence order → the last decision on a finding wins
      }
      const report = input.dailyTasks === undefined ? undefined : assessDailyTasks({ tasks: await input.dailyTasks(tenantId), now: input.now() });
      const findings = report === undefined ? [] : taskGuidanceFindings(report);
      const wl = buildDataQualityWorklist({ findings, dispositions: [...latest.values()] });
      // EA-09: the branch is the task's own (a task naming none is shop-wide).
      const annotate = annotateInbox<(typeof wl.open)[number]>(workforceGuidanceProposals(report?.assessments ?? [], input.now()), (e) => e.finding.branchId ?? null);
      return { ...wl, open: wl.open.map(annotate), dismissed: wl.dismissed.map(annotate) };
    },

    /**
     * A manager's judgement that a piece of guidance is (not) worth acting on now — a HUMAN write, recorded in
     * the human's name (`by` is the authenticated caller, stamped by the route). Append-only, latest-wins; a
     * reopen (`dismissed:false`) is another event, never an erasure (hard rule #2/#6). It records only the
     * manager's set-aside note — it commits no HR action (the task is completed/assigned the ordinary way).
     */
    recordWorkforceDisposition: async (tenantId, disposition, key) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: keyedEventId('wf-disposition', `wf-disposition-${tenantId}-${key}`),
        type: 'AiWorkforceDismissed',
        occurredAt: disposition.at,
        idempotencyKey: `wf-disposition-${tenantId}-${key}`,
        source: 'api/ai',
        payload: disposition,
      }));
    },
  };
}

// ── EA-08: the governed model call — admission, reservation, metering, immutable audit ──────────────────────────────

export function modelGatewayAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly transport?: ModelTransport;
  readonly pricing?: Readonly<Record<ModelTier, TierPricing>>;
  /** EA-08: the agent's governed evidence, read server-side from its domain readers. */
  readonly evidenceFor?: ModelGatewayDeps['evidenceFor'];
}): ModelGatewayDeps {
  const ai = aiAdapter({ store: input.store, now: input.now });
  return {
    now: input.now,
    killSwitchOn: ai.killSwitchOn,
    enabledAgents: ai.enabledAgents,
    budget: ai.budget,
    openReservedMinor: async (tenantId) => {
      const reserved = await allOf<{ readonly callId: string; readonly amountMinor: number }>(input.store, tenantId, STREAM.ai, 'AiCostReserved');
      const settled = new Set((await allOf<{ readonly runId: string }>(input.store, tenantId, STREAM.ai, 'AiRunCosted')).map((c) => c.runId));
      return reserved.filter((r) => !settled.has(r.callId)).reduce((t, r) => t + r.amountMinor, 0);
    },
    reserve: async (tenantId, r) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({ id: `ai-reserve-${r.callId}`, type: 'AiCostReserved', occurredAt: r.at, idempotencyKey: `ai-reserve-${tenantId}-${r.callId}`, source: 'api/ai', payload: r }));
    },
    settle: async (tenantId, s) => {
      // The SAME AiRunCosted fact the budget sums — the actual, metered cost, keyed on the call.
      await input.store.append(tenantId, STREAM.ai, makeEvent({ id: `ai-cost-${s.callId}`, type: 'AiRunCosted', occurredAt: s.at, idempotencyKey: `ai-cost-${tenantId}-${s.callId}`, source: 'api/ai', payload: { runId: s.callId, agent: s.agent, costMinor: s.actualMinor, reservedMinor: s.reservedMinor, calledAModel: true } }));
    },
    audits: (tenantId) => allOf<ModelCallAudit>(input.store, tenantId, streamName(STREAM.ai, 'model-calls'), 'AiModelCallAudited'),
    appendAudit: async (tenantId, a) => {
      await input.store.append(tenantId, streamName(STREAM.ai, 'model-calls'), makeEvent({ id: `ai-model-call-${a.callId}`, type: 'AiModelCallAudited', occurredAt: a.at, idempotencyKey: `ai-model-call-${tenantId}-${a.callId}`, source: 'api/ai', payload: a }));
    },
    ...(input.pricing === undefined ? {} : { pricing: () => input.pricing }),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.evidenceFor === undefined ? {} : { evidenceFor: input.evidenceFor }),
    // OB-288 lane 4 · P1 — AI-NFR-01: only a model on the approved register; AI-NFR-10: the agent's own ceiling and
    // call-rate limit; §30.2: blocked tool calls recorded and raised as AI incidents; OB-296: free text off.
    approvedModel: (tenantId, tier) => approvedModelFor(modelRegistryStore({ store: input.store }), tenantId, tier),
    agentLimit: async (tenantId, agent) => latestLimits(await aiGovernanceStore({ store: input.store, now: input.now }).agentLimits(tenantId)).get(agent),
    agentSpentMinor: async (tenantId, agent) => (await aiGovernanceStore({ store: input.store, now: input.now }).spendByAgent(tenantId))[agent] ?? 0,
    agentOpenReservedMinor: async (tenantId, agent) => {
      const reserved = await allOf<{ readonly callId: string; readonly agent: AgentId; readonly amountMinor: number }>(input.store, tenantId, STREAM.ai, 'AiCostReserved');
      const settled = new Set((await allOf<{ readonly runId: string }>(input.store, tenantId, STREAM.ai, 'AiRunCosted')).map((c) => c.runId));
      return reserved.filter((r) => r.agent === agent && !settled.has(r.callId)).reduce((t, r) => t + r.amountMinor, 0);
    },
    recordBlockedTools: (tenantId, blocked) => aiIncidentStore({ store: input.store }).recordBlocked(tenantId, blocked),
    raiseIncident: (tenantId, incident) => aiIncidentStore({ store: input.store }).raise(tenantId, incident),
    freeTextEnabled: async (tenantId) => (await aiGovernanceStore({ store: input.store, now: input.now }).freeText(tenantId)).enabled,
  };
}

// ── OB-288 lane 4 · P1: the AI governance surface ─────────────────────────────────────────────────────────────────────
//
// One registration from main.ts: scoped kill switches, per-agent budgets and rate limits, the free-text switch (OB-296,
// off), people's decisions on proposals, the AI-incident register, the approved-model register, the evaluation route, the
// AI control read, A01's action list, A05's staff answers and the customer-facing suggestion read (AI-NFR-11, OB-314).
// Over the same store and the same governed agent runs the rest of the API uses; a bare composition (no store: the
// API-surface document) serves the same routes over a store that keeps nothing.
export function aiGovernanceSurface(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  /** The agents' governed deps main.ts built (the same runs the run route makes). Absent → a bare adapter. */
  readonly governedAi?: AiDeps;
  readonly modelTransport?: ModelTransport;
  readonly modelPricing?: Readonly<Record<ModelTier, TierPricing>>;
  /** A05: the order a question is about, in words (round8-adapters `orderFactsFor`, passed in: importing it here would
   *  evaluate it while adapters.ts is still loading). */
  readonly orderFacts?: (store: EventStore, tenantId: string, orderId: string) => Promise<string | undefined>;
}): void {
  const { now } = input;
  const store = input.store ?? new InMemoryEventStore();
  const ai = input.governedAi ?? aiAdapter({ store, now });
  const governance = aiGovernanceStore({ store, now });
  const incidents = aiIncidentStore({ store });
  const registry = modelRegistryStore({ store });
  const evaluations = evaluationStore({ store });
  const gateway = modelGatewayAdapter({
    store, now,
    ...(input.modelTransport === undefined ? {} : { transport: input.modelTransport }),
    ...(input.modelPricing === undefined ? {} : { pricing: input.modelPricing }),
  });
  const masterOn = async (tenantId: string): Promise<boolean> =>
    (await latest<{ readonly on: boolean }>(store, tenantId, STREAM.ai, 'AiKillSwitchSet'))?.on ?? true;
  surface.push(
    ...aiGovernanceRoutes({ governance, masterOn, budget: ai.budget, openProposals: ai.openProposals, now }),
    ...aiIncidentRoutes({ incidents, now }),
    ...modelRegistryRoutes({ registry, evaluationRuns: evaluations.runs, now }),
    ...evaluationRoutes({ gateway, evaluations, now }),
    ...aiControlRoutes({
      masterOn, enabledAgents: ai.enabledAgents, budget: ai.budget, governance, incidents, registry, evaluations,
      openProposals: ai.openProposals, modelCalls: gateway.audits, providerConfigured: () => input.modelTransport !== undefined,
      run: ai.run,
      orderFacts: (tenantId, orderId) => input.orderFacts?.(store, tenantId, orderId) ?? undefined,
      servicePolicy: async (tenantId) => {
        const p = await serviceCaseAdapter({ store, now }).compensationPolicy(tenantId);
        const rupees = (m: number): string => `₹${(m / 100).toFixed(2)}`;
        return p === undefined
          ? ['No compensation policy is set; the default applies: a desk agent may offer up to ₹500.00 alone, and nothing above ₹5,000.00.']
          : [`Compensation: a desk agent may offer up to ${rupees(p.agentAuthorityMinor)} alone; above that a second person approves; nothing above ${rupees(p.deskCeilingMinor)}.`];
      },
      consentRecords: async (tenantId, customerId) => customerAdapter({ store, now }).consentRecords(tenantId, customerId),
      // The customer's OWN storefront orders only (the order index's `customerRef` is the authenticated subject).
      boughtBefore: async (tenantId, customerId) => {
        const placed = await allOf<PlacedOrder>(store, tenantId, streamName(STREAM.orders, 'index'), 'OrderPlaced');
        return placed.filter((o) => o.customerRef === customerId).flatMap((o) => o.lines.map((l) => l.productId));
      },
      inStockAt: async (tenantId, locationId) => {
        const rows = await inventoryAdapter({ store, now }).availability(tenantId);
        const m = new Map<string, number>();
        for (const r of rows) if (r.locationId === locationId) m.set(r.productId, (m.get(r.productId) ?? 0) + r.onHandMinor);
        return m;
      },
      now,
    }),
  );
}
