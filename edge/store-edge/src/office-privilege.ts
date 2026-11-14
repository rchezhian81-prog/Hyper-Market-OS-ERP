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
// Adding a person from here (`person_provision`) needs a people register the store PC can write without an identity
// server: CR-01 step 4b. Until then it is refused in words and nothing is asked or relayed.

import { privilegeSealKey } from '../../../packages/identity/src/till-seal';
import { PRIVILEGE_VIA, sealPrivilegeRecord, type PrivilegeKind, type PrivilegeRecord } from '../../../packages/identity/src/privilege-seal';

export { privilegeSealKey };

/** The office screens' privilege doors (this PC's loopback only, behind the office PIN sign-in). */
export const PRIVILEGE_PATHS = Object.freeze({ people: '/office/privilege/people', grants: '/office/privilege/grants' });
/** Approve a pending request: /office/privilege/grants/<grantId>/approve. */
export const PRIVILEGE_APPROVE_PATH = /^\/office\/privilege\/grants\/([A-Za-z0-9._:-]{1,128})\/approve$/;
/** The box's own append-only record of every privilege act and refusal made on its office screens. */
export const PRIVILEGE_LOG = 'office-privilege.log';
/** Largest request a page may send for one privilege act. */
export const PRIVILEGE_BODY_MAX_BYTES = 8 * 1024;

/** The permission the person's own route requires — the authority their PIN is checked holding (ADR-0033 §2). */
export const PRIVILEGE_AUTHORITY: Readonly<Record<PrivilegeKind, string>> = Object.freeze({
  person_provision: 'platform.person.provision',
  role_request: 'identity.role.request',
  role_grant_approval: 'identity.role.grant',
});

/** Head office's box-relay route for each act (services/identity/src/box-privilege.ts). */
export function privilegeApiPath(kind: PrivilegeKind, grantId?: string): string {
  if (kind === 'person_provision') return '/v1/identity/box/people';
  if (kind === 'role_request') return '/v1/identity/box/grants';
  return `/v1/identity/box/grants/${encodeURIComponent(grantId ?? '')}/approve`;
}

/** Is this path one of the privilege doors? Which act, and (approve) which request. */
export function privilegeDoorOf(path: string): { readonly kind: PrivilegeKind; readonly grantId?: string } | undefined {
  if (path === PRIVILEGE_PATHS.people) return { kind: 'person_provision' };
  if (path === PRIVILEGE_PATHS.grants) return { kind: 'role_request' };
  const m = PRIVILEGE_APPROVE_PATH.exec(path);
  return m === null ? undefined : { kind: 'role_grant_approval', grantId: m[1]! };
}

export type PrivilegeRefusal = 'not_signed_in' | 'not_readable' | 'pin_not_confirmed' | 'not_set_up' | 'comes_in_step_4b'
  | 'head_office_refused' | 'head_office_unreachable' | 'not_recorded';

/** What the person reads, in both languages. "Nothing changed" is said wherever it is true. */
export const PRIVILEGE_WORDS: Readonly<Record<PrivilegeRefusal | 'role_requested' | 'role_granted', { readonly en: string; readonly ta: string }>> = Object.freeze({
  not_signed_in: { en: 'Your office sign-in has ended. Sign in again with your own PIN. Nothing changed.', ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. உங்கள் PIN-உடன் மீண்டும் உள்நுழையுங்கள். எதுவும் மாற்றப்படவில்லை.' },
  not_readable: { en: 'Type your PIN, and fill in who, which role and where. Nothing changed.', ta: 'உங்கள் PIN-ஐயும், யார், எந்தப் பணி, எங்கே என்பதையும் நிரப்புங்கள். எதுவும் மாற்றப்படவில்லை.' },
  pin_not_confirmed: { en: 'Your PIN was not confirmed, or your role does not include this. Nothing changed.', ta: 'உங்கள் PIN உறுதிசெய்யப்படவில்லை, அல்லது உங்கள் பணிக்கு இது இல்லை. எதுவும் மாற்றப்படவில்லை.' },
  not_set_up: { en: 'This store PC cannot make a privilege change yet: its privilege-seal key or its link to the office service is not set up. Run the store computer setup again. Nothing changed.', ta: 'இந்தக் கடைக் கணினியால் இன்னும் அனுமதி மாற்றம் செய்ய முடியாது: அதன் முத்திரை விசை அல்லது அலுவலகச் சேவை இணைப்பு அமைக்கப்படவில்லை. கடைக் கணினி அமைப்பை மீண்டும் இயக்குங்கள். எதுவும் மாற்றப்படவில்லை.' },
  comes_in_step_4b: { en: 'Adding a person on the store PC comes in the next step (4b). Nobody was added.', ta: 'கடைக் கணினியில் புதிய நபரைச் சேர்ப்பது அடுத்த படியில் (4b) வரும். யாரும் சேர்க்கப்படவில்லை.' },
  head_office_refused: { en: 'The office service refused this. Nothing changed.', ta: 'அலுவலகச் சேவை இதை மறுத்தது. எதுவும் மாற்றப்படவில்லை.' },
  head_office_unreachable: { en: 'The office service on this PC did not answer. Nothing changed. Try again in a minute.', ta: 'இந்தக் கணினியில் உள்ள அலுவலகச் சேவை பதில் அளிக்கவில்லை. எதுவும் மாற்றப்படவில்லை. ஒரு நிமிடம் கழித்து மீண்டும் முயலுங்கள்.' },
  not_recorded: { en: 'This could not be written down on this PC, so it was not done. Nothing changed.', ta: 'இதை இந்தக் கணினியில் பதிவு செய்ய முடியவில்லை, அதனால் செய்யப்படவில்லை. எதுவும் மாற்றப்படவில்லை.' },
  role_requested: { en: 'The role was asked for. A second person must approve it before it counts. The owner is told.', ta: 'பணி கேட்கப்பட்டது. அது செல்லுபடியாக இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும். உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
  role_granted: { en: 'Approved: the role is given. The owner is told.', ta: 'ஒப்புதல் அளிக்கப்பட்டது: பணி வழங்கப்பட்டது. உரிமையாளருக்குத் தெரிவிக்கப்படும்.' },
});

/** Head office's answer to one relay, or no answer at all. */
export type RelayAnswer = { readonly status: number; readonly body: unknown } | 'unreachable';

export interface PrivilegeDeps {
  readonly tenantId: string;
  /** The key from BOX_PRIVILEGE_SEAL_KEY (`privilegeSealKey`). Absent: nothing is sealed or relayed (not set up). */
  readonly sealKey: Buffer | undefined;
  /** POST to head office under the box's store token. Absent: no office service named (not set up). */
  readonly relay: ((path: string, body: unknown, idempotencyKey: string) => Promise<RelayAnswer>) | undefined;
  /** The person's own till PIN, by the till's PIN register (same guess limits), holding `authority`. */
  readonly verifyPin: (userId: string, pin: string, authority: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly laneMessage: string }>;
  /** Append one record to the box's privilege log, durably. Throws when it cannot. Never handed a PIN. */
  readonly record: (entry: Record<string, unknown>) => Promise<void>;
  readonly now: () => string;
  /** A fresh request id (a uuid). */
  readonly newRequestId: () => string;
}

export type PrivilegeAnswer =
  | { readonly ok: true; readonly kind: PrivilegeKind; readonly requestId: string; readonly en: string; readonly ta: string; readonly result: unknown }
  | { readonly ok: false; readonly refusedBecause: PrivilegeRefusal; readonly en: string; readonly ta: string; readonly code?: string; readonly detail?: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

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
  if (kind === 'person_provision') return refused(501, 'comes_in_step_4b');
  if (deps.sealKey === undefined || deps.relay === undefined) return refused(503, 'not_set_up');
  const pin = typeof input.pin === 'string' ? input.pin.trim() : '';
  const body: Record<string, unknown> | undefined = kind === 'role_grant_approval'
    ? (input.grantId === undefined || input.grantId === '' ? undefined : { grantId: input.grantId })
    : isObj(input.request) ? { ...input.request } : undefined;
  if (pin === '' || body === undefined) return refused(400, 'not_readable');

  // The PIN again, by the till's register, holding THIS act's own permission (ADR-0033 §2). Never kept.
  const who = await deps.verifyPin(person.userId, pin, PRIVILEGE_AUTHORITY[kind]);
  if (!who.ok) return refused(403, 'pin_not_confirmed', { detail: who.laneMessage });

  const record: PrivilegeRecord = {
    kind, tenantId: deps.tenantId, userId: person.userId, requestId: deps.newRequestId(), confirmedAt: deps.now(), via: PRIVILEGE_VIA, body,
  };
  // Written down BEFORE it is sent: who, which act, the request id (never the PIN). If it cannot be written, it is not sent.
  try {
    await deps.record({ kind: 'privilege_act', act: kind, at, userId: person.userId, outcome: 'sealed', requestId: record.requestId, ...(kind === 'role_grant_approval' ? { grantId: body['grantId'] } : { grantId: body['grantId'], roleId: body['roleId'], forUserId: body['userId'] }) });
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
  const words = kind === 'role_request' ? PRIVILEGE_WORDS.role_requested : PRIVILEGE_WORDS.role_granted;
  return { status: 200, answer: { ok: true, kind, requestId: record.requestId, ...words, result: answer.body } };
}
