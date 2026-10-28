// OB-435 · OB-439: every alert sentence the product composes, in English and Tamil — one registry, so the guardrail can
// check that every kind has both (tests/guardrails/every-alert-kind-has-a-tamil-twin.test.ts), and one way to read an
// alert in a language. See `alert-text.ts` for the rules.

import { renderWith, isAlertText, UnknownAlertKindError, type AlertLang, type AlertParam, type AlertText, type AlertTemplate } from './alert-text';
export type { AlertText, AlertLang, AlertParam } from './alert-text';
import { HEALTH_WORDS } from './alert-words-health';
import { PLATFORM_WORDS } from './alert-words-platform';
import { BOX_WORDS } from './alert-words-box';
import { BUSINESS_WORDS } from './alert-words-business';

export const ALERT_TEMPLATES = {
  ...HEALTH_WORDS,
  ...PLATFORM_WORDS,
  ...BOX_WORDS,
  ...BUSINESS_WORDS,
} as const satisfies Readonly<Record<string, AlertTemplate>>;

/** Every alert sentence the product knows. A typo in a kind is a type error at the place it is raised. */
export type AlertKind = keyof typeof ALERT_TEMPLATES;
export const ALERT_KINDS: readonly AlertKind[] = Object.keys(ALERT_TEMPLATES) as AlertKind[];

/** A structured alert sentence. */
export function alertText(kind: AlertKind, params: Readonly<Record<string, AlertParam>> = {}): AlertText {
  return Object.keys(params).length === 0 ? { kind } : { kind, params };
}

/** Render one alert sentence in a language (Tamil never blank: it falls back to English). */
export function renderAlert(text: AlertText, lang: AlertLang): string {
  return renderWith(ALERT_TEMPLATES, text, lang);
}

/**
 * The words to keep on a component, finding or alert: the English `detail` (word for word what it always was) AND the
 * structured `text` it was rendered from, so any reader can show it in Tamil.
 */
export function told(kind: AlertKind, params: Readonly<Record<string, AlertParam>> = {}): { readonly detail: string; readonly text: AlertText } {
  const text = alertText(kind, params);
  return { detail: renderAlert(text, 'en'), text };
}

/** A part of a sentence that may be structured or (an old record, an outside note) plain English: as a parameter. */
export function partOf(text: AlertText | undefined, english: string): string | AlertText {
  return text ?? english;
}

/** One alert's words in both languages. `englishOnly`: recorded before Tamil existed (or unreadable) — English in both. */
export interface AlertWords {
  readonly en: string;
  readonly ta: string;
  readonly englishOnly?: true;
}

/**
 * Read an alert's words in both languages. An alert recorded with no structured words (every alert raised before OB-435)
 * reads in English, exactly as it was recorded — in both languages, said so (`englishOnly`) — never an error, never blank.
 */
export function alertWords(text: unknown, recordedEnglish: string): AlertWords {
  if (!isAlertText(text)) return { en: recordedEnglish, ta: recordedEnglish, englishOnly: true };
  try {
    return { en: renderAlert(text, 'en'), ta: renderAlert(text, 'ta') };
  } catch (e) {
    if (e instanceof UnknownAlertKindError) return { en: recordedEnglish, ta: recordedEnglish, englishOnly: true };
    throw e;
  }
}

/** The words a screen shows for one alert, in each language: its component, its status, its detail (and escalation). */
export interface AlertDisplay {
  readonly en: { readonly component: string; readonly status: string; readonly detail: string; readonly escalation?: string };
  readonly ta: { readonly component: string; readonly status: string; readonly detail: string; readonly escalation?: string };
  /** The detail was recorded in English only (before OB-435): it reads in English on a Tamil screen too. */
  readonly englishOnly?: true;
}

/** What an alert carries that its words are made from. */
export interface AlertWordSource {
  readonly component: string;
  readonly status: string;
  readonly detail: string;
  readonly text?: AlertText;
  readonly componentText?: AlertText;
}

/** One alert's screen words in both languages (an old English-only alert still reads, in English). */
export function alertDisplay(alert: AlertWordSource, escalation?: { readonly detail?: string; readonly text?: AlertText }): AlertDisplay {
  const detail = alertWords(alert.text, alert.detail);
  const component = alert.componentText === undefined
    ? { en: alert.component, ta: renderAlert(alertText('alert.component', { component: alert.component }), 'ta') }
    : alertWords(alert.componentText, alert.component);
  const status = { en: alert.status, ta: renderAlert(alertText('alert.status', { status: alert.status }), 'ta') };
  const esc = escalation?.detail === undefined ? undefined : alertWords(escalation.text, escalation.detail);
  return {
    en: { component: component.en, status: status.en, detail: detail.en, ...(esc === undefined ? {} : { escalation: esc.en }) },
    ta: { component: component.ta, status: status.ta, detail: detail.ta, ...(esc === undefined ? {} : { escalation: esc.ta }) },
    ...(detail.englishOnly === true ? { englishOnly: true as const } : {}),
  };
}

/**
 * OB-439: the text message about an alert, in ONE language — the recipient's. The English message is word for word what
 * it always was; an alert recorded in English only is sent with its English detail inside the Tamil frame.
 */
export function alertMessage(alert: AlertWordSource, stage: 'raised' | 'escalated', updated: boolean, lang: AlertLang, extra: { readonly ackDueBy: string; readonly ownerName: string }): string {
  const d = alertDisplay(alert)[lang];
  return stage === 'escalated'
    ? renderAlert(alertText('alert.sms.escalated', { component: d.component, status: d.status, detail: d.detail, ownerName: extra.ownerName }), lang)
    : renderAlert(alertText('alert.sms.raised', { updated, component: d.component, status: d.status, detail: d.detail, ackDueBy: extra.ackDueBy }), lang);
}

/** A person's language as recorded (OB-439): Tamil only when they chose it; anything else — or nothing — is English. */
export function languageOrEnglish(v: unknown): AlertLang {
  return v === 'ta' ? 'ta' : 'en';
}
