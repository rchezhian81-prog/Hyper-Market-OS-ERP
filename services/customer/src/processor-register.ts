// C6 (v2.1 addendum · M16/M32 · DPDP Act 2023 s.8(2)) — the data-processor contract register, on the API.
//
//   • POST /v1/privacy/processor-contracts — a person records a vendor's entry: what personal data it processes, why,
//     and under which contract (its reference). Refused without a contract reference. Append-only: a change is a newer
//     entry for the same vendor, the latest applies, and every earlier one stays on record (hard rules #2, #6).
//   • GET  /v1/privacy/processor-contracts — the register, and the CHECK against what the system really does: every
//     vendor seen processing the shop's personal data (an enabled integration adapter in a personal-data category, a
//     processor the shop has sent an erasure notice to) without an entry, without a contract in force, or handling a
//     category its contract does not cover, is FLAGGED by name (P-03, P-08).
//
// The engine is `packages/customer/src/processor-register.ts`; the evidence of processing comes from the head-office
// wiring (`services/api/src/r2-data-adapters.ts`).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  validateProcessorEntry, checkProcessorRegister, latestProcessorEntries,
  type ProcessorContractEntry, type ProcessingActivity,
} from '../../../packages/customer/src/processor-register';
import type { AuditEntry } from '../../../packages/audit/src/index';

export interface ProcessorRegisterDeps {
  /** Every entry ever recorded (append-only; the engine takes the latest per vendor). */
  readonly entries: (tenantId: string) => Promise<readonly ProcessorContractEntry[]> | readonly ProcessorContractEntry[];
  readonly recordEntry: (tenantId: string, entry: ProcessorContractEntry) => Promise<void> | void;
  /** What the system really does: each vendor seen processing the shop's personal data, and where. */
  readonly activities: (tenantId: string) => Promise<readonly ProcessingActivity[]> | readonly ProcessingActivity[];
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function processorRegisterRoutes(deps: ProcessorRegisterDeps): readonly Route[] {
  return [
    {
      api: 'API-06', method: 'POST', path: '/v1/privacy/processor-contracts',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['vendorId']) || !isStr(b['vendorName']) || !isStrArray(b['dataCategories']) || !isStr(b['purpose'])
          || !isStr(b['contractRef']) || !isStr(b['contractFrom']) || (b['contractUntil'] !== undefined && !isStr(b['contractUntil']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_processor_entry',
            whatHappened: 'A processor entry needs { vendorId, vendorName, dataCategories[], purpose, contractRef, contractFrom (YYYY-MM-DD), contractUntil? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the vendor, what personal data it processes and why, and the reference of its contract. Nothing was recorded.',
          });
        }
        const draft = {
          vendorId: b['vendorId'].trim(), vendorName: b['vendorName'].trim(),
          dataCategories: [...new Set(b['dataCategories'].map((c) => c.trim()))].sort(),
          purpose: b['purpose'].trim(), contractRef: b['contractRef'].trim(), contractFrom: b['contractFrom'],
          ...(isStr(b['contractUntil']) ? { contractUntil: b['contractUntil'] } : {}),
        };
        const v = validateProcessorEntry(draft);
        if (!v.ok) {
          throw apiError(422, {
            code: v.problems[0]!.code,
            whatHappened: v.problems.map((p) => p.detail).join('; '),
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. A vendor is registered only with the reference of the contract it processes personal data under.',
          });
        }
        // Who recorded it is the caller, never the body.
        const entry: ProcessorContractEntry = { ...draft, recordedBy: ctx.userId, recordedAt: deps.now() };
        await deps.recordEntry(ctx.tenantId, entry);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'privacy.processor_contract.record', objectType: 'processor-contract', objectId: entry.vendorId,
          at: entry.recordedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { vendorName: entry.vendorName, contractRef: entry.contractRef, contractFrom: entry.contractFrom, contractUntil: entry.contractUntil ?? '', dataCategories: entry.dataCategories.join(',') },
          correlationId: entry.vendorId,
        });
        return { status: 201, body: { vendorId: entry.vendorId, contractRef: entry.contractRef, recordedBy: entry.recordedBy, recordedAt: entry.recordedAt } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/privacy/processor-contracts',
      // The privacy officer's authority (owner, store manager) — not every role that may read a consent.
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const asOf = ctx.query['date'] ?? deps.now().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
          throw apiError(400, { code: 'check_needs_a_date', whatHappened: '?date must be YYYY-MM-DD (default today).', wasItSaved: 'not_saved', nextSafeAction: 'Send the date or leave it out. A check reads, it never writes.' });
        }
        const entries = await deps.entries(ctx.tenantId);
        const check = checkProcessorRegister({ entries, activities: await deps.activities(ctx.tenantId), asOf });
        return { status: 200, body: { register: latestProcessorEntries(entries), check, asAt: deps.now() } };
      },
    },
  ];
}
