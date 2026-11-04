// W7 · QG-01 — the requirement-records reading on the gate register (roadmap §22 "No build without approved ID, rules,
// actors, errors, permissions and testable acceptance").
//
//   GET /v1/compliance/gate-register/qg01-reading   the CI's latest reading and what it found   compliance.gate.read
//
// The reading itself is the CI guardrail's own check (packages/compliance/src/requirement-records.ts), sent by the CI's
// machine identity through the findings register like every other machine reading (POST /v1/compliance/finding-scans,
// OB-331). This route only reads: no reading, or one that could not read every record, is NOT KNOWN; a record missing a field
// is an open finding that holds the gate; a clean reading is evidence for the owner's QG-01 decision — never the decision.

import type { Route } from '../../kernel/src/index';
import { qg01ReadingOf, type SecurityFinding } from '../../../packages/compliance/src/index';
import type { ScanRunRecord } from './findings';

export interface Qg01ReadingDeps {
  readonly scans: (tenantId: string) => Promise<readonly ScanRunRecord[]> | readonly ScanRunRecord[];
  readonly findings: (tenantId: string) => Promise<readonly SecurityFinding[]> | readonly SecurityFinding[];
  readonly now: () => string;
}

export const QG01_PASS_CONDITION = 'No build without approved ID, rules, actors, errors, permissions and testable acceptance';

export function qg01ReadingRoutes(deps: Qg01ReadingDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/gate-register/qg01-reading',
      permission: 'compliance.gate.read',
      handler: async (ctx) => {
        const reading = qg01ReadingOf(await deps.scans(ctx.tenantId), await deps.findings(ctx.tenantId));
        return { status: 200, body: { gate: 'QG-01', passCondition: QG01_PASS_CONDITION, ...reading, asAt: deps.now() } };
      },
    },
  ];
}
