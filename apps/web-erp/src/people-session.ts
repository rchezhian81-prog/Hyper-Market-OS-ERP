// The People part of "Who can get in" (OB-15-c-2 · M02-FR-01 · SEC-03 · §28 · hard rule #4) — the tested model behind
// the administrator giving a NAMED person their sign-in at the identity server.
//
// What this screen will and will not do:
//   • it asks head office (`POST /v1/identity/people`) in the administrator's OWN signed-in session; head office decides,
//     and re-checks everything this model checks first;
//   • it refuses the cheap things before any request, from the SAME rules head office uses: a shared or job name
//     ("cashier2", "till-3", "Store Manager"), a name it cannot read, the administrator themselves;
//   • it never asks for a password. Head office makes the one-time password and this model holds it IN MEMORY ONLY,
//     until the administrator says it has been handed over — never in storage, never sent anywhere, never shown again;
//   • a request with no answer is not repeated behind anybody's back: the screen says what is known, and a press of
//     "Check again" reads the list.
//
// Every press is a human act on an explicit click; nothing is written on load.

import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { isGenericName, SIGN_IN_NAME, tidyPersonName, readablePersonName } from '../../../packages/identity/src/sign-in-names';
import { shopTime, type LostLink, type Refused } from './approvals-session';

import type { Lang } from '../../../packages/ui/src/index';

/** The authority head office checks before giving anybody a sign-in — the platform administrator's. */
export const PERSON_PROVISION_PERMISSION = 'platform.person.provision';

export type PersonState = 'requested' | 'issued' | 'ended';

/** One person's sign-in as head office lists it. Never holds a password. */
export interface PersonRow {
  readonly userId: string;
  readonly signInName: string;
  readonly displayName: string;
  readonly state: PersonState;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly issuedAt?: string;
  readonly endedAt?: string;
}

export type PeopleRead = { readonly result: 'read'; readonly people: readonly PersonRow[]; readonly connected: boolean } | Refused | LostLink;

/** Head office's answer to "give this person a sign-in". `oneTimePassword` is absent when head office withheld it. */
export type IssueResult =
  | { readonly result: 'issued'; readonly userId: string; readonly signInName: string; readonly displayName: string; readonly oneTimePassword?: string }
  | Refused | LostLink;

export interface PeoplePort {
  read(): Promise<PeopleRead>;
  issue(input: { readonly signInName: string; readonly displayName: string }): Promise<IssueResult>;
}

export interface PeopleConfig {
  /** Who is looking. `null`: the screen was not told — nothing may be done. */
  readonly userId: string | null;
  /** Whether this person holds the platform administrator's authority to give sign-ins. Default-deny. */
  readonly mayProvision: boolean;
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const COPY = {
  en: {
    title: 'Sign-ins',
    lead: 'Give a new person their own sign-in. One person, one sign-in — never a shared one. What they may do is asked for and approved separately.',
    nameLabel: 'Full name', signInLabel: 'Sign-in name', signInHint: 'Their own name, for example asha.k — lower case, 3 to 40 letters or digits.',
    issueBtn: 'Give a sign-in', checkAgainBtn: 'Check again', handedOverBtn: 'I have handed it over',
    noneYet: 'Nobody has been given a sign-in from here yet.',
    stateRequested: 'asked for — not finished', stateIssued: 'has a sign-in', stateEnded: 'sign-in ended (left)',
    givenBy: 'given by', on: 'on',
    sourceRead: 'Head office, as at {at}.', sourceChecking: 'Asking head office…',
    sourceNotConnected: 'This screen is not connected to head office, so no sign-in can be given here.',
    sourceLostLink: 'Head office did not answer. Nothing here is known to have changed.',
    sourceNotPermitted: 'You may not see who has a sign-in.',
    sourceIdentityNotConnected: 'Head office is not connected to the identity server yet, so sign-ins are given there by hand (runbook: identity server).',
    sourceRefused: 'Head office said:',
    cannotNobody: 'This screen was not told who you are, so nothing can be done here.',
    cannotPermission: 'Only the platform administrator gives sign-ins.',
    refuseBlankName: 'Type the person’s full name.',
    refuseBadSignIn: 'The sign-in name must be 3 to 40 lower-case letters or digits (dots, hyphens and underscores allowed).',
    refuseGeneric: '“{name}” names a job, a place or a shared account, not a person. Use the person’s own name.',
    refuseYourself: 'Nobody gives themselves a sign-in. Ask another administrator.',
    issuedTitle: 'Sign-in made for {name} ({signIn}).',
    passwordLabel: 'One-time password',
    handOver: 'Give this to {name} yourself — read it out or write it down. It works once: at first sign-in they choose their own password and set up the code on their phone. It is not shown again.',
    withheld: 'Head office made the sign-in but did not show the password again (it is shown only once). If it was not written down, reset it at the identity server.',
    lostLinkIssue: 'Head office did not answer. Press “Check again” to see whether the sign-in was made before trying again.',
    reasons: {
      shared_or_generic_sign_in: 'That names a job, a place or a shared account, not a person.',
      signing_in_yourself: 'Nobody gives themselves a sign-in.',
      person_already_holds_authority: 'This person already holds a role. Their sign-in is made at the identity server in their presence (runbook).',
      person_already_has_a_sign_in: 'This person already has a sign-in. A second one is never made; a forgotten password is reset at the identity server.',
      sign_in_name_or_person_already_used: 'That sign-in name or person is already used.',
      username_taken: 'That sign-in name already belongs to somebody else at the identity server. Choose another.',
      sign_in_ended: 'This person’s sign-in ended when they left. It is not revived from here.',
      identity_server_not_connected: 'Head office is not connected to the identity server yet.',
      identity_server_unavailable: 'The identity server did not answer. It is recorded as asked for — try again shortly and it will be finished.',
      reauthentication_required: 'Sign out and sign in again with the code from your phone, then try again. Giving a sign-in needs a fresh two-step sign-in.',
      forbidden: 'Only the platform administrator gives sign-ins.',
    } as Record<string, string>,
  },
  ta: {
    title: 'உள்நுழைவுகள்',
    lead: 'புதிய நபருக்கு அவருக்கே உரிய உள்நுழைவைக் கொடுங்கள். ஒருவருக்கு ஒரு உள்நுழைவு — பகிர்ந்த உள்நுழைவு ஒருபோதும் இல்லை. அவர் என்ன செய்யலாம் என்பது தனியாகக் கேட்கப்பட்டு அனுமதிக்கப்படும்.',
    nameLabel: 'முழுப் பெயர்', signInLabel: 'உள்நுழைவுப் பெயர்', signInHint: 'அவரது சொந்தப் பெயர், எ.கா. asha.k — சிறிய எழுத்துகள், 3 முதல் 40 எழுத்துகள் அல்லது எண்கள்.',
    issueBtn: 'உள்நுழைவு கொடு', checkAgainBtn: 'மீண்டும் பார்', handedOverBtn: 'நான் ஒப்படைத்துவிட்டேன்',
    noneYet: 'இங்கிருந்து இன்னும் யாருக்கும் உள்நுழைவு கொடுக்கப்படவில்லை.',
    stateRequested: 'கேட்கப்பட்டது — முடியவில்லை', stateIssued: 'உள்நுழைவு உள்ளது', stateEnded: 'உள்நுழைவு முடிந்தது (விலகினார்)',
    givenBy: 'கொடுத்தவர்', on: 'அன்று',
    sourceRead: 'தலைமை அலுவலகம், {at} நிலவரப்படி.', sourceChecking: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
    sourceNotConnected: 'இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை, எனவே இங்கே உள்நுழைவு கொடுக்க முடியாது.',
    sourceLostLink: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை. இங்கே எதுவும் மாறியதாகத் தெரியவில்லை.',
    sourceNotPermitted: 'யாருக்கு உள்நுழைவு உள்ளது என்பதை நீங்கள் பார்க்க முடியாது.',
    sourceIdentityNotConnected: 'தலைமை அலுவலகம் இன்னும் அடையாளச் சேவையகத்துடன் இணைக்கப்படவில்லை, எனவே உள்நுழைவுகள் அங்கே கைமுறையாகக் கொடுக்கப்படுகின்றன.',
    sourceRefused: 'தலைமை அலுவலகம் சொன்னது:',
    cannotNobody: 'நீங்கள் யார் என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை, எனவே இங்கே எதுவும் செய்ய முடியாது.',
    cannotPermission: 'தள நிர்வாகி மட்டுமே உள்நுழைவுகளைக் கொடுக்கிறார்.',
    refuseBlankName: 'நபரின் முழுப் பெயரைத் தட்டச்சு செய்யுங்கள்.',
    refuseBadSignIn: 'உள்நுழைவுப் பெயர் 3 முதல் 40 சிறிய எழுத்துகள் அல்லது எண்களாக இருக்க வேண்டும்.',
    refuseGeneric: '“{name}” ஒரு வேலை, இடம் அல்லது பகிர்ந்த கணக்கைக் குறிக்கிறது, ஒரு நபரை அல்ல. நபரின் சொந்தப் பெயரைப் பயன்படுத்துங்கள்.',
    refuseYourself: 'யாரும் தனக்குத் தானே உள்நுழைவு கொடுப்பதில்லை. மற்றொரு நிர்வாகியிடம் கேளுங்கள்.',
    issuedTitle: '{name} ({signIn}) க்கு உள்நுழைவு உருவாக்கப்பட்டது.',
    passwordLabel: 'ஒருமுறைக் கடவுச்சொல்',
    handOver: 'இதை {name} அவர்களிடம் நீங்களே கொடுங்கள். இது ஒருமுறை மட்டுமே வேலை செய்யும்: முதல் உள்நுழைவில் அவர் தனது சொந்தக் கடவுச்சொல்லைத் தேர்ந்தெடுத்து, தொலைபேசியில் குறியீட்டை அமைப்பார். இது மீண்டும் காட்டப்படாது.',
    withheld: 'உள்நுழைவு உருவாக்கப்பட்டது, ஆனால் கடவுச்சொல் மீண்டும் காட்டப்படவில்லை (ஒருமுறை மட்டுமே காட்டப்படும்). எழுதி வைக்கவில்லை என்றால், அடையாளச் சேவையகத்தில் மாற்றவும்.',
    lostLinkIssue: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை. மீண்டும் முயலும் முன், உள்நுழைவு உருவாக்கப்பட்டதா என்று “மீண்டும் பார்” அழுத்திப் பாருங்கள்.',
    reasons: {
      shared_or_generic_sign_in: 'அது ஒரு வேலை, இடம் அல்லது பகிர்ந்த கணக்கைக் குறிக்கிறது, ஒரு நபரை அல்ல.',
      signing_in_yourself: 'யாரும் தனக்குத் தானே உள்நுழைவு கொடுப்பதில்லை.',
      person_already_holds_authority: 'இவருக்கு ஏற்கனவே ஒரு பொறுப்பு உள்ளது. அவரது உள்நுழைவு அவர் முன்னிலையில் அடையாளச் சேவையகத்தில் உருவாக்கப்படும்.',
      person_already_has_a_sign_in: 'இவருக்கு ஏற்கனவே உள்நுழைவு உள்ளது. இரண்டாவது ஒருபோதும் உருவாக்கப்படாது; மறந்த கடவுச்சொல் அடையாளச் சேவையகத்தில் மாற்றப்படும்.',
      sign_in_name_or_person_already_used: 'அந்த உள்நுழைவுப் பெயர் அல்லது நபர் ஏற்கனவே பயன்பாட்டில் உள்ளது.',
      username_taken: 'அந்த உள்நுழைவுப் பெயர் அடையாளச் சேவையகத்தில் வேறொருவருக்குச் சொந்தமானது. வேறொன்றைத் தேர்ந்தெடுங்கள்.',
      sign_in_ended: 'இவர் விலகியபோது இவரது உள்நுழைவு முடிந்தது. இங்கிருந்து மீண்டும் தொடங்கப்படாது.',
      identity_server_not_connected: 'தலைமை அலுவலகம் இன்னும் அடையாளச் சேவையகத்துடன் இணைக்கப்படவில்லை.',
      identity_server_unavailable: 'அடையாளச் சேவையகம் பதிலளிக்கவில்லை. கோரிக்கை பதிவு செய்யப்பட்டுள்ளது — சிறிது நேரத்தில் மீண்டும் முயலுங்கள், அது முடிக்கப்படும்.',
      reauthentication_required: 'வெளியேறி, உங்கள் தொலைபேசிக் குறியீட்டுடன் மீண்டும் உள்நுழைந்து, பிறகு முயலுங்கள்.',
      forbidden: 'தள நிர்வாகி மட்டுமே உள்நுழைவுகளைக் கொடுக்கிறார்.',
    } as Record<string, string>,
  },
} as const;

export type PeopleCopyKey = Exclude<keyof typeof COPY.en, 'reasons'>;

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (whole, k: string) => values[k] ?? whole);

// ── The view ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonLine {
  readonly userId: string;
  /** "Asha Kumar (asha.k)" */
  readonly name: string;
  /** The state, in words — never a coloured dot alone. */
  readonly stateWords: string;
  readonly tone: 'ok' | 'degraded' | 'idle';
  /** "given by u-admin on 08-10-2026 15:30" */
  readonly detail: string;
}

export interface PeopleView {
  readonly source: StatusPresentation;
  readonly rows: readonly PersonLine[];
  readonly listKnown: boolean;
  /** May this person give a sign-in here? When not, `cannot` says why. */
  readonly mayIssue: boolean;
  readonly cannot: string | null;
}

/** The one-time password, held in memory until handed over. */
export interface HandOver {
  readonly signInName: string;
  readonly displayName: string;
  readonly oneTimePassword: string;
}

export type IssueOutcome =
  | { readonly kind: 'refused_here'; readonly field: 'displayName' | 'signInName' | 'none' }
  | { readonly kind: 'issued' }
  | { readonly kind: 'issued_without_password' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' }
  | { readonly kind: 'not_connected' };

export interface PeopleSession {
  readonly connected: boolean;
  text(lang: Lang, key: PeopleCopyKey): string;
  view(lang: Lang): PeopleView;
  /** Read head office's list (a GET — writes nothing). */
  refresh(): Promise<void>;
  /** Why this request would be refused before it is sent, in words — or null. */
  check(lang: Lang, input: { readonly signInName: string; readonly displayName: string }): string | null;
  issue(input: { readonly signInName: string; readonly displayName: string }): Promise<IssueOutcome>;
  /** The answer to the last press, in words. */
  present(lang: Lang, outcome: IssueOutcome, input?: { readonly signInName: string; readonly displayName: string }): StatusPresentation;
  /** The one-time password waiting to be handed over, or null. */
  handOver(): HandOver | null;
  /** The administrator says it has been handed over: it is forgotten. */
  handedOver(): void;
}

type Source =
  | { readonly kind: 'not_read' } | { readonly kind: 'checking' }
  | { readonly kind: 'read'; readonly at: string; readonly connected: boolean }
  | { readonly kind: 'lost_link' } | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string };

export function createPeopleSession(config: PeopleConfig, port?: PeoplePort, now: () => string = () => new Date().toISOString()): PeopleSession {
  let people: readonly PersonRow[] = [];
  let source: Source = { kind: 'not_read' };
  let pending: HandOver | null = null;
  const t = (lang: Lang, key: PeopleCopyKey): string => (COPY[lang] as Record<string, unknown>)[key] as string | undefined ?? (COPY.en[key] as string);
  const reason = (lang: Lang, code: string, fallback: string): string =>
    COPY[lang].reasons[code] ?? COPY.en.reasons[code] ?? fallback;

  const cannot = (): 'nobody' | 'permission' | 'not_connected' | null => {
    if (config.userId === null) return 'nobody';
    if (!config.mayProvision) return 'permission';
    if (port === undefined) return 'not_connected';
    return null;
  };

  const check = (lang: Lang, input: { readonly signInName: string; readonly displayName: string }): string | null => {
    const name = tidyPersonName(input.displayName);
    const signIn = input.signInName.trim().toLowerCase();
    if (!readablePersonName(name)) return t(lang, 'refuseBlankName');
    if (!SIGN_IN_NAME.test(signIn)) return t(lang, 'refuseBadSignIn');
    if (isGenericName(signIn)) return fill(t(lang, 'refuseGeneric'), { name: signIn });
    if (isGenericName(name)) return fill(t(lang, 'refuseGeneric'), { name });
    if (config.userId !== null && signIn === config.userId.toLowerCase()) return t(lang, 'refuseYourself');
    return null;
  };

  return {
    connected: port !== undefined,
    text: t,
    view: (lang) => {
      const why = cannot();
      const presentSource = (): StatusPresentation => {
        switch (source.kind) {
          case 'read':
            return source.connected
              ? presentStatus({ tone: 'ok', icon: '✓', label: fill(t(lang, 'sourceRead'), { at: shopTime(source.at) }), needsAttention: false })
              : presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'sourceIdentityNotConnected') });
          case 'checking': return presentStatus({ tone: 'idle', icon: '…', label: t(lang, 'sourceChecking'), needsAttention: false });
          case 'lost_link': return presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'sourceLostLink') });
          case 'refused':
            return source.code === 'forbidden' || source.code === 'permission_denied'
              ? presentStatus({ tone: 'error', icon: '✕', label: t(lang, 'sourceNotPermitted') })
              : presentStatus({ tone: 'error', icon: '✕', label: `${t(lang, 'sourceRefused')} ${reason(lang, source.code, source.whatHappened)}`.trim() });
          default:
            return port === undefined
              ? presentStatus({ tone: 'idle', icon: 'ℹ', label: t(lang, 'sourceNotConnected'), needsAttention: false })
              : presentStatus({ tone: 'idle', icon: '…', label: t(lang, 'sourceChecking'), needsAttention: false });
        }
      };
      const identityConnected = source.kind !== 'read' || source.connected;
      return {
        source: presentSource(),
        listKnown: source.kind === 'read',
        rows: people.map((p) => ({
          userId: p.userId,
          name: `${p.displayName} (${p.signInName})`,
          stateWords: t(lang, p.state === 'issued' ? 'stateIssued' : p.state === 'ended' ? 'stateEnded' : 'stateRequested'),
          tone: p.state === 'issued' ? 'ok' as const : p.state === 'requested' ? 'degraded' as const : 'idle' as const,
          detail: `${t(lang, 'givenBy')} ${p.requestedBy} ${t(lang, 'on')} ${shopTime(p.issuedAt ?? p.requestedAt)}`,
        })),
        mayIssue: why === null && identityConnected,
        cannot: why === 'nobody' ? t(lang, 'cannotNobody')
          : why === 'permission' ? t(lang, 'cannotPermission')
            : why === 'not_connected' ? t(lang, 'sourceNotConnected')
              : identityConnected ? null : t(lang, 'sourceIdentityNotConnected'),
      };
    },
    refresh: async () => {
      if (port === undefined) return;
      source = { kind: 'checking' };
      const read = await port.read();
      if (read.result === 'read') { people = read.people; source = { kind: 'read', at: now(), connected: read.connected }; }
      else if (read.result === 'lost_link') source = { kind: 'lost_link' };
      else source = { kind: 'refused', code: read.code, whatHappened: read.whatHappened };
    },
    check,
    issue: async (input) => {
      if (port === undefined) return { kind: 'not_connected' };
      if (cannot() !== null) return { kind: 'refused_here', field: 'none' };
      const problem = check('en', input);
      if (problem !== null) {
        return { kind: 'refused_here', field: readablePersonName(tidyPersonName(input.displayName)) && !isGenericName(tidyPersonName(input.displayName)) ? 'signInName' : 'displayName' };
      }
      const sent = { signInName: input.signInName.trim().toLowerCase(), displayName: tidyPersonName(input.displayName) };
      const answer = await port.issue(sent);
      if (answer.result === 'lost_link') return { kind: 'lost_link' };
      if (answer.result === 'refused') return { kind: 'refused', code: answer.code, whatHappened: answer.whatHappened };
      // The password stays only here, in memory; the list is read again so the new person shows.
      if (answer.oneTimePassword !== undefined) {
        pending = { signInName: answer.signInName, displayName: answer.displayName, oneTimePassword: answer.oneTimePassword };
      }
      const r = await port.read();
      if (r.result === 'read') { people = r.people; source = { kind: 'read', at: now(), connected: r.connected }; }
      return answer.oneTimePassword === undefined ? { kind: 'issued_without_password' } : { kind: 'issued' };
    },
    present: (lang, outcome, input) => {
      switch (outcome.kind) {
        case 'issued':
          return presentStatus({ tone: 'ok', icon: '✓', label: fill(t(lang, 'issuedTitle'), { name: pending?.displayName ?? '', signIn: pending?.signInName ?? '' }), needsAttention: false });
        case 'issued_without_password':
          return presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'withheld') });
        case 'refused_here': {
          const words = input === undefined ? null : check(lang, input);
          const why = cannot();
          const label = words ?? (why === 'nobody' ? t(lang, 'cannotNobody') : t(lang, 'cannotPermission'));
          return presentStatus({ tone: 'error', icon: '✕', label });
        }
        case 'refused':
          return presentStatus({ tone: 'error', icon: '✕', label: reason(lang, outcome.code, outcome.whatHappened) || t(lang, 'sourceLostLink') });
        case 'lost_link':
          return presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'lostLinkIssue') });
        default:
          return presentStatus({ tone: 'idle', icon: 'ℹ', label: t(lang, 'sourceNotConnected'), needsAttention: false });
      }
    },
    handOver: () => pending,
    handedOver: () => { pending = null; },
  };
}

/** The hand-over words for the password panel. */
export function handOverWords(session: PeopleSession, lang: Lang, h: HandOver): string {
  return fill(session.text(lang, 'handOver'), { name: h.displayName });
}
