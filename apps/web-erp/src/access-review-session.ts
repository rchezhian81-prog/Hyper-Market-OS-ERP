// The Access review page (M02-FR-01 "access-review report lists users, roles, scope and last login" · M02-FR-02 "a
// permissions matrix export and an access-review report" · SEC-11 · §28 · P-03 · P-08). A tested, DOM-free session.
//
// It reads head office's access review (GET /v1/identity/access-review) on a click: every person and machine that holds a
// role — what, where (branches and departments), up to how much — with the rows that need a second look flagged; and it
// fetches the permission matrix as a CSV to save (GET /v1/identity/permission-matrix?format=csv). Read-only: the page
// changes nobody's access. The last sign-in is kept by the identity server, and the page says so — never a blank.

import type { ViewerIdentity } from './browser-entry';
import type { Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export interface AccessRowView {
  readonly userId: string; readonly displayName: string | null; readonly signIn: 'issued' | 'requested' | 'ended' | 'none';
  readonly secondFactor: boolean | null; readonly privileged: boolean; readonly machine: boolean;
  readonly roles: readonly {
    readonly roleId: string; readonly roleName: string; readonly branchScope: readonly string[] | 'all'; readonly departmentScope: readonly string[] | 'all';
    /** FG-4 · M02-FR-02: the supplier / category / location limits on this grant — absent or 'all' when not limited. */
    readonly supplierScope?: readonly string[] | 'all'; readonly categoryScope?: readonly string[] | 'all'; readonly locationScope?: readonly string[] | 'all';
  }[];
  readonly emergency: readonly { readonly roleId: string; readonly expiresAt: string }[];
  readonly moneyLimits?: Readonly<Record<string, { readonly state: string; readonly limitMinor: number | null }>>;
  readonly flags: readonly string[];
}
export interface AccessReviewRead { readonly rows: readonly AccessRowView[]; readonly count: number; readonly flagged: number; readonly asAt: string }

export const ACCESS_REVIEW_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Access review',
    lead: 'Who holds which role, where, and up to how much — with the people who need a second look shown first. Reading this changes nobody\'s access; a change is made by two people on the people pages.',
    read: 'Show who holds what', onlyFlagged: 'Only the ones that need a look', exportCsv: 'Save the permission matrix (CSV)', saved: 'The permission matrix is saved as',
    countK: 'People and machines', flaggedK: 'Need a look',
    rolesK: 'Roles', whereK: 'Where', allBranches: 'all branches', allDepartments: 'all departments', departmentsK: 'departments',
    suppliersK: 'suppliers', categoriesK: 'categories', locationsK: 'places',
    signInK: 'Sign-in', si_issued: 'Live', si_requested: 'Being set up', si_ended: 'Ended', si_none: 'No sign-in at head office',
    secondK: 'Second factor', yes: 'Yes', no: 'No', machine: 'Machine (store computer or job)',
    limitsK: 'Money limits', k_refund: 'Refund', k_purchase_order: 'Purchase order', k_stock_adjustment: 'Stock adjustment', notSet: 'Not set', unlimited: 'Unlimited',
    lastSignIn: 'Last sign-in: kept by the identity server, not by head office.', emergencyK: 'Emergency access until',
    f_privileged_without_second_factor: 'Privileged, but no second factor was set up',
    f_holds_roles_after_sign_in_ended: 'Their sign-in has ended, but they still hold a role',
    f_holds_roles_with_no_sign_in: 'Holds a role, but head office gave this name no sign-in',
    f_emergency_access_live: 'Emergency access is live',
    f_it_and_business_roles: 'Holds the IT role and a business role together',
    nothingFlagged: 'Nothing needs a look.',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read the access review.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    lang: 'English', title: 'அணுகல் மீளாய்வு',
    lead: 'யார் எந்தப் பங்கை, எங்கே, எவ்வளவு வரை வைத்திருக்கிறார்கள் — இரண்டாம் பார்வை தேவைப்படுபவர்கள் முதலில். இதைப் படிப்பது யாருடைய அணுகலையும் மாற்றாது; மாற்றம் நபர்கள் பக்கங்களில் இருவரால் செய்யப்படும்.',
    read: 'யார் எதை வைத்திருக்கிறார்கள் என்று காட்டு', onlyFlagged: 'பார்வை தேவைப்படுபவை மட்டும்', exportCsv: 'அனுமதி அட்டவணையைச் சேமி (CSV)', saved: 'அனுமதி அட்டவணை இந்தப் பெயரில் சேமிக்கப்பட்டது',
    countK: 'நபர்களும் இயந்திரங்களும்', flaggedK: 'பார்வை தேவை',
    rolesK: 'பங்குகள்', whereK: 'எங்கே', allBranches: 'எல்லாக் கிளைகளும்', allDepartments: 'எல்லாத் துறைகளும்', departmentsK: 'துறைகள்',
    suppliersK: 'விநியோகஸ்தர்கள்', categoriesK: 'வகைகள்', locationsK: 'இடங்கள்',
    signInK: 'உள்நுழைவு', si_issued: 'இயக்கத்தில்', si_requested: 'அமைக்கப்படுகிறது', si_ended: 'முடிந்தது', si_none: 'தலைமை அலுவலகத்தில் உள்நுழைவு இல்லை',
    secondK: 'இரண்டாம் அடையாளம்', yes: 'ஆம்', no: 'இல்லை', machine: 'இயந்திரம் (கடைக் கணினி அல்லது பணி)',
    limitsK: 'பண வரம்புகள்', k_refund: 'பணத்திருப்பம்', k_purchase_order: 'கொள்முதல் ஆணை', k_stock_adjustment: 'சரக்குத் திருத்தம்', notSet: 'அமைக்கப்படவில்லை', unlimited: 'வரம்பு இல்லை',
    lastSignIn: 'கடைசி உள்நுழைவு: அடையாளச் சேவையகத்தில் வைக்கப்படுகிறது, தலைமை அலுவலகத்தில் அல்ல.', emergencyK: 'அவசர அணுகல் இதுவரை',
    f_privileged_without_second_factor: 'சிறப்பு அதிகாரம் உள்ளது, ஆனால் இரண்டாம் அடையாளம் அமைக்கப்படவில்லை',
    f_holds_roles_after_sign_in_ended: 'உள்நுழைவு முடிந்துவிட்டது, ஆனால் இன்னும் ஒரு பங்கு உள்ளது',
    f_holds_roles_with_no_sign_in: 'பங்கு உள்ளது, ஆனால் இந்தப் பெயருக்குத் தலைமை அலுவலகம் உள்நுழைவு தரவில்லை',
    f_emergency_access_live: 'அவசர அணுகல் இயக்கத்தில் உள்ளது',
    f_it_and_business_roles: 'தகவல் தொழில்நுட்பப் பங்கும் வணிகப் பங்கும் ஒன்றாக உள்ளன',
    nothingFlagged: 'எதற்கும் பார்வை தேவையில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு அணுகல் மீளாய்வைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;
export const accessReviewWords = (lang: Lang, key: string): string => (ACCESS_REVIEW_COPY[lang] as Record<string, string>)[key] ?? (ACCESS_REVIEW_COPY.en as Record<string, string>)[key] ?? key;
export function accessReviewOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${accessReviewWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return accessReviewWords(lang, out.why);
  if (out.result === 'lost_link') return accessReviewWords(lang, 'unreachable');
  return '';
}

/** Where a role reaches, in words. */
export function whereWords(lang: Lang, r: AccessRowView['roles'][number]): string {
  const w = (k: string) => accessReviewWords(lang, k);
  const branches = r.branchScope === 'all' ? w('allBranches') : r.branchScope.join(', ');
  const departments = r.departmentScope === 'all' ? w('allDepartments') : `${w('departmentsK')}: ${r.departmentScope.join(', ')}`;
  // FG-4 · M02-FR-02: a supplier / category / location limit is said only where one is set.
  const limits = ([['suppliersK', r.supplierScope], ['categoriesK', r.categoryScope], ['locationsK', r.locationScope]] as const)
    .filter(([, v]) => v !== undefined && v !== 'all').map(([k, v]) => `${w(k)}: ${(v as readonly string[]).join(', ')}`);
  return [branches, departments, ...limits].join(' · ');
}

/** Flagged rows first, then by name — control by exception (P-03). */
export function ordered(rows: readonly AccessRowView[]): readonly AccessRowView[] {
  return [...rows].sort((a, b) => (b.flags.length > 0 ? 1 : 0) - (a.flags.length > 0 ? 1 : 0) || (a.userId < b.userId ? -1 : 1));
}

export interface AccessReviewSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(onlyFlagged: boolean): Promise<Outcome<AccessReviewRead>>;
  matrixCsv(): Promise<Outcome<{ readonly filename: string; readonly csv: string }>>;
}

export function createAccessReviewSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch }): AccessReviewSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('identity.access.review') };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const get = async <T>(path: string): Promise<Outcome<T, never>> => {
    try {
      const res = await http(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { const e = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: e.code ?? String(res.status), whatHappened: e.whatHappened ?? `status ${res.status}` }; }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  };
  const gate = (): Outcome<never> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : undefined);
  return {
    may,
    read: async (onlyFlagged) => gate() ?? get(`/v1/identity/access-review${onlyFlagged ? '?flagged=true' : ''}`),
    matrixCsv: async () => gate() ?? get('/v1/identity/permission-matrix?format=csv'),
  };
}
