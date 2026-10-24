// Appointment letters (addendum C17 "an appointment letter to every worker, kept as HR evidence"; OB-323, owner,
// 23 Oct 2026, in writing: "both — HR generates the letter from the employee record, and the signed scan is stored as
// HR evidence").
//
// Two halves, each a fact that is never edited:
//
//   • THE LETTER — generated from the employee's own record (name, staff id, the roles and the branch the staff list
//     gives them, their pay rate when the record holds one), the employer's legal name from the shop's GST registration,
//     the day the appointment takes effect, and the OWNER'S own wording. The wording is the owner's (a legal document's
//     words are not the software's to write): until he sets it the letter cannot be generated — "not set" — and every
//     letter keeps the wording version it was made with. The text is rendered once and FROZEN; a re-print is the same
//     bytes, never a re-render under newer wording.
//   • THE SIGNED SCAN — the worker's signed copy, photographed, kept as HR evidence beside the letter (its SHA-256 and
//     the bytes; never deleted, hard rule #6). The scan names the letter it signs.
//
// A placeholder the wording uses but the record does not hold refuses the letter and names the field — a letter with a
// blank where the pay should be is worse than no letter. Pure and deterministic.

export interface LetterWording {
  readonly version: number;
  /** The letter body in English and Tamil, with {{placeholders}} from `LETTER_FIELDS`. */
  readonly bodyEn: string;
  readonly bodyTa: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** The fields a letter may use. */
export const LETTER_FIELDS = Object.freeze(['employerName', 'employeeName', 'employeeId', 'roles', 'branch', 'effectiveFrom', 'hourlyRate', 'issuedOn'] as const);
export type LetterField = (typeof LETTER_FIELDS)[number];

export interface AppointmentLetter {
  readonly letterId: string;
  readonly employeeId: string;
  readonly wordingVersion: number;
  readonly effectiveFrom: string;
  readonly textEn: string;
  readonly textTa: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
}

export interface SignedScan {
  readonly letterId: string;
  readonly employeeId: string;
  readonly scanId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly keptBy: string;
  readonly keptAt: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** The placeholders a wording uses that are not letter fields — refused when the wording is set. */
export function unknownPlaceholders(text: string): readonly string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((f) => !(LETTER_FIELDS as readonly string[]).includes(f)))];
}

export type RenderOutcome =
  | { readonly ok: true; readonly textEn: string; readonly textTa: string }
  | { readonly ok: false; readonly missing: readonly LetterField[] };

/** Render the owner's wording with the record's values; any placeholder used with no value refuses, naming it. */
export function renderLetter(wording: Pick<LetterWording, 'bodyEn' | 'bodyTa'>, values: Partial<Record<LetterField, string>>): RenderOutcome {
  const used = new Set<LetterField>();
  for (const t of [wording.bodyEn, wording.bodyTa]) for (const m of t.matchAll(PLACEHOLDER)) used.add(m[1] as LetterField);
  const missing = [...used].filter((f) => values[f] === undefined || values[f]!.trim() === '').sort();
  if (missing.length > 0) return { ok: false, missing };
  const fill = (t: string): string => t.replace(PLACEHOLDER, (_all, f: string) => values[f as LetterField]!);
  return { ok: true, textEn: fill(wording.bodyEn), textTa: fill(wording.bodyTa) };
}

/** A pay rate as a letter prints it: rupees per hour, Indian grouping. */
export const hourlyRateWords = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per hour`;
