// DEPARTMENTS — the part of the Organisation page where a person with setup rights says which product categories a
// department owns, and anyone who may read reports reads one department's sales for a day (M01-FR-01 acceptance "a report
// filtered to one department returns only that department's data" · M02-FR-02 · §28 · P-08).
//
// A THIN client over head office's own routes, every rule theirs (`services/platform/src/org-departments.ts`):
//   • `GET /v1/org/departments` (`org.branch.read`) — the departments, the categories each owns, and the categories nobody owns;
//   • `POST /v1/org/departments/:departmentId/categories` { categoryIds, reason, approvalId } (`platform.setup.write`) — a
//     STRUCTURAL change, so it ALWAYS names the owner's approval: the person asks first on head office's maker-checker engine
//     (`POST /v1/approvals/requests`, kind `org_structure_change`, subject `department:<id>`, details EXACTLY what the change
//     will send: { categoryIds, reason, departmentId }); the owner (`org.structure.approve`, never the person asking) approves
//     it on his Approvals page; then "Save the approved change" sends it naming that approval number. Nobody's name is typed.
//     A category already owned by another department is refused by head office, in its words;
//   • `GET /v1/org/departments/:departmentId/report?day=YYYY-MM-DD` (`reporting.report.read`) — the department's own sales
//     that trading day; what no department owns is counted apart, never folded in; a reader limited to other departments is
//     refused by head office.
// Head office unreachable → "nothing was saved" / "could not be read", never a success it did not get.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { outcomeOf, rupees, type HttpAnswer, type Outcome } from './finance-close-session';

export interface OrgDepartmentsHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

export const ORG_DEPARTMENT_PERMISSIONS = Object.freeze({ read: 'org.branch.read', link: 'platform.setup.write', report: 'reporting.report.read' });
export const ORG_STRUCTURE_KIND = 'org_structure_change';

export interface DepartmentRow { readonly departmentId: string; readonly name: string; readonly parentId: string | null; readonly status: string; readonly categoryIds: readonly string[] }
export interface DepartmentList { readonly departments: readonly DepartmentRow[]; readonly unownedCategories: readonly string[] }

export interface LinkRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly subjectRef: string;
  readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly details: { readonly categoryIds: readonly string[]; readonly reason: string; readonly departmentId: string };
  readonly decidedBy?: string;
  readonly decisionReason?: string;
  readonly requestedAt: string;
}

export interface DepartmentReport {
  readonly departmentId: string; readonly name: string; readonly tradingDay: string; readonly categoryIds: readonly string[];
  readonly products: readonly { readonly productId: string; readonly name: string | null; readonly quantityMinor: number; readonly valueMinor: number; readonly bills: number }[];
  readonly totalValueMinor: number; readonly unownedValueMinor: number; readonly note?: string;
}

export type OrgDeptCopyKey =
  | 'h' | 'lede' | 'department' | 'owns' | 'ownsNothing' | 'unowned' | 'noDepartments' | 'pick' | 'reason' | 'ask'
  | 'asked' | 'mineH' | 'noMine' | 'reqWaiting' | 'reqApproved' | 'reqRejected' | 'reqUsed' | 'reqExpired' | 'useApproved' | 'saved'
  | 'reportH' | 'reportLede' | 'day' | 'showReport' | 'reportTotal' | 'reportUnowned' | 'reportNone' | 'reportLine' | 'reportNote'
  | 'refused' | 'unreachable' | 'unreadable' | 'notAllowed' | 'needDepartment' | 'needReason' | 'needDay' | 'readOnly' | 'cannotReport' | 'none';

export const ORG_DEPT_COPY: BilingualCopy<OrgDeptCopyKey> = {
  en: {
    h: 'Departments and their categories',
    lede: 'Each department owns product categories (and their sub-categories); its report counts only those. A category belongs to one department at most. Changing what a department owns is the owner’s approval, never the person asking.',
    department: 'Department', owns: 'Owns: {list}', ownsNothing: 'Owns no categories yet — nothing is counted to it.',
    unowned: 'Categories no department owns: {list}', noDepartments: 'No department yet. Add one above (kind “Department”) under its store.',
    pick: 'The categories this department should own', reason: 'Why (the owner reads this)', ask: 'Ask the owner to approve this',
    asked: 'Asked. The owner decides it on the Approvals page; once approved, press “Save the approved change” below. Nothing was changed yet.',
    mineH: 'Your requests for this department', noMine: 'You have asked for no change to this department.',
    reqWaiting: 'Approval number {id}: {list} — waiting for the owner', reqApproved: 'Approval number {id}: {list} — approved by {by}',
    reqRejected: 'Approval number {id}: {list} — refused by {by}: {why}', reqUsed: 'Approval number {id}: {list} — approved and saved',
    reqExpired: 'Approval number {id}: {list} — the approval ran out; ask again', useApproved: 'Save the approved change',
    saved: 'Saved at head office with the owner’s approval ({by}).',
    reportH: 'Department report', reportLede: 'One department’s sales for one trading day — only its own products. What no department owns is shown apart, never added in.',
    day: 'Trading day (empty for today)', showReport: 'Show the report', reportTotal: '{name} on {day}: {total}', reportUnowned: 'Sold that day in categories no department owns: {total}',
    reportNone: 'No sale of this department’s products that day.', reportLine: '{name}: {qty} sold on {bills} bills, {value}',
    reportNote: 'This department owns no categories yet, so nothing is counted to it.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — it could not be read, so nothing is shown.',
    notAllowed: 'Your role cannot change what a department owns.', needDepartment: 'Choose a department first.',
    needReason: 'Write why, then ask again. Nothing was sent.', needDay: 'Write the trading day as a date, or leave it empty for today.',
    readOnly: 'You can read the departments; changing what one owns needs setup rights.', cannotReport: 'Your role cannot read reports.',
    none: 'none',
  },
  ta: {
    h: 'பிரிவுகளும் அவற்றின் வகைகளும்',
    lede: 'ஒவ்வொரு பிரிவும் பொருள் வகைகளை (அவற்றின் துணை வகைகளுடன்) உடையது; அதன் அறிக்கை அவற்றை மட்டுமே கணக்கிடும். ஒரு வகை அதிகபட்சம் ஒரு பிரிவுக்கே சொந்தம். ஒரு பிரிவு உடையதை மாற்றுவது உரிமையாளரின் ஒப்புதல், கேட்பவர் ஒருபோதும் இல்லை.',
    department: 'பிரிவு', owns: 'உடையவை: {list}', ownsNothing: 'இன்னும் எந்த வகையும் இல்லை — இதற்கு எதுவும் கணக்கிடப்படாது.',
    unowned: 'எந்தப் பிரிவுக்கும் சொந்தமில்லாத வகைகள்: {list}', noDepartments: 'இன்னும் பிரிவு இல்லை. மேலே அதன் கடையின் கீழ் ஒன்றைச் சேர்க்கவும் (வகை “பிரிவு”).',
    pick: 'இந்தப் பிரிவு உடைய வேண்டிய வகைகள்', reason: 'ஏன் (உரிமையாளர் இதைப் படிப்பார்)', ask: 'இதற்கு உரிமையாளரின் ஒப்புதல் கேள்',
    asked: 'கேட்கப்பட்டது. உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் முடிவு செய்வார்; ஒப்புதல் கிடைத்ததும் கீழே “ஒப்புதல் பெற்ற மாற்றத்தைச் சேமி” அழுத்தவும். இன்னும் எதுவும் மாற்றப்படவில்லை.',
    mineH: 'இந்தப் பிரிவுக்கான உங்கள் கோரிக்கைகள்', noMine: 'இந்தப் பிரிவுக்கு நீங்கள் எந்த மாற்றமும் கேட்கவில்லை.',
    reqWaiting: 'ஒப்புதல் எண் {id}: {list} — உரிமையாளருக்காகக் காத்திருக்கிறது', reqApproved: 'ஒப்புதல் எண் {id}: {list} — {by} ஒப்புதல் அளித்தார்',
    reqRejected: 'ஒப்புதல் எண் {id}: {list} — {by} மறுத்தார்: {why}', reqUsed: 'ஒப்புதல் எண் {id}: {list} — ஒப்புதல் பெற்றுச் சேமிக்கப்பட்டது',
    reqExpired: 'ஒப்புதல் எண் {id}: {list} — ஒப்புதலின் காலம் முடிந்தது; மீண்டும் கேளுங்கள்', useApproved: 'ஒப்புதல் பெற்ற மாற்றத்தைச் சேமி',
    saved: 'உரிமையாளரின் ஒப்புதலுடன் ({by}) தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.',
    reportH: 'பிரிவு அறிக்கை', reportLede: 'ஒரு வணிக நாளில் ஒரு பிரிவின் விற்பனை — அதன் சொந்தப் பொருட்கள் மட்டும். எந்தப் பிரிவுக்கும் சொந்தமில்லாதவை தனியாகக் காட்டப்படும், சேர்க்கப்படாது.',
    day: 'வணிக நாள் (இன்றைக்கு காலியாக)', showReport: 'அறிக்கையைக் காட்டு', reportTotal: '{day} அன்று {name}: {total}', reportUnowned: 'அன்று எந்தப் பிரிவுக்கும் சொந்தமில்லாத வகைகளில் விற்றது: {total}',
    reportNone: 'அன்று இந்தப் பிரிவின் பொருள் எதுவும் விற்கப்படவில்லை.', reportLine: '{name}: {bills} பில்களில் {qty} விற்றது, {value}',
    reportNote: 'இந்தப் பிரிவு இன்னும் எந்த வகையையும் உடையவில்லை, அதனால் இதற்கு எதுவும் கணக்கிடப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — படிக்க முடியவில்லை, அதனால் எதுவும் காட்டப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கால் ஒரு பிரிவு உடையதை மாற்ற முடியாது.', needDepartment: 'முதலில் ஒரு பிரிவைத் தேர்ந்தெடுங்கள்.',
    needReason: 'ஏன் என்று எழுதி, மீண்டும் கேளுங்கள். எதுவும் அனுப்பப்படவில்லை.', needDay: 'வணிக நாளைத் தேதியாக எழுதுங்கள், அல்லது இன்றைக்கு காலியாக விடுங்கள்.',
    readOnly: 'நீங்கள் பிரிவுகளைப் படிக்கலாம்; ஒன்று உடையதை மாற்ற அமைப்பு உரிமை தேவை.', cannotReport: 'உங்கள் பங்கால் அறிக்கைகளைப் படிக்க முடியாது.',
    none: 'எதுவுமில்லை',
  },
};
export const ORG_DEPT_COPY_KEYS: readonly OrgDeptCopyKey[] = Object.freeze(Object.keys(ORG_DEPT_COPY.en) as OrgDeptCopyKey[]);

export function orgDeptWords(lang: Lang): (key: OrgDeptCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(ORG_DEPT_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

const listWords = (lang: Lang, ids: readonly string[]): string => (ids.length === 0 ? orgDeptWords(lang)('none') : ids.join(', '));

export function requestLine(lang: Lang, r: LinkRequest): string {
  const w = orgDeptWords(lang);
  const fill = { id: r.requestId, list: listWords(lang, r.details.categoryIds ?? []), by: r.decidedBy ?? '', why: r.decisionReason ?? '' };
  switch (r.status) {
    case 'waiting': return w('reqWaiting', fill);
    case 'approved': return w('reqApproved', fill);
    case 'rejected': return w('reqRejected', fill);
    case 'used': return w('reqUsed', fill);
    case 'expired': return w('reqExpired', fill);
  }
}

/** The report in plain lines: the total first, each product, then what no department owns (apart). Pure. */
export function reportLines(lang: Lang, r: DepartmentReport): { readonly total: string; readonly lines: readonly string[]; readonly unowned: string; readonly note?: string } {
  const w = orgDeptWords(lang);
  const lines = r.products.length === 0 ? [w('reportNone')]
    : r.products.map((p) => w('reportLine', { name: p.name ?? p.productId, qty: p.quantityMinor, bills: p.bills, value: rupees(p.valueMinor) }));
  return {
    total: w('reportTotal', { name: r.name, day: r.tradingDay, total: rupees(r.totalValueMinor) }), lines,
    unowned: w('reportUnowned', { total: rupees(r.unownedValueMinor) }),
    ...(r.note === undefined ? {} : { note: w('reportNote') }),
  };
}

export function orgDeptOutcomeWords(lang: Lang, o: Outcome<{ approvedBy?: string }>, saved: 'ask' | 'link' | 'read'): { readonly ok: boolean; readonly text: string } {
  const w = orgDeptWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: saved === 'ask' ? w('asked') : saved === 'link' ? w('saved', { by: o.body.approvedBy ?? '' }) : '' };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: o.needs === ORG_DEPARTMENT_PERMISSIONS.report ? w('cannotReport') : w('notAllowed') };
    case 'invalid': return { ok: false, text: w(o.detail === 'reason' ? 'needReason' : o.detail === 'day' ? 'needDay' : 'needDepartment') };
    case 'unreachable': return { ok: false, text: saved === 'read' ? w('unreadable') : w('unreachable') };
  }
}

export interface OrgDepartmentsSession {
  readonly may: { readonly read: boolean; readonly link: boolean; readonly report: boolean };
  departments(): Promise<Outcome<DepartmentList>>;
  /** This person's own requests to change what the department owns, newest first. */
  myRequests(departmentId: string): Promise<Outcome<readonly LinkRequest[]>>;
  /** Ask the owner for EXACTLY this list (the details the change will send). A reason is needed. */
  askLink(input: { readonly departmentId: string; readonly categoryIds: readonly string[]; readonly reason: string }): Promise<Outcome<{ readonly requestId: string }>>;
  /** Send an approved change naming its approval number; the list and reason are the approved ones, never retyped. */
  saveApprovedLink(request: LinkRequest): Promise<Outcome<{ readonly approvedBy: string }>>;
  report(departmentId: string, day: string): Promise<Outcome<DepartmentReport>>;
}

export function createOrgDepartmentsSession(viewer: { readonly permissions: readonly string[] }, http: OrgDepartmentsHttp): OrgDepartmentsSession {
  const held = new Set(viewer.permissions);
  const P = ORG_DEPARTMENT_PERMISSIONS;
  const may = Object.freeze({ read: held.has(P.read), link: held.has(P.link), report: held.has(P.report) });
  const deptPath = (id: string): string => `/v1/org/departments/${encodeURIComponent(id.trim())}`;
  return {
    may,
    departments: async () => {
      if (!may.read) return { kind: 'not_allowed', needs: P.read };
      return outcomeOf<DepartmentList>(await http.get('/v1/org/departments'));
    },
    myRequests: async (departmentId) => {
      if (!may.link) return { kind: 'not_allowed', needs: P.link };
      const inbox = outcomeOf<{ mine?: LinkRequest[] }>(await http.get('/v1/approvals/requests'));
      if (inbox.kind !== 'done') return inbox;
      const subject = `department:${departmentId.trim()}`;
      const mine = (inbox.body.mine ?? []).filter((r) => r.kind === ORG_STRUCTURE_KIND && r.subjectRef === subject && Array.isArray(r.details?.categoryIds))
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return { kind: 'done', status: 200, body: mine };
    },
    askLink: async (input) => {
      if (!may.link) return { kind: 'not_allowed', needs: P.link };
      const departmentId = input.departmentId.trim();
      if (departmentId === '') return { kind: 'invalid', detail: 'department' };
      const reason = input.reason.trim().slice(0, 300);
      if (reason === '') return { kind: 'invalid', detail: 'reason' };
      // The list exactly as head office will store it (unique, sorted) — the same object the change will send, so the
      // engine's fingerprint of the details matches the change's body.
      const categoryIds = [...new Set(input.categoryIds.map((c) => c.trim()).filter((c) => c !== ''))].sort();
      return outcomeOf(await http.post('/v1/approvals/requests', {
        kind: ORG_STRUCTURE_KIND, subjectRef: `department:${departmentId}`, valueMinor: null,
        details: { categoryIds, reason, departmentId },
        summary: `Department ${departmentId} owns: ${categoryIds.length === 0 ? 'no categories' : categoryIds.join(', ')}`.slice(0, 300), reason,
      }));
    },
    saveApprovedLink: async (request) => {
      if (!may.link) return { kind: 'not_allowed', needs: P.link };
      const { categoryIds, reason, departmentId } = request.details;
      return outcomeOf(await http.post(`${deptPath(departmentId)}/categories`, { categoryIds, reason, approvalId: request.requestId }));
    },
    report: async (departmentId, day) => {
      if (!may.report) return { kind: 'not_allowed', needs: P.report };
      if (departmentId.trim() === '') return { kind: 'invalid', detail: 'department' };
      // No day chosen → head office's own today (the shop's calendar); the screen never reads a clock of its own.
      if (day.trim() === '') return outcomeOf<DepartmentReport>(await http.get(`${deptPath(departmentId)}/report`));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return { kind: 'invalid', detail: 'day' };
      return outcomeOf<DepartmentReport>(await http.get(`${deptPath(departmentId)}/report?day=${encodeURIComponent(day.trim())}`));
    },
  };
}
