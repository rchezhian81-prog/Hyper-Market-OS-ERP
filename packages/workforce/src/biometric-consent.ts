// C21 (R3, OB-138) — fingerprint attendance only after the person's OWN recorded consent for that purpose. Pure.
//
// Signed test sentence: "A person's fingerprint attendance is used only after their own recorded consent for that
// specific purpose. Anyone may refuse or withdraw consent and use the PIN method instead, with no other difference.
// Aadhaar is never required. Without consent, the fingerprint method is refused by name." (DPDP Act s.7.)
//
// The rule: consent is a sequence of the person's own decisions — given, refused, withdrawn — append-only, for ONE
// purpose (`attendance`). The latest decision decides. Only `given` lets the fingerprint method be used; refused,
// withdrawn or never asked leaves the PIN method, which is always available and records exactly the same attendance.
// No identity number of any kind (Aadhaar or other) is asked for, stored or needed. No fingerprint image or template is
// held by head office: an attendance mark carries only which METHOD was used.

export const BIOMETRIC_PURPOSE = 'attendance' as const;
export type ConsentDecision = 'given' | 'refused' | 'withdrawn';
export const CONSENT_DECISIONS: readonly ConsentDecision[] = Object.freeze(['given', 'refused', 'withdrawn']);
export type AttendanceMethod = 'fingerprint' | 'pin';
export const ATTENDANCE_METHODS: readonly AttendanceMethod[] = Object.freeze(['fingerprint', 'pin']);

export interface BiometricConsentEvent {
  readonly eventId: string;
  readonly employeeId: string;
  readonly purpose: typeof BIOMETRIC_PURPOSE;
  readonly decision: ConsentDecision;
  /** The version of the notice the person was shown when they decided. */
  readonly noticeRef: string;
  /** Always the person themself (the signed-in user) — never recorded for them by someone else. */
  readonly decidedBy: string;
  readonly at: string;
}

export type ConsentState = ConsentDecision | 'not_asked';

export function consentStateOf(events: readonly BiometricConsentEvent[], employeeId: string): { readonly state: ConsentState; readonly since: string | null; readonly history: readonly BiometricConsentEvent[] } {
  const mine = events.filter((e) => e.employeeId === employeeId && e.purpose === BIOMETRIC_PURPOSE).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const last = mine.at(-1);
  return { state: last?.decision ?? 'not_asked', since: last?.at ?? null, history: mine };
}

/** The methods a person may use now: PIN always; fingerprint only with consent given. */
export const methodsAllowed = (state: ConsentState): readonly AttendanceMethod[] => (state === 'given' ? ['fingerprint', 'pin'] : ['pin']);

/** Any field that carries an identity number this rule never asks for. */
export const IDENTITY_NUMBER_FIELD = /aadhaar|aadhar|uid(ai)?$|national_?id/i;
export const identityNumberFieldsIn = (body: unknown): readonly string[] =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as Record<string, unknown>).filter((k) => IDENTITY_NUMBER_FIELD.test(k)) : [];

// ── OB-197 "A" (owner, 18 Oct 2026, in writing, "We draft, you sign") ─────────────────────────────────────────────
// The consent notice (DPDP Act s.5 / s.6) is drafted for the owner and SIGNED by him before fingerprint attendance is used.
// So consent to the fingerprint method can be GIVEN only against a notice reference whose status is "signed by owner";
// until a notice is signed, the fingerprint method is refused by name (`consent_notice_not_signed`) and PIN works exactly
// as before. Refusing or withdrawing consent never needs a signed notice — saying no is always possible.

export const NOTICE_SIGNED_BY_OWNER = 'signed_by_owner' as const;

/** A consent notice the owner signed — recorded in his own sign-in, append-only, pointing at the signed document. */
export interface BiometricConsentNotice {
  readonly noticeRef: string;
  readonly status: typeof NOTICE_SIGNED_BY_OWNER;
  /** Where the signed notice is kept (the repository path of the draft he signed, or the scan of the signed paper). */
  readonly documentPath: string;
  readonly signedBy: string;
  readonly signedAt: string;
}

/** The notice references whose status is "signed by owner". */
export const signedNoticeRefs = (notices: readonly BiometricConsentNotice[]): ReadonlySet<string> =>
  new Set(notices.filter((n) => n.status === NOTICE_SIGNED_BY_OWNER).map((n) => n.noticeRef));

export type FingerprintVerdict =
  | { readonly allowed: true; readonly noticeRef: string }
  | { readonly allowed: false; readonly code: 'consent_notice_not_signed' | 'fingerprint_consent_not_given'; readonly detail: string };

/**
 * May this person use the fingerprint method now? Only when their latest decision is `given` AND it was given against a
 * notice the owner signed. With no signed notice behind it the answer is `consent_notice_not_signed`, whatever was
 * recorded — so a consent taken on an unsigned (draft) notice is never relied on.
 */
export function fingerprintVerdict(events: readonly BiometricConsentEvent[], employeeId: string, signed: ReadonlySet<string>): FingerprintVerdict {
  const s = consentStateOf(events, employeeId);
  const last = s.history.at(-1);
  if (s.state === 'given' && last !== undefined) {
    if (signed.has(last.noticeRef)) return { allowed: true, noticeRef: last.noticeRef };
    return { allowed: false, code: 'consent_notice_not_signed', detail: `${employeeId}'s consent was given on notice ${last.noticeRef}, which the owner has not signed` };
  }
  if (signed.size === 0) return { allowed: false, code: 'consent_notice_not_signed', detail: 'the owner has not yet signed the fingerprint-attendance consent notice, so fingerprint attendance is not in use' };
  return { allowed: false, code: 'fingerprint_consent_not_given', detail: `${employeeId} has ${s.state === 'not_asked' ? 'not given' : s.state} consent to fingerprint attendance` };
}

/** The methods a person may use now, the signed notice taken into account: PIN always; fingerprint only when allowed. */
export const methodsAllowedNow = (v: FingerprintVerdict): readonly AttendanceMethod[] => (v.allowed ? ['fingerprint', 'pin'] : ['pin']);
