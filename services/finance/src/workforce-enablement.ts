// API-11 HR/Workforce — enablement and adoption (OB-288 · audit-3 package 5 · audit-4 D11-FR-04):
//
//   • ACCESS MATCHES ASSIGNMENT (M25-FR-01) — `GET /v1/hr/workforce/access-match`: the staff list against the sign-in
//     grants, every difference listed as an exception for a person (`packages/workforce/src/access-match.ts`). Read only;
//     a manager reads the branches they hold.
//   • TRAINING AND COMPETENCY (M25-FR-03 · D11-FR-04) — assign a curriculum item, record its completion (never the trainee
//     about themselves), and a SECOND person signs competency (`packages/workforce/src/training.ts`).
//   • PRODUCTIVITY (M25-FR-03 · OB-317) — sales per labour hour from the roster and the banked bills, per department
//     where the hours can be attributed; whole-store otherwise (`packages/workforce/src/productivity.ts`).
//   • THE ROLE CURRICULUM (OB-320) — proposed from the shop's own sheets and the owner guide, one list per role; the
//     owner approves a role's list on screen (versioned) before it counts.
//   • FLOOR CHAMPIONS (D11-FR-04) — the owner names one per department; "not set" until he does.
//   • QG-09 ADOPTION — the gate read from all of the above and the SOP acknowledgements, per role, naming people
//     (`packages/workforce/src/adoption-gate.ts`): GO, HOLD or NOT PROVEN.
//
// Every write names its maker as the signed-in caller and is sealed on the audit trail. Nothing is assigned, completed,
// signed or approved automatically (P-05).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Employee, ShiftRequirement, ShiftAssignment, SopAcknowledgement } from '../../../packages/workforce/src/workforce';
import { accessMatch, type AccessGrant } from '../../../packages/workforce/src/access-match';
import {
  trainingRows, checkCompletion, checkCompetency, currentCurricula, readCurriculumItems,
  type TrainingAssignment, type TrainingCompletion, type CompetencySignOff, type ApprovedCurriculum, type CurriculumItem,
} from '../../../packages/workforce/src/training';
import { rosteredMinutes, productivityReport } from '../../../packages/workforce/src/productivity';
import { adoptionGate, proposedCurricula, currentChampions, type FloorChampion, type PublishedSop, type AdoptionGateReading } from '../../../packages/workforce/src/adoption-gate';
import { BUILT_IN_SOPS, OWNER_GUIDE_PARTS } from '../../../packages/workforce/src/sop-library.generated';
import { STAFF_SIGN_IN_ROLES } from '../../../packages/workforce/src/access-match';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface WorkforceEnablementDeps {
  readonly now: () => string;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  readonly shifts: (tenantId: string) => Promise<{ readonly shifts: readonly ShiftRequirement[]; readonly assignments: readonly ShiftAssignment[] }>;
  readonly grants: (tenantId: string) => Promise<readonly AccessGrant[]>;

  readonly trainingAssignments: (tenantId: string) => Promise<readonly TrainingAssignment[]>;
  readonly recordAssignment: (tenantId: string, a: TrainingAssignment) => Promise<void>;
  readonly trainingCompletions: (tenantId: string) => Promise<readonly TrainingCompletion[]>;
  readonly recordCompletion: (tenantId: string, c: TrainingCompletion) => Promise<void>;
  readonly competencySignOffs: (tenantId: string) => Promise<readonly CompetencySignOff[]>;
  readonly recordSignOff: (tenantId: string, s: CompetencySignOff) => Promise<void>;

  readonly curricula: (tenantId: string) => Promise<readonly ApprovedCurriculum[]>;
  readonly recordCurriculum: (tenantId: string, c: ApprovedCurriculum) => Promise<void>;

  readonly departments: (tenantId: string) => Promise<readonly { readonly departmentId: string; readonly name: string }[]>;
  readonly champions: (tenantId: string) => Promise<readonly FloorChampion[]>;
  readonly recordChampion: (tenantId: string, c: FloorChampion) => Promise<void>;

  /** The SOPs published now (latest version per id) and every acknowledgement (latest per person and SOP). */
  readonly sops: (tenantId: string) => Promise<readonly PublishedSop[]>;
  readonly acknowledgements: (tenantId: string) => Promise<readonly SopAcknowledgement[]>;
  /** Who holds the owner's role now (the people of the "owner" curriculum). */
  readonly owners: (tenantId: string) => Promise<readonly string[]>;
  /** Banked sales in [from, to): the whole store's net line value, each department's (by the categories it owns), and the rest. */
  readonly salesByDepartment: (tenantId: string, from: string, to: string) => Promise<{ readonly totalMinor: number; readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly salesMinor: number }[]; readonly unownedMinor: number }>;
  readonly recordAudit?: Recorder;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const DAY_MS = 86_400_000;

const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send it again. Nothing was saved.' });
};
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

/** Every role the gate judges: each role with a proposed or approved list, and each staff role somebody is rostered for. */
function gateRoles(curricula: ReadonlyMap<string, ApprovedCurriculum>, employees: readonly Employee[]): string[] {
  const roles = new Set<string>([...proposedCurricula(BUILT_IN_SOPS, OWNER_GUIDE_PARTS).keys(), ...curricula.keys()]);
  for (const e of employees) if (e.active) for (const r of e.roles) if (STAFF_SIGN_IN_ROLES.includes(r)) roles.add(r);
  return [...roles].sort();
}

/** QG-09, read from the stored records. */
export async function readAdoptionGate(deps: WorkforceEnablementDeps, tenantId: string): Promise<AdoptionGateReading> {
  const [employees, assignments, completions, signOffs, curricula, departments, champions, sops, acks, owners] = await Promise.all([
    deps.employees(tenantId), deps.trainingAssignments(tenantId), deps.trainingCompletions(tenantId), deps.competencySignOffs(tenantId), deps.curricula(tenantId),
    deps.departments(tenantId), deps.champions(tenantId), deps.sops(tenantId), deps.acknowledgements(tenantId), deps.owners(tenantId),
  ]);
  const current = currentCurricula(curricula);
  const active = employees.filter((e) => e.active);
  const byId = new Map(employees.map((e) => [e.employeeId, e] as const));
  return adoptionGate({
    roles: gateRoles(current, employees), curricula: current,
    peopleOf: (roleId) => (roleId === 'owner'
      ? owners.map((u) => byId.get(u) ?? { employeeId: u, name: u, branchId: '', roles: ['owner'], active: true })
      : active.filter((e) => e.roles.includes(roleId))),
    training: trainingRows({ assignments, completions, signOffs, today: deps.now().slice(0, 10) }),
    sops, acknowledgements: acks, departments, champions: currentChampions(champions), activeStaff: active,
  });
}

export function workforceEnablementRoutes(deps: WorkforceEnablementDeps): readonly Route[] {
  const seal = async (ctx: RequestContext, action: string, objectType: string, objectId: string, after: Record<string, string>, reason?: string): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, { actorId: ctx.userId, action, objectType, objectId, at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, ...(reason === undefined ? {} : { reason }), correlationId: objectId });
  };
  const assignmentOf = async (tenantId: string, assignmentId: string): Promise<TrainingAssignment> => {
    const a = [...await deps.trainingAssignments(tenantId)].reverse().find((x) => x.assignmentId === assignmentId);
    if (a === undefined) throw notFound(`training assignment ${assignmentId}`);
    return a;
  };
  return [
    // ── access matches assignment (M25-FR-01) ─────────────────────────────────────────────────────────────────────
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/access-match',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const scope = scopeOf(ctx);
        const [employees, grants] = await Promise.all([deps.employees(ctx.tenantId), deps.grants(ctx.tenantId)]);
        const mine = scope === 'all' ? employees : employees.filter((e) => scope.includes(e.branchId));
        const ids = new Set(mine.map((e) => e.employeeId));
        // A manager of some branches reads their own people; "not on the staff list" is read only company-wide.
        const report = accessMatch({ employees: mine, grants: scope === 'all' ? grants : grants.filter((g) => ids.has(g.userId)) });
        return { status: 200, body: { ...report, scope, asAt: deps.now() } };
      },
    },

    // ── training and competency (M25-FR-03 · D11-FR-04) ────────────────────────────────────────────────────────────
    {
      // Body: { employeeId, itemId, title, dueOn? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/training/:assignmentId',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const assignmentId = (ctx.params['assignmentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (assignmentId === '' || !isStr(b['employeeId']) || !isStr(b['itemId']) || !isStr(b['title']) || (b['dueOn'] !== undefined && !isDay(b['dueOn']))) {
          bad('not_readable_as_a_training_assignment', 'An assignment needs { employeeId, itemId, title } and an optional dueOn (YYYY-MM-DD).');
        }
        // The trainee is somebody on the staff list — or the owner (his own curriculum is the owner guide), who is not on it.
        const onList = (await deps.employees(ctx.tenantId)).find((e) => e.employeeId === b['employeeId']);
        const isOwner = onList === undefined && (await deps.owners(ctx.tenantId)).includes(b['employeeId'] as string);
        if (onList === undefined && !isOwner) throw notFound(`employee ${String(b['employeeId'])} on the staff list`);
        const employee = onList ?? { employeeId: b['employeeId'] as string, name: b['employeeId'] as string, active: true };
        if (!employee.active) refuse(422, 'employee_has_left', `${employee.name} has left — training is not assigned to a leaver.`, 'Check the person. Nothing was assigned.');
        const prior = (await deps.trainingAssignments(ctx.tenantId)).find((a) => a.assignmentId === assignmentId);
        if (prior !== undefined) return { status: 200, body: { assignment: prior, alreadyAssigned: true } };
        const a: TrainingAssignment = { assignmentId, employeeId: employee.employeeId, itemId: (b['itemId'] as string).trim(), title: (b['title'] as string).trim(), assignedBy: ctx.userId, assignedAt: deps.now(), ...(isDay(b['dueOn']) ? { dueOn: b['dueOn'] } : {}) };
        await deps.recordAssignment(ctx.tenantId, a);
        await seal(ctx, 'workforce.training.assigned', 'training_assignment', assignmentId, { employeeId: a.employeeId, itemId: a.itemId, dueOn: a.dueOn ?? '' });
        return { status: 201, body: { assignment: a } };
      },
    },
    {
      // The trainer records the person did it. Body: { evidenceRef?, certificationId? }. Never the trainee.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/training/:assignmentId/completion',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const a = await assignmentOf(ctx.tenantId, (ctx.params['assignmentId'] ?? '').trim());
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (checkCompletion(a, ctx.userId) !== null) refuse(422, 'trainee_cannot_record_own_training', 'Nobody records their own training as done — the trainer records it (§28).', 'Ask the trainer to record it. Nothing was saved.');
        const prior = (await deps.trainingCompletions(ctx.tenantId)).find((c) => c.assignmentId === a.assignmentId);
        if (prior !== undefined) return { status: 200, body: { completion: prior, alreadyRecorded: true } };
        const c: TrainingCompletion = { assignmentId: a.assignmentId, recordedBy: ctx.userId, completedAt: deps.now(), ...(isStr(b['evidenceRef']) ? { evidenceRef: b['evidenceRef'].trim() } : {}), ...(isStr(b['certificationId']) ? { certificationId: b['certificationId'].trim() } : {}) };
        await deps.recordCompletion(ctx.tenantId, c);
        await seal(ctx, 'workforce.training.completed', 'training_assignment', a.assignmentId, { employeeId: a.employeeId, itemId: a.itemId, evidenceRef: c.evidenceRef ?? '' });
        return { status: 201, body: { completion: c } };
      },
    },
    {
      // A second person signs competency. Body: { outcome: 'competent' | 'not_yet', note? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/training/:assignmentId/competency',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const a = await assignmentOf(ctx.tenantId, (ctx.params['assignmentId'] ?? '').trim());
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['outcome'] !== 'competent' && b['outcome'] !== 'not_yet') bad('not_readable_as_a_competency_sign_off', 'A sign-off says { outcome: "competent" | "not_yet" } and an optional note.');
        const completion = (await deps.trainingCompletions(ctx.tenantId)).find((c) => c.assignmentId === a.assignmentId) ?? null;
        const why = checkCompetency(a, completion, ctx.userId);
        if (why === 'not_completed_yet') refuse(409, 'not_completed_yet', 'The training is not recorded as done yet, so competency cannot be signed.', 'Record the completion first. Nothing was signed.');
        if (why === 'second_person_required') refuse(422, 'second_person_required', 'Competency is signed by a second person — not the trainee, and not the trainer who recorded the completion (QG-09).', 'Ask another manager who watched them do it. Nothing was signed.');
        const s: CompetencySignOff = { assignmentId: a.assignmentId, signedBy: ctx.userId, signedAt: deps.now(), outcome: b['outcome'] as 'competent' | 'not_yet', ...(isStr(b['note']) ? { note: b['note'].trim() } : {}) };
        await deps.recordSignOff(ctx.tenantId, s);
        await seal(ctx, 'workforce.competency.signed', 'training_assignment', a.assignmentId, { employeeId: a.employeeId, itemId: a.itemId, outcome: s.outcome });
        return { status: 201, body: { signOff: s } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/training',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const [assignments, completions, signOffs] = await Promise.all([deps.trainingAssignments(ctx.tenantId), deps.trainingCompletions(ctx.tenantId), deps.competencySignOffs(ctx.tenantId)]);
        const employeeId = isStr(ctx.query['employeeId']) ? ctx.query['employeeId'] : undefined;
        const rows = trainingRows({ assignments, completions, signOffs, today: deps.now().slice(0, 10) }).filter((r) => employeeId === undefined || r.employeeId === employeeId);
        return { status: 200, body: { rows, count: rows.length } };
      },
    },

    // ── productivity (M25-FR-03 · OB-317) ───────────────────────────────────────────────────────────────────────────
    {
      // ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive days; default the last 7 days). Reported, never enforced.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/productivity',
      permission: 'workforce.incentive.read',
      handler: async (ctx) => {
        const now = deps.now();
        const to = isDay(ctx.query['to']) ? new Date(Date.parse(ctx.query['to']!) + DAY_MS).toISOString() : new Date(Date.parse(now.slice(0, 10)) + DAY_MS).toISOString();
        const from = isDay(ctx.query['from']) ? new Date(Date.parse(ctx.query['from']!)).toISOString() : new Date(Date.parse(to) - 7 * DAY_MS).toISOString();
        if (Date.parse(from) >= Date.parse(to)) bad('window_backwards', 'The first day is after the last day.');
        const [{ shifts, assignments }, employees, sales] = await Promise.all([deps.shifts(ctx.tenantId), deps.employees(ctx.tenantId), deps.salesByDepartment(ctx.tenantId, from, to)]);
        const labour = rosteredMinutes({ shifts, assignments, employees, from, to });
        const report = productivityReport({ from, to, labour, totalSalesMinor: sales.totalMinor, departments: sales.departments, unownedSalesMinor: sales.unownedMinor });
        return { status: 200, body: { ...report, asAt: now, note: 'Labour hours are the rostered hours. How a rostered hour belongs to a department is an owner decision not yet made, so each department\'s rate is "not attributed" and the whole-store rate is shown.' } };
      },
    },

    // ── the role curriculum (OB-320) ────────────────────────────────────────────────────────────────────────────────
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/curriculum',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const current = currentCurricula(await deps.curricula(ctx.tenantId));
        const proposed = proposedCurricula(BUILT_IN_SOPS, OWNER_GUIDE_PARTS);
        const roles = [...new Set([...proposed.keys(), ...current.keys()])].sort();
        return {
          status: 200,
          body: {
            roles: roles.map((roleId) => ({ roleId, proposed: proposed.get(roleId) ?? [], approved: current.get(roleId) ?? null })),
            source: 'Proposed from the shop\'s SOP sheets (docs/sop) by each sheet\'s "For:" line, and the owner guide Parts 12 onward for the owner. A list counts only once the owner approves it.',
          },
        };
      },
    },
    {
      // The owner approves a role's list (as proposed, or as he changed it). Body: { items: [{ itemId, title, source, titleTa? }] }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/curriculum/:roleId',
      permission: 'workforce.curriculum.approve', idempotent: true,
      handler: async (ctx) => {
        const roleId = (ctx.params['roleId'] ?? '').trim();
        const items = readCurriculumItems((ctx.body as { items?: unknown } | null)?.items);
        if (roleId === '' || typeof items === 'string') bad('not_readable_as_a_curriculum', typeof items === 'string' ? items : 'Name the role in the address.');
        const all = await deps.curricula(ctx.tenantId);
        const current = currentCurricula(all).get(roleId);
        if (current !== undefined && JSON.stringify(current.items) === JSON.stringify(items)) return { status: 200, body: { curriculum: current, alreadyApproved: true } };
        const c: ApprovedCurriculum = { roleId, version: (current?.version ?? 0) + 1, items: items as readonly CurriculumItem[], approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordCurriculum(ctx.tenantId, c);
        await seal(ctx, 'workforce.curriculum.approved', 'curriculum', roleId, { version: String(c.version), items: c.items.map((i) => i.itemId).join(',') });
        return { status: 201, body: { curriculum: c } };
      },
    },

    // ── floor champions (D11-FR-04) ─────────────────────────────────────────────────────────────────────────────────
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/floor-champions',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const [departments, champions, employees] = await Promise.all([deps.departments(ctx.tenantId), deps.champions(ctx.tenantId), deps.employees(ctx.tenantId)]);
        const current = currentChampions(champions);
        const byId = new Map(employees.map((e) => [e.employeeId, e] as const));
        const rows = departments.map((d) => {
          const c = current.get(d.departmentId);
          const e = c?.employeeId == null ? undefined : byId.get(c.employeeId);
          return { departmentId: d.departmentId, name: d.name, employeeId: c?.employeeId ?? null, employeeName: e?.name ?? null, state: c?.employeeId == null ? 'not_set' : e?.active === true ? 'named' : 'champion_left', namedBy: c?.namedBy ?? null, at: c?.at ?? null };
        });
        return { status: 200, body: { departments: rows, notSet: rows.filter((r) => r.state !== 'named').length } };
      },
    },
    {
      // The owner names a department's floor champion (or { employeeId: null } to take the name off).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/floor-champions/:departmentId',
      permission: 'workforce.champion.name', idempotent: true,
      handler: async (ctx) => {
        const departmentId = (ctx.params['departmentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!(b['employeeId'] === null || isStr(b['employeeId']))) bad('not_readable_as_a_champion', 'Name the floor champion: { employeeId } — or null to take the name off.');
        if (!(await deps.departments(ctx.tenantId)).some((d) => d.departmentId === departmentId)) throw notFound(`department ${departmentId}`);
        const employeeId = b['employeeId'] === null ? null : (b['employeeId'] as string).trim();
        if (employeeId !== null) {
          const e = (await deps.employees(ctx.tenantId)).find((x) => x.employeeId === employeeId);
          if (e === undefined || !e.active) refuse(422, 'champion_not_on_staff_list', `${employeeId} is not on the staff list (or has left) — a floor champion works here.`, 'Choose somebody on the staff list. Nothing was saved.');
        }
        const c: FloorChampion = { departmentId, employeeId, namedBy: ctx.userId, at: deps.now() };
        await deps.recordChampion(ctx.tenantId, c);
        await seal(ctx, 'workforce.floor_champion.named', 'department', departmentId, { employeeId: employeeId ?? 'not set' });
        return { status: 201, body: { champion: c } };
      },
    },

    // ── QG-09 ───────────────────────────────────────────────────────────────────────────────────────────────────────
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/adoption-gate',
      permission: 'workforce.adoption.read',
      handler: async (ctx) => ({ status: 200, body: { ...await readAdoptionGate(deps, ctx.tenantId), asAt: deps.now() } }),
    },
  ];
}
