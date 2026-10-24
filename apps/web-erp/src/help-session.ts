// The Help page — the role-aware SOP / help centre (M25-FR-04: "a cashier sees cashier SOPs; acknowledgement is recorded;
// help works offline") with the emergency procedures and contacts (D11-FR-06). A tested, DOM-free session.
//
// Two ways it is served, one page:
//   • by the STORE COMPUTER (with the line down too): the library is head office's last word as the box holds it (every SOP
//     with its English and Tamil words, the store's people and their roles, their acknowledgements, the emergency
//     contacts), with how old it is; the person signed in at the office screens sees the SOPs for THEIR roles; an
//     acknowledgement is saved on this device and carried by the box to head office (the person re-checked there).
//   • by HEAD OFFICE: the same page reads `GET /v1/hr/workforce/help` live and acknowledges directly. A manager also
//     publishes the shop's own SOP sheets, writes a procedure (English and Tamil both), records an emergency drill; the
//     owner sets the emergency contacts ("not set" until he does).
// A person acknowledges for themselves only, the version they read. Nobody acknowledges for anybody (P-05).

import { makeCaller, newId, type Outcome } from './r4-insight-call';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { createBoxQueue, STATE_KEYS, type BoxQueue } from './lpw-box-queue';

export type Lang = 'en' | 'ta';

export const HELP_COPY = {
  en: {
    title: 'Help and procedures', lead: 'The procedures for your role, in English and Tamil. Read one, then press "I have read this" — that is your acknowledgement.',
    forYou: 'Your procedures', emergency: 'Emergency', procedure: 'Procedure', version: 'version', read: 'I have read this', upToDate: 'You have read this version', outstanding: 'to read',
    contactsH: 'Emergency contacts', contactsNotSet: 'The owner has not entered the emergency contacts yet (not set).', asOf: 'As the store computer last heard it, at', noLibrary: 'The store computer has not been told the help library yet.',
    noneForYou: 'There is no procedure for your role yet.', nobody: 'Nobody is signed in on this screen — sign in to see your procedures and acknowledge them.',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Booked at head office', stRefused: 'Refused — a person must look',
    manageH: 'For managers', sheetsH: 'The shop\'s own sheets', publish: 'Publish', published: 'Published', behind: 'The sheet has changed — publish the new version', notPublished: 'Not published',
    writeH: 'Write a procedure (English and Tamil)', sopId: 'Procedure id', titleEn: 'Title (English)', titleTa: 'Title (Tamil)', roles: 'For roles (comma between)', category: 'Kind', bodyEn: 'Words (English)', bodyTa: 'Words (Tamil)', versionL: 'Version', save: 'Publish the procedure',
    contactsSet: 'Set the emergency contacts', contactLine: 'One per line: label, phone (e.g. Fire service, 101)',
    drillH: 'Emergency drills', drillSop: 'Procedure practised', branch: 'Store', heldOn: 'Held on', participants: 'Who took part (comma between)', findings: 'What was found', record: 'Record the drill', lastHeld: 'Last practised', never: 'never',
    saved: 'Saved.', needFields: 'Fill in every field first — English and Tamil both.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'உதவி மற்றும் நடைமுறைகள்', lead: 'உங்கள் பணிக்கான நடைமுறைகள், ஆங்கிலத்திலும் தமிழிலும். ஒன்றைப் படித்து, "இதைப் படித்தேன்" அழுத்தவும் — அதுவே உங்கள் ஏற்பு.',
    forYou: 'உங்கள் நடைமுறைகள்', emergency: 'அவசரம்', procedure: 'நடைமுறை', version: 'பதிப்பு', read: 'இதைப் படித்தேன்', upToDate: 'இந்தப் பதிப்பைப் படித்துவிட்டீர்கள்', outstanding: 'படிக்க வேண்டியவை',
    contactsH: 'அவசரத் தொடர்புகள்', contactsNotSet: 'அவசரத் தொடர்புகளை உரிமையாளர் இன்னும் பதியவில்லை (அமைக்கப்படவில்லை).', asOf: 'கடைக் கணினி கடைசியாகக் கேட்டது, நேரம்', noLibrary: 'உதவி நூலகம் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.',
    noneForYou: 'உங்கள் பணிக்கு இன்னும் நடைமுறை இல்லை.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — உங்கள் நடைமுறைகளைப் பார்க்க உள்நுழையவும்.',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் பதிவானது', stRefused: 'மறுக்கப்பட்டது — ஒருவர் பார்க்க வேண்டும்',
    manageH: 'மேலாளர்களுக்கு', sheetsH: 'கடையின் சொந்தத் தாள்கள்', publish: 'வெளியிடு', published: 'வெளியிடப்பட்டது', behind: 'தாள் மாறியுள்ளது — புதிய பதிப்பை வெளியிடவும்', notPublished: 'வெளியிடப்படவில்லை',
    writeH: 'ஒரு நடைமுறையை எழுதுங்கள் (ஆங்கிலம் மற்றும் தமிழ்)', sopId: 'நடைமுறை எண்', titleEn: 'தலைப்பு (ஆங்கிலம்)', titleTa: 'தலைப்பு (தமிழ்)', roles: 'பணிகளுக்கு (இடையே கமா)', category: 'வகை', bodyEn: 'சொற்கள் (ஆங்கிலம்)', bodyTa: 'சொற்கள் (தமிழ்)', versionL: 'பதிப்பு', save: 'நடைமுறையை வெளியிடு',
    contactsSet: 'அவசரத் தொடர்புகளை அமை', contactLine: 'ஒரு வரிக்கு ஒன்று: பெயர், தொலைபேசி (எ.கா. தீயணைப்பு, 101)',
    drillH: 'அவசரப் பயிற்சிகள்', drillSop: 'பயிற்சி செய்த நடைமுறை', branch: 'கடை', heldOn: 'நடந்த நாள்', participants: 'பங்கேற்றவர்கள் (இடையே கமா)', findings: 'கண்டறிந்தவை', record: 'பயிற்சியைப் பதிவு செய்', lastHeld: 'கடைசியாகப் பயிற்சி', never: 'இல்லை',
    saved: 'சேமிக்கப்பட்டது.', needFields: 'முதலில் எல்லா இடங்களையும் நிரப்பவும் — ஆங்கிலம் மற்றும் தமிழ் இரண்டும்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const helpWords = (lang: Lang, key: string): string =>
  (HELP_COPY[lang] as Record<string, string>)[key] ?? (HELP_COPY.en as Record<string, string>)[key] ?? key;

export function helpOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => helpWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

export interface HelpSop { readonly sopId: string; readonly title: string; readonly titleTa: string; readonly version: number; readonly forRoles: readonly string[]; readonly category: 'procedure' | 'emergency'; readonly bodyEn: string | null; readonly bodyTa: string | null }
export interface HeldLibrary {
  readonly asAt: string; readonly ageMinutes: number; readonly sops: readonly HelpSop[]; readonly people: readonly { readonly employeeId: string; readonly roles: readonly string[] }[];
  readonly acknowledgements: readonly { readonly employeeId: string; readonly sopId: string; readonly version: number }[];
  readonly emergencyContacts: readonly { readonly label: string; readonly labelTa?: string; readonly phone: string }[]; readonly contactsSet: boolean;
}
export interface HelpData { readonly userId?: string; readonly permissions?: readonly string[]; readonly storeId?: string; readonly library?: HeldLibrary | null }

/** One SOP as the page shows it to this person. */
export interface HelpRow extends HelpSop { readonly upToDate: boolean; readonly acknowledgedVersion: number | null; readonly saved?: { readonly stateWord: string; readonly state: string; readonly reason?: string } }
export interface HelpView {
  readonly source: 'store_computer' | 'head_office';
  readonly known: boolean;
  readonly asAtWords: string;
  readonly rows: readonly HelpRow[];
  readonly outstanding: number;
  readonly contacts: { readonly set: boolean; readonly list: readonly { readonly label: string; readonly phone: string }[] };
}

export const SOP_ACKNOWLEDGED = 'SopAcknowledged';
export const ackKeyFor = (userId: string, sopId: string, version: number): string => `sop-ack:${userId}:${sopId}:v${version}`;

export interface HelpSession {
  readonly may: { readonly named: boolean; readonly manage: boolean; readonly contacts: boolean; readonly drills: boolean; readonly onBox: boolean };
  view(lang: Lang): Promise<Outcome<HelpView>>;
  acknowledge(sopId: string, version: number): Promise<Outcome<unknown, 'needFields'>>;
  builtIn(): Promise<Outcome<{ readonly sheets: readonly { readonly sopId: string; readonly title: string; readonly titleTa: string; readonly version: number; readonly forRoles: readonly string[]; readonly state: string }[] }>>;
  publishBuiltIn(sopId: string): Promise<Outcome<unknown>>;
  write(input: { readonly sopId: string; readonly title: string; readonly titleTa: string; readonly version: string; readonly roles: string; readonly category: 'procedure' | 'emergency'; readonly bodyEn: string; readonly bodyTa: string }): Promise<Outcome<unknown, 'needFields'>>;
  setContacts(lines: string): Promise<Outcome<unknown, 'needFields'>>;
  drills(): Promise<Outcome<{ readonly procedures: readonly { readonly sopId: string; readonly title: string; readonly titleTa: string; readonly lastHeldOn: string | null }[] }>>;
  recordDrill(input: { readonly sopId: string; readonly branchId: string; readonly heldOn: string; readonly participants: string; readonly findings: string }): Promise<Outcome<unknown, 'needFields'>>;
  /** The box leg: hand what is saved here and learn where it got to (undefined off the box). */
  readonly queue?: BoxQueue<{ sopId: string; employeeId: string; version: number; acknowledgedAt: string }>;
}

const list = (raw: string): string[] => raw.split(',').map((x) => x.trim()).filter((x) => x !== '');

export function createHelpSession(input: {
  readonly data: HelpData | undefined; readonly onBox: boolean; readonly outbox?: SyncOutbox;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly now?: () => string;
}): HelpSession {
  const data = input.data;
  const userId = data?.userId;
  const named = userId !== undefined;
  const held = new Set(data?.permissions ?? []);
  const onBox = input.onBox && data?.library !== undefined;
  const now = input.now ?? (() => new Date().toISOString());
  const may = { named, manage: named && !onBox && held.has('workforce.roster.manage'), contacts: named && !onBox && held.has('workforce.emergency.manage'), drills: named && !onBox && held.has('workforce.training.manage'), onBox };
  const call = makeCaller({ keyPrefix: 'help', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const queue = onBox && input.outbox !== undefined ? createBoxQueue<{ sopId: string; employeeId: string; version: number; acknowledgedAt: string }>(SOP_ACKNOWLEDGED, 'web-erp/help', input.outbox) : undefined;

  const boxView = (lang: Lang): HelpView => {
    const w = (k: string) => helpWords(lang, k);
    const lib = data?.library ?? null;
    if (lib === null) return { source: 'store_computer', known: false, asAtWords: w('noLibrary'), rows: [], outstanding: 0, contacts: { set: false, list: [] } };
    const roles = new Set(lib.people.find((p) => p.employeeId === userId)?.roles ?? []);
    const acked = new Map<string, number>();
    for (const a of lib.acknowledgements) if (a.employeeId === userId) acked.set(a.sopId, Math.max(acked.get(a.sopId) ?? -1, a.version));
    const savedHere = new Map((queue?.items() ?? []).filter((i) => i.payload.employeeId === userId).map((i) => [`${i.payload.sopId}\u0000${i.payload.version}`, i] as const));
    const rows = lib.sops.filter((s) => s.forRoles.some((r) => roles.has(r))).map((s): HelpRow => {
      const mine = savedHere.get(`${s.sopId}\u0000${s.version}`);
      const v = acked.get(s.sopId) ?? null;
      return {
        ...s, acknowledgedVersion: v, upToDate: (v !== null && v >= s.version) || (mine !== undefined && mine.state !== 'refused'),
        ...(mine === undefined ? {} : { saved: { state: mine.state, stateWord: w(STATE_KEYS[mine.state]), ...(mine.reason === undefined ? {} : { reason: mine.reason }) } }),
      };
    });
    return {
      source: 'store_computer', known: true, asAtWords: `${w('asOf')} ${lib.asAt}`, rows, outstanding: rows.filter((r) => !r.upToDate).length,
      contacts: { set: lib.contactsSet, list: lib.emergencyContacts.map((c) => ({ label: lang === 'ta' && c.labelTa !== undefined ? c.labelTa : c.label, phone: c.phone })) },
    };
  };

  return {
    may,
    ...(queue === undefined ? {} : { queue }),
    view: async (lang) => {
      if (!named && !onBox) return { result: 'invalid', why: 'nobody' as never };
      if (onBox) return { result: 'ok', value: boxView(lang) };
      const o = await call<{ sops: (HelpSop & { upToDate: boolean; acknowledgedVersion: number | null; forMe: boolean })[]; outstanding: number; emergencyContacts: { set: boolean; contacts: { label: string; labelTa?: string; phone: string }[] } }>('GET', '/v1/hr/workforce/help');
      if (o.result !== 'ok') return o;
      return {
        result: 'ok',
        value: {
          source: 'head_office', known: true, asAtWords: '', rows: o.value.sops.filter((s) => s.forMe), outstanding: o.value.outstanding,
          contacts: { set: o.value.emergencyContacts.set, list: o.value.emergencyContacts.contacts.map((c) => ({ label: lang === 'ta' && c.labelTa !== undefined ? c.labelTa : c.label, phone: c.phone })) },
        },
      };
    },
    acknowledge: async (sopId, version) => {
      if (!named) return { result: 'invalid', why: 'needFields' };
      if (queue !== undefined) {
        queue.enqueue(ackKeyFor(userId!, sopId, version), { sopId, employeeId: userId!, version, acknowledgedAt: now() }, now());
        return { result: 'ok', value: { saved: true } };
      }
      return call('POST', `/v1/hr/workforce/sops/${encodeURIComponent(sopId)}/acknowledge`, { version });
    },
    builtIn: () => call('GET', '/v1/hr/workforce/help/built-in'),
    publishBuiltIn: (sopId) => call('POST', `/v1/hr/workforce/help/built-in/${encodeURIComponent(sopId)}/publish`, {}),
    write: async (p) => {
      const version = Number(p.version);
      if ([p.sopId, p.title, p.titleTa, p.bodyEn, p.bodyTa].some((x) => x.trim() === '') || list(p.roles).length === 0 || !Number.isInteger(version) || version < 1) return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/hr/workforce/help/sops/${encodeURIComponent(p.sopId.trim())}`, { title: p.title.trim(), titleTa: p.titleTa.trim(), version, forRoles: list(p.roles), category: p.category, bodyEn: p.bodyEn, bodyTa: p.bodyTa });
    },
    setContacts: async (lines) => {
      const contacts = lines.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => { const at = l.lastIndexOf(','); return at < 0 ? null : { label: l.slice(0, at).trim(), phone: l.slice(at + 1).trim() }; });
      if (contacts.some((c) => c === null || c.label === '' || c.phone === '')) return { result: 'invalid', why: 'needFields' };
      return call('POST', '/v1/hr/workforce/emergency-contacts', { contacts });
    },
    drills: () => call('GET', '/v1/hr/workforce/emergency-drills'),
    recordDrill: async (d) => {
      if ([d.sopId, d.branchId, d.heldOn, d.findings].some((x) => x.trim() === '') || list(d.participants).length === 0) return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/hr/workforce/emergency-drills/${newId('DR')}`, { sopId: d.sopId.trim(), branchId: d.branchId.trim(), heldOn: d.heldOn, participants: list(d.participants), findings: d.findings.trim() });
    },
  };
}
