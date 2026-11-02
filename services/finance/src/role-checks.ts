// API-11 HR/Workforce — the scored check per role behind QG-02 (W3 · OB-675 · roadmap §2.3 / §22):
//
//   • GET  /v1/hr/workforce/role-checks — every role judged: its check (the questions and tasks), the pass mark ("not set"
//     until the owner sets it), the people trained for it with their latest score, and the reading at the pilot (90%) and
//     final (95%) levels, with why it is not passed.
//   • POST /v1/hr/workforce/role-checks/:roleId — a person who manages training sets the role's check (a new version; the
//     earlier ones are kept).
//   • POST /v1/hr/workforce/role-checks/:roleId/pass-mark — the OWNER sets the pass mark (OB-675: "set by the owner on
//     screen"); a later one supersedes, the earlier ones are kept.
//   • POST /v1/hr/workforce/role-checks/:roleId/attempts/:attemptId — a trainer records one person's attempt, item by item;
//     the score is worked out here. Never the person about themselves. A retake is a new attempt id.
//   • GET  /v1/hr/workforce/role-checks/:roleId/attempts — every attempt kept for the role, oldest first.
//
// Every write names its maker as the signed-in caller and is sealed on the audit trail. Nothing is scored, set or passed
// automatically (P-05); the gate never reads a pass from nothing (P-08).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Employee } from '../../../packages/workforce/src/workforce';
import { STAFF_SIGN_IN_ROLES } from '../../../packages/workforce/src/access-match';
import { currentCurricula, type TrainingAssignment, type TrainingCompletion, type ApprovedCurriculum } from '../../../packages/workforce/src/training';
import {
  readCheckItems, readPassMark, currentChecks, currentPassMarks, scoreAttempt, roleCheckReading, QG02_LEVELS, QG02_PILOT_RELEASES, QG02_FINAL_RELEASES,
  type RoleCheck, type RolePassMark, type CheckAttempt, type RoleCheckRow,
} from '../../../packages/workforce/src/role-check';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface RoleCheckDeps {
  readonly now: () => string;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  /** Who holds the owner's role now (the people of an "owner" check). */
  readonly owners: (tenantId: string) => Promise<readonly string[]>;
  readonly curricula: (tenantId: string) => Promise<readonly ApprovedCurriculum[]>;
  readonly trainingAssignments: (tenantId: string) => Promise<readonly TrainingAssignment[]>;
  readonly trainingCompletions: (tenantId: string) => Promise<readonly TrainingCompletion[]>;
  readonly checks: (tenantId: string) => Promise<readonly RoleCheck[]>;
  readonly recordCheck: (tenantId: string, c: RoleCheck) => Promise<void>;
  readonly passMarks: (tenantId: string) => Promise<readonly RolePassMark[]>;
  readonly recordPassMark: (tenantId: string, m: RolePassMark) => Promise<void>;
  readonly attempts: (tenantId: string) => Promise<readonly CheckAttempt[]>;
  readonly recordAttempt: (tenantId: string, a: CheckAttempt) => Promise<void>;
  readonly recordAudit?: Recorder;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

/** The QG-02 training reading, read from the stored records (the gate register and the page read the same). */
export async function readRoleChecks(deps: RoleCheckDeps, tenantId: string): Promise<readonly RoleCheckRow[]> {
  const [employees, owners, curricula, assignments, completions, checks, marks, attempts] = await Promise.all([
    deps.employees(tenantId), deps.owners(tenantId), deps.curricula(tenantId), deps.trainingAssignments(tenantId), deps.trainingCompletions(tenantId),
    deps.checks(tenantId), deps.passMarks(tenantId), deps.attempts(tenantId),
  ]);
  const active = employees.filter((e) => e.active);
  const byId = new Map(employees.map((e) => [e.employeeId, e] as const));
  const roles = new Set<string>();
  for (const e of active) for (const r of e.roles) if (STAFF_SIGN_IN_ROLES.includes(r)) roles.add(r);
  const current = currentCurricula(curricula);
  // Each assignment's (person, item) once it is recorded done.
  const assignmentOf = new Map(assignments.map((a) => [a.assignmentId, a] as const));
  const done = new Set<string>();
  for (const c of completions) { const a = assignmentOf.get(c.assignmentId); if (a !== undefined) done.add(`${a.employeeId}\u0000${a.itemId}`); }
  return roleCheckReading({
    roles: [...roles], checks, passMarks: marks, attempts,
    people: (roleId) => (roleId === 'owner'
      ? owners.map((u) => ({ employeeId: u, name: byId.get(u)?.name ?? u }))
      : active.filter((e) => e.roles.includes(roleId)).map((e) => ({ employeeId: e.employeeId, name: e.name }))),
    curriculumDone: (roleId, employeeId) => {
      const c = current.get(roleId);
      return c !== undefined && c.items.length > 0 && c.items.every((i) => done.has(`${employeeId}\u0000${i.itemId}`));
    },
  });
}

export function roleCheckRoutes(deps: RoleCheckDeps): readonly Route[] {
  const seal = async (ctx: RequestContext, action: string, objectId: string, after: Record<string, string>): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, { actorId: ctx.userId, action, objectType: 'role_check', objectId, at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, correlationId: objectId });
  };
  /** A role a check may be set for: one somebody on the staff list holds now, a staff sign-in role, or the owner's. */
  const knownRole = async (tenantId: string, roleId: string): Promise<void> => {
    if (roleId === 'owner' || STAFF_SIGN_IN_ROLES.includes(roleId)) return;
    if ((await deps.employees(tenantId)).some((e) => e.active && e.roles.includes(roleId))) return;
    refuse(404, 'role_not_known', `Nobody on the staff list holds the role "${roleId}", and it is not one of the staff sign-in roles.`, 'Check the role name. Nothing was saved.');
  };
  const roleParam = (ctx: RequestContext): string => {
    const roleId = (ctx.params['roleId'] ?? '').trim();
    if (!/^[a-z][a-z0-9_]{0,59}$/.test(roleId)) refuse(400, 'not_a_role_id', 'Name the role in the address (for example cashier).', 'Correct it. Nothing was saved.');
    return roleId;
  };
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/role-checks',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const [rows, checks] = await Promise.all([readRoleChecks(deps, ctx.tenantId), deps.checks(ctx.tenantId)]);
        const current = currentChecks(checks);
        return {
          status: 200,
          body: {
            roles: rows.map((r) => ({ ...r, items: current.get(r.roleId)?.items ?? [] })),
            levels: { pilotPercent: QG02_LEVELS.pilot, finalPercent: QG02_LEVELS.final, pilotReleases: QG02_PILOT_RELEASES, finalReleases: QG02_FINAL_RELEASES },
            rule: 'OB-675: a scored check per role; QG-02 passes when, in each role, at least 90% of the trained staff passed their latest attempt (pilot, R0–R2) and 95% (final, after the pilot). A role with no check, no pass mark or nobody trained is not passed.',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Body: { items: [{ itemId, kind: 'question' | 'task', text, textTa? }] }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/role-checks/:roleId',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const roleId = roleParam(ctx);
        const items = readCheckItems((ctx.body as { items?: unknown } | null)?.items);
        if (typeof items === 'string') refuse(400, 'not_readable_as_a_check', items as string, 'Correct it and send it again. Nothing was saved.');
        await knownRole(ctx.tenantId, roleId);
        const current = currentChecks(await deps.checks(ctx.tenantId)).get(roleId);
        if (current !== undefined && JSON.stringify(current.items) === JSON.stringify(items)) return { status: 200, body: { check: current, alreadySet: true } };
        const c: RoleCheck = { roleId, version: (current?.version ?? 0) + 1, items: items as RoleCheck['items'], definedBy: ctx.userId, definedAt: deps.now() };
        await deps.recordCheck(ctx.tenantId, c);
        await seal(ctx, 'workforce.role_check.set', roleId, { version: String(c.version), items: c.items.map((i) => i.itemId).join(',') });
        return { status: 201, body: { check: c } };
      },
    },
    {
      // The owner sets the pass mark. Body: { passMarkPercent } — a whole percentage, 1–100.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/role-checks/:roleId/pass-mark',
      permission: 'workforce.curriculum.approve', idempotent: true,
      handler: async (ctx) => {
        const roleId = roleParam(ctx);
        const mark = readPassMark((ctx.body as { passMarkPercent?: unknown } | null)?.passMarkPercent);
        if (typeof mark === 'string') refuse(400, 'not_readable_as_a_pass_mark', mark as string, 'Correct it and send it again. Nothing was saved.');
        await knownRole(ctx.tenantId, roleId);
        const prior = currentPassMarks(await deps.passMarks(ctx.tenantId)).get(roleId);
        if (prior?.passMarkPercent === mark) return { status: 200, body: { passMark: prior, alreadySet: true } };
        const m: RolePassMark = { roleId, passMarkPercent: mark as number, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordPassMark(ctx.tenantId, m);
        await seal(ctx, 'workforce.role_check.pass_mark_set', roleId, { passMarkPercent: String(m.passMarkPercent), before: prior === undefined ? 'not set' : String(prior.passMarkPercent) });
        return { status: 201, body: { passMark: m } };
      },
    },
    {
      // A trainer records one person's attempt. Body: { employeeId, results: [{ itemId, passed }], note? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/role-checks/:roleId/attempts/:attemptId',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const roleId = roleParam(ctx);
        const attemptId = (ctx.params['attemptId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (attemptId === '' || !isStr(b['employeeId'])) refuse(400, 'not_readable_as_an_attempt', 'An attempt needs { employeeId, results: [{ itemId, passed }] } and an optional note.', 'Correct it and send it again. Nothing was saved.');
        const prior = (await deps.attempts(ctx.tenantId)).find((a) => a.attemptId === attemptId);
        if (prior !== undefined) return { status: 200, body: { attempt: prior, alreadyRecorded: true } };
        const employeeId = (b['employeeId'] as string).trim();
        const holds = roleId === 'owner'
          ? (await deps.owners(ctx.tenantId)).includes(employeeId)
          : (await deps.employees(ctx.tenantId)).some((e) => e.employeeId === employeeId && e.active && e.roles.includes(roleId));
        if (!holds) throw notFound(`${employeeId} on the staff list in the role ${roleId}`);
        const [checks, marks] = await Promise.all([deps.checks(ctx.tenantId), deps.passMarks(ctx.tenantId)]);
        const check = currentChecks(checks).get(roleId);
        const scored = scoreAttempt({ check, passMark: currentPassMarks(marks).get(roleId), employeeId, recordedBy: ctx.userId, results: b['results'] });
        if (scored === 'no_check') refuse(409, 'no_check_for_this_role', `No check has been set for the role ${roleId} yet, so an attempt cannot be scored.`, 'Set the check first. Nothing was recorded.');
        if (scored === 'pass_mark_not_set') refuse(409, 'pass_mark_not_set', `The pass mark for ${roleId} is not set — the owner sets it — so an attempt cannot be judged.`, 'Ask the owner to set the pass mark. Nothing was recorded.');
        if (scored === 'cannot_record_own_attempt') refuse(422, 'cannot_record_own_attempt', 'Nobody records their own check — the trainer records it (§28).', 'Ask the trainer to record it. Nothing was recorded.');
        if (scored === 'results_do_not_match_the_check') refuse(400, 'results_do_not_match_the_check', `Give a passed / not passed for every item of the ${roleId} check (version ${check!.version}), each once.`, 'Correct it and send it again. Nothing was recorded.');
        const s = scored as Exclude<typeof scored, string>;
        const a: CheckAttempt = {
          attemptId, roleId, employeeId, checkVersion: check!.version, results: s.results, scorePercent: s.scorePercent, passMarkPercent: s.passMarkPercent, passed: s.passed,
          recordedBy: ctx.userId, recordedAt: deps.now(), ...(isStr(b['note']) ? { note: (b['note'] as string).trim().slice(0, 500) } : {}),
        };
        await deps.recordAttempt(ctx.tenantId, a);
        await seal(ctx, 'workforce.role_check.attempt_recorded', `${roleId}/${attemptId}`, { employeeId, scorePercent: String(a.scorePercent), passMarkPercent: String(a.passMarkPercent), passed: String(a.passed) });
        return { status: 201, body: { attempt: a } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/role-checks/:roleId/attempts',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const roleId = roleParam(ctx);
        const attempts = (await deps.attempts(ctx.tenantId)).filter((a) => a.roleId === roleId);
        return { status: 200, body: { roleId, attempts, count: attempts.length } };
      },
    },
  ];
}
