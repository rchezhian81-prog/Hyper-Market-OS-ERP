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
