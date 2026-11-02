// W3 · the gates' outside evidence on the compliance API (QG-04 · QG-05 · QG-06 · roadmap §22, §32, §35.1).
//
//   POST /v1/compliance/gate-evidence/:evidenceId   record one piece of outside evidence      compliance.gate.decide (owner)
//   GET  /v1/compliance/gate-evidence               every record, and what each kind needs    compliance.gate.read
//
// The rules are the tested engine in `packages/compliance/src/gate-evidence.ts`: the recorder is the signed-in person, a
// timing's result is worked out from the measured p95 against the fixed §32 target (never typed), and the register is
// append-only — an id is one record (the same content again is a re-send; different content under it is refused 409).
// Missing evidence is a blocker on its gate (`gateEvidenceBlockers`), read by the gate register — evidence, never a decision.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  readGateEvidence, sameEvidence, latestEvidence, GATE_EVIDENCE_SPECS, NotGateEvidenceError, type GateEvidenceRecord,
} from '../../../packages/compliance/src/index';

export interface GateEvidenceDeps {
  readonly records: (tenantId: string) => Promise<readonly GateEvidenceRecord[]> | readonly GateEvidenceRecord[];
  readonly record: (tenantId: string, r: GateEvidenceRecord) => Promise<void> | void;
  readonly now: () => string;
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function gateEvidenceRoutes(deps: GateEvidenceDeps): readonly Route[] {
  return [
    {
      // Body: { kind, result (passed|failed — not for a timing), measuredMs (a timing only), where, reportRef, testedOn, statement }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/gate-evidence/:evidenceId',
      permission: 'compliance.gate.decide', idempotent: true,
      handler: async (ctx) => {
        let rec: GateEvidenceRecord;
        try {
          rec = readGateEvidence({ evidenceId: (ctx.params['evidenceId'] ?? '').trim(), body: ctx.body, recordedBy: ctx.userId, recordedAt: deps.now() });
        } catch (e) {
          if (e instanceof NotGateEvidenceError) throw refuse(400, 'gate_evidence_not_readable', `${e.message}.`, 'Send { kind, result or measuredMs, where, reportRef, testedOn, statement }. Nothing was recorded.');
          throw e;
        }
        const prior = (await deps.records(ctx.tenantId)).find((r) => r.evidenceId === rec.evidenceId);
        if (prior !== undefined) {
          if (sameEvidence(prior, rec)) return { status: 200, body: { evidence: prior, alreadyRecorded: true } };
          throw refuse(409, 'gate_evidence_id_used', `Evidence ${rec.evidenceId} is already on the register (${prior.kind}, tested ${prior.testedOn}, recorded by ${prior.recordedBy}) and is never changed.`, 'Record a newer test under a new id; the old record stays as it was. Nothing was changed.');
        }
        await deps.record(ctx.tenantId, rec);
        return { status: 201, body: { evidence: rec, alreadyRecorded: false } };
      },
    },
    {
      // Every record, newest first, and per kind what it needs and what the latest one says (or that nothing is on file).
      api: 'API-11', method: 'GET', path: '/v1/compliance/gate-evidence',
      permission: 'compliance.gate.read',
      handler: async (ctx) => {
        const all = await deps.records(ctx.tenantId);
        const records = [...all].sort((a, z) => (a.testedOn === z.testedOn ? (a.recordedAt < z.recordedAt ? 1 : -1) : a.testedOn < z.testedOn ? 1 : -1));
        const kinds = GATE_EVIDENCE_SPECS.map((s) => {
          const latest = latestEvidence(all, s.kind);
          return { ...s, standing: latest === undefined ? 'nothing_on_file' : latest.result, latest: latest ?? null };
        });
        return { status: 200, body: { records, kinds, asAt: deps.now() } };
      },
    },
  ];
}
