// Self-service store setup (ADR-0003 §4 "onboarding is configuration, not code" ·
// M01-FR-02/03 · M33-FR-01 · M36-FR-02).
//
// Turns the per-tenant settings catalogue into something a retailer completes
// itself. Every setting carries a plain-English question and its safe default is
// pre-loaded, so an untouched store already runs. The engine reports, per tenant,
// which settings are answered, which are on their default, and which REQUIRED ones
// are still missing and therefore block — the same "block-until-given" rule the
// product uses elsewhere (a product cannot publish without a tax class). No value
// is guessed on the tenant's behalf, and no one is ever asked for another store's
// facts.

import { PAPER_FORMATS } from '../../receipt/src/presets';
import { SETTINGS, TenantSettings, type TenantSetting } from './settings';

/** How much attention a setting usually needs — advisory, for grouping in the UI. */
export type SetupGroup = 'give_now' | 'check_default' | 'already_set';

/** A message describing why a value is invalid, or null when it is acceptable. */
export type SetupValidator = (value: unknown) => string | null;

/** One step of store setup: a setting, a plain question, and how it is treated. */
export interface SetupItem {
  readonly setting: TenantSetting<unknown>;
  readonly group: SetupGroup;
  /** Plain-English, no jargon — what the screen actually asks. */
  readonly question: string;
  /** A required setting blocks setup until the tenant gives a value (no safe guess). */
  readonly required: boolean;
  /** Optional check run before a value is accepted. */
  readonly validate?: SetupValidator;
}

// ── Validators (each takes an unknown and narrows) ─────────────────────────────

const isString = (v: unknown): v is string => typeof v === 'string';
const isIntIn = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const validateCutoff: SetupValidator = (v) =>
  isString(v) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'Use a 24-hour time like 22:00.';
const validateCurrency: SetupValidator = (v) =>
  isString(v) && /^[A-Z]{3}$/.test(v) ? null : 'Use a 3-letter ISO currency code, e.g. INR.';
const validateLanguages: SetupValidator = (v) =>
  isStringArray(v) && v.length > 0 && v.every((s) => s.trim() !== '')
    ? null : 'Give at least one language code, e.g. en.';
const validateTaxBps: SetupValidator = (v) =>
  isIntIn(v, 0, 10_000) ? null : 'Give a GST rate in basis points (0–10000; 1800 = 18%).';
const validateAge: SetupValidator = (v) =>
  isIntIn(v, 0, 120) ? null : 'Give an age in whole years.';
const validateRadius: SetupValidator = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : 'Give a distance in km (0 turns delivery off).';
const validateMinutes: SetupValidator = (v) =>
  isIntIn(v, 1, 100_000) ? null : 'Give a number of minutes (at least 1).';
const validateBp: SetupValidator = (v) =>
  isIntIn(v, 0, 10_000) ? null : 'Give a level in basis points (0–10000; 5000 = half).';
const validateBool: SetupValidator = (v) =>
  typeof v === 'boolean' ? null : 'Choose on or off.';
const validateStringList: SetupValidator = (v) =>
  isStringArray(v) ? null : 'Give a list of names (an empty list means none).';
const validatePaperFormat: SetupValidator = (v) =>
  isString(v) && PAPER_FORMATS.some((f) => f.id === v)
    ? null : `Choose a paper size: ${PAPER_FORMATS.map((f) => f.id).join(', ')}.`;

/**
 * The ordered setup catalogue. Every tenant setting a store chooses at onboarding,
 * each with a plain question and — where a wrong guess would cost money or breach a
 * rule — a `required` flag so the setting blocks until the tenant gives it.
 */
export const SETUP_CATALOGUE: readonly SetupItem[] = [
  {
    setting: SETTINGS.DEFAULT_TAX_BPS,
    group: 'give_now',
    required: true,
    question: 'What default GST rate applies until a category sets its own? A product cannot go on sale without a tax class.',
    validate: validateTaxBps,
  },
  {
    setting: SETTINGS.TRADING_DAY_CUTOFF,
    group: 'give_now',
    required: false,
    question: 'When does one trading day end and the next begin? (Drives the daily close and the GST day.)',
    validate: validateCutoff,
  },
  {
    setting: SETTINGS.RECEIPT_PAPER_FORMAT,
    group: 'check_default',
    required: false,
    question: 'What size paper do the till receipts print on?',
    validate: validatePaperFormat,
  },
  {
    setting: SETTINGS.LANGUAGES,
    group: 'check_default',
    required: false,
    question: 'Which languages should the tills and app offer?',
    validate: validateLanguages,
  },
  {
    setting: SETTINGS.BASE_CURRENCY,
    group: 'check_default',
    required: false,
    question: 'What currency does the store trade in?',
    validate: validateCurrency,
  },
  {
    setting: SETTINGS.PRODUCTION_DEPARTMENTS,
    group: 'give_now',
    required: false,
    question: 'Which in-store production departments do you run (café, bakery…)? Empty means none.',
    validate: validateStringList,
  },
  {
    setting: SETTINGS.PICK_ZONE_ORDER,
    group: 'give_now',
    required: false,
    question: 'In what order does a picker collect the store’s zones? Empty follows shelf position and says so.',
    validate: validateStringList,
  },
  {
    setting: SETTINGS.DELIVERY_RADIUS_KM,
    group: 'check_default',
    required: false,
    question: 'How far from the store do you deliver (km)? 0 turns delivery off.',
    validate: validateRadius,
  },
  {
    setting: SETTINGS.AGE_RESTRICTED_MINIMUM_AGE,
    group: 'check_default',
    required: false,
    question: 'What is the minimum age for age-restricted items?',
    validate: validateAge,
  },
  {
    setting: SETTINGS.LICENCE_HOURS_ENABLED,
    group: 'check_default',
    required: false,
    question: 'Do any items sell only during licensed hours?',
    validate: validateBool,
  },
  {
    setting: SETTINGS.SHELF_COUNT_STALE_AFTER_MINUTES,
    group: 'check_default',
    required: false,
    question: 'How long does a shelf count stay worth acting on (minutes)?',
    validate: validateMinutes,
  },
  {
    setting: SETTINGS.SHELF_REFILL_AT_BP,
    group: 'check_default',
    required: false,
    question: 'How empty must a facing be before it is worth a refill trip?',
    validate: validateBp,
  },
];

/** Look a setup item up by its setting key. */
export function setupItem(key: string, catalogue: readonly SetupItem[] = SETUP_CATALOGUE): SetupItem | undefined {
  return catalogue.find((i) => i.setting.key === key);
}

// ── Status ─────────────────────────────────────────────────────────────────────

/** answered = the tenant chose it · using_default = safe default · blocking = required and unset. */
export type ItemState = 'answered' | 'using_default' | 'blocking';

export interface SetupItemStatus {
  readonly key: string;
  readonly label: string;
  readonly question: string;
  readonly group: SetupGroup;
  readonly required: boolean;
  readonly state: ItemState;
  /** The value in force now — the tenant's answer, or the default. */
  readonly value: unknown;
  readonly isDefault: boolean;
}

export interface SetupStatus {
  readonly items: readonly SetupItemStatus[];
  /** How many settings the tenant has explicitly chosen. */
  readonly answered: number;
  readonly total: number;
  readonly requiredCount: number;
  /** Keys of required settings still missing — what stops the store opening. */
  readonly blocking: readonly string[];
  /** True when no required setting is still missing: the store can open. */
  readonly complete: boolean;
  /** answered / total in basis points — advisory progress for the screen. */
  readonly progressBp: number;
}

/** Report a tenant's setup state: what is answered, on default, or still blocking. */
export function setupStatus(
  settings: TenantSettings,
  tenantId: string,
  catalogue: readonly SetupItem[] = SETUP_CATALOGUE,
): SetupStatus {
  const items: SetupItemStatus[] = catalogue.map((item) => {
    const answered = settings.isSet(tenantId, item.setting);
    const state: ItemState = item.required && !answered ? 'blocking' : answered ? 'answered' : 'using_default';
    return {
      key: item.setting.key,
      label: item.setting.label,
      question: item.question,
      group: item.group,
      required: item.required,
      state,
      value: settings.get(tenantId, item.setting),
      isDefault: !answered,
    };
  });

  const blocking = items.filter((i) => i.state === 'blocking').map((i) => i.key);
  const answered = items.filter((i) => !i.isDefault).length;
  const total = items.length;
  return {
    items,
    answered,
    total,
    requiredCount: catalogue.filter((i) => i.required).length,
    blocking,
    complete: blocking.length === 0,
    progressBp: total === 0 ? 10_000 : Math.round((answered / total) * 10_000),
  };
}

// ── Applying an answer ─────────────────────────────────────────────────────────

export class InvalidSetupAnswerError extends Error {
  constructor(readonly key: string, message: string) {
    super(`Cannot accept ${key}: ${message}`);
    this.name = 'InvalidSetupAnswerError';
  }
}

/**
 * Record a tenant's answer to one setup item. Validated first (an invalid value is
 * refused, by name, never stored), then written through the versioned config engine
 * — so the change is audited, reversible, and isolated to this tenant.
 */
export function applyAnswer(
  settings: TenantSettings,
  tenantId: string,
  item: SetupItem,
  value: unknown,
  author: string,
  effectiveAt: string,
  reason = 'store setup',
): void {
  const problem = item.validate ? item.validate(value) : null;
  if (problem !== null) throw new InvalidSetupAnswerError(item.setting.key, problem);
  settings.set(tenantId, item.setting, value, author, reason, effectiveAt);
}
