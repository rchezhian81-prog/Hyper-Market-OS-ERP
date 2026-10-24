// The Related parties and staff buying page (M15-FR-03 · OB-301, owner, 23 Oct 2026). A tested, DOM-free session.
//
//   • RELATED PARTIES — the owner's own list of related people and firms (the GSTINs, phones and bank accounts that
//     identify them; accounts shown masked) and the suppliers that match it now, each fact named. Owner only.
//   • STAFF BUYING — the owner's two numbers: the staff discount cap and the service-desk till(s), each "not set" until he
//     enters it; the staff members' own customer accounts (a manager records them, never their own).
//   • SALARY ACCOUNTS — each staff member's salary account (owner or accountant), shown masked, so the duplicate-account
//     control compares staff with suppliers.
// Every write is a person's explicit click, in their own name; head office re-checks every act.

import { makeCaller, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const RELATED_PARTIES_COPY = {
  en: {
    title: 'Related parties and staff buying', lead: 'The owner\'s list of related people and firms, the staff-buying rules, and staff salary accounts. A supplier on the list needs the owner\'s written approval before a purchase order.',
    partiesH: 'Related parties (the owner\'s list)', partyId: 'Entry id', name: 'Name', kind: 'Person or firm', person: 'Person', firm: 'Firm', relation: 'How related', gstins: 'GSTINs (comma between)', phones: 'Phones (comma between)', accounts: 'Bank accounts (comma between)',
    saveParty: 'Save the entry', takeOff: 'Take off the list', takeOffWhy: 'Why it comes off (required)', needReason: 'Write why it comes off the list first.', listEmpty: 'Nobody is on the list yet.', matchesH: 'Suppliers matching the list now', matchesNone: 'No supplier matches the list.', inactive: 'taken off',
    on_gstin: 'GSTIN', on_phone: 'phone', on_bank_account: 'bank account',
    staffH: 'Staff buying (the owner\'s rules)', cap: 'Staff discount, at most (%)', desk: 'Service-desk till(s) (comma between)', notSet: 'not set', savePolicy: 'Save the rules', policyNow: 'In force:',
    accountsH: 'Staff members\' own customer accounts', employee: 'Staff id', customerRef: 'Their customer account (member code)', saveAccount: 'Record it', accountsNone: 'No staff account is recorded.',
    salaryH: 'Staff salary accounts', accountRef: 'Salary account', saveSalary: 'Record it', salaryNone: 'No salary account is recorded.',
    read: 'Read', saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot open this page.',
    needName: 'Write the name, how they are related, and at least one GSTIN, phone or bank account.', needPercent: 'The discount is a percentage from 0 to 100, or empty for "not set".',
    needEmployee: 'Type the staff id and their account.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'தொடர்புடையவர்கள் மற்றும் பணியாளர் வாங்கல்', lead: 'உரிமையாளரின் தொடர்புடைய நபர்கள் மற்றும் நிறுவனங்களின் பட்டியல், பணியாளர் வாங்கல் விதிகள், பணியாளர் சம்பளக் கணக்குகள். பட்டியலில் உள்ள சப்ளையருக்கு கொள்முதல் ஆணைக்கு முன் உரிமையாளரின் எழுத்துப்பூர்வ ஒப்புதல் வேண்டும்.',
    partiesH: 'தொடர்புடையவர்கள் (உரிமையாளரின் பட்டியல்)', partyId: 'பதிவு எண்', name: 'பெயர்', kind: 'நபர் அல்லது நிறுவனம்', person: 'நபர்', firm: 'நிறுவனம்', relation: 'எப்படித் தொடர்பு', gstins: 'GSTIN-கள் (இடையே கமா)', phones: 'தொலைபேசிகள் (இடையே கமா)', accounts: 'வங்கிக் கணக்குகள் (இடையே கமா)',
    saveParty: 'பதிவைச் சேமி', takeOff: 'பட்டியலிலிருந்து நீக்கு', takeOffWhy: 'ஏன் நீக்கப்படுகிறது (தேவை)', needReason: 'முதலில் பட்டியலிலிருந்து ஏன் நீக்கப்படுகிறது என்று எழுதவும்.', listEmpty: 'பட்டியலில் இன்னும் யாரும் இல்லை.', matchesH: 'இப்போது பட்டியலுடன் பொருந்தும் சப்ளையர்கள்', matchesNone: 'எந்த சப்ளையரும் பட்டியலுடன் பொருந்தவில்லை.', inactive: 'நீக்கப்பட்டது',
    on_gstin: 'GSTIN', on_phone: 'தொலைபேசி', on_bank_account: 'வங்கிக் கணக்கு',
    staffH: 'பணியாளர் வாங்கல் (உரிமையாளரின் விதிகள்)', cap: 'பணியாளர் தள்ளுபடி, அதிகபட்சம் (%)', desk: 'சேவை மேசைக் கவுண்டர்(கள்) (இடையே கமா)', notSet: 'அமைக்கப்படவில்லை', savePolicy: 'விதிகளைச் சேமி', policyNow: 'நடைமுறையில்:',
    accountsH: 'பணியாளர்களின் சொந்த வாடிக்கையாளர் கணக்குகள்', employee: 'பணியாளர் எண்', customerRef: 'அவரின் வாடிக்கையாளர் கணக்கு (உறுப்பினர் குறியீடு)', saveAccount: 'பதிவு செய்', accountsNone: 'எந்தப் பணியாளர் கணக்கும் பதிவாகவில்லை.',
    salaryH: 'பணியாளர் சம்பளக் கணக்குகள்', accountRef: 'சம்பளக் கணக்கு', saveSalary: 'பதிவு செய்', salaryNone: 'எந்தச் சம்பளக் கணக்கும் பதிவாகவில்லை.',
    read: 'படி', saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு இந்தப் பக்கத்தைத் திறக்க முடியாது.',
    needName: 'பெயர், எப்படித் தொடர்பு, குறைந்தது ஒரு GSTIN, தொலைபேசி அல்லது வங்கிக் கணக்கை எழுதவும்.', needPercent: 'தள்ளுபடி 0 முதல் 100 வரை ஒரு சதவீதம், அல்லது "அமைக்கப்படவில்லை" என்பதற்குக் காலியாக விடவும்.',
    needEmployee: 'பணியாளர் எண்ணையும் அவரின் கணக்கையும் தட்டச்சு செய்யவும்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const relatedPartiesWords = (lang: Lang, key: string): string =>
  (RELATED_PARTIES_COPY[lang] as Record<string, string>)[key] ?? (RELATED_PARTIES_COPY.en as Record<string, string>)[key] ?? key;

export function relatedPartiesOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => relatedPartiesWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

export interface PartyRow { readonly partyId: string; readonly name: string; readonly kind: 'person' | 'firm'; readonly relation: string; readonly gstins: readonly string[]; readonly phones: readonly string[]; readonly bankAccountRefs: readonly string[]; readonly active: boolean }
export interface MatchRow { readonly supplierId: string; readonly name: string | null; readonly matches: readonly { readonly partyId: string; readonly partyName: string; readonly relation: string; readonly on: string; readonly shown: string }[] }
export interface PolicyRow { readonly staffDiscountCapBps: number | null; readonly serviceDeskLaneIds: readonly string[] | null; readonly notSet: readonly string[] }

/** "a, b , c" → ['a','b','c']. */
export const listOf = (raw: string): string[] => raw.split(',').map((x) => x.trim()).filter((x) => x !== '');
/** "10" / "12.5" → basis points; '' → null ("not set"); anything else → undefined (not readable). */
export function bpsOfPercent(raw: string): number | null | undefined {
  const v = raw.trim();
  if (v === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return undefined;
  const bps = Math.round(Number(v) * 100);
  return bps <= 10_000 ? bps : undefined;
}

export interface RelatedPartiesSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly parties: boolean; readonly policy: boolean; readonly staffAccounts: boolean; readonly salary: boolean };
  readParties(): Promise<Outcome<{ readonly parties: readonly PartyRow[]; readonly supplierMatches: readonly MatchRow[] }>>;
  saveParty(input: { readonly partyId?: string; readonly name: string; readonly kind: 'person' | 'firm'; readonly relation: string; readonly gstins: string; readonly phones: string; readonly accounts: string; readonly active?: boolean }): Promise<Outcome<unknown, 'needName'>>;
  /** Take an entry off the list: head office keeps its facts (append-only) and it stops matching. */
  takeOff(partyId: string, reason: string): Promise<Outcome<unknown, 'needReason'>>;
  readPolicy(): Promise<Outcome<PolicyRow>>;
  savePolicy(input: { readonly capPercent: string; readonly desks: string }): Promise<Outcome<unknown, 'needPercent'>>;
  readStaffAccounts(): Promise<Outcome<{ readonly accounts: readonly { readonly employeeId: string; readonly customerRef: string }[] }>>;
  saveStaffAccount(input: { readonly employeeId: string; readonly customerRef: string }): Promise<Outcome<unknown, 'needEmployee'>>;
  readSalary(): Promise<Outcome<{ readonly accounts: readonly { readonly employeeId: string; readonly account: string; readonly recordedBy: string }[] }>>;
  saveSalary(input: { readonly employeeId: string; readonly accountRef: string }): Promise<Outcome<unknown, 'needEmployee'>>;
}

export function createRelatedPartiesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RelatedPartiesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, open: named && held.has('lp.case.read'), parties: named && held.has('lp.relatedparty.manage'), policy: named && held.has('lp.staffpurchase.manage'),
    staffAccounts: named && held.has('lp.staffaccount.record'), salary: named && held.has('hr.salaryaccount.record'),
  };
  const call = makeCaller({ keyPrefix: 'related-parties', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    readParties: () => call('GET', '/v1/loss-prevention/related-parties'),
    saveParty: async (p) => {
      if (p.name.trim() === '' || p.relation.trim() === '' || listOf(p.gstins).length + listOf(p.phones).length + listOf(p.accounts).length === 0) return { result: 'invalid', why: 'needName' };
      const id = p.partyId !== undefined && p.partyId.trim() !== '' ? p.partyId.trim() : newId('RP');
      return call('POST', `/v1/loss-prevention/related-parties/${encodeURIComponent(id)}`, { name: p.name.trim(), kind: p.kind, relation: p.relation.trim(), gstins: listOf(p.gstins), phones: listOf(p.phones), bankAccountRefs: listOf(p.accounts), active: p.active !== false });
    },
    takeOff: async (partyId, reason) => {
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/loss-prevention/related-parties/${encodeURIComponent(partyId)}/take-off`, { reason: reason.trim() });
    },
    readPolicy: () => call('GET', '/v1/loss-prevention/staff-purchases/policy'),
    savePolicy: async ({ capPercent, desks }) => {
      const bps = bpsOfPercent(capPercent);
      if (bps === undefined) return { result: 'invalid', why: 'needPercent' };
      const lanes = listOf(desks);
      return call('POST', '/v1/loss-prevention/staff-purchases/policy', { staffDiscountCapBps: bps, serviceDeskLaneIds: lanes.length === 0 ? null : lanes });
    },
    readStaffAccounts: () => call('GET', '/v1/loss-prevention/staff-purchases/accounts'),
    saveStaffAccount: async ({ employeeId, customerRef }) => {
      if (employeeId.trim() === '' || customerRef.trim() === '') return { result: 'invalid', why: 'needEmployee' };
      return call('POST', `/v1/loss-prevention/staff-purchases/accounts/${encodeURIComponent(employeeId.trim())}`, { customerRef: customerRef.trim() });
    },
    readSalary: () => call('GET', '/v1/hr/workforce/salary-accounts'),
    saveSalary: async ({ employeeId, accountRef }) => {
      if (employeeId.trim() === '' || accountRef.trim() === '') return { result: 'invalid', why: 'needEmployee' };
      return call('POST', `/v1/hr/workforce/employees/${encodeURIComponent(employeeId.trim())}/salary-account`, { accountRef: accountRef.trim() });
    },
  };
}
