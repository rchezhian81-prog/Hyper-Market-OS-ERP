// A PRIVILEGE CHANGE ON THE STORE PC'S OFFICE SCREENS, CONFIRMED BY PIN — CR-01 step 4a · OI-06 · ADR-0033 · OB-731 "A" ·
// OB-732 "B" · §28 · P-04 · P-07 · P-08 · hard rules #4, #5, #10.
//
// On a store PC with no identity server (the head-office link OFF), a person signed in on the office screens with their own
// staff ID and PIN (office-sign-in.ts) may ask for a role for somebody else, or approve a request somebody else made — each
// confirmed by typing their PIN AGAIN:
//
//   • the PIN is checked by the till's own PIN register (`verifyPerson`, the same guess limits), holding the ROUTE's own
//     permission — `identity.role.request` to ask, `identity.role.grant` to approve — never only "signed in";
//   • the PIN is never kept: not in the record, not in the log, not in what is relayed;
//   • the box NEVER mints a token (ADR-0029 §1). It seals a decision record — which act, this shop, the person, the exact
//     request, a fresh request id, the moment the PIN was confirmed — with the DEDICATED privilege-seal key (OB-732 "B"),
//     and relays it under its store token to head office's box-relay routes, which check the seal, refuse a stale or reused
//     one, and run the person's own checks as that person (services/identity/src/box-privilege.ts);
//   • every act and every refusal is written, before the answer, to this box's own append-only log (who, which act, the
//     request id, the outcome — never a PIN); head office's answer is said in plain words, in English and Tamil.
//
// CR-01 step 4b-1 (OB-733 "A" · OB-735 · ADR-0033 amended): adding a STORE-PC PERSON (`person_provision` — a name and staff
// id, no sign-in anywhere; one person, the maker's authority `identity.role.request`, by PIN) and turning a pending request
// down (`role_grant_rejection`, `identity.role.grant`, a reason) go the same way. The page's lists — the roles, who holds
// what at this store, what waits — are READ through the box too (`officeUsersView`): head office judges the signed-in
// person's own authority and answers for this store only. A read asks for no PIN and changes nothing.

import { privilegeSealKey } from '../../../packages/identity/src/till-seal';
import { PRIVILEGE_VIA, sealPrivilegeRecord, type PrivilegeKind, type PrivilegeRecord } from '../../../packages/identity/src/privilege-seal';

export { privilegeSealKey };

/** The office screens' privilege doors (this PC's loopback only, behind the office PIN sign-in). */
export const PRIVILEGE_PATHS = Object.freeze({
  people: '/office/privilege/people', grants: '/office/privilege/grants', view: '/office/privilege/users-view',
  /** CR-01 step 4b-2. */
  accessChanges: '/office/privilege/access-changes', tillPins: '/office/privilege/till-pins',
});
/** Decide a take-back: /office/privilege/access-changes/<approvalId>/decide (CR-01 step 4b-2). */
export const PRIVILEGE_DECIDE_PATH = /^\/office\/privilege\/access-changes\/([A-Za-z0-9._:-]{1,128})\/decide$/;
/** Approve a pending request: /office/privilege/grants/<grantId>/approve. */
export const PRIVILEGE_APPROVE_PATH = /^\/office\/privilege\/grants\/([A-Za-z0-9._:-]{1,128})\/approve$/;
/** Turn a pending request down: /office/privilege/grants/<grantId>/reject (CR-01 step 4b-1). */
export const PRIVILEGE_REJECT_PATH = /^\/office\/privilege\/grants\/([A-Za-z0-9._:-]{1,128})\/reject$/;
/** The longest reason a rejection carries. */
export const REJECT_REASON_MAX = 300;
/** The box's own append-only record of every privilege act and refusal made on its office screens. */
export const PRIVILEGE_LOG = 'office-privilege.log';
/** Largest request a page may send for one privilege act. */
export const PRIVILEGE_BODY_MAX_BYTES = 8 * 1024;

/** The permission the person's own route requires — the authority their PIN is checked holding (ADR-0033 §2). */
export const PRIVILEGE_AUTHORITY: Readonly<Record<PrivilegeKind, string>> = Object.freeze({
  // OB-733 "A": the maker's word adds a store-PC person (the owner, the store manager) — the name alone gives no authority.
  person_provision: 'identity.role.request',
  role_request: 'identity.role.request',
  role_grant_approval: 'identity.role.grant',
  role_grant_rejection: 'identity.role.grant',
  access_change_request: 'identity.role.request',
  access_change_decision: 'identity.role.grant',
  // Somebody else's PIN: the maker's word (and head office refuses reaching above yourself, OB-737). Your own: see `pinAuthority`.
  till_pin_change: 'identity.role.request',
});
/** Changing your OWN till PIN needs only that you are you — your current PIN, as at the office sign-in. */
export const OWN_PIN_AUTHORITY = 'identity.self.read';

/** Head office's box-relay route for each act (services/identity/src/box-privilege.ts). */
export function privilegeApiPath(kind: PrivilegeKind, grantId?: string): string {
  if (kind === 'person_provision') return '/v1/identity/box/people';
  if (kind === 'role_request') return '/v1/identity/box/grants';
  if (kind === 'role_grant_rejection') return `/v1/identity/box/grants/${encodeURIComponent(grantId ?? '')}/reject`;
  if (kind === 'access_change_request') return '/v1/identity/box/access-changes';
  if (kind === 'access_change_decision') return `/v1/identity/box/access-changes/${encodeURIComponent(grantId ?? '')}/decide`;
  if (kind === 'till_pin_change') return '/v1/identity/box/till-pins';
  return `/v1/identity/box/grants/${encodeURIComponent(grantId ?? '')}/approve`;
}

/** Head office's read for the Users & roles page, for the person signed in on the office screens. */
export const usersViewApiPath = (userId: string): string => `/v1/identity/box/users-view?for=${encodeURIComponent(userId)}`;

/** Is this path one of the privilege doors? Which act, and (approve) which request. */
export function privilegeDoorOf(path: string): { readonly kind: PrivilegeKind; readonly grantId?: string } | undefined {
  if (path === PRIVILEGE_PATHS.people) return { kind: 'person_provision' };
  if (path === PRIVILEGE_PATHS.grants) return { kind: 'role_request' };
  if (path === PRIVILEGE_PATHS.accessChanges) return { kind: 'access_change_request' };
  if (path === PRIVILEGE_PATHS.tillPins) return { kind: 'till_pin_change' };
  const d = PRIVILEGE_DECIDE_PATH.exec(path);
  if (d !== null) return { kind: 'access_change_decision', grantId: d[1]! };
  const m = PRIVILEGE_APPROVE_PATH.exec(path);
  if (m !== null) return { kind: 'role_grant_approval', grantId: m[1]! };
  const r = PRIVILEGE_REJECT_PATH.exec(path);
  return r === null ? undefined : { kind: 'role_grant_rejection', grantId: r[1]! };
}

export type PrivilegeRefusal = 'not_signed_in' | 'not_readable' | 'pin_not_confirmed' | 'not_set_up'
  | 'head_office_refused' | 'head_office_unreachable' | 'not_recorded'
  /** CR-01 step 4b-2: the new PIN is not six digits, or the two do not match. */
  | 'new_pin_not_readable'
  /** CR-01 step 4b-2: head office recorded it, but this PC could not write the PIN — said, never shown as done. */
  | 'pin_not_saved_here';

/** What the person reads, in both languages. "Nothing changed" is said wherever it is true. */
export const PRIVILEGE_WORDS: Readonly<Record<PrivilegeRefusal | 'role_requested' | 'role_granted' | 'person_added' | 'role_rejected'
  | 'take_back_asked' | 'take_back_done' | 'take_back_rejected' | 'take_back_not_applied' | 'pin_set' | 'pin_cancelled' | 'pin_changed_own', { readonly en: string; readonly ta: string }>> = Object.freeze({
  not_signed_in: { en: 'Your office sign-in has ended. Sign in again with your own PIN. Nothing changed.', ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. உங்கள் PIN-உடன் மீண்டும் உள்நுழையுங்கள். எதுவும் மாற்றப்படவில்லை.' },
  not_readable: { en: 'Type your PIN, and fill in every box (who, which role, where — or the name and staff id, or the reason). Nothing changed.', ta: 'உங்கள் PIN-ஐ உள்ளிட்டு, எல்லாப் பெட்டிகளையும் நிரப்புங்கள் (யார், எந்தப் பணி, எங்கே — அல்லது பெயர், பணியாளர் எண், அல்லது காரணம்). எதுவும் மாற்றப்படவில்லை.' },
  pin_not_confirmed: { en: 'Your PIN was not confirmed, or your role does not include this. Nothing changed.', ta: 'உங்கள் PIN உறுதிசெய்யப்படவில்லை, அல்லது உங்கள் பணிக்கு இது இல்லை. எதுவும் மாற்றப்படவில்லை.' },
  not_set_up: { en: 'This store PC cannot make a privilege change yet: its privilege-seal key or its link to the office service is not set up. Run the store computer setup again. Nothing changed.', ta: 'இந்தக் கடைக் கணினியால் இன்னும் அனுமதி மாற்றம் செய்ய முடியாது: அதன் முத்திரை விசை அல்லது அலுவலகச் சேவை இணைப்பு அமைக்கப்படவில்லை. கடைக் கணினி அமைப்பை மீண்டும் இயக்குங்கள். எதுவும் மாற்றப்படவில்லை.' },
  head_office_refused: { en: 'The office service refused this. Nothing changed.', ta: 'அலுவலகச் சேவை இதை மறுத்தது. எதுவும் மாற்றப்படவில்லை.' },
  head_office_unreachable: { en: 'The office service on this PC did not answer. Nothing changed. Try again in a minute.', ta: 'இந்தக் கணினியில் உள்ள அலுவலகச் சேவை பதில் அளிக்கவில்லை. எதுவும் மாற்றப்படவில்லை. ஒரு நிமிடம் கழித்து மீண்டும் முயலுங்கள்.' },
  not_recorded: { en: 'This could not be written down on this PC, so it was not done. Nothing changed.', ta: 'இதை இந்தக் கணினியில் பதிவு செய்ய முடியவில்லை, அதனால் செய்யப்படவில்லை. எதுவும் மாற்றப்படவில்லை.' },
  role_requested: { en: 'The role was asked for. A second person must approve it before it counts. The owner is told.', ta: 'பணி கேட்கப்பட்டது. அது செல்லுபடியாக இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும். உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  role_granted: { en: 'Approved: the role is given. The owner is told.', ta: 'ஒப்புதல் அளிக்கப்பட்டது: பணி வழங்கப்பட்டது. உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  person_added: { en: 'The person is added, for this store PC only. They can do nothing yet: ask for a role for them (a second person approves), then set their till PIN. The owner is told.', ta: 'நபர் சேர்க்கப்பட்டார், இந்தக் கடைக் கணினிக்கு மட்டும். அவரால் இன்னும் எதுவும் செய்ய முடியாது: அவருக்குப் பணி கேளுங்கள் (இரண்டாவது நபர் ஒப்புதல் தருவார்), பிறகு அவரது PIN-ஐ அமையுங்கள். உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  role_rejected: { en: 'Rejected: the role is not given. The request stays on record.', ta: 'மறுக்கப்பட்டது: பணி வழங்கப்படவில்லை. கோரிக்கை பதிவில் இருக்கும்.' },
  new_pin_not_readable: { en: 'The new PIN must be 6 digits, typed the same twice. Nothing changed.', ta: 'புதிய PIN 6 இலக்கங்களாக, இருமுறை ஒரே மாதிரி உள்ளிடப்பட வேண்டும். எதுவும் மாற்றப்படவில்லை.' },
  pin_not_saved_here: { en: 'The office service recorded it, but this PC could not save the PIN, so the tills did not change. Try again; if it happens again, call the administrator.', ta: 'அலுவலகச் சேவை இதைப் பதிவு செய்தது, ஆனால் இந்தக் கணினியால் PIN-ஐச் சேமிக்க முடியவில்லை, எனவே கவுண்டர்களில் எதுவும் மாறவில்லை. மீண்டும் முயலுங்கள்; மீண்டும் நடந்தால் நிர்வாகியை அழையுங்கள்.' },
  take_back_asked: { en: 'Asked. A second person must approve it on this page, with their PIN; then it is done at once. The owner is told.', ta: 'கேட்கப்பட்டது. இரண்டாவது நபர் இந்தப் பக்கத்தில் தன் PIN-உடன் ஒப்புதல் தர வேண்டும்; பிறகு உடனே நடக்கும். உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  take_back_done: { en: 'Approved and done: the role is taken back. For a person who left, every role is taken back and their till PIN no longer works. The owner is told.', ta: 'ஒப்புதல் அளிக்கப்பட்டு முடிந்தது: பணி திரும்பப் பெறப்பட்டது. வெளியேறியவருக்கு எல்லாப் பணிகளும் திரும்பப் பெறப்பட்டு, அவரது PIN இனி வேலை செய்யாது. உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  take_back_rejected: { en: 'Rejected: nobody\'s access changed. The request stays on record.', ta: 'மறுக்கப்பட்டது: யாருடைய அணுகலும் மாறவில்லை. கோரிக்கை பதிவில் இருக்கும்.' },
  take_back_not_applied: { en: 'Approved, but the office service did not apply it — read its words below. Nobody\'s access changed yet.', ta: 'ஒப்புதல் அளிக்கப்பட்டது, ஆனால் அலுவலகச் சேவை அதைச் செயல்படுத்தவில்லை — கீழே அதன் சொற்களைப் படியுங்கள். இன்னும் யாருடைய அணுகலும் மாறவில்லை.' },
  pin_set: { en: 'The new till PIN is set. It works at the tills and the office screens now; the old one has stopped. The owner is told.', ta: 'புதிய PIN அமைக்கப்பட்டது. இது இப்போது கவுண்டர்களிலும் அலுவலகத் திரைகளிலும் வேலை செய்யும்; பழையது நின்றுவிட்டது. உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  pin_cancelled: { en: 'The till PIN is cancelled. They cannot sign in at a till or the office screens until a new one is set. The owner is told.', ta: 'PIN ரத்து செய்யப்பட்டது. புதியது அமைக்கப்படும் வரை அவர் கவுண்டரிலோ அலுவலகத் திரைகளிலோ உள்நுழைய முடியாது. உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  pin_changed_own: { en: 'Your till PIN is changed. Use the new one from now on.', ta: 'உங்கள் PIN மாற்றப்பட்டது. இனி புதியதைப் பயன்படுத்துங்கள்.' },
});

/** Head office's answer to one relay, or no answer at all. */
export type RelayAnswer = { readonly status: number; readonly body: unknown } | 'unreachable';

export interface PrivilegeDeps {
  readonly tenantId: string;
  /** The key from BOX_PRIVILEGE_SEAL_KEY (`privilegeSealKey`). Absent: nothing is sealed or relayed (not set up). */
  readonly sealKey: Buffer | undefined;
  /** POST to head office under the box's store token. Absent: no office service named (not set up). */
  readonly relay: ((path: string, body: unknown, idempotencyKey: string) => Promise<RelayAnswer>) | undefined;
  /** GET from head office under the box's store token (CR-01 step 4b-1, the page's lists). Absent: the lists are not read. */
  readonly read?: ((path: string) => Promise<RelayAnswer>) | undefined;
  /** The person's own till PIN, by the till's PIN register (same guess limits), holding `authority`. */
  readonly verifyPin: (userId: string, pin: string, authority: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly laneMessage: string }>;
  /** Append one record to the box's privilege log, durably. Throws when it cannot. Never handed a PIN. */
  readonly record: (entry: Record<string, unknown>) => Promise<void>;
  readonly now: () => string;
  /** A fresh request id (a uuid). */
  readonly newRequestId: () => string;
  /**
   * CR-01 step 4b-2: write a till PIN on THIS box — the new PIN's fingerprint (`pin`), or a cancellation (`null`) — to the
   * till-credentials file the tills and the office sign-in read. Throws when it cannot. Absent: no PIN is set from screens.
   */
  readonly writeTillPin?: (userId: string, pin: string | null, by: string) => Promise<void>;
}

export type PrivilegeAnswer =
  | { readonly ok: true; readonly kind: PrivilegeKind; readonly requestId: string; readonly en: string; readonly ta: string; readonly result: unknown }
  | { readonly ok: false; readonly refusedBecause: PrivilegeRefusal; readonly en: string; readonly ta: string; readonly code?: string; readonly detail?: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A take-back as the page sends it: exactly { requestId, event, userId, reason, grants } — anything else is not read. */
function takeBackBody(raw: unknown): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined;
  const { requestId, event, userId, reason, grants } = raw;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) return undefined;
  if ((event !== 'mover' && event !== 'leaver') || typeof userId !== 'string' || userId.trim() === '') return undefined;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > REJECT_REASON_MAX || !Array.isArray(grants)) return undefined;
  const g = grants.filter((x): x is Record<string, unknown> => isObj(x) && typeof x['userId'] === 'string' && typeof x['roleId'] === 'string')
    .map((x) => ({ userId: x['userId'], roleId: x['roleId'], branchScope: x['branchScope'] === 'all' ? 'all' : Array.isArray(x['branchScope']) ? (x['branchScope'] as unknown[]).map(String) : [] }));
  if (g.length !== grants.length || (event === 'leaver' && g.length > 0) || (event === 'mover' && g.length === 0)) return undefined;
  return { requestId, event, userId: userId.trim(), reason: reason.trim(), grants: g };
}

/** A till PIN act as sealed: { userId, action } only — the new PIN is NEVER in it. Your own PIN names you. */
function pinBody(raw: unknown, actingUserId: string): Record<string, unknown> | undefined {
  if (!isObj(raw) || (raw['action'] !== 'set' && raw['action'] !== 'cancel' && raw['action'] !== 'own')) return undefined;
  if (raw['action'] === 'own') return { userId: actingUserId, action: 'own' };
  const userId = typeof raw['userId'] === 'string' ? raw['userId'].trim().toLowerCase() : '';
  return userId === '' ? undefined : { userId, action: raw['action'] };
}

/**
 * One privilege act from the office screen: `person` is who the office sign-in says is at the screen (null: nobody);
 * `input.pin` their PIN typed again; `input.request` the request their own route would take (for an approval, nothing —
 * the request is named by `grantId`). Returns the HTTP status and the answer the page shows.
 */
export async function privilegeAct(
  deps: PrivilegeDeps, kind: PrivilegeKind, person: { readonly userId: string } | null,
  input: { readonly pin: unknown; readonly request: unknown; readonly grantId?: string },
): Promise<{ readonly status: number; readonly answer: PrivilegeAnswer }> {
  const at = deps.now();
  const refused = async (status: number, why: PrivilegeRefusal, extra: { requestId?: string; code?: string; detail?: string } = {}) => {
    try {
      await deps.record({ kind: 'privilege_act', act: kind, at, userId: person?.userId ?? '(nobody)', outcome: `refused:${why}`, ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }), ...(extra.code === undefined ? {} : { code: extra.code }) });
    } catch { /* the refusal is still said; nothing was done */ }
    return { status, answer: { ok: false as const, refusedBecause: why, ...PRIVILEGE_WORDS[why], ...(extra.code === undefined ? {} : { code: extra.code }), ...(extra.detail === undefined ? {} : { detail: extra.detail }) } };
  };
  if (person === null) return refused(401, 'not_signed_in');
  if (deps.sealKey === undefined || deps.relay === undefined) return refused(503, 'not_set_up');
  const pin = typeof input.pin === 'string' ? input.pin.trim() : '';
  const grantId = input.grantId === undefined || input.grantId === '' ? undefined : input.grantId;
  const reason = isObj(input.request) && typeof input.request['reason'] === 'string' ? input.request['reason'].trim() : '';
  const body: Record<string, unknown> | undefined = kind === 'role_grant_approval'
    ? (grantId === undefined ? undefined : { grantId })
    : kind === 'role_grant_rejection'
      ? (grantId === undefined || reason === '' || reason.length > REJECT_REASON_MAX ? undefined : { grantId, reason })
      : kind === 'person_provision'
        ? (isObj(input.request) && typeof input.request['userId'] === 'string' && typeof input.request['displayName'] === 'string'
          ? { userId: input.request['userId'].trim().toLowerCase(), displayName: input.request['displayName'].trim() } : undefined)
        : kind === 'access_change_request' ? takeBackBody(input.request)
          : kind === 'access_change_decision'
            ? (grantId === undefined || reason === '' || reason.length > REJECT_REASON_MAX || !isObj(input.request) || (input.request['decision'] !== 'approved' && input.request['decision'] !== 'rejected')
              ? undefined : { approvalId: grantId, decision: input.request['decision'], reason })
            // A till PIN act is sealed as { userId, action } ONLY — the new PIN never leaves this box.
            : kind === 'till_pin_change' ? pinBody(input.request, person.userId)
              : kind === 'role_request' && isObj(input.request) ? { ...input.request } : undefined;
  if (pin === '' || body === undefined) return refused(400, 'not_readable');
  // A till PIN act: this box must be able to write it, and a new PIN must be six digits, the same twice (never sealed).
  const newPin = kind === 'till_pin_change' && body['action'] !== 'cancel' && isObj(input.request) ? input.request['newPin'] : undefined;
  if (kind === 'till_pin_change') {
    if (deps.writeTillPin === undefined) return refused(503, 'not_set_up');
    if (body['action'] !== 'cancel' && (typeof newPin !== 'string' || !/^[0-9]{6}$/.test(newPin) || !isObj(input.request) || input.request['newPinAgain'] !== newPin)) return refused(400, 'new_pin_not_readable');
  }

  // The PIN again, by the till's register, holding THIS act's own permission (ADR-0033 §2). Never kept. Your OWN PIN:
  // your current PIN, as at the office sign-in.
  const who = await deps.verifyPin(person.userId, pin, kind === 'till_pin_change' && body['action'] === 'own' ? OWN_PIN_AUTHORITY : PRIVILEGE_AUTHORITY[kind]);
  if (!who.ok) return refused(403, 'pin_not_confirmed', { detail: who.laneMessage });

  const record: PrivilegeRecord = {
    kind, tenantId: deps.tenantId, userId: person.userId, requestId: deps.newRequestId(), confirmedAt: deps.now(), via: PRIVILEGE_VIA, body,
  };
  // Written down BEFORE it is sent: who, which act, the request id (never the PIN). If it cannot be written, it is not sent.
  try {
    await deps.record({ kind: 'privilege_act', act: kind, at, userId: person.userId, outcome: 'sealed', requestId: record.requestId,
      ...(kind === 'role_grant_approval' || kind === 'role_grant_rejection' ? { grantId: body['grantId'] }
        : kind === 'person_provision' ? { forUserId: body['userId'], displayName: body['displayName'] }
          : kind === 'access_change_request' ? { forUserId: body['userId'], event: body['event'] }
            : kind === 'access_change_decision' ? { approvalId: body['approvalId'], decision: body['decision'] }
              : kind === 'till_pin_change' ? { forUserId: body['userId'], pinAction: body['action'] }
                : { grantId: body['grantId'], roleId: body['roleId'], forUserId: body['userId'] }) });
  } catch {
    return { status: 503, answer: { ok: false, refusedBecause: 'not_recorded', ...PRIVILEGE_WORDS.not_recorded } };
  }
  const sealed = sealPrivilegeRecord(deps.sealKey, record);
  const answer = await deps.relay(privilegeApiPath(kind, input.grantId), sealed, record.requestId);
  if (answer === 'unreachable') return refused(503, 'head_office_unreachable', { requestId: record.requestId });
  if (answer.status >= 400) {
    const err = isObj(answer.body) && isObj(answer.body['error']) ? answer.body['error'] : {};
    const code = typeof err['code'] === 'string' ? err['code'] : String(answer.status);
    const said = typeof err['whatHappened'] === 'string' ? err['whatHappened'] : undefined;
    // head office's 401 is the BOX's credential, never the person's sign-in: said as a refusal, not as "sign in again".
    const out = await refused(answer.status === 401 ? 502 : answer.status, 'head_office_refused', { requestId: record.requestId, code, ...(said === undefined ? {} : { detail: said }) });
    return said === undefined ? out : { status: out.status, answer: { ...out.answer, en: `${PRIVILEGE_WORDS.head_office_refused.en} ${said}` } };
  }
  try {
    await deps.record({ kind: 'privilege_act', act: kind, at: deps.now(), userId: person.userId, outcome: 'accepted', requestId: record.requestId, status: answer.status });
  } catch { /* head office has it; the box's own line is best effort after the fact */ }
  // CR-01 step 4b-2: what this box does itself once head office has it — a till PIN written, or a leaver's cancelled.
  const result = isObj(answer.body) ? answer.body : {};
  const pinToWrite: { readonly userId: string; readonly pin: string | null } | undefined = kind === 'till_pin_change'
    ? { userId: String(body['userId']), pin: body['action'] === 'cancel' ? null : String(newPin) }
    : kind === 'access_change_decision' && typeof result['tillPinToCancel'] === 'string' ? { userId: result['tillPinToCancel'], pin: null } : undefined;
  if (pinToWrite !== undefined) {
    try {
      await deps.writeTillPin!(pinToWrite.userId, pinToWrite.pin, person.userId);
      try { await deps.record({ kind: 'privilege_act', act: kind, at: deps.now(), userId: person.userId, outcome: pinToWrite.pin === null ? 'pin_cancelled_here' : 'pin_written_here', requestId: record.requestId, forUserId: pinToWrite.userId }); } catch { /* best effort */ }
    } catch {
      return refused(503, 'pin_not_saved_here', { requestId: record.requestId });
    }
  }
  if (kind === 'access_change_decision' && body['decision'] === 'approved' && result['applied'] !== true) {
    const said = isObj(result['result']) && Array.isArray(result['result']['blockers']) ? (result['result']['blockers'] as unknown[]).map(String).join('; ') : '';
    return { status: 200, answer: { ok: true, kind, requestId: record.requestId, en: `${PRIVILEGE_WORDS.take_back_not_applied.en}${said === '' ? '' : ` ${said}`}`, ta: PRIVILEGE_WORDS.take_back_not_applied.ta, result: answer.body } };
  }
  if (kind === 'access_change_request' || kind === 'access_change_decision' || kind === 'till_pin_change') {
    const w = kind === 'access_change_request' ? PRIVILEGE_WORDS.take_back_asked
      : kind === 'access_change_decision' ? (body['decision'] === 'approved' ? PRIVILEGE_WORDS.take_back_done : PRIVILEGE_WORDS.take_back_rejected)
        : body['action'] === 'cancel' ? PRIVILEGE_WORDS.pin_cancelled : body['action'] === 'own' ? PRIVILEGE_WORDS.pin_changed_own : PRIVILEGE_WORDS.pin_set;
    return { status: 200, answer: { ok: true, kind, requestId: record.requestId, ...w, result: answer.body } };
  }
  const words = kind === 'role_request' ? PRIVILEGE_WORDS.role_requested : kind === 'person_provision' ? PRIVILEGE_WORDS.person_added
    : kind === 'role_grant_rejection' ? PRIVILEGE_WORDS.role_rejected : PRIVILEGE_WORDS.role_granted;
  return { status: 200, answer: { ok: true, kind, requestId: record.requestId, ...words, result: answer.body } };
}

/**
 * CR-01 step 4b-1: the Users & roles page's lists for the person signed in on the office screens (`person`; null: nobody),
 * read from head office under the box's store token. Head office answers with what THAT person may see, at this store only.
 * Asks for no PIN, seals nothing, changes nothing; head office's refusal or silence is said, never shown as an empty list.
 */
export async function officeUsersView(deps: Pick<PrivilegeDeps, 'read'>, person: { readonly userId: string } | null): Promise<{ readonly status: number; readonly answer: Record<string, unknown> }> {
  if (person === null) return { status: 401, answer: { ok: false, refusedBecause: 'not_signed_in', ...PRIVILEGE_WORDS.not_signed_in } };
  if (deps.read === undefined) return { status: 503, answer: { ok: false, refusedBecause: 'not_set_up', ...PRIVILEGE_WORDS.not_set_up } };
  const answer = await deps.read(usersViewApiPath(person.userId));
  if (answer === 'unreachable') return { status: 503, answer: { ok: false, refusedBecause: 'head_office_unreachable', ...PRIVILEGE_WORDS.head_office_unreachable } };
  if (answer.status >= 400 || !isObj(answer.body)) {
    const err = isObj(answer.body) && isObj(answer.body['error']) ? answer.body['error'] : {};
    return { status: answer.status === 401 ? 502 : answer.status >= 400 ? answer.status : 502, answer: { ok: false, refusedBecause: 'head_office_refused', ...PRIVILEGE_WORDS.head_office_refused, ...(typeof err['code'] === 'string' ? { code: err['code'] } : {}) } };
  }
  return { status: 200, answer: { ok: true, ...answer.body } };
}
