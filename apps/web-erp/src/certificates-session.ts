// The Staff certificates page (OB-522 · OB-502 · M25-FR-03). A tested, DOM-free session over head office's EXISTING certificate
// register routes (services/finance/src/cert-store.ts), which until now no screen reached:
//   • READ the store's people (`GET /v1/hr/workforce/roster`) and the certificates on file (`GET /v1/hr/workforce/certifications`),
//     and say for each person whether food-handling work (production, bakery, counter food) may be recorded in their name
//     today — with the SAME rule head office and the store computer use (packages/workforce/src/food-handling.ts);
//   • RECORD a certificate: the person, the kind from a SHORT PICK-LIST (food handling; FoSTaC, which counts as the same —
//     OB-522), the issue date and the last valid date. Ticking "I have seen it" verifies it in the signed-in person's own name;
//   • VERIFY a certificate somebody recorded without verifying: a person who saw it re-records it in their own name. Head
//     office's engine needs the verifier to be the signed-in person and NOT the certificate's holder (nobody verifies their
//     own — `self_verification`); only a verified certificate is cover;
//   • RENEW: record the new certificate (a new record); the old one stays on file (append-only, hard rule #2).
// Head office re-checks every permission; `may` only shapes what is offered. Dates are the shop's own (never UTC).

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { CERTIFICATE_KINDS, certificateKindKey, foodHandlingVerdict, isFoodHandlingKind } from '../../../packages/workforce/src/food-handling';
import type { Certification, Employee } from '../../../packages/workforce/src/workforce';

export type Lang = 'en' | 'ta';
export { CERTIFICATE_KINDS };

export const CERTIFICATES_COPY = {
  en: {
    title: 'Staff certificates', lead: 'Record, verify and renew each person\'s certificates. When a person\'s food-handling certificate (or FoSTaC, which counts as the same) has expired, production, bakery or counter-food work cannot be recorded in their name until a renewed one is recorded. A person with no certificate on file is not blocked. Only a certificate someone has seen counts, and nobody verifies their own.',
    recordH: 'Record a certificate', person: 'Person', kind: 'Certificate', issuedOn: 'Issued on', validUntil: 'Valid until (last day)',
    seen: 'I have seen the original certificate — verify it in my name', record: 'Record the certificate', renewing: 'Renewing — the old certificate stays on file.',
    listH: 'People and their certificates', reload: 'Read again from head office', none: 'No certificate on file.', nobodyOnRoster: 'Head office has nobody on the roster for you to see.',
    foodOk: 'Food-handling work: allowed until', foodNo: 'Food-handling work: BLOCKED —',
    stValid: 'Verified · in date', stExpired: 'Expired on', stUnverified: 'Not verified — does not count until someone who saw it verifies it', stFuture: 'Not yet in force — from',
    verifiedBy: 'verified by', from: 'from', to: 'to', verify: 'Verify — I have seen it', renew: 'Renew', notThisList: 'Recorded as',
    recorded: 'Recorded at head office.', recordedVerified: 'Recorded and verified at head office in your name.', verified: 'Verified at head office in your name.',
    needRecord: 'Choose the person and the certificate, and write both dates (the last valid day on or after the issue day).',
    selfVerify: 'You cannot verify your own certificate. Ask a different manager who has seen it.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see staff certificates.', cannotManage: 'You can see the certificates; recording or verifying one needs manager permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'பணியாளர் சான்றிதழ்கள்', lead: 'ஒவ்வொருவரின் சான்றிதழ்களைப் பதிவு செய்யவும், சரிபார்க்கவும், புதுப்பிக்கவும். ஒருவரின் உணவு கையாளும் சான்றிதழ் (அல்லது அதற்குச் சமமான FoSTaC) காலாவதியானால், புதுப்பித்த சான்றிதழ் பதியும் வரை அவர் பெயரில் உற்பத்தி, பேக்கரி அல்லது கவுண்டர் உணவு வேலை பதிய முடியாது. பதிவில் சான்றிதழ் இல்லாதவருக்குத் தடை இல்லை. யாராவது பார்த்துச் சரிபார்த்த சான்றிதழ் மட்டுமே கணக்கில்; தன் சான்றிதழை யாரும் தானே சரிபார்க்க முடியாது.',
    recordH: 'சான்றிதழைப் பதிவு செய்', person: 'நபர்', kind: 'சான்றிதழ்', issuedOn: 'வழங்கிய தேதி', validUntil: 'செல்லுபடி கடைசி நாள்',
    seen: 'அசல் சான்றிதழை நான் பார்த்தேன் — என் பெயரில் சரிபார்', record: 'சான்றிதழைப் பதிவு செய்', renewing: 'புதுப்பித்தல் — பழைய சான்றிதழ் பதிவில் இருக்கும்.',
    listH: 'நபர்களும் அவர்களின் சான்றிதழ்களும்', reload: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', none: 'பதிவில் சான்றிதழ் இல்லை.', nobodyOnRoster: 'நீங்கள் பார்க்க வேண்டிய யாரும் தலைமை அலுவலகப் பணிப்பட்டியலில் இல்லை.',
    foodOk: 'உணவு கையாளும் வேலை: அனுமதி, கடைசி நாள்', foodNo: 'உணவு கையாளும் வேலை: தடை —',
    stValid: 'சரிபார்க்கப்பட்டது · செல்லுபடி', stExpired: 'காலாவதியான நாள்', stUnverified: 'சரிபார்க்கப்படவில்லை — பார்த்தவர் சரிபார்க்கும் வரை கணக்கில் இல்லை', stFuture: 'இன்னும் நடைமுறைக்கு வரவில்லை — தொடக்கம்',
    verifiedBy: 'சரிபார்த்தவர்', from: 'முதல்', to: 'வரை', verify: 'சரிபார் — நான் பார்த்தேன்', renew: 'புதுப்பி', notThisList: 'பதிவான வகை',
    recorded: 'தலைமை அலுவலகத்தில் பதிவானது.', recordedVerified: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் பதிவாகிச் சரிபார்க்கப்பட்டது.', verified: 'உங்கள் பெயரில் தலைமை அலுவலகத்தில் சரிபார்க்கப்பட்டது.',
    needRecord: 'நபரையும் சான்றிதழையும் தேர்ந்தெடுத்து, இரண்டு தேதிகளையும் எழுதுங்கள் (கடைசி நாள் வழங்கிய நாளுக்குச் சமம் அல்லது பிந்தையது).',
    selfVerify: 'உங்கள் சொந்தச் சான்றிதழை நீங்களே சரிபார்க்க முடியாது. அதைப் பார்த்த வேறு மேலாளரிடம் கேளுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி பணியாளர் சான்றிதழ்களைப் பார்க்க முடியாது.', cannotManage: 'சான்றிதழ்களைப் பார்க்கலாம்; பதிவு அல்லது சரிபார்க்க மேலாளர் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const certificatesWords = (lang: Lang, key: string): string =>
  (CERTIFICATES_COPY[lang] as Record<string, string>)[key] ?? (CERTIFICATES_COPY.en as Record<string, string>)[key] ?? key;

/** The words for a certificate kind: the pick-list's own words, or (a kind recorded before the list) the kind as recorded. */
export function kindWords(lang: Lang, kind: string): string {
  const known = CERTIFICATE_KINDS.find((k) => k.kind === certificateKindKey(kind));
  return known === undefined ? `${certificatesWords(lang, 'notThisList')} "${kind}"` : known[lang];
}

export type Standing = 'valid' | 'expired' | 'unverified' | 'not_yet';
/** One certificate on file, judged on the shop's `today`. */
export function standingOf(c: Certification, today: string): Standing {
  if (c.verifiedBy === undefined) return 'unverified';
  if (c.validUntil < today) return 'expired';
  if (c.issuedOn > today) return 'not_yet';
  return 'valid';
}

export interface CertificateRow extends Certification { readonly standing: Standing; readonly foodHandling: boolean }
export interface PersonRow {
  readonly employeeId: string; readonly name: string; readonly active: boolean;
  /** May food-handling work be recorded in this person's name today (OB-502), with the reason in both languages if not. */
  readonly food: { readonly allowed: true; readonly validUntil: string }
    /** No verified certificate on file: allowed (only an expired one blocks); `validUntil` is a dash, the words say why. */
    | { readonly allowed: true; readonly validUntil: '—'; readonly noCertificateOnFile: true; readonly words: { readonly en: string; readonly ta: string } }
    | { readonly allowed: false; readonly words: { readonly en: string; readonly ta: string } };
  readonly certificates: readonly CertificateRow[];
}
export interface RecordForm { readonly employeeId: string; readonly kind: string; readonly issuedOn: string; readonly validUntil: string; readonly seen: boolean }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needRecord' | 'selfVerify';
type Done<T> = Promise<Outcome<T, Why>>;

export interface CertificatesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean; readonly me: string | undefined };
  /** The people and their certificates, judged on the shop's today. */
  load(): Done<{ readonly today: string; readonly people: readonly PersonRow[] }>;
  /** Record a certificate (a new record — a renewal never overwrites the old one); `seen` verifies it in my name. */
  record(form: RecordForm): Done<{ readonly certification: Certification }>;
  /** Verify a certificate somebody recorded without verifying — in my name; never my own. */
  verify(cert: Certification): Done<{ readonly certification: Certification }>;
}

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

export const certificatesOutcomeWords = (lang: Lang, out: Outcome<unknown>, act?: 'record' | 'verify'): string => {
  if (out.result !== 'ok') return outcomeIn((k) => certificatesWords(lang, k), out);
  if (act === 'verify') return certificatesWords(lang, 'verified');
  const c = ((out.value ?? {}) as { certification?: Certification }).certification;
  return certificatesWords(lang, c?.verifiedBy !== undefined ? 'recordedVerified' : 'recorded');
};

export function createCertificatesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newCertificateId?: () => string; readonly now?: () => string;
}): CertificatesSession {
  const me = input.viewer?.userId;
  const named = me !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('workforce.roster.read'), manage: named && held.has('workforce.roster.manage'), me };
  const call = makeCaller({ keyPrefix: 'certificate', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const newCertificateId = input.newCertificateId ?? (() => newId('CERT'));
  const now = input.now ?? (() => new Date().toISOString());
  const gate = (need: 'read' | 'manage'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotManage' } : undefined;
  const post = (c: Certification): Done<{ readonly certification: Certification }> => call('POST', `/v1/hr/workforce/certifications/${encodeURIComponent(c.certificationId)}`, {
    employeeId: c.employeeId, kind: c.kind, issuedOn: c.issuedOn, validUntil: c.validUntil, ...(c.verifiedBy === undefined ? {} : { verifiedBy: c.verifiedBy }),
  });
  return {
    may,
    load: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      const [roster, certs] = await Promise.all([
        call<{ employees?: Employee[] }>('GET', '/v1/hr/workforce/roster'),
        call<{ certifications?: Certification[] }>('GET', '/v1/hr/workforce/certifications'),
      ]);
      if (roster.result !== 'ok') return roster;
      if (certs.result !== 'ok') return certs;
      const today = shopDateIn(now());
      const employees = Array.isArray(roster.value.employees) ? roster.value.employees : [];
      const all = Array.isArray(certs.value.certifications) ? certs.value.certifications : [];
      const people: PersonRow[] = employees
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId))
        .map((e) => {
          const mine = all.filter((c) => c.employeeId === e.employeeId);
          const v = foodHandlingVerdict({ personId: e.employeeId, employee: e, certifications: mine, today, task: 'production_run' });
          return {
            employeeId: e.employeeId, name: e.name, active: e.active,
            // OB-502 (owner, 28 Oct 2026): only an EXPIRED certificate blocks; none on file is allowed and said so.
            food: !v.allowed ? { allowed: false as const, words: v.words }
              : 'validUntil' in v ? { allowed: true as const, validUntil: v.validUntil }
                : { allowed: true as const, validUntil: '—', noCertificateOnFile: true as const, words: v.words },
            certificates: mine
              .map((c) => ({ ...c, standing: standingOf(c, today), foodHandling: isFoodHandlingKind(c.kind) }))
              .sort((a, b) => b.validUntil.localeCompare(a.validUntil) || a.certificationId.localeCompare(b.certificationId)),
          };
        });
      return { result: 'ok', value: { today, people } };
    },
    record: async (f) => {
      const no = gate('manage'); if (no !== undefined) return no;
      const kind = CERTIFICATE_KINDS.find((k) => k.kind === f.kind)?.kind;
      if (f.employeeId.trim() === '' || kind === undefined || !isDay(f.issuedOn) || !isDay(f.validUntil) || f.validUntil < f.issuedOn) return { result: 'invalid', why: 'needRecord' };
      if (f.seen && f.employeeId.trim() === me) return { result: 'invalid', why: 'selfVerify' };
      return post({ certificationId: newCertificateId(), employeeId: f.employeeId.trim(), kind, issuedOn: f.issuedOn, validUntil: f.validUntil, ...(f.seen ? { verifiedBy: me } : {}) });
    },
    verify: async (c) => {
      const no = gate('manage'); if (no !== undefined) return no;
      if (c.employeeId === me) return { result: 'invalid', why: 'selfVerify' };
      // The same certificate, re-recorded in my name as the verifier (the register keeps every version — append-only).
      return post({ certificationId: c.certificationId, employeeId: c.employeeId, kind: c.kind, issuedOn: c.issuedOn, validUntil: c.validUntil, verifiedBy: me });
    },
  };
}
