// API-11 HR/Workforce — the role-aware SOP / HELP CENTRE (M25-FR-04: "deliver role-aware SOPs/help and capture
// acknowledgement … a cashier sees cashier SOPs; acknowledgement is recorded; help works offline") and EMERGENCY
// PROCEDURES (D11-FR-06: "incident, injury, lost-and-found and emergency procedures").
//
//   • CONTENT — an SOP now carries its words in English and Tamil, at a version, for the roles it applies to, as a
//     procedure or an emergency procedure. The SOP definition (title, version, roles) is the same record the SOP store
//     and its status already read (`sop-store.ts`); its words sit beside it on their own record. A new version is a new
//     record — the old words stay, so an acknowledgement always names the words it acknowledged.
//   • THE SHOP'S OWN SHEETS — the four SOP sheets in docs/sop are built in (`sop-library.generated.ts`); a manager
//     publishes each (the roles from the sheet's own "For:" line, changeable on the way).
//   • HELP FOR ME — `GET /v1/hr/workforce/help`: the SOPs for the roles the signed-in person holds (their sign-in roles
//     and their roster roles), with the words, whether they have acknowledged the CURRENT version, and the emergency
//     contacts. A person acknowledges for themselves only, and only the current version.
//   • OFFLINE — the store computer pulls the whole library for its store (`GET /v1/hr/workforce/help-library`) so the
//     help page it serves works with the line down; an acknowledgement given there is carried back and recorded here
//     (`…/acknowledgements/:employeeId/synced`), the person re-checked from their own grants.
//   • EMERGENCY — the owner's emergency contacts ("not set" until he enters them), emergency procedures as SOPs of the
//     emergency kind, and a drill register: which procedure was practised, where, when, by whom, what was found.
//
// Nothing is acknowledged for anybody automatically; nothing is deleted (hard rule #6).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Employee, SopAcknowledgement } from '../../../packages/workforce/src/workforce';
import { BUILT_IN_SOPS } from '../../../packages/workforce/src/sop-library.generated';
import type { Sop } from './sop-store';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export type SopCategory = 'procedure' | 'emergency';

/** An SOP's words at one version. */
export interface SopContent {
  readonly sopId: string;
  readonly version: number;
  readonly titleTa: string;
  readonly category: SopCategory;
  readonly bodyEn: string;
  readonly bodyTa: string;
  /** Where the words came from: a built-in sheet, or written on the help page. */
  readonly source: 'built_in' | 'written';
  readonly setBy: string;
  readonly setAt: string;
}

export interface EmergencyContact { readonly label: string; readonly labelTa?: string; readonly phone: string }
export interface EmergencyContacts { readonly contacts: readonly EmergencyContact[]; readonly setBy: string; readonly setAt: string }

export interface EmergencyDrill {
  readonly drillId: string;
  /** The emergency procedure practised. */
  readonly sopId: string;
  readonly branchId: string;
  readonly heldOn: string;
  readonly participants: readonly string[];
  readonly findings: string;
  readonly evidenceRef?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface HelpCentreDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly now: () => string;
  readonly sops: (tenantId: string) => Promise<readonly Sop[]>;
  readonly putSop: (tenantId: string, sop: Sop, key: string) => Promise<void>;
  readonly contents: (tenantId: string) => Promise<readonly SopContent[]>;
  readonly putContent: (tenantId: string, content: SopContent) => Promise<void>;
  readonly acknowledgements: (tenantId: string, employeeId?: string) => Promise<readonly SopAcknowledgement[]>;
  readonly putAcknowledgement: (tenantId: string, ack: SopAcknowledgement, key: string) => Promise<void>;
  readonly employee: (tenantId: string, employeeId: string) => Promise<Employee | undefined>;
  readonly employees: (tenantId: string) => Promise<readonly Employee[]>;
  /** The sign-in roles a person holds now (their grants). */
  readonly rolesOf: (tenantId: string, userId: string) => Promise<readonly string[]>;
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  readonly contacts: (tenantId: string) => Promise<EmergencyContacts | undefined>;
  readonly putContacts: (tenantId: string, c: EmergencyContacts) => Promise<void>;
  readonly drills: (tenantId: string) => Promise<readonly EmergencyDrill[]>;
  readonly putDrill: (tenantId: string, d: EmergencyDrill) => Promise<void>;
  readonly recordAudit?: Recorder;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send it again. Nothing was saved.' });
};
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};
/** The longest SOP body kept (a sheet is one printable page; this is ample and keeps a page small). */
const MAX_BODY_CHARS = 20_000;

/** One published SOP as the help page shows it: the definition and its words at that version (or that it has none). */
export interface HelpSop {
  readonly sopId: string;
  readonly title: string;
  readonly titleTa: string;
  readonly version: number;
  readonly forRoles: readonly string[];
  readonly category: SopCategory;
  readonly bodyEn: string | null;
  readonly bodyTa: string | null;
}

/** The library as published now: the latest definition per SOP and its words at that version. */
export function helpLibrary(sops: readonly Sop[], contents: readonly SopContent[]): readonly HelpSop[] {
  const latestDef = new Map<string, Sop>();
  for (const s of sops) latestDef.set(s.sopId, s);
  const words = new Map<string, SopContent>();
  for (const c of contents) words.set(`${c.sopId}\u0000${c.version}`, c);
  return [...latestDef.values()].map((s): HelpSop => {
    const c = words.get(`${s.sopId}\u0000${s.version}`);
    return { sopId: s.sopId, title: s.title, titleTa: c?.titleTa ?? s.title, version: s.version, forRoles: s.forRoles, category: c?.category ?? 'procedure', bodyEn: c?.bodyEn ?? null, bodyTa: c?.bodyTa ?? null };
  }).sort((a, b) => (a.category === b.category ? a.sopId.localeCompare(b.sopId) : a.category === 'emergency' ? -1 : 1));
}

/** The latest version each person acknowledged of each SOP. */
function latestAcks(acks: readonly SopAcknowledgement[]): Map<string, SopAcknowledgement> {
  const m = new Map<string, SopAcknowledgement>();
  for (const a of acks) {
    const k = `${a.employeeId}\u0000${a.sopId}`;
    const p = m.get(k);
    if (p === undefined || a.version >= p.version) m.set(k, a);
  }
  return m;
}

function readContacts(raw: unknown): readonly EmergencyContact[] | string {
  if (!Array.isArray(raw)) return 'Send { contacts: [{ label, phone, labelTa? }] } — an empty list takes them all off.';
  const out: EmergencyContact[] = [];
  for (const r of raw) {
    const o = r !== null && typeof r === 'object' ? r as Record<string, unknown> : {};
    if (!isStr(o['label']) || !isStr(o['phone']) || o['phone'].replace(/\D/g, '').length < 3) return 'Each contact needs a label and a phone number (at least 3 digits, e.g. 101).';
    out.push({ label: o['label'].trim(), phone: o['phone'].trim(), ...(isStr(o['labelTa']) ? { labelTa: o['labelTa'].trim() } : {}) });
  }
  return out;
}

export function helpCentreRoutes(deps: HelpCentreDeps): readonly Route[] {
  const seal = async (ctx: RequestContext, action: string, objectType: string, objectId: string, after: Record<string, string>, actorId = ctx.userId): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, { actorId, action, objectType, objectId, at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, correlationId: objectId });
  };
  /** Publish an SOP's definition and its words at a version (a re-send of the same words collapses). */
  const publish = async (ctx: RequestContext, sop: Sop, content: Omit<SopContent, 'setBy' | 'setAt'>): Promise<{ status: number; body: unknown }> => {
    const library = helpLibrary(await deps.sops(ctx.tenantId), await deps.contents(ctx.tenantId));
    const current = library.find((s) => s.sopId === sop.sopId);
    if (current !== undefined) {
      const same = current.version === sop.version && current.bodyEn === content.bodyEn && current.bodyTa === content.bodyTa && JSON.stringify(current.forRoles) === JSON.stringify(sop.forRoles) && current.title === sop.title;
      if (same) return { status: 200, body: { sop: current, alreadyPublished: true } };
      if (sop.version <= current.version) refuse(409, 'version_not_newer', `${sop.sopId} is at version ${current.version}; changed words are a new version (${current.version + 1}), so an acknowledgement always names the words it acknowledged.`, `Publish it as version ${current.version + 1}. Nothing was saved.`);
    }
    const at = deps.now();
    await deps.putContent(ctx.tenantId, { ...content, setBy: ctx.userId, setAt: at });
    await deps.putSop(ctx.tenantId, sop, `help-${sop.sopId}-v${sop.version}`);
    await seal(ctx, 'workforce.sop.published', 'sop', sop.sopId, { version: String(sop.version), forRoles: sop.forRoles.join(','), category: content.category, source: content.source });
    return { status: 201, body: { sop: helpLibrary([sop], [{ ...content, setBy: ctx.userId, setAt: at }])[0] } };
  };
  /** Record an acknowledgement of the CURRENT version by this person (refusing an SOP not for their roles). */
  const acknowledge = async (ctx: RequestContext, employeeId: string, sopId: string, version: unknown, at: string, key: string, via: 'self' | 'store_computer'): Promise<{ status: number; body: unknown }> => {
    if (!isNonNegInt(version)) bad('not_readable_as_an_acknowledgement', 'Say which version you read: { version }.');
    const sop = helpLibrary(await deps.sops(ctx.tenantId), await deps.contents(ctx.tenantId)).find((s) => s.sopId === sopId);
    if (sop === undefined) throw notFound(`SOP ${sopId}`);
    const roles = new Set([...(await deps.rolesOf(ctx.tenantId, employeeId)), ...((await deps.employee(ctx.tenantId, employeeId))?.roles ?? [])]);
    if (!sop.forRoles.some((r) => roles.has(r))) refuse(422, 'not_for_your_role', `${sopId} is for ${sop.forRoles.join(', ')}; ${employeeId} holds none of those roles.`, 'Read the SOPs for your own role. Nothing was saved.');
    const prior = latestAcks(await deps.acknowledgements(ctx.tenantId, employeeId)).get(`${employeeId}\u0000${sopId}`);
    if (prior !== undefined && prior.version >= (version as number)) return { status: 200, body: { acknowledgement: prior, alreadyAcknowledged: true } };
    // At the screen it is the current version only. From the store computer an older version is still a fact — the
    // person read the words the box held — recorded as it is; the status then shows them not up to date.
    if (via === 'self' && version !== sop.version) refuse(409, 'not_the_current_version', `${sopId} is now version ${sop.version}; you read version ${String(version)}.`, 'Read the current words and acknowledge those. Nothing was saved.');
    if ((version as number) > sop.version) refuse(422, 'no_such_version', `${sopId} has no version ${String(version)} yet.`, 'Keep it at the store and raise it. Nothing was saved.');
    const ack: SopAcknowledgement = { sopId, version: version as number, employeeId, acknowledgedAt: at };
    await deps.putAcknowledgement(ctx.tenantId, ack, key);
    await seal(ctx, 'workforce.sop.acknowledged', 'sop', sopId, { employeeId, version: String(version), via }, employeeId);
    return { status: via === 'self' ? 201 : 202, body: { acknowledgement: ack, current: ack.version === sop.version } };
  };

  return [
    {
      // Help for the signed-in person. ?all=1 (a manager holding workforce.sop.read) shows every role's.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/help',
      permission: 'workforce.help.read',
      handler: async (ctx) => {
        const [library, employee, signIn, acks, contacts, perms] = await Promise.all([
          deps.sops(ctx.tenantId).then(async (s) => helpLibrary(s, await deps.contents(ctx.tenantId))), deps.employee(ctx.tenantId, ctx.userId),
          deps.rolesOf(ctx.tenantId, ctx.userId), deps.acknowledgements(ctx.tenantId, ctx.userId), deps.contacts(ctx.tenantId), deps.permissionsOf(ctx.tenantId, ctx.userId),
        ]);
        const roles = [...new Set([...signIn, ...(employee?.roles ?? [])])].sort();
        const all = ctx.query['all'] === '1' && (perms ?? []).includes('workforce.sop.read');
        const mine = latestAcks(acks);
        const sops = library.filter((s) => all || s.forRoles.some((r) => roles.includes(r))).map((s) => {
          const a = mine.get(`${ctx.userId}\u0000${s.sopId}`);
          return { ...s, forMe: s.forRoles.some((r) => roles.includes(r)), acknowledgedVersion: a?.version ?? null, upToDate: a !== undefined && a.version >= s.version };
        });
        return {
          status: 200,
          body: {
            userId: ctx.userId, roles, sops, outstanding: sops.filter((s) => s.forMe && !s.upToDate).length,
            emergencyContacts: contacts === undefined ? { set: false, contacts: [] } : { set: contacts.contacts.length > 0, contacts: contacts.contacts, setBy: contacts.setBy, setAt: contacts.setAt },
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Write (or re-version) an SOP with its words. Body: { title, titleTa, version, forRoles[], category, bodyEn, bodyTa }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/help/sops/:sopId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const sopId = (ctx.params['sopId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (sopId === '' || !isStr(b['title']) || !isStr(b['titleTa']) || !isNonNegInt(b['version']) || (b['version'] as number) < 1
          || !Array.isArray(b['forRoles']) || b['forRoles'].length === 0 || !(b['forRoles'] as unknown[]).every(isStr)
          || (b['category'] !== 'procedure' && b['category'] !== 'emergency') || !isStr(b['bodyEn']) || !isStr(b['bodyTa'])) {
          bad('not_readable_as_an_sop', 'An SOP needs { title, titleTa, version (1 or more), forRoles[] (at least one), category (procedure | emergency), bodyEn, bodyTa } — English and Tamil words both.');
        }
        if ((b['bodyEn'] as string).length > MAX_BODY_CHARS || (b['bodyTa'] as string).length > MAX_BODY_CHARS) bad('sop_too_long', `An SOP is one page; at most ${MAX_BODY_CHARS} characters in each language.`);
        if (BUILT_IN_SOPS.some((s) => s.sopId === sopId)) refuse(409, 'built_in_sheet', `${sopId} is one of the shop's own sheets (docs/sop); it is published from the sheet so its words stay the sheet's.`, 'Publish it from the built-in sheets, or use another id. Nothing was saved.');
        return publish(ctx, { sopId, title: (b['title'] as string).trim(), version: b['version'] as number, forRoles: (b['forRoles'] as string[]).map((r) => r.trim()) },
          { sopId, version: b['version'] as number, titleTa: (b['titleTa'] as string).trim(), category: b['category'] as SopCategory, bodyEn: b['bodyEn'] as string, bodyTa: b['bodyTa'] as string, source: 'written' });
      },
    },
    {
      // The shop's own sheets, and where each stands: not published, published at its version, or behind the sheet.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/help/built-in',
      permission: 'workforce.sop.read',
      handler: async (ctx) => {
        const library = helpLibrary(await deps.sops(ctx.tenantId), await deps.contents(ctx.tenantId));
        return {
          status: 200,
          body: {
            sheets: BUILT_IN_SOPS.map((s) => {
              const p = library.find((x) => x.sopId === s.sopId);
              return { sopId: s.sopId, title: s.title, titleTa: s.titleTa, version: s.version, forLine: s.forLine, forRoles: s.forRoles, publishedVersion: p?.version ?? null, publishedForRoles: p?.forRoles ?? null, state: p === undefined ? 'not_published' : p.version >= s.version ? 'published' : 'behind_the_sheet' };
            }),
          },
        };
      },
    },
    {
      // Publish one built-in sheet at its version. Body: { forRoles? } — the sheet's own reading unless changed here.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/help/built-in/:sopId/publish',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const sheet = BUILT_IN_SOPS.find((s) => s.sopId === (ctx.params['sopId'] ?? '').trim());
        if (sheet === undefined) throw notFound(`built-in sheet ${ctx.params['sopId'] ?? ''}`);
        const asked = (ctx.body as { forRoles?: unknown } | null)?.forRoles;
        if (asked !== undefined && !(Array.isArray(asked) && asked.length > 0 && asked.every(isStr))) bad('not_readable_as_roles', 'forRoles is a list of one or more role ids, or left out for the sheet\'s own.');
        const forRoles = asked === undefined ? [...sheet.forRoles] : (asked as string[]).map((r) => r.trim());
        return publish(ctx, { sopId: sheet.sopId, title: sheet.title, version: sheet.version, forRoles },
          { sopId: sheet.sopId, version: sheet.version, titleTa: sheet.titleTa, category: sheet.category, bodyEn: sheet.bodyEn, bodyTa: sheet.bodyTa, source: 'built_in' });
      },
    },
    {
      // I have read this SOP. Body: { version } — the current version only. For myself only.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/sops/:sopId/acknowledge',
      permission: 'workforce.sop.ack.self', idempotent: true,
      handler: async (ctx) => acknowledge(ctx, ctx.userId, (ctx.params['sopId'] ?? '').trim(), (ctx.body as { version?: unknown } | null)?.version, deps.now(), ctx.idempotencyKey ?? `ack-${ctx.userId}-${ctx.params['sopId'] ?? ''}-${deps.now()}`, 'self'),
    },
    {
      // An acknowledgement given on the help page the store computer serves, carried here. The person is re-checked from
      // THEIR grants; one who may not acknowledge is refused by name (kept at the store, visible).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/sops/:sopId/acknowledgements/:employeeId/synced',
      permission: 'workforce.sop.ack.sync', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || b['employeeId'] !== employeeId || b['sopId'] !== ctx.params['sopId'] || !isStr(b['acknowledgedAt']) || Number.isNaN(Date.parse(b['acknowledgedAt']))) {
          bad('not_readable_as_a_relayed_acknowledgement', 'A relayed acknowledgement needs sopId and employeeId matching the address, the version, and when it was given (acknowledgedAt).');
        }
        if (!((await deps.permissionsOf(ctx.tenantId, employeeId)) ?? []).includes('workforce.sop.ack.self')) {
          refuse(403, 'person_may_not_acknowledge', `${employeeId} holds no right to acknowledge SOPs here (re-checked from their own grants).`, 'Keep it at the store; a person must look. Nothing was recorded.');
        }
        return acknowledge(ctx, employeeId, (ctx.params['sopId'] ?? '').trim(), b['version'], b['acknowledgedAt'] as string, `ack-synced-${employeeId}-${String(ctx.params['sopId'])}-${String(b['version'])}`, 'store_computer');
      },
    },
    {
      // The whole library for a store computer's help page, offline: every published SOP with its words, the store's
      // people and the roles they hold, each one's latest acknowledgements, and the emergency contacts.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/help-library',
      permission: 'workforce.help.pull',
      handler: async (ctx) => {
        const storeId = isStr(ctx.query['storeId']) ? ctx.query['storeId'].trim() : undefined;
        const [library, employees, acks, contacts] = await Promise.all([
          deps.sops(ctx.tenantId).then(async (s) => helpLibrary(s, await deps.contents(ctx.tenantId))), deps.employees(ctx.tenantId), deps.acknowledgements(ctx.tenantId), deps.contacts(ctx.tenantId),
        ]);
        const people = employees.filter((e) => e.active && (storeId === undefined || e.branchId === storeId));
        const people2 = await Promise.all(people.map(async (e) => ({ employeeId: e.employeeId, roles: [...new Set([...e.roles, ...await deps.rolesOf(ctx.tenantId, e.employeeId)])].sort() })));
        const ids = new Set(people.map((p) => p.employeeId));
        const latest = [...latestAcks(acks).values()].filter((a) => ids.has(a.employeeId)).map((a) => ({ employeeId: a.employeeId, sopId: a.sopId, version: a.version }));
        return { status: 200, body: { storeId: storeId ?? null, sops: library, people: people2, acknowledgements: latest, emergencyContacts: contacts?.contacts ?? [], contactsSet: (contacts?.contacts.length ?? 0) > 0, asAt: deps.now() } };
      },
    },

    // ── emergency (D11-FR-06) ───────────────────────────────────────────────────────────────────────────────────────
    {
      // The owner's emergency contacts. Body: { contacts: [{ label, labelTa?, phone }] }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/emergency-contacts',
      permission: 'workforce.emergency.manage', idempotent: true,
      handler: async (ctx) => {
        const contacts = readContacts((ctx.body as { contacts?: unknown } | null)?.contacts);
        if (typeof contacts === 'string') bad('not_readable_as_emergency_contacts', contacts);
        const c: EmergencyContacts = { contacts: contacts as readonly EmergencyContact[], setBy: ctx.userId, setAt: deps.now() };
        await deps.putContacts(ctx.tenantId, c);
        await seal(ctx, 'workforce.emergency_contacts.set', 'emergency_contacts', 'emergency-contacts', { contacts: String(c.contacts.length) });
        return { status: 201, body: c };
      },
    },
    {
      // A drill held. Body: { sopId (an emergency procedure), branchId, heldOn, participants[], findings, evidenceRef? }.
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/emergency-drills/:drillId',
      permission: 'workforce.training.manage', idempotent: true,
      handler: async (ctx) => {
        const drillId = (ctx.params['drillId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (drillId === '' || !isStr(b['sopId']) || !isStr(b['branchId']) || !isDay(b['heldOn']) || !Array.isArray(b['participants']) || b['participants'].length === 0
          || !(b['participants'] as unknown[]).every(isStr) || !isStr(b['findings'])) {
          bad('not_readable_as_a_drill', 'A drill needs { sopId, branchId, heldOn (YYYY-MM-DD), participants[] (at least one), findings } and an optional evidenceRef.');
        }
        if ((b['heldOn'] as string) > await shopToday(deps, ctx.tenantId)) refuse(422, 'drill_in_the_future', 'A drill is recorded after it is held.', 'Record it on the day it happened. Nothing was saved.');
        const sop = helpLibrary(await deps.sops(ctx.tenantId), await deps.contents(ctx.tenantId)).find((s) => s.sopId === b['sopId']);
        if (sop === undefined || sop.category !== 'emergency') refuse(422, 'not_an_emergency_procedure', `${String(b['sopId'])} is not a published emergency procedure.`, 'Publish the emergency procedure first, then record the drill. Nothing was saved.');
        const prior = (await deps.drills(ctx.tenantId)).find((d) => d.drillId === drillId);
        if (prior !== undefined) return { status: 200, body: { drill: prior, alreadyRecorded: true } };
        const d: EmergencyDrill = { drillId, sopId: b['sopId'] as string, branchId: (b['branchId'] as string).trim(), heldOn: b['heldOn'] as string, participants: (b['participants'] as string[]).map((p) => p.trim()), findings: (b['findings'] as string).trim(), ...(isStr(b['evidenceRef']) ? { evidenceRef: b['evidenceRef'].trim() } : {}), recordedBy: ctx.userId, recordedAt: deps.now() };
        await deps.putDrill(ctx.tenantId, d);
        await seal(ctx, 'workforce.emergency_drill.recorded', 'emergency_drill', drillId, { sopId: d.sopId, branchId: d.branchId, heldOn: d.heldOn, participants: String(d.participants.length) });
        return { status: 201, body: { drill: d } };
      },
    },
    {
      // Every drill, newest first, and for each emergency procedure the last time it was practised (or never).
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/emergency-drills',
      permission: 'workforce.roster.read',
      handler: async (ctx) => {
        const [drills, library] = await Promise.all([deps.drills(ctx.tenantId), deps.sops(ctx.tenantId).then(async (s) => helpLibrary(s, await deps.contents(ctx.tenantId)))]);
        const procedures = library.filter((s) => s.category === 'emergency').map((s) => {
          const last = drills.filter((d) => d.sopId === s.sopId).sort((a, b) => b.heldOn.localeCompare(a.heldOn))[0];
          return { sopId: s.sopId, title: s.title, titleTa: s.titleTa, lastHeldOn: last?.heldOn ?? null };
        });
        return { status: 200, body: { drills: [...drills].sort((a, b) => b.heldOn.localeCompare(a.heldOn) || a.drillId.localeCompare(b.drillId)), procedures } };
      },
    },
  ];
}
