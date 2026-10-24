// QG-09 Adoption (roadmap §22: "Role curriculum, competency, floor support and SOP acknowledgements complete"; D11-FR-04
// "training, competency, floor champions and adoption"; OB-320).
//
// The gate is read from the shop's own records, per role, and it names people — "Asha has not been signed competent on
// SOP-04" is something a manager can fix this afternoon; "87% adopted" is not:
//
//   • ROLE CURRICULUM — the owner's approved list for the role (OB-320). A role whose list the owner has not approved is
//     NOT PROVEN: the gate cannot pass on a list nobody approved, and it says so rather than reading an empty list as
//     "nothing to learn".
//   • COMPETENCY — every person in the role signed "competent" on every item of the approved list, by a second person.
//   • SOP ACKNOWLEDGEMENTS — every person in the role acknowledged the CURRENT version of every SOP published for it.
//   • FLOOR SUPPORT — every department has a named floor champion who is still on the staff list (an owner input: until
//     he names them, "not set").
//
// The verdict: NOT_PROVEN while any role's curriculum is unapproved (or there is no role to judge); HOLD while anything
// is missing (with every missing name); GO only when nothing is. Staff actually completing it is the store's work — the
// software's part is to say exactly what is missing. Pure and deterministic.

import type { Employee, SopAcknowledgement } from './workforce';
import type { ApprovedCurriculum, CurriculumItem, TrainingRow } from './training';
import type { BuiltInSop, OwnerGuidePart } from './sop-library.generated';

export type AdoptionVerdict = 'GO' | 'HOLD' | 'NOT_PROVEN';

export interface PublishedSop { readonly sopId: string; readonly title: string; readonly version: number; readonly forRoles: readonly string[] }

export interface FloorChampion { readonly departmentId: string; readonly employeeId: string | null; readonly namedBy: string; readonly at: string }

export interface PersonGap {
  readonly employeeId: string;
  readonly name: string;
  /** Curriculum items not yet signed competent (by a second person). */
  readonly notCompetent: readonly string[];
  /** SOPs whose current version they have not acknowledged. */
  readonly notAcknowledged: readonly string[];
}

export interface RoleReading {
  readonly roleId: string;
  readonly curriculum: { readonly approved: true; readonly version: number; readonly approvedBy: string; readonly items: number } | { readonly approved: false };
  readonly people: number;
  readonly gaps: readonly PersonGap[];
  readonly verdict: AdoptionVerdict;
}

export interface FloorSupportReading {
  readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly champion: string | null; readonly championName: string | null; readonly state: 'named' | 'not_set' | 'champion_left' }[];
  readonly complete: boolean;
}

export interface AdoptionGateReading {
  readonly gate: 'QG-09';
  readonly verdict: AdoptionVerdict;
  readonly roles: readonly RoleReading[];
  readonly floorSupport: FloorSupportReading;
  /** Why it is not GO, in words, one line each. */
  readonly why: readonly string[];
}

/** The proposed curriculum per role, built from the shop's own sheets and the owner guide (OB-320) — for the owner to approve. */
export function proposedCurricula(sheets: readonly BuiltInSop[], ownerGuide: readonly OwnerGuidePart[]): ReadonlyMap<string, readonly CurriculumItem[]> {
  const out = new Map<string, CurriculumItem[]>();
  for (const s of sheets) for (const r of s.forRoles) out.set(r, [...(out.get(r) ?? []), { itemId: s.sopId, title: s.title, titleTa: s.titleTa, source: s.sopId }]);
  const owner = out.get('owner') ?? [];
  for (const p of ownerGuide) owner.push({ itemId: `owner-guide-${p.part}`, title: `Owner's guide, Part ${p.part} — ${p.title}`, titleTa: `உரிமையாளர் வழிகாட்டி, பகுதி ${p.part} — ${p.title}`, source: `owner-guide:${p.part}` });
  if (owner.length > 0) out.set('owner', owner);
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** The latest champion named for each department (`employeeId: null` = taken off). */
export function currentChampions(records: readonly FloorChampion[]): ReadonlyMap<string, FloorChampion> {
  const m = new Map<string, FloorChampion>();
  for (const r of records) m.set(r.departmentId, r);
  return m;
}

export function adoptionGate(input: {
  /** The roles judged: every role with a proposed or approved curriculum, and every staff role somebody is rostered for. */
  readonly roles: readonly string[];
  readonly curricula: ReadonlyMap<string, ApprovedCurriculum>;
  /** The people in each role (active staff for a staff role; the owner's grant holders for "owner"). */
  readonly peopleOf: (roleId: string) => readonly Employee[];
  readonly training: readonly TrainingRow[];
  readonly sops: readonly PublishedSop[];
  readonly acknowledgements: readonly SopAcknowledgement[];
  readonly departments: readonly { readonly departmentId: string; readonly name: string }[];
  readonly champions: ReadonlyMap<string, FloorChampion>;
  readonly activeStaff: readonly Employee[];
}): AdoptionGateReading {
  const why: string[] = [];
  const competent = new Set(input.training.filter((t) => t.state === 'competent').map((t) => `${t.employeeId}\u0000${t.itemId}`));
  const acked = new Map<string, number>();
  for (const a of input.acknowledgements) {
    const k = `${a.employeeId}\u0000${a.sopId}`;
    acked.set(k, Math.max(acked.get(k) ?? -1, a.version));
  }
  const roles = [...new Set(input.roles)].sort().map((roleId): RoleReading => {
    const c = input.curricula.get(roleId);
    const people = input.peopleOf(roleId);
    const sops = input.sops.filter((s) => s.forRoles.includes(roleId));
    const gaps: PersonGap[] = [];
    for (const p of people) {
      const notCompetent = c === undefined ? [] : c.items.filter((i) => !competent.has(`${p.employeeId}\u0000${i.itemId}`)).map((i) => i.itemId);
      const notAcknowledged = sops.filter((s) => (acked.get(`${p.employeeId}\u0000${s.sopId}`) ?? -1) < s.version).map((s) => s.sopId);
      if (notCompetent.length > 0 || notAcknowledged.length > 0) gaps.push({ employeeId: p.employeeId, name: p.name, notCompetent, notAcknowledged });
    }
    let verdict: AdoptionVerdict;
    if (c === undefined) { verdict = 'NOT_PROVEN'; why.push(`${roleId}: the owner has not approved this role's curriculum, so it is not proven.`); }
    else if (gaps.length > 0) { verdict = 'HOLD'; for (const g of gaps) why.push(`${roleId}: ${g.name} (${g.employeeId})${g.notCompetent.length > 0 ? ` not signed competent on ${g.notCompetent.join(', ')}` : ''}${g.notCompetent.length > 0 && g.notAcknowledged.length > 0 ? ';' : ''}${g.notAcknowledged.length > 0 ? ` has not acknowledged ${g.notAcknowledged.join(', ')}` : ''}.`); }
    else if (people.length === 0) { verdict = 'HOLD'; why.push(`${roleId}: nobody is in this role on the staff list.`); }
    else verdict = 'GO';
    return {
      roleId, people: people.length, gaps, verdict,
      curriculum: c === undefined ? { approved: false } : { approved: true, version: c.version, approvedBy: c.approvedBy, items: c.items.length },
    };
  });

  const active = new Map(input.activeStaff.filter((e) => e.active).map((e) => [e.employeeId, e] as const));
  const departments = input.departments.map((d) => {
    const ch = input.champions.get(d.departmentId);
    const id = ch?.employeeId ?? null;
    const state: 'named' | 'not_set' | 'champion_left' = id === null ? 'not_set' : active.has(id) ? 'named' : 'champion_left';
    return { departmentId: d.departmentId, name: d.name, champion: id, championName: id === null ? null : active.get(id)?.name ?? null, state };
  });
  const floorComplete = departments.length > 0 && departments.every((d) => d.state === 'named');
  if (departments.length === 0) why.push('Floor support: no departments are recorded, so no floor champion can be named (not set).');
  for (const d of departments) {
    if (d.state === 'not_set') why.push(`Floor support: ${d.name} has no floor champion (not set).`);
    if (d.state === 'champion_left') why.push(`Floor support: ${d.name}'s floor champion ${d.champion} is no longer on the staff list.`);
  }

  const verdict: AdoptionVerdict = roles.length === 0 || roles.some((r) => r.verdict === 'NOT_PROVEN') ? 'NOT_PROVEN'
    : roles.some((r) => r.verdict === 'HOLD') || !floorComplete ? 'HOLD' : 'GO';
  if (roles.length === 0) why.unshift('No role is judged yet: there is no curriculum and nobody on the staff list.');
  return { gate: 'QG-09', verdict, roles, floorSupport: { departments, complete: floorComplete }, why };
}
