// API-11 HR/Workforce — the DURABLE certification store (M25-FR-03 follow-on), on the tested
// `packages/workforce` `canPerformTask` engine, alongside the durable roster store (`roster-store.ts`). The
// `POST /v1/hr/workforce/task-gate` route is a stateless what-if — the caller supplies the employee and every
// certificate in the body. This persists the certificates (append-only, latest-per-id, hard rule #2) so the
// question "may this person work the deli counter TODAY?" reads STORED facts — the employee from the roster
// store and the certificate on file — and survives a restart.
//
//   • `POST /v1/hr/workforce/certifications/:certificationId`         — record/replace one certificate on file
//     (kind, issued/valid dates, and WHO verified it — an unverified certificate is not cover). manage.
//   • `GET  /v1/hr/workforce/certifications?employeeId=`              — the stored certificates, optionally one person's.
//   • `GET  /v1/hr/workforce/employees/:employeeId/task-gate?task=&requiresCertification=&requiresRole=&today=`
//     — the STATEFUL gate: folds the stored employee + their stored certificates and runs the tested
//     `canPerformTask`. The gate is on the TASK, never the person: a lapsed food-handling certificate blocks the
//     deli counter but not shelf-stacking (`stillAllowed` says so). A leaver is blocked outright. 404 if the
//     employee is unknown — a decision cannot be made about somebody the shop has no record of.
//
// Writes gated `workforce.roster.manage`; certificate reads `workforce.roster.read`; the task-gate read
// `workforce.task.read` (the same permission the stateless POST task-gate uses). Nothing here authorises a task
// automatically — it records what was verified and reports what today's facts allow (P-05).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  canPerformTask,
  type Certification, type Employee,
} from '../../../packages/workforce/src/workforce';

export interface CertStoreDeps {
  /** Record/replace one certificate (latest-per-certificationId). */
  readonly putCertification: (tenantId: string, cert: Certification, key: string) => Promise<void> | void;
  /** The stored certificates, optionally narrowed to one employee. */
  readonly certifications: (tenantId: string, employeeId?: string) => Promise<readonly Certification[]> | readonly Certification[];
  /** One stored staff record (from the roster store), or undefined — the task-gate needs it. */
  readonly employee: (tenantId: string, employeeId: string) => Promise<Employee | undefined> | Employee | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A certificate on file — only a `verifiedBy` one counts as cover, and its `validUntil` is checked against today. */
const readCert = (certificationId: string, employeeIdIn: unknown, b: Record<string, unknown>): Certification | undefined => {
  const employeeId = isStr(b['employeeId']) ? b['employeeId'] : (isStr(employeeIdIn) ? employeeIdIn : undefined);
  if (employeeId === undefined || !isStr(b['kind']) || !isStr(b['issuedOn']) || !isStr(b['validUntil'])) return undefined;
  return {
    certificationId,
    employeeId,
    kind: b['kind'],
    issuedOn: b['issuedOn'],
    validUntil: b['validUntil'],
    ...(isStr(b['verifiedBy']) ? { verifiedBy: b['verifiedBy'] } : {}),
  };
};

export function certStoreRoutes(deps: CertStoreDeps): readonly Route[] {
  return [
    {
      // Record/replace one certificate. Body: { employeeId, kind, issuedOn, validUntil, verifiedBy? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/certifications/:certificationId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const certificationId = (ctx.params['certificationId'] ?? '').trim();
        const cert = certificationId === '' ? undefined : readCert(certificationId, undefined, (ctx.body ?? {}) as Record<string, unknown>);
        if (cert === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_certification',
            whatHappened: 'A certificate needs a certificationId in the path and { employeeId, kind, issuedOn, validUntil } in the body (verifiedBy optional — but an unverified certificate does not count as cover).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the certificate and who verified it.',
          });
        }
        await deps.putCertification(ctx.tenantId, cert, ctx.idempotencyKey ?? `cert-${certificationId}-${deps.now()}`);
        return { status: 200, body: { certification: cert } };
      },
    },
    {
      // The stored certificates, optionally one person's. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/certifications',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const employeeId = typeof ctx.query['employeeId'] === 'string' && ctx.query['employeeId'] !== '' ? ctx.query['employeeId'] : undefined;
        const certifications = await deps.certifications(ctx.tenantId, employeeId);
        return { status: 200, body: { certifications, count: certifications.length, ...(employeeId === undefined ? {} : { employeeId }) } };
      },
    },
    {
      // May this stored person do a gated task TODAY, on the certificates on file? Query: task (required),
      // requiresCertification?, requiresRole?, today? (default today). Read-only — the stateful counterpart to
      // POST /task-gate. 404 when the employee is unknown.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/employees/:employeeId/task-gate',
      permission: 'workforce.task.read',
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const task = ctx.query['task'];
        if (employeeId === '' || !isStr(task)) {
          throw apiError(400, {
            code: 'task_gate_needs_a_task',
            whatHappened: 'A task-gate check needs an employeeId in the path and a task in the query (requiresCertification, requiresRole and today optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Call …/employees/:employeeId/task-gate?task=deli-counter&requiresCertification=food-handling.',
          });
        }
        const employee = await deps.employee(ctx.tenantId, employeeId);
        if (employee === undefined) throw notFound(`employee ${employeeId}`);
        const today = typeof ctx.query['today'] === 'string' && ctx.query['today'] !== '' ? ctx.query['today'] : deps.now().slice(0, 10);
        const decision = canPerformTask({
          employee,
          task,
          ...(isStr(ctx.query['requiresCertification']) ? { requiresCertification: ctx.query['requiresCertification'] } : {}),
          ...(isStr(ctx.query['requiresRole']) ? { requiresRole: ctx.query['requiresRole'] } : {}),
          certifications: await deps.certifications(ctx.tenantId, employeeId),
          today,
        });
        return { status: 200, body: { decision, today } };
      },
    },
  ];
}
