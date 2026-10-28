// Alert words in English AND Tamil (owner decisions OB-435 and OB-439, 28 Oct 2026, in writing).
//
// Every operational alert used to be written as one English sentence at the moment it was raised, and that sentence was
// stored on the alert fact. The screens are bilingual, so an alert was the one thing on them still in English only, and a
// text message to a Tamil-reading manager came in English too.
//
// The rule now (the same shape as `packages/orders/src/substitution-messages.ts` and `packages/ui`'s translator):
//
//   • an alert's words are STRUCTURED — a kind (which sentence) and its parameters (the store, the minutes, the bill
//     numbers…) — `AlertText`. Each kind has an English and a Tamil template (`alert-words.ts`, and the guardrail
//     `tests/guardrails/every-alert-kind-has-a-tamil-twin.test.ts` fails the build if one is missing or blank);
//   • the English sentence is still kept on the fact as `detail`, rendered from the same template, word for word what it
//     was before — so every reader that knew the English keeps reading it, and an old alert (stored before this, with no
//     `text`) still reads in English, exactly as it was recorded (hard rule #2: old facts are never rewritten);
//   • a parameter that is free text from outside (an operator's note, a till's own device message, an error a machine
//     reported) is kept VERBATIM in both languages; only the frame around it is translated;
//   • a parameter may itself be an `AlertText` (one sentence inside another): it is rendered in the same language.
//
// Pure: no clock, no I/O. Nothing here decides anything — it only says what was already decided, in two languages.

/** The two languages the product ships in (mirrors `packages/ui` `Lang`; kept local so ops does not depend on the UI). */
export type AlertLang = 'en' | 'ta';
export const ALERT_LANGS: readonly AlertLang[] = ['en', 'ta'];

/** One parameter of an alert sentence: a value, a nested sentence, or a list of them. */
export type AlertParam = string | number | boolean | null | AlertText | readonly (string | number | AlertText)[];

/** An alert sentence, structured: which sentence (`kind`) and what goes in it. */
export interface AlertText {
  readonly kind: string;
  readonly params?: Readonly<Record<string, AlertParam>>;
}

/** A parameter as a template sees it — every nested sentence already rendered in the template's language. */
export type Shown = string | number | boolean | null | readonly string[];
export type ShownParams = Readonly<Record<string, Shown>>;

/** One alert sentence in both languages, with the parameters a test renders it with (the guardrail renders every one). */
export interface AlertTemplate {
  readonly en: (p: ShownParams) => string;
  readonly ta: (p: ShownParams) => string;
  readonly sample: Readonly<Record<string, AlertParam>>;
}

export type AlertTemplates = Readonly<Record<string, AlertTemplate>>;

// ── Small readers the templates use (a missing parameter reads as nothing, never as "undefined") ────────────────────
export const s = (v: Shown | undefined): string => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v));
export const n = (v: Shown | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
export const b = (v: Shown | undefined): boolean => v === true;
export const l = (v: Shown | undefined): readonly string[] => (Array.isArray(v) ? (v as readonly string[]) : v === undefined || v === null || v === '' ? [] : [String(v)]);
/** A parameter that may be absent (null / undefined): `undefined` then, else its words. */
export const opt = (v: Shown | undefined): string | undefined => (v === undefined || v === null ? undefined : s(v));

/** Is this a structured alert sentence? */
export function isAlertText(v: unknown): v is AlertText {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { kind?: unknown }).kind === 'string';
}

/** An alert kind no template knows (a programming error at raise time; at read time the recorded English is shown). */
export class UnknownAlertKindError extends Error {
  constructor(readonly kind: string) {
    super(`no alert words for kind ${kind}`);
    this.name = 'UnknownAlertKindError';
  }
}

/**
 * Render one alert sentence in a language, with the given templates. Tamil falls back to English rather than a blank
 * (the guardrail makes sure that never happens, but a screen must never show nothing).
 */
export function renderWith(templates: AlertTemplates, text: AlertText, lang: AlertLang): string {
  const t = templates[text.kind];
  if (t === undefined) throw new UnknownAlertKindError(text.kind);
  const shown: Record<string, Shown> = {};
  for (const [k, v] of Object.entries(text.params ?? {})) shown[k] = showParam(templates, v, lang);
  const out = t[lang](shown);
  return out.trim() === '' ? t.en(shown) : out;
}

function showParam(templates: AlertTemplates, v: AlertParam, lang: AlertLang): Shown {
  if (isAlertText(v)) return renderWith(templates, v, lang);
  if (Array.isArray(v)) return (v as readonly (string | number | AlertText)[]).map((x) => (isAlertText(x) ? renderWith(templates, x, lang) : String(x)));
  return v as Shown;
}
