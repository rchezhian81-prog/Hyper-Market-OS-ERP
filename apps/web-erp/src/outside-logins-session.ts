// OB-76 (owner, 12 Oct 2026, "Staff invite + 2nd approves") — the "Logins for customers and suppliers" part of "Who can
// get in": the tested model behind a member of staff inviting an outside party's login (a business customer, an app
// customer, a supplier), a DIFFERENT person approving it, revoking it, and giving its sign-in.
//
// What this screen will and will not do:
//   • it asks head office (`/v1/identity/outside-logins/…`) in the viewer's OWN signed-in session; head office decides and
//     re-checks everything (the party exists, maker ≠ checker, the right to manage that party, one person per login);
//   • it offers a kind only to someone who holds the right to manage that kind of party (default-deny) — head office
//     refuses the rest anyway;
//   • it never offers the inviter the Approve button on their own invite; head office refuses it too;
//   • nothing is written on load — a read is a GET; every write is an explicit press;
//   • a one-time password head office returns is held IN MEMORY ONLY until "I have handed it over" — never in storage.

import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import { isGenericName, SIGN_IN_NAME, PRODUCT_ID, tidyPersonName, readablePersonName } from '../../../packages/identity/src/sign-in-names';
import { shopTime, type LostLink, type Refused } from './approvals-session';
import type { Lang } from '../../../packages/ui/src/index';

export type OutsideKind = 'b2b_customer' | 'customer' | 'supplier';
export const OUTSIDE_KINDS: readonly OutsideKind[] = ['b2b_customer', 'customer', 'supplier'];
/** The right head office asks for each kind — the one that manages that party. */
export const OUTSIDE_KIND_PERMISSION: Readonly<Record<OutsideKind, string>> = {
  b2b_customer: 'b2b.account.manage', customer: 'customer.identity.manage', supplier: 'supplier.portal.manage',
};
export const OUTSIDE_KIND_SEGMENT: Readonly<Record<OutsideKind, string>> = { b2b_customer: 'b2b-accounts', customer: 'customers', supplier: 'suppliers' };
export const B2B_PORTAL_GRANTS = ['view_invoices', 'view_statement', 'place_order', 'make_payment'] as const;

export type OutsideState = 'invited' | 'approved' | 'rejected' | 'revoked';
export interface OutsideLoginRow {
  readonly inviteId: string; readonly role: OutsideKind; readonly partyId: string; readonly userId: string; readonly displayName: string;
  readonly state: OutsideState; readonly invitedBy: string; readonly invitedAt: string;
  readonly approvedBy?: string; readonly rejectedBy?: string; readonly revokedBy?: string; readonly grants?: readonly string[];
}

export type OutsideRead = { readonly result: 'read'; readonly logins: readonly OutsideLoginRow[] } | Refused | LostLink;
export type OutsideWrite = { readonly result: 'done'; readonly login?: OutsideLoginRow; readonly oneTimePassword?: string } | Refused | LostLink;

export interface OutsideLoginsPort {
  list(kind: OutsideKind): Promise<OutsideRead>;
  invite(kind: OutsideKind, partyId: string, inviteId: string, body: { readonly userId?: string; readonly displayName: string; readonly grants?: readonly string[] }): Promise<OutsideWrite>;
  approve(kind: OutsideKind, inviteId: string): Promise<OutsideWrite>;
  revoke(kind: OutsideKind, inviteId: string, reason: string): Promise<OutsideWrite>;
  signIn(kind: OutsideKind, inviteId: string, signInName: string): Promise<OutsideWrite>;
}

export interface OutsideLoginsConfig {
  readonly userId: string | null;
  readonly permissions: readonly string[];
}

const COPY = {
  en: {
    title: 'Logins for customers and suppliers',
    lead: 'A business customer, an app customer or a supplier gets its own login, bound to its own record — it sees its own account and nothing else. One person invites; a different person approves.',
    kindLabel: 'Who the login is for', partyLabel: 'Their record (account, customer or supplier code)', userLabel: 'Login id', nameLabel: 'The person’s full name',
    userHint: 'For an app customer the login id is the customer’s own code. Lower case, 3 to 64 letters or digits.',
    grantsLabel: 'What a business customer may use',
    inviteBtn: 'Invite', approveBtn: 'Approve', revokeBtn: 'Revoke', signInBtn: 'Give the sign-in', handedOverBtn: 'I have handed it over',
    reasonLabel: 'Why', signInLabel: 'Sign-in name',
    kind_b2b_customer: 'Business customer', kind_customer: 'App customer', kind_supplier: 'Supplier',
    grant_view_invoices: 'see invoices', grant_view_statement: 'see the statement and balance', grant_place_order: 'place orders', grant_make_payment: 'make payments',
    state_invited: 'waiting for a second person to approve', state_approved: 'approved — can sign in to its own record', state_rejected: 'rejected', state_revoked: 'revoked — cannot sign in',
    invitedBy: 'invited by', approvedBy: 'approved by', rejectedBy: 'rejected by', revokedBy: 'revoked by',
    noneYet: 'No outside logins have been invited yet.',
    sourceRead: 'Head office, as at {at}.', sourceChecking: 'Asking head office…', sourceLostLink: 'Head office did not answer. Nothing here is known to have changed.',
    sourceNotConnected: 'This screen is not connected to head office, so nothing can be done here.',
    cannotNobody: 'This screen was not told who you are, so nothing can be done here.',
    cannotPermission: 'You may not manage business customers, customers or suppliers, so you cannot invite or approve their logins.',
    refuseParty: 'Type the record’s code.', refuseUser: 'The login id must be 3 to 64 lower-case letters or digits.', refuseName: 'Type the person’s full name.',
    refuseGeneric: '“{name}” names a job, a place or a shared account, not a person.', refuseYourself: 'Nobody invites a login for themselves.',
    refuseGrants: 'Choose at least one thing the business customer may use.', refuseReason: 'Say why.', refuseSignIn: 'The sign-in name must be 3 to 40 lower-case letters or digits.',
    invited: 'Invited {name} — waiting for a second person to approve.', approved: 'Approved. {name} can now sign in to their own record.',
    revoked: 'Revoked. {name} can no longer sign in.', signedIn: 'Sign-in made for {name}.',
    passwordLabel: 'One-time password', handOver: 'Give this to {name} yourself. It works once; it is not shown again.',
    headOfficeSaid: 'Head office said:',
  },
  ta: {
    title: 'வாடிக்கையாளர்கள், சப்ளையர்களுக்கான உள்நுழைவுகள்',
    lead: 'வணிக வாடிக்கையாளர், செயலி வாடிக்கையாளர் அல்லது சப்ளையருக்கு அவருக்கே உரிய உள்நுழைவு, அவரது சொந்தப் பதிவுடன் இணைக்கப்படும் — அவர் தனது கணக்கை மட்டுமே பார்ப்பார். ஒருவர் அழைக்கிறார்; வேறொருவர் அனுமதிக்கிறார்.',
    kindLabel: 'உள்நுழைவு யாருக்கு', partyLabel: 'அவர்களின் பதிவு (கணக்கு, வாடிக்கையாளர் அல்லது சப்ளையர் குறியீடு)', userLabel: 'உள்நுழைவு அடையாளம்', nameLabel: 'நபரின் முழுப் பெயர்',
    userHint: 'செயலி வாடிக்கையாளருக்கு உள்நுழைவு அடையாளம் அவரது சொந்த வாடிக்கையாளர் குறியீடு. சிறிய எழுத்துகள், 3 முதல் 64 எழுத்துகள் அல்லது எண்கள்.',
    grantsLabel: 'வணிக வாடிக்கையாளர் பயன்படுத்தக்கூடியவை',
    inviteBtn: 'அழை', approveBtn: 'அனுமதி', revokeBtn: 'திரும்பப் பெறு', signInBtn: 'உள்நுழைவு கொடு', handedOverBtn: 'நான் ஒப்படைத்துவிட்டேன்',
    reasonLabel: 'ஏன்', signInLabel: 'உள்நுழைவுப் பெயர்',
    kind_b2b_customer: 'வணிக வாடிக்கையாளர்', kind_customer: 'செயலி வாடிக்கையாளர்', kind_supplier: 'சப்ளையர்',
    grant_view_invoices: 'விலைப்பட்டியல்களைப் பார்க்க', grant_view_statement: 'அறிக்கையையும் இருப்பையும் பார்க்க', grant_place_order: 'ஆர்டர் செய்ய', grant_make_payment: 'பணம் செலுத்த',
    state_invited: 'இரண்டாவது நபரின் அனுமதிக்காகக் காத்திருக்கிறது', state_approved: 'அனுமதிக்கப்பட்டது — தனது பதிவில் உள்நுழையலாம்', state_rejected: 'நிராகரிக்கப்பட்டது', state_revoked: 'திரும்பப் பெறப்பட்டது — உள்நுழைய முடியாது',
    invitedBy: 'அழைத்தவர்', approvedBy: 'அனுமதித்தவர்', rejectedBy: 'நிராகரித்தவர்', revokedBy: 'திரும்பப் பெற்றவர்',
    noneYet: 'இதுவரை வெளியாட்களின் உள்நுழைவு எதுவும் அழைக்கப்படவில்லை.',
    sourceRead: 'தலைமை அலுவலகம், {at} நிலவரப்படி.', sourceChecking: 'தலைமை அலுவலகத்திடம் கேட்கிறது…', sourceLostLink: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை. இங்கே எதுவும் மாறியதாகத் தெரியவில்லை.',
    sourceNotConnected: 'இந்தத் திரை தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை, எனவே இங்கே எதுவும் செய்ய முடியாது.',
    cannotNobody: 'நீங்கள் யார் என்று இந்தத் திரைக்குச் சொல்லப்படவில்லை, எனவே இங்கே எதுவும் செய்ய முடியாது.',
    cannotPermission: 'வணிக வாடிக்கையாளர்கள், வாடிக்கையாளர்கள் அல்லது சப்ளையர்களை நீங்கள் நிர்வகிக்க முடியாது, எனவே அவர்களின் உள்நுழைவுகளை அழைக்கவோ அனுமதிக்கவோ முடியாது.',
    refuseParty: 'பதிவின் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.', refuseUser: 'உள்நுழைவு அடையாளம் 3 முதல் 64 சிறிய எழுத்துகள் அல்லது எண்களாக இருக்க வேண்டும்.', refuseName: 'நபரின் முழுப் பெயரைத் தட்டச்சு செய்யுங்கள்.',
    refuseGeneric: '“{name}” ஒரு வேலை, இடம் அல்லது பகிர்ந்த கணக்கைக் குறிக்கிறது, ஒரு நபரை அல்ல.', refuseYourself: 'யாரும் தனக்குத் தானே உள்நுழைவை அழைப்பதில்லை.',
    refuseGrants: 'வணிக வாடிக்கையாளர் பயன்படுத்தக்கூடிய குறைந்தது ஒன்றைத் தேர்ந்தெடுங்கள்.', refuseReason: 'காரணம் சொல்லுங்கள்.', refuseSignIn: 'உள்நுழைவுப் பெயர் 3 முதல் 40 சிறிய எழுத்துகள் அல்லது எண்களாக இருக்க வேண்டும்.',
    invited: '{name} அழைக்கப்பட்டார் — இரண்டாவது நபரின் அனுமதிக்காகக் காத்திருக்கிறது.', approved: 'அனுமதிக்கப்பட்டது. {name} இப்போது தனது பதிவில் உள்நுழையலாம்.',
    revoked: 'திரும்பப் பெறப்பட்டது. {name} இனி உள்நுழைய முடியாது.', signedIn: '{name} க்கு உள்நுழைவு உருவாக்கப்பட்டது.',
    passwordLabel: 'ஒருமுறைக் கடவுச்சொல்', handOver: 'இதை {name} அவர்களிடம் நீங்களே கொடுங்கள். இது ஒருமுறை மட்டுமே வேலை செய்யும்; மீண்டும் காட்டப்படாது.',
    headOfficeSaid: 'தலைமை அலுவலகம் சொன்னது:',
  },
} as const;
export type OutsideCopyKey = keyof typeof COPY.en;
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (whole, k: string) => values[k] ?? whole);

export interface OutsideRowView {
  readonly inviteId: string; readonly kind: OutsideKind; readonly name: string; readonly stateWords: string; readonly state: OutsideState;
  readonly detail: string; readonly mayApprove: boolean; readonly mayRevoke: boolean; readonly maySignIn: boolean;
}
export interface OutsideView {
  readonly source: StatusPresentation; readonly rows: readonly OutsideRowView[]; readonly listKnown: boolean;
  readonly kinds: readonly OutsideKind[]; readonly cannot: string | null;
}
export type OutsideOutcome =
  | { readonly kind: 'refused_here'; readonly words: OutsideCopyKey; readonly name?: string }
  | { readonly kind: 'done'; readonly what: 'invited' | 'approved' | 'revoked' | 'signedIn'; readonly name: string }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };
export interface OutsideHandOver { readonly displayName: string; readonly oneTimePassword: string }

export interface OutsideLoginsSession {
  readonly connected: boolean;
  text(lang: Lang, key: OutsideCopyKey): string;
  view(lang: Lang): OutsideView;
  refresh(): Promise<void>;
  invite(input: { readonly kind: OutsideKind; readonly partyId: string; readonly userId: string; readonly displayName: string; readonly grants: readonly string[] }): Promise<OutsideOutcome>;
  approve(kind: OutsideKind, inviteId: string): Promise<OutsideOutcome>;
  revoke(kind: OutsideKind, inviteId: string, reason: string): Promise<OutsideOutcome>;
  signIn(kind: OutsideKind, inviteId: string, signInName: string): Promise<OutsideOutcome>;
  present(lang: Lang, outcome: OutsideOutcome): StatusPresentation;
  handOver(): OutsideHandOver | null;
  handedOver(): void;
}

export function createOutsideLoginsSession(config: OutsideLoginsConfig, port?: OutsideLoginsPort, now: () => string = () => new Date().toISOString()): OutsideLoginsSession {
  const kinds = OUTSIDE_KINDS.filter((k) => config.permissions.includes(OUTSIDE_KIND_PERMISSION[k]));
  let rows: readonly OutsideLoginRow[] = [];
  let source: { kind: 'not_read' | 'checking' | 'lost_link' } | { kind: 'read'; at: string } | { kind: 'refused'; code: string; whatHappened: string } = { kind: 'not_read' };
  let pending: OutsideHandOver | null = null;
  const t = (lang: Lang, key: OutsideCopyKey): string => COPY[lang][key] ?? COPY.en[key];
  const why = (): 'nobody' | 'permission' | 'not_connected' | null =>
    config.userId === null ? 'nobody' : kinds.length === 0 ? 'permission' : port === undefined ? 'not_connected' : null;
  const nameOf = (inviteId: string): string => rows.find((r) => r.inviteId === inviteId)?.displayName ?? inviteId;
  const answer = (w: OutsideWrite, what: 'invited' | 'approved' | 'revoked' | 'signedIn', name: string): OutsideOutcome => {
    if (w.result === 'lost_link') return { kind: 'lost_link' };
    if (w.result === 'refused') return { kind: 'refused', code: w.code, whatHappened: w.whatHappened };
    if (w.oneTimePassword !== undefined) pending = { displayName: name, oneTimePassword: w.oneTimePassword };
    return { kind: 'done', what, name };
  };
  const refresh = async (): Promise<void> => {
    if (port === undefined || why() !== null) return;
    source = { kind: 'checking' };
    const all: OutsideLoginRow[] = [];
    for (const k of kinds) {
      const read = await port.list(k);
      if (read.result === 'lost_link') { source = { kind: 'lost_link' }; return; }
      if (read.result === 'refused') { source = { kind: 'refused', code: read.code, whatHappened: read.whatHappened }; return; }
      all.push(...read.logins);
    }
    rows = all.sort((a, b) => b.invitedAt.localeCompare(a.invitedAt));
    source = { kind: 'read', at: now() };
  };
  const guard = (): OutsideOutcome | null => {
    const w = why();
    return w === null ? null : { kind: 'refused_here', words: w === 'nobody' ? 'cannotNobody' : w === 'permission' ? 'cannotPermission' : 'sourceNotConnected' };
  };
  return {
    connected: port !== undefined,
    text: t,
    view: (lang) => {
      const w = why();
      const presentSource = (): StatusPresentation => {
        switch (source.kind) {
          case 'read': return presentStatus({ tone: 'ok', icon: '✓', label: fill(t(lang, 'sourceRead'), { at: shopTime(source.at) }), needsAttention: false });
          case 'lost_link': return presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'sourceLostLink') });
          case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t(lang, 'headOfficeSaid')} ${source.whatHappened}`.trim() });
          default: return port === undefined
            ? presentStatus({ tone: 'idle', icon: 'ℹ', label: t(lang, 'sourceNotConnected'), needsAttention: false })
            : presentStatus({ tone: 'idle', icon: '…', label: t(lang, 'sourceChecking'), needsAttention: false });
        }
      };
      return {
        source: presentSource(),
        listKnown: source.kind === 'read',
        kinds: w === null ? kinds : [],
        cannot: w === 'nobody' ? t(lang, 'cannotNobody') : w === 'permission' ? t(lang, 'cannotPermission') : w === 'not_connected' ? t(lang, 'sourceNotConnected') : null,
        rows: rows.map((r) => {
          const names = [`${t(lang, 'invitedBy')} ${r.invitedBy}`, ...(r.approvedBy === undefined ? [] : [`${t(lang, 'approvedBy')} ${r.approvedBy}`]),
            ...(r.rejectedBy === undefined ? [] : [`${t(lang, 'rejectedBy')} ${r.rejectedBy}`]), ...(r.revokedBy === undefined ? [] : [`${t(lang, 'revokedBy')} ${r.revokedBy}`])];
          return {
            inviteId: r.inviteId, kind: r.role, state: r.state,
            name: `${r.displayName} (${r.userId}) — ${t(lang, `kind_${r.role}`)} ${r.partyId}`,
            stateWords: t(lang, `state_${r.state}`),
            detail: `${names.join(' · ')} · ${shopTime(r.invitedAt)}`,
            // Never the inviter's own approval — head office refuses it too.
            mayApprove: r.state === 'invited' && config.userId !== null && r.invitedBy !== config.userId,
            mayRevoke: r.state === 'approved',
            maySignIn: r.state === 'approved',
          };
        }),
      };
    },
    refresh,
    invite: async (input) => {
      const g = guard(); if (g !== null) return g;
      if (!kinds.includes(input.kind)) return { kind: 'refused_here', words: 'cannotPermission' };
      const partyId = input.partyId.trim();
      const displayName = tidyPersonName(input.displayName);
      const userId = input.kind === 'customer' && input.userId.trim() === '' ? partyId : input.userId.trim();
      if (partyId === '') return { kind: 'refused_here', words: 'refuseParty' };
      if (!PRODUCT_ID.test(userId)) return { kind: 'refused_here', words: 'refuseUser' };
      if (!readablePersonName(displayName)) return { kind: 'refused_here', words: 'refuseName' };
      if (isGenericName(displayName) || isGenericName(userId)) return { kind: 'refused_here', words: 'refuseGeneric', name: isGenericName(displayName) ? displayName : userId };
      if (userId === config.userId) return { kind: 'refused_here', words: 'refuseYourself' };
      if (input.kind === 'b2b_customer' && input.grants.length === 0) return { kind: 'refused_here', words: 'refuseGrants' };
      const inviteId = `inv-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).slice(0, 18)}`;
      const w = await port!.invite(input.kind, partyId, inviteId, { userId, displayName, ...(input.kind === 'b2b_customer' ? { grants: input.grants } : {}) });
      const out = answer(w, 'invited', displayName);
      if (out.kind === 'done') await refresh();
      return out;
    },
    approve: async (kind, inviteId) => {
      const g = guard(); if (g !== null) return g;
      const out = answer(await port!.approve(kind, inviteId), 'approved', nameOf(inviteId));
      if (out.kind === 'done') await refresh();
      return out;
    },
    revoke: async (kind, inviteId, reason) => {
      const g = guard(); if (g !== null) return g;
      if (reason.trim() === '') return { kind: 'refused_here', words: 'refuseReason' };
      const out = answer(await port!.revoke(kind, inviteId, reason.trim()), 'revoked', nameOf(inviteId));
      if (out.kind === 'done') await refresh();
      return out;
    },
    signIn: async (kind, inviteId, signInName) => {
      const g = guard(); if (g !== null) return g;
      const name = signInName.trim().toLowerCase();
      if (!SIGN_IN_NAME.test(name)) return { kind: 'refused_here', words: 'refuseSignIn' };
      if (isGenericName(name)) return { kind: 'refused_here', words: 'refuseGeneric', name };
      return answer(await port!.signIn(kind, inviteId, name), 'signedIn', nameOf(inviteId));
    },
    present: (lang, o) => {
      switch (o.kind) {
        case 'done': return presentStatus({ tone: 'ok', icon: '✓', label: fill(t(lang, o.what), { name: o.name }), needsAttention: false });
        case 'refused_here': return presentStatus({ tone: 'error', icon: '✕', label: fill(t(lang, o.words), { name: o.name ?? '' }) });
        // Head office's own words, as it said them.
        case 'refused': return presentStatus({ tone: 'error', icon: '✕', label: `${t(lang, 'headOfficeSaid')} ${o.whatHappened}`.trim() });
        default: return presentStatus({ tone: 'degraded', icon: '!', label: t(lang, 'sourceLostLink') });
      }
    },
    handOver: () => pending,
    handedOver: () => { pending = null; },
  };
}
