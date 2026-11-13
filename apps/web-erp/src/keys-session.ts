// U6 · §27 Admin/Security "keys" · M32-FR-03 (secrets in a managed vault; a credential can be rotated and revoked; access
// least-privilege and audited) · SEC-04 · hard rule 4 — the "Keys and credentials" office page's tested, DOM-free session.
//
// The UI/UX gap audit (1 Nov 2026, lane 4) found NO screen naming the shop's keys and credentials: the secret inventory sat
// as one list on Integration health, with no way to rotate or revoke, and the token revocations on Users. This page is the
// one place: which secrets exist, what each protects, who owns it, its state and when its rotation is due; head office's
// review of them; their use over the last 30 shop days and what the nightly check found; rotating one WITH an overlap and
// revoking one AT ONCE with a reason that names what will break; revoking a person's or a token's sign-in; and where the
// other credentials live (partner credentials, store computers, release signing). A secret's VALUE never passes through
// this file: only the named fields of a reference do, whatever head office ever sent along (hard rule 4).
//
// The page is a THIN CLIENT over head office's routes (services/platform/src/secrets.ts, services/identity): every rule
// is head office's; the session refuses only what it can see is incomplete before asking, and folds every answer into one
// Outcome the page shows in head office's own words. Every act is an explicit click; nothing on a timer.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SECRET_KINDS = Object.freeze(['payment_provider', 'gst_portal', 'messaging_provider', 'logistics_provider', 'tally_bridge', 'service_identity', 'device_credential', 'partner_credential', 'signing_key', 'other'] as const);
export const SECRET_STATES = Object.freeze(['active', 'rotating', 'superseded', 'revoked'] as const);
export const REVOCATION_REASONS = Object.freeze(['admin_revoked', 'security', 'credential_change', 'signed_out'] as const);

/** A secret as this page ever sees one: a reference, an owner, a policy and some dates — never a value. */
export interface SecretRow {
  readonly secretId: string; readonly kind: string; readonly vaultRef: string; readonly version: number; readonly state: string;
  readonly createdOn: string; readonly owner: string; readonly protects: string; readonly lastRotatedOn?: string; readonly revokedOn?: string;
  readonly rotateEveryDays: number; readonly environment: string;
}
const SECRET_FIELDS = ['secretId', 'kind', 'vaultRef', 'version', 'state', 'createdOn', 'owner', 'protects', 'lastRotatedOn', 'revokedOn', 'rotateEveryDays', 'environment'] as const;
/** Keep only the named fields — anything else head office ever sent along is dropped before the page sees it (hard rule 4). */
export function secretRowOf(raw: Record<string, unknown>): SecretRow {
  const out: Record<string, unknown> = {};
  for (const k of SECRET_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  return out as unknown as SecretRow;
}

export interface ReviewIssue { readonly secretId: string; readonly kind?: string; readonly owner?: string; readonly finding: string; readonly blocking: boolean; readonly detail: string; readonly daysOverdue?: number; readonly daysLeft?: number }
export interface ReviewRead { readonly issues: readonly ReviewIssue[]; readonly detail: string; readonly asAt?: string }
export interface UseRow { readonly credentialRef: string; readonly callerId: string; readonly api: string; readonly calls: number; readonly errors: number; readonly daysUsed: number }
export interface UseFinding { readonly day: string; readonly baselineDay: string; readonly identityId: string; readonly api: string; readonly signal: string }
export interface UsageRead { readonly from: string; readonly to: string; readonly uses: readonly UseRow[]; readonly lastRolledUpDay: string | null; readonly findings: readonly UseFinding[]; readonly notJudged: readonly string[] }
export interface RotationRead { readonly secretId: string; readonly rotated: boolean; readonly outcome: string; readonly detail: string; readonly next?: SecretRow; readonly graceEndsOn?: string }
export interface RevocationRead { readonly secretId: string; readonly revoked: SecretRow; readonly willBreak?: readonly { readonly adapterId: string; readonly environment: string }[]; readonly detail: string }
export interface TokenRevocationRow { readonly id: string; readonly jti?: string; readonly userId?: string; readonly issuedBefore?: number; readonly reason: string; readonly revokedBy: string; readonly revokedAt: string }

export interface KeysMay { readonly named: boolean; readonly read: boolean; readonly write: boolean; readonly revokeTokens: boolean }

export interface KeysSession {
  readonly may: KeysMay;
  /** The inventory — latest state per secret, references only. */
  inventory(): Promise<Outcome<readonly SecretRow[]>>;
  /** Head office's review on the shop's day (overdue, due soon, no owner, never rotated, revoked still referenced). It reads, it never writes. */
  review(): Promise<Outcome<ReviewRead>>;
  /** Each machine credential's use over the last 30 shop days and what the nightly check found (W6 · OB-688). */
  usage(): Promise<Outcome<UsageRead>>;
  /** Rotate WITH an overlap: the previous version stays valid for graceDays so unsynced edge devices keep working. */
  rotate(secretId: string, d: { readonly newVaultRef: string; readonly graceDays: string }): Promise<Outcome<RotationRead>>;
  /** Revoke AT ONCE (a compromise): no overlap; head office names what will break. */
  revoke(secretId: string, reason: string): Promise<Outcome<RevocationRead>>;
  /** The sign-in revocations head office holds (SEC-11). */
  tokenRevocations(): Promise<Outcome<readonly TokenRevocationRow[]>>;
  /** Revoke every sign-in of a person, or one token, with one of the named reasons. */
  revokeTokens(target: 'user' | 'token', id: string, reason: string): Promise<Outcome<{ readonly revocation: TokenRevocationRow }>>;
}

// ── words ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const KEYS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Keys and credentials',
    lead: 'Every key and credential the shop\'s system uses: what each protects, who owns it, its state and when it must be changed. A value is never shown, typed or stored here — only the reference that names it in the vault (hard rule 4). Head office checks every act against your own permission and writes it to the audit trail.',
    nobody: 'Nobody is signed in on this computer, so nothing is offered. Sign in first.',
    notAllowed: 'Your role does not include this. Nothing was changed. Ask the owner if you need it.',
    unreachable: 'Head office could not be reached. Nothing was changed. Check the connection and try again.',
    refused: 'Head office refused:',
    reading: 'Reading…', done: 'Done.',
    // the inventory
    invH: 'Secrets the shop\'s connections use', invLead: 'Which secrets exist, what each protects, who owns it, when it was made and last changed, and its rotation state. Head office\'s own sentences are in English.',
    show: 'Show', readAgain: 'Read again',
    cSecret: 'Secret', cKind: 'Kind', cProtects: 'What it protects', cOwner: 'Owner', cEnv: 'Where', cState: 'State', cVersion: 'Version', cMade: 'Made on', cRotated: 'Last changed', cEvery: 'Change every', cDue: 'Next change', cRef: 'Reference in the vault', cUse: 'Use in 30 days',
    days: 'days', noSecrets: 'Head office holds no secret reference for this shop yet. A connection that needs one is registered by the platform administrator.',
    envProduction: 'the real shop', envSandbox: 'a practice space',
    // cards
    cardActive: 'In use', cardRotating: 'Changing over', cardRevoked: 'Revoked', cardOverdue: 'Change overdue', cardDueSoon: 'Change due soon', cardBlocking: 'Blocking findings',
    // the review
    revH: 'Head office\'s check of them', revLead: 'On the shop\'s day: which secret is overdue for a change, due soon, has nobody\'s name against it, was never changed, or is revoked while a connection still points at it.',
    revClean: 'Nothing found — every secret has an owner, is in date and is not pointed at after revocation.', cFinding: 'Finding', cBlocking: 'Holds the release?', yes: 'yes', no: 'no',
    f_overdue_rotation: 'overdue for a change', f_rotation_due_soon: 'change due soon', f_no_owner: 'nobody owns it', f_never_rotated: 'never changed', f_revoked_still_referenced: 'revoked but still pointed at',
    // use
    useH: 'Use over the last 30 shop days', useLead: 'Each machine credential, who called with it, which part of head office, how many calls, how many were refused and on how many days. Unusual use is what the nightly check found; nothing here ever blocks a credential on its own (hard rule 5).',
    cCaller: 'Called by', cApi: 'Part of head office', cCalls: 'Calls', cRefusedCalls: 'Refused', cDays: 'Days used',
    useNone: 'No machine credential was used in the last 30 shop days.', notChecked: 'The nightly check has not run yet.', checkedOn: 'Checked up to', notJudged: 'not judged',
    unusualH: 'Unusual use', unusualNone: 'Nothing unusual was found.', cDay: 'Day', cWho: 'Who', cSignal: 'What was seen', cBaseline: 'Compared with',
    sig_spike: 'far more calls than usual', sig_silent: 'went quiet', sig_errors: 'a surge of refused calls', sig_new_caller: 'a caller never seen before',
    // rotate
    rotH: 'Change a secret with an overlap', rotLead: 'The new version is named by its reference in the vault; the old one stays valid for the grace days so a store computer that has not synced keeps working. A change with no overlap is a revocation.',
    rotWhich: 'Which secret', rotRef: 'The new reference in the vault (vault://…, never the key itself)', rotGrace: 'Grace (days the old version stays valid)', rotBtn: 'Change it over',
    rotConfirmTitle: 'Change this secret over?', rotConfirmDetail: 'Head office records a new version of {secret} in your name. The old version stays valid for {grace} days, then stops. Every connection that uses it must be given the new reference before then.',
    rotDone: 'Changed over. The old version stays valid until the grace ends.',
    noVaultRef: 'Type the new reference in the vault first. Nothing was sent.', notAReference: 'That looks like a key itself, not a reference. Only a reference (vault://…) is ever typed here. Nothing was sent.', noGrace: 'The grace must be a whole number of days above zero. Nothing was sent.', noSecret: 'Choose the secret first. Nothing was sent.',
    // revoke
    rvkH: 'Revoke a secret at once', rvkLead: 'For a compromise: no overlap — every connection using it stops the moment head office records it. Head office names what will break before it happens. Say why; the reason goes to the audit trail.',
    rvkReason: 'Why (goes to the audit trail)', rvkBtn: 'Revoke it now',
    rvkConfirmTitle: 'Revoke this secret now?', rvkConfirmDetail: '{secret} stops working the moment head office records this, with no overlap. Anything that uses it breaks until it is given a new secret. This cannot be undone.',
    rvkDone: 'Revoked. What breaks is listed below.', willBreak: 'Will stop working', nothingBreaks: 'No live connection pointed at it.',
    noReason: 'Say why first — the reason goes to the audit trail. Nothing was sent.',
    // token revocations
    tokH: 'Sign-ins cut short', tokLead: 'When a phone is lost or a person leaves, their sign-ins are cut here; every sign-in issued before this moment stops working everywhere. The list is what head office holds.',
    tokWho: 'A person (their user id) or one token', tokTarget: 'Cut', tokUser: 'every sign-in of a person', tokOne: 'one token', tokReason: 'Why', tokBtn: 'Cut the sign-ins',
    tokConfirmTitle: 'Cut these sign-ins?', tokConfirmDetail: 'Every sign-in of {who} issued before now stops working on every device at once. They sign in again with their own password.',
    tokDone: 'Cut. The revocation is recorded.', tokNone: 'No sign-in has been cut yet.',
    cWhen: 'When', cTarget: 'What was cut', cReason: 'Why', cBy: 'By', tokAllOf: 'every sign-in of', tokOneToken: 'token', tokUpTo: 'issued up to',
    rr_admin_revoked: 'cut by an administrator', rr_security: 'a security concern', rr_credential_change: 'the credential changed', rr_signed_out: 'signed out everywhere',
    noWho: 'Name the person or the token first. Nothing was sent.', noRevocationReason: 'Choose one of the named reasons. Nothing was sent.',
    // where the others live
    whereH: 'Where the other credentials live', whereLead: 'Each kind of credential has its own page; this one keeps the inventory and the changes.',
    wPartners: 'Partner credentials', wPartnersNote: 'what each partner may reach and do; its token is issued out of band', wBoxes: 'Store computers', wBoxesNote: 'each store computer\'s own sealed credential and fingerprints', wGates: 'Release signing', wGatesNote: 'every release is signed in the pipeline; the quality gates read the signature', wUsers: 'Users and roles', wUsersNote: 'who can sign in and with which role',
    // states and kinds
    st_active: 'in use', st_rotating: 'changing over', st_superseded: 'replaced', st_revoked: 'revoked',
    k_payment_provider: 'payment provider', k_gst_portal: 'GST portal', k_messaging_provider: 'messaging provider', k_logistics_provider: 'logistics provider', k_tally_bridge: 'Tally bridge', k_service_identity: 'service identity', k_device_credential: 'device credential', k_partner_credential: 'partner credential', k_signing_key: 'signing key', k_other: 'other',
    dueIn: 'due in', dueOverdue: 'overdue by', wasDue: 'was due', revokedOn: 'revoked on', notKnownDate: 'not known — no date on record',
    headOfficeEnglish: 'Head office\'s own sentences are in English.',
  },
  ta: {
    lang: 'English', title: 'சாவிகளும் சான்றுகளும்',
    lead: 'கடையின் அமைப்பு பயன்படுத்தும் ஒவ்வொரு சாவியும் சான்றும்: அது எதைக் காக்கிறது, யார் பொறுப்பு, அதன் நிலை, எப்போது மாற்ற வேண்டும். ஒரு மதிப்பு இங்கே காட்டப்படுவதோ, தட்டச்சு செய்யப்படுவதோ, சேமிக்கப்படுவதோ இல்லை — பெட்டகத்தில் அதைப் பெயரிடும் குறிப்பு மட்டுமே (கடும் விதி 4). ஒவ்வொரு செயலையும் தலைமை அலுவலகம் உங்கள் சொந்த அனுமதியோடு சரிபார்த்து தணிக்கைப் பதிவில் எழுதும்.',
    nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதுவும் வழங்கப்படவில்லை. முதலில் உள்நுழையவும்.',
    notAllowed: 'உங்கள் பங்கில் இது இல்லை. எதுவும் மாற்றப்படவில்லை. தேவைப்பட்டால் உரிமையாளரைக் கேளுங்கள்.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயலவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:',
    reading: 'படிக்கிறது…', done: 'முடிந்தது.',
    invH: 'கடையின் இணைப்புகள் பயன்படுத்தும் ரகசியங்கள்', invLead: 'எந்த ரகசியங்கள் உள்ளன, ஒவ்வொன்றும் எதைக் காக்கிறது, யார் பொறுப்பு, எப்போது உருவாக்கப்பட்டது, கடைசியாக எப்போது மாற்றப்பட்டது, மாற்ற வேண்டிய நிலை. தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.',
    show: 'காட்டு', readAgain: 'மீண்டும் படி',
    cSecret: 'ரகசியம்', cKind: 'வகை', cProtects: 'எதைக் காக்கிறது', cOwner: 'பொறுப்பு', cEnv: 'எங்கே', cState: 'நிலை', cVersion: 'பதிப்பு', cMade: 'உருவாக்கியது', cRotated: 'கடைசி மாற்றம்', cEvery: 'மாற்றும் இடைவெளி', cDue: 'அடுத்த மாற்றம்', cRef: 'பெட்டகக் குறிப்பு', cUse: '30 நாள் பயன்பாடு',
    days: 'நாட்கள்', noSecrets: 'இந்தக் கடைக்கு தலைமை அலுவலகத்தில் இன்னும் ரகசியக் குறிப்பு எதுவும் இல்லை. தேவைப்படும் இணைப்பை தளநிர்வாகி பதிவு செய்வார்.',
    envProduction: 'உண்மைக் கடை', envSandbox: 'பயிற்சி இடம்',
    cardActive: 'பயன்பாட்டில்', cardRotating: 'மாறிக்கொண்டிருக்கிறது', cardRevoked: 'ரத்து', cardOverdue: 'மாற்றம் தாமதம்', cardDueSoon: 'மாற்றம் விரைவில்', cardBlocking: 'தடுக்கும் கண்டறிதல்கள்',
    revH: 'தலைமை அலுவலகத்தின் சோதனை', revLead: 'கடையின் நாளில்: எந்த ரகசியம் மாற்றத் தாமதம், விரைவில் மாற்ற வேண்டியது, யாரும் பொறுப்பில்லாதது, ஒருபோதும் மாற்றப்படாதது, அல்லது ரத்தான பின்னும் ஒரு இணைப்பு அதைச் சுட்டுகிறது.',
    revClean: 'எதுவும் கிடைக்கவில்லை — ஒவ்வொரு ரகசியத்துக்கும் பொறுப்பாளர் உண்டு, காலத்தில் உள்ளது, ரத்துக்குப் பின் சுட்டப்படவில்லை.', cFinding: 'கண்டறிதல்', cBlocking: 'வெளியீட்டைத் தடுக்குமா?', yes: 'ஆம்', no: 'இல்லை',
    f_overdue_rotation: 'மாற்றம் தாமதம்', f_rotation_due_soon: 'மாற்றம் விரைவில்', f_no_owner: 'யாரும் பொறுப்பில்லை', f_never_rotated: 'ஒருபோதும் மாற்றப்படவில்லை', f_revoked_still_referenced: 'ரத்தானது, ஆனால் இன்னும் சுட்டப்படுகிறது',
    useH: 'கடந்த 30 கடை நாட்களின் பயன்பாடு', useLead: 'ஒவ்வொரு இயந்திரச் சான்றும், யார் அதைக் கொண்டு அழைத்தார், தலைமை அலுவலகத்தின் எந்தப் பகுதி, எத்தனை அழைப்புகள், எத்தனை மறுக்கப்பட்டன, எத்தனை நாட்கள். வழக்கத்திற்கு மாறான பயன்பாடு இரவுச் சோதனை கண்டது; இங்கே எதுவும் தானாக ஒரு சான்றைத் தடுக்காது (கடும் விதி 5).',
    cCaller: 'அழைத்தவர்', cApi: 'தலைமை அலுவலகப் பகுதி', cCalls: 'அழைப்புகள்', cRefusedCalls: 'மறுக்கப்பட்டவை', cDays: 'பயன்படுத்திய நாட்கள்',
    useNone: 'கடந்த 30 கடை நாட்களில் எந்த இயந்திரச் சான்றும் பயன்படுத்தப்படவில்லை.', notChecked: 'இரவுச் சோதனை இன்னும் ஓடவில்லை.', checkedOn: 'சோதித்தது வரை', notJudged: 'தீர்ப்பளிக்கப்படவில்லை',
    unusualH: 'வழக்கத்திற்கு மாறான பயன்பாடு', unusualNone: 'வழக்கத்திற்கு மாறானது எதுவும் இல்லை.', cDay: 'நாள்', cWho: 'யார்', cSignal: 'என்ன காணப்பட்டது', cBaseline: 'ஒப்பிட்டது',
    sig_spike: 'வழக்கத்தை விட மிக அதிக அழைப்புகள்', sig_silent: 'அமைதியானது', sig_errors: 'மறுக்கப்பட்ட அழைப்புகள் அதிகரிப்பு', sig_new_caller: 'முன்பு பார்த்திராத அழைப்பாளர்',
    rotH: 'ஒரு ரகசியத்தை மேலடுப்போடு மாற்று', rotLead: 'புதிய பதிப்பு பெட்டகக் குறிப்பால் பெயரிடப்படுகிறது; ஒத்திசையாத கடைக் கணினி தொடர்ந்து இயங்க பழையது கருணை நாட்கள் வரை செல்லுபடியாகும். மேலடுப்பு இல்லாத மாற்றம் ரத்தாகும்.',
    rotWhich: 'எந்த ரகசியம்', rotRef: 'பெட்டகத்தில் புதிய குறிப்பு (vault://…, சாவி அல்ல)', rotGrace: 'கருணை (பழைய பதிப்பு செல்லுபடியாகும் நாட்கள்)', rotBtn: 'மாற்று',
    rotConfirmTitle: 'இந்த ரகசியத்தை மாற்றவா?', rotConfirmDetail: '{secret}-இன் புதிய பதிப்பை தலைமை அலுவலகம் உங்கள் பெயரில் பதிவு செய்யும். பழைய பதிப்பு {grace} நாட்கள் செல்லுபடியாகி, பின் நின்றுவிடும். அதற்குள் அதைப் பயன்படுத்தும் ஒவ்வொரு இணைப்புக்கும் புதிய குறிப்பு தரப்பட வேண்டும்.',
    rotDone: 'மாற்றப்பட்டது. கருணை முடியும் வரை பழைய பதிப்பு செல்லுபடியாகும்.',
    noVaultRef: 'முதலில் பெட்டகத்தில் புதிய குறிப்பைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.', notAReference: 'அது குறிப்பு அல்ல, சாவி போலத் தெரிகிறது. இங்கே குறிப்பு (vault://…) மட்டுமே தட்டச்சு செய்யப்படும். எதுவும் அனுப்பப்படவில்லை.', noGrace: 'கருணை பூச்சியத்துக்கு மேல் முழு நாட்களாக இருக்க வேண்டும். எதுவும் அனுப்பப்படவில்லை.', noSecret: 'முதலில் ரகசியத்தைத் தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.',
    rvkH: 'ஒரு ரகசியத்தை உடனே ரத்து செய்', rvkLead: 'சமரசத்துக்கு: மேலடுப்பு இல்லை — தலைமை அலுவலகம் பதிவு செய்த கணத்தில் அதைப் பயன்படுத்தும் ஒவ்வொரு இணைப்பும் நின்றுவிடும். எது உடையும் என்பதை தலைமை அலுவலகம் முன்பே பெயரிடும். காரணம் சொல்லுங்கள்; அது தணிக்கைப் பதிவுக்குச் செல்லும்.',
    rvkReason: 'ஏன் (தணிக்கைப் பதிவுக்குச் செல்லும்)', rvkBtn: 'இப்போதே ரத்து செய்',
    rvkConfirmTitle: 'இந்த ரகசியத்தை இப்போதே ரத்து செய்யவா?', rvkConfirmDetail: 'தலைமை அலுவலகம் பதிவு செய்த கணத்தில் {secret} மேலடுப்பு இல்லாமல் நின்றுவிடும். அதைப் பயன்படுத்தும் எதுவும் புதிய ரகசியம் தரப்படும் வரை உடையும். இதைத் திரும்பப் பெற முடியாது.',
    rvkDone: 'ரத்து செய்யப்பட்டது. எது உடையும் என்பது கீழே.', willBreak: 'நின்றுவிடும்', nothingBreaks: 'எந்த நேரடி இணைப்பும் அதைச் சுட்டவில்லை.',
    noReason: 'முதலில் ஏன் என்று சொல்லுங்கள் — காரணம் தணிக்கைப் பதிவுக்குச் செல்லும். எதுவும் அனுப்பப்படவில்லை.',
    tokH: 'துண்டிக்கப்பட்ட உள்நுழைவுகள்', tokLead: 'ஒரு தொலைபேசி தொலைந்தாலோ ஒருவர் வெளியேறினாலோ அவர்களின் உள்நுழைவுகள் இங்கே துண்டிக்கப்படும்; இந்தக் கணத்துக்கு முன் வழங்கப்பட்ட ஒவ்வொரு உள்நுழைவும் எல்லா இடத்திலும் நின்றுவிடும். பட்டியல் தலைமை அலுவலகம் வைத்திருப்பது.',
    tokWho: 'ஒரு நபர் (அவரின் பயனர் அடையாளம்) அல்லது ஒரு டோக்கன்', tokTarget: 'துண்டி', tokUser: 'ஒருவரின் எல்லா உள்நுழைவுகளும்', tokOne: 'ஒரு டோக்கன்', tokReason: 'ஏன்', tokBtn: 'உள்நுழைவுகளைத் துண்டி',
    tokConfirmTitle: 'இந்த உள்நுழைவுகளைத் துண்டிக்கவா?', tokConfirmDetail: '{who}-இன் இப்போதைக்கு முன் வழங்கப்பட்ட ஒவ்வொரு உள்நுழைவும் எல்லா சாதனங்களிலும் உடனே நின்றுவிடும். அவர்கள் தங்கள் கடவுச்சொல்லோடு மீண்டும் உள்நுழைவார்கள்.',
    tokDone: 'துண்டிக்கப்பட்டது. ரத்து பதிவு செய்யப்பட்டது.', tokNone: 'இன்னும் எந்த உள்நுழைவும் துண்டிக்கப்படவில்லை.',
    cWhen: 'எப்போது', cTarget: 'எது துண்டிக்கப்பட்டது', cReason: 'ஏன்', cBy: 'யார்', tokAllOf: 'எல்லா உள்நுழைவுகளும்:', tokOneToken: 'டோக்கன்', tokUpTo: 'வரை வழங்கியவை',
    rr_admin_revoked: 'நிர்வாகி துண்டித்தார்', rr_security: 'பாதுகாப்புக் கவலை', rr_credential_change: 'சான்று மாறியது', rr_signed_out: 'எல்லா இடத்திலும் வெளியேறினார்',
    noWho: 'முதலில் நபரையோ டோக்கனையோ பெயரிடுங்கள். எதுவும் அனுப்பப்படவில்லை.', noRevocationReason: 'பெயரிடப்பட்ட காரணங்களில் ஒன்றைத் தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.',
    whereH: 'மற்ற சான்றுகள் எங்கே உள்ளன', whereLead: 'ஒவ்வொரு வகைச் சான்றுக்கும் அதன் சொந்தப் பக்கம் உண்டு; இந்தப் பக்கம் பட்டியலையும் மாற்றங்களையும் வைத்திருக்கிறது.',
    wPartners: 'கூட்டாளர் சான்றுகள்', wPartnersNote: 'ஒவ்வொரு கூட்டாளரும் எதை அடையலாம், என்ன செய்யலாம்; அதன் டோக்கன் தனியாக வழங்கப்படும்', wBoxes: 'கடை கணினிகள்', wBoxesNote: 'ஒவ்வொரு கடைக் கணினியின் சொந்த முத்திரையிட்ட சான்றும் கைரேகைகளும்', wGates: 'வெளியீட்டு கையொப்பம்', wGatesNote: 'ஒவ்வொரு வெளியீடும் குழாயில் கையொப்பமிடப்படும்; தர வாயில்கள் கையொப்பத்தைப் படிக்கும்', wUsers: 'பயனர்களும் பங்குகளும்', wUsersNote: 'யார் உள்நுழையலாம், எந்தப் பங்கில்',
    st_active: 'பயன்பாட்டில்', st_rotating: 'மாறிக்கொண்டிருக்கிறது', st_superseded: 'மாற்றப்பட்டது', st_revoked: 'ரத்து',
    k_payment_provider: 'கட்டண வழங்குநர்', k_gst_portal: 'GST தளம்', k_messaging_provider: 'செய்தி வழங்குநர்', k_logistics_provider: 'போக்குவரத்து வழங்குநர்', k_tally_bridge: 'Tally பாலம்', k_service_identity: 'சேவை அடையாளம்', k_device_credential: 'சாதனச் சான்று', k_partner_credential: 'கூட்டாளர் சான்று', k_signing_key: 'கையொப்பச் சாவி', k_other: 'மற்றவை',
    dueIn: 'இன்னும்', dueOverdue: 'தாமதம்', wasDue: 'மாற்ற வேண்டிய நாள்', revokedOn: 'ரத்தான நாள்', notKnownDate: 'தெரியவில்லை — பதிவில் தேதி இல்லை',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.',
  },
} as const;
export type KeysCopyKey = keyof typeof KEYS_COPY.en;
export const keysWords = (lang: Lang, key: KeysCopyKey | string): string =>
  (KEYS_COPY[lang] as Record<string, string>)[key] ?? (KEYS_COPY.en as Record<string, string>)[key] ?? key;
/** The three-part refusal words (what happened · nothing was changed · the next safe action) in the reader's language. */
export const keysOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => keysWords(lang, k), out, lang);

// ── dates: when a change is due, said in words ─────────────────────────────────────────────────────────────────────

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TA_MONTHS = ['ஜன', 'பிப்', 'மார்', 'ஏப்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக', 'செப்', 'அக்', 'நவ', 'டிச'];
const DAY_MS = 86_400_000;
/** A calendar DAY as written (YYYY-MM-DD, a shop day — never an instant) → its day number's start, for counting days between two of them. */
const dayOf = (day: string): number | undefined => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day); return m === null ? undefined : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); };
/** "1 Apr 2026" / "1 ஏப் 2026" — a day a shop person reads (OB-606 spirit: never the machine's YYYY-MM-DD on screen). */
export function dayWords(lang: Lang, iso: string): string {
  const ms = dayOf(iso);
  if (ms === undefined) return iso;
  const d = new Date(ms);
  return `${d.getUTCDate()} ${(lang === 'ta' ? TA_MONTHS : EN_MONTHS)[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** When the next change is due, counted from the last change (or the making) and the policy, against the shop's day. */
export function dueWords(lang: Lang, s: SecretRow, today: string): string {
  const w = (k: string) => keysWords(lang, k);
  if (s.state === 'revoked') return `${w('revokedOn')} ${s.revokedOn === undefined ? '—' : dayWords(lang, s.revokedOn)}`;
  const since = dayOf(s.lastRotatedOn ?? s.createdOn ?? '');
  const now = dayOf(today);
  if (since === undefined || now === undefined || !Number.isFinite(s.rotateEveryDays)) return w('notKnownDate');
  const dueMs = since + s.rotateEveryDays * DAY_MS;
  const due = new Date(dueMs); // a day number built from shop days above — its UTC parts ARE that calendar day
  const dueIso = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, '0')}-${String(due.getUTCDate()).padStart(2, '0')}`;
  const days = Math.round((dueMs - now) / DAY_MS);
  if (days >= 0) return lang === 'ta' ? `${w('dueIn')} ${days} ${w('days')} (${dayWords(lang, dueIso)})` : `due in ${days} days (${dayWords(lang, dueIso)})`;
  return lang === 'ta' ? `${w('dueOverdue')} ${-days} ${w('days')} (${w('wasDue')} ${dayWords(lang, dueIso)})` : `overdue by ${-days} days (was due ${dayWords(lang, dueIso)})`;
}
/** Whether a secret's change is overdue / due within `warn` days on the shop's day — the cards' counts, from the same arithmetic. */
export function dueState(s: SecretRow, today: string, warn = 14): 'overdue' | 'due_soon' | 'ok' | 'not_known' {
  if (s.state === 'revoked') return 'ok';
  const since = dayOf(s.lastRotatedOn ?? s.createdOn ?? ''); const now = dayOf(today);
  if (since === undefined || now === undefined || !Number.isFinite(s.rotateEveryDays)) return 'not_known';
  const days = Math.round((since + s.rotateEveryDays * DAY_MS - now) / DAY_MS);
  return days < 0 ? 'overdue' : days <= warn ? 'due_soon' : 'ok';
}

// ── the session ────────────────────────────────────────────────────────────────────────────────────────────────────

type Invalid = { readonly result: 'invalid'; readonly why: string };
const invalid = (why: string): Invalid => ({ result: 'invalid', why });
/** A vault reference is a scheme URI (vault://…, kms://…), never a bare key; a key-looking string is refused before it is sent. */
const isReference = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s.trim());
const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);
const enc = encodeURIComponent;

export function createKeysSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): KeysSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const has = (p: string): boolean => named && perms.has(p);
  const may: KeysMay = { named, read: has('platform.setup.read'), write: has('platform.setup.write'), revokeTokens: has('identity.session.revoke') };
  const call = makeCaller({ keyPrefix: 'keys', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (right: boolean): Invalid | undefined => (!named ? invalid('nobody') : right ? undefined : invalid('notAllowed'));
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    may,
    inventory: async () => {
      const no = gate(may.read); if (no) return no;
      const out = await call<{ secrets?: unknown }>('GET', '/v1/integration/secrets');
      return out.result === 'ok' ? { result: 'ok', value: rows(out.value.secrets).map(secretRowOf) } : out;
    },
    review: async () => {
      const no = gate(may.read); if (no) return no;
      const out = await call<{ issues?: unknown; detail?: unknown; asAt?: unknown }>('POST', '/v1/integration/secrets/review', {});
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: {
        issues: rows(out.value.issues).map((i) => ({ secretId: str(i['secretId']), kind: str(i['kind']), owner: str(i['owner']), finding: str(i['finding']), blocking: i['blocking'] === true, detail: str(i['detail']),
          ...(typeof i['daysOverdue'] === 'number' ? { daysOverdue: i['daysOverdue'] } : {}), ...(typeof i['daysLeft'] === 'number' ? { daysLeft: i['daysLeft'] } : {}) })),
        detail: str(out.value.detail), ...(typeof out.value.asAt === 'string' ? { asAt: out.value.asAt } : {}),
      } };
    },
    usage: async () => {
      const no = gate(may.read); if (no) return no;
      const out = await call<Record<string, unknown>>('GET', '/v1/integration/secrets/usage');
      if (out.result !== 'ok') return out;
      const r = out.value;
      return { result: 'ok', value: {
        from: str(r['from']), to: str(r['to']),
        uses: rows(r['uses']).map((u) => ({ credentialRef: str(u['credentialRef']), callerId: str(u['callerId']), api: str(u['api']), calls: num(u['calls']), errors: num(u['errors']), daysUsed: num(u['daysUsed']) })),
        lastRolledUpDay: typeof r['lastRolledUpDay'] === 'string' ? r['lastRolledUpDay'] : null,
        findings: rows(r['findings']).map((f) => ({ day: str(f['day']), baselineDay: str(f['baselineDay']), identityId: str(f['identityId']), api: str(f['api']), signal: str(f['signal']) })),
        notJudged: Array.isArray(r['notJudged']) ? r['notJudged'].filter((d): d is string => typeof d === 'string') : [],
      } };
    },
    rotate: async (secretId, d) => {
      const no = gate(may.write); if (no) return no;
      if (secretId.trim() === '') return invalid('noSecret');
      const ref = d.newVaultRef.trim();
      if (ref === '') return invalid('noVaultRef');
      if (!isReference(ref)) return invalid('notAReference');
      const grace = whole(d.graceDays);
      if (grace === undefined || grace < 1) return invalid('noGrace');
      const out = await call<Record<string, unknown>>('POST', `/v1/integration/secrets/${enc(secretId.trim())}/rotation`, { newVaultRef: ref, graceDays: grace });
      if (out.result !== 'ok') return out;
      const r = out.value;
      return { result: 'ok', value: { secretId: str(r['secretId']), rotated: r['rotated'] === true, outcome: str(r['outcome']), detail: str(r['detail']),
        ...(typeof r['next'] === 'object' && r['next'] !== null ? { next: secretRowOf(r['next'] as Record<string, unknown>) } : {}), ...(typeof r['graceEndsOn'] === 'string' ? { graceEndsOn: r['graceEndsOn'] } : {}) } };
    },
    revoke: async (secretId, reason) => {
      const no = gate(may.write); if (no) return no;
      if (secretId.trim() === '') return invalid('noSecret');
      if (reason.trim() === '') return invalid('noReason');
      const out = await call<Record<string, unknown>>('POST', `/v1/integration/secrets/${enc(secretId.trim())}/revocation`, { reason: reason.trim() });
      if (out.result !== 'ok') return out;
      const r = out.value;
      return { result: 'ok', value: { secretId: str(r['secretId']), revoked: secretRowOf((typeof r['revoked'] === 'object' && r['revoked'] !== null ? r['revoked'] : {}) as Record<string, unknown>),
        willBreak: rows(r['willBreak']).map((a) => ({ adapterId: str(a['adapterId']), environment: str(a['environment']) })), detail: str(r['detail']) } };
    },
    tokenRevocations: async () => {
      const no = gate(may.revokeTokens); if (no) return no;
      const out = await call<{ revocations?: unknown }>('GET', '/v1/identity/token-revocations');
      if (out.result !== 'ok') return out;
      const list = rows(out.value.revocations).map((r): TokenRevocationRow => ({ id: str(r['id']), reason: str(r['reason']), revokedBy: str(r['revokedBy']), revokedAt: str(r['revokedAt']),
        ...(typeof r['jti'] === 'string' ? { jti: r['jti'] } : {}), ...(typeof r['userId'] === 'string' ? { userId: r['userId'] } : {}), ...(typeof r['issuedBefore'] === 'number' ? { issuedBefore: r['issuedBefore'] } : {}) }));
      return { result: 'ok', value: [...list].sort((x, y) => y.revokedAt.localeCompare(x.revokedAt)) };
    },
    revokeTokens: async (target, id, reason) => {
      const no = gate(may.revokeTokens); if (no) return no;
      if (id.trim() === '') return invalid('noWho');
      if (!(REVOCATION_REASONS as readonly string[]).includes(reason)) return invalid('noRevocationReason');
      return call('POST', '/v1/identity/token-revocations', { ...(target === 'user' ? { userId: id.trim() } : { jti: id.trim() }), reason });
    },
  };
}
