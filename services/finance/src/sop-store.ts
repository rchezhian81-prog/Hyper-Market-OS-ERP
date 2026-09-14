// API-11 HR/Workforce — the DURABLE SOP-acknowledgement store (M25-FR-04 follow-on), on the tested
// `packages/workforce` `sopStatus` engine, alongside the roster and certification stores. The
// `POST /v1/hr/workforce/sop-status` route is a stateless what-if (the caller supplies the employee, the SOPs
// and every acknowledgement). This persists the SOPs and the acknowledgements (append-only, latest-per-id,
// hard rule #2) so "who has acknowledged the CURRENT version of each SOP for their role?" reads STORED facts
// and survives a restart. Acknowledging v3 is not acknowledging v5 — an old signature that looks like
// compliance is worse than none (M25-FR-04).
//
//   • `POST /v1/hr/workforce/sops/:sopId`                              — publish/replace an SOP at a version, for
//     some roles. manage.
//   • `POST /v1/hr/workforce/sops/:sopId/acknowledgements/:employeeId` — record that this person acknowledged a
//     version (defaults to now). manage.
//   • `GET  /v1/hr/workforce/sops`                                     — the published SOPs. sop.read.
//   • `GET  /v1/hr/workforce/employees/:employeeId/sop-status`         — the STATEFUL status: folds the stored
//     employee + the SOPs for their role + their acknowledgements and runs the tested `sopStatus`. sop.read.
//     404 when the employee is unknown.
//
// Writes gated `workforce.roster.manage`; reads `workforce.sop.read`. Nothing is signed automatically — it
// records what was acknowledged and reports, by exception, who is not up to date (P-03, P-05).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  sopStatus,
  type SopAcknowledgement, type Employee,
} from '../../../packages/workforce/src/workforce';

/** An SOP as published: an id, a human title, a version, and the roles it applies to. */
export interface Sop {
  readonly sopId: string;
  readonly title: string;
  readonly version: number;
  readonly forRoles: readonly string[];
}

export interface SopStoreDeps {
  readonly putSop: (tenantId: string, sop: Sop, key: string) => Promise<void> | void;
  readonly putAcknowledgement: (tenantId: string, ack: SopAcknowledgement, key: string) => Promise<void> | void;
  readonly sops: (tenantId: string) => Promise<readonly Sop[]> | readonly Sop[];
  readonly acknowledgements: (tenantId: string, employeeId?: string) => Promise<readonly SopAcknowledgement[]> | readonly SopAcknowledgement[];
  readonly employee: (tenantId: string, employeeId: string) => Promise<Employee | undefined> | Employee | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const readSop = (sopId: string, b: Record<string, unknown>): Sop | undefined => {
  if (!isStr(b['title']) || !isNonNegInt(b['version']) || !isArr(b['forRoles']) || !(b['forRoles'] as unknown[]).every(isStr)) return undefined;
  return { sopId, title: b['title'], version: b['version'], forRoles: b['forRoles'] as string[] };
};

export function sopStoreRoutes(deps: SopStoreDeps): readonly Route[] {
  return [
    {
      // Publish/replace an SOP. Body: { title, version, forRoles[] }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/sops/:sopId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const sopId = (ctx.params['sopId'] ?? '').trim();
        const sop = sopId === '' ? undefined : readSop(sopId, (ctx.body ?? {}) as Record<string, unknown>);
        if (sop === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_sop',
            whatHappened: 'An SOP needs a sopId in the path and { title, version (0 or more), forRoles[] } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the SOP, its version, and the roles it applies to.',
          });
        }
        await deps.putSop(ctx.tenantId, sop, ctx.idempotencyKey ?? `sop-${sopId}-${deps.now()}`);
        return { status: 200, body: { sop } };
      },
    },
    {
      // Record an acknowledgement. Body: { version, acknowledgedAt? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/sops/:sopId/acknowledgements/:employeeId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const sopId = (ctx.params['sopId'] ?? '').trim();
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (sopId === '' || employeeId === '' || !isNonNegInt(b['version'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_acknowledgement',
            whatHappened: 'An acknowledgement needs a sopId and employeeId in the path and { version } in the body (acknowledgedAt optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the version this person acknowledged.',
          });
        }
        const ack: SopAcknowledgement = {
          sopId,
          version: b['version'],
          employeeId,
          acknowledgedAt: isStr(b['acknowledgedAt']) ? b['acknowledgedAt'] : deps.now(),
        };
        await deps.putAcknowledgement(ctx.tenantId, ack, ctx.idempotencyKey ?? `sopack-${sopId}-${employeeId}-${deps.now()}`);
        return { status: 200, body: { acknowledgement: ack } };
      },
    },
    {
      // The published SOPs. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/sops',
      permission: 'workforce.sop.read',
      handler: async (ctx) => {
        const sops = await deps.sops(ctx.tenantId);
        return { status: 200, body: { sops, count: sops.length } };
      },
    },
    {
      // Is this stored person up to date on the SOPs for their role? Read-only — the stateful counterpart to
      // POST /sop-status. 404 when the employee is unknown.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/employees/:employeeId/sop-status',
      permission: 'workforce.sop.read',
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        if (employeeId === '') throw notFound('employee ');
        const employee = await deps.employee(ctx.tenantId, employeeId);
        if (employee === undefined) throw notFound(`employee ${employeeId}`);
        const statuses = sopStatus({
          employee,
          sops: await deps.sops(ctx.tenantId),
          acknowledgements: await deps.acknowledgements(ctx.tenantId, employeeId),
        });
        const outstanding = statuses.filter((s) => !s.upToDate).length;
        return { status: 200, body: { statuses, count: statuses.length, outstanding } };
      },
    },
  ];
}
