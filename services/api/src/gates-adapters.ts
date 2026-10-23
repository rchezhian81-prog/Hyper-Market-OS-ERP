// OB-288 gates lane — the security findings register (QG-03 · QG-06) and the gate-decision register (QG-12) on head
// office's durable store. Head-office wiring only: the rules are the tested engines in `packages/compliance`
// (findings.ts, gate-decisions.ts) and `packages/ops` (recovery-gate.ts); the routes are `services/compliance/src`.
//
// Three append-only streams (hard rules #2, #6): findings (each change of a finding's state is a new fact; the fold
// takes the latest per finding), imported scanner runs, and gate decisions. `gatesRoutes` is this lane's one
// registration in main.ts; `gateBlockersBeyondRisks` is handed to the risk register so `can-pass` sees findings too.

import { createHash, randomUUID } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  blockedGates, findingBlocks,
  type SecurityFinding, type GateDecision, type GateBlocker,
} from '../../../packages/compliance/src/index';
import { recoveryGateReading } from '../../../packages/ops/src/index';
import { findingsRoutes, type FindingsDeps, type ScanRunRecord } from '../../compliance/src/findings';
import type { TwoSignatureDeps } from '../../compliance/src/risk';
import type { SecurityReviewer, RiskAcceptanceSignature } from '../../../packages/compliance/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { rolesHeldNow, permissionsHeldBy } from './adapters';
import { gateDecisionRoutes, type GateDecisionDeps } from '../../compliance/src/gate-decisions';
import type { OtherGateBlocker } from '../../compliance/src/risk';
import { STREAM, streamName, riskRegisterAdapter, drReadinessAdapter } from './adapters';

export const FINDINGS_STREAM = streamName(STREAM.compliance, 'findings');
export const FINDING_SCANS_STREAM = streamName(STREAM.compliance, 'finding-scans');
export const GATE_DECISIONS_STREAM = streamName(STREAM.compliance, 'gate-decisions');
/** OB-330: the security reviewer the owner names, and the two signatures on a critical/high risk's acceptance. */
export const SECURITY_REVIEWER_STREAM = streamName(STREAM.compliance, 'security-reviewer');
export const RISK_ACCEPTANCE_SIGNATURES_STREAM = streamName(STREAM.compliance, 'risk-acceptance-signatures');

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, key: string, occurredAt: string, payload: unknown): Promise<void> => {
  const d = digest(key);
  await store.append(tenantId, stream, makeEvent({
    id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/compliance',
    payload: payload as Record<string, unknown>,
  }));
};

/** The findings register folded: the latest state of each finding (append-only underneath). */
async function foldFindings(store: EventStore, tenantId: string): Promise<readonly SecurityFinding[]> {
  const byId = new Map<string, SecurityFinding>();
  for (const f of await all<SecurityFinding>(store, tenantId, FINDINGS_STREAM, 'SecurityFindingRecorded')) byId.set(f.findingId, f);
  return [...byId.values()];
}

export function findingsAdapter(input: { readonly store: EventStore; readonly now: () => string }): FindingsDeps {
  const { store, now } = input;
  return {
    now,
    findings: (tenantId) => foldFindings(store, tenantId),
    scans: (tenantId) => all<ScanRunRecord>(store, tenantId, FINDING_SCANS_STREAM, 'SecurityScanImported'),
    recordFindings: async (tenantId, changes) => {
      const at = now();
      // Keyed on the finding AND its whole new state: a re-sent change collapses; a real change is a new fact.
      for (const f of changes) await put(store, tenantId, FINDINGS_STREAM, 'SecurityFindingRecorded', `${f.findingId}|${JSON.stringify(f)}`, at, f);
    },
    recordScan: async (tenantId, scan) => {
      await put(store, tenantId, FINDING_SCANS_STREAM, 'SecurityScanImported', `${scan.tool}|${scan.runId}`, scan.importedAt, scan);
    },
  };
}

/**
 * Everything that blocks a gate apart from the risk register: open critical/high findings (QG-03, QG-06) and the
 * QG-08 rehearsal reading when it is HOLD.
 */
export async function gateBlockersBeyondRisks(store: EventStore, now: () => string, tenantId: string): Promise<readonly OtherGateBlocker[]> {
  const fromFindings: OtherGateBlocker[] = findingBlocks(await foldFindings(store, tenantId))
    .map((b) => ({ gate: b.gate, kind: 'finding' as const, ref: b.findingId, reason: b.reason }));
  const recovery = recoveryGateReading(await drReadinessAdapter({ store, now }).drills(tenantId), now()); // OB-332: a pass counts one quarter
  const fromRecovery: OtherGateBlocker[] = recovery.verdict === 'GO' ? [] : [{
    gate: 'QG-08', kind: 'check', ref: 'recovery-gate', reason: `QG-08 rehearsals not all passed — ${recovery.why}`,
  }];
  return [...fromFindings, ...fromRecovery];
}

export function gateDecisionAdapter(input: { readonly store: EventStore; readonly now: () => string }): GateDecisionDeps {
  const { store, now } = input;
  const risks = riskRegisterAdapter({ store, now });
  return {
    now,
    decisions: (tenantId) => all<GateDecision>(store, tenantId, GATE_DECISIONS_STREAM, 'GateDecisionRecorded'),
    recordDecision: async (tenantId, d) => {
      await put(store, tenantId, GATE_DECISIONS_STREAM, 'GateDecisionRecorded', d.decisionId, d.decidedAt, d);
    },
    blockers: async (tenantId): Promise<readonly GateBlocker[]> => {
      const fromRisks: GateBlocker[] = blockedGates(await risks.risks(tenantId))
        .map((b) => ({ gate: b.gate, kind: 'risk' as const, ref: b.riskId, reason: b.reason }));
      return [...fromRisks, ...await gateBlockersBeyondRisks(store, now, tenantId)];
    },
    newDecisionId: (gate, release) => `${gate}-${release}-${randomUUID()}`,
  };
}

/** This lane's one registration in main.ts. Without a durable store every call answers 503 by name (P-08). */
export function gatesRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const { store, now } = input;
  if (store === undefined) {
    const absent = <T extends object>(): T => new Proxy({ now } as object, {
      get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => {
        throw apiError(503, { code: 'register_store_not_available', whatHappened: 'Head office is running without its durable store, so the findings and gate-decision registers cannot be read or written.', wasItSaved: 'not_saved', nextSafeAction: 'Start head office with its database. Nothing was read or saved.' });
      }),
    }) as T;
    return [...findingsRoutes(absent<FindingsDeps>()), ...gateDecisionRoutes(absent<GateDecisionDeps>())];
  }
  return [...findingsRoutes(findingsAdapter({ store, now })), ...gateDecisionRoutes(gateDecisionAdapter({ store, now }))];
}

/**
 * OB-330 (owner, 23 Oct 2026 · §35.1): the two-signature acceptance of a critical or high risk, on head office's own
 * append-only streams. The reviewer named NOW is the latest naming (the old ones stay); each signature is its own fact.
 * Whether the signer holds the owner's role, and whether a named person may read the risk register, come from their own
 * grants — never the request.
 */
export function twoSignatureAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void }): { readonly twoSignature: TwoSignatureDeps } {
  const { store, now } = input;
  return {
    twoSignature: {
      reviewer: async (tenantId) => (await all<SecurityReviewer>(store, tenantId, SECURITY_REVIEWER_STREAM, 'SecurityReviewerNamed')).at(-1),
      recordReviewer: (tenantId, r) => put(store, tenantId, SECURITY_REVIEWER_STREAM, 'SecurityReviewerNamed', `${r.userId}|${r.displayName}|${r.namedAt}`, r.namedAt, r),
      signatures: (tenantId) => all<RiskAcceptanceSignature>(store, tenantId, RISK_ACCEPTANCE_SIGNATURES_STREAM, 'RiskAcceptanceSigned'),
      recordSignature: (tenantId, sig) => put(store, tenantId, RISK_ACCEPTANCE_SIGNATURES_STREAM, 'RiskAcceptanceSigned', `${sig.riskId}|${sig.as}|${sig.signedBy}|${sig.riskDigest}`, sig.signedAt, sig),
      isOwner: async (tenantId, userId) => (await rolesHeldNow(store, tenantId, userId, now())).includes('owner'),
      mayReview: async (tenantId, userId) => ((await permissionsHeldBy(store, tenantId, userId)) ?? []).includes('compliance.risk.read'),
      ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    },
  };
}
