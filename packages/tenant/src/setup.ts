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
import { isUpiId, isBankAccountNo, isIfsc } from '../../receipt/src/b2c-dynamic-qr';
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
  /** U3 (OB-699, 7 Nov 2026): the same question in Tamil — a setup question is the product's own word, carried in both languages. */
  readonly questionTa: string;
  /** A required setting blocks setup until the tenant gives a value (no safe guess). */
  readonly required: boolean;
  /** Optional check run before a value is accepted. */
  readonly validate?: SetupValidator;
  /**
   * For a NUMBER setting: the bounds its rule accepts, declared once so the engine's check and the setup screen's
   * number editor read the SAME numbers (the screen derives its editor from the setting's type and this range — a
   * new number setting needs no hand-kept screen entry). Round 13 found four number settings shown as text and
   * impossible to save because the screen kept its own per-setting list.
   */
  readonly range?: SetupRange;
}

/** The accepted bounds of a number setting: inclusive `min`/`max` (no `max` = unbounded) and whole numbers only or not. */
export interface SetupRange {
  readonly min: number;
  readonly max?: number;
  readonly whole: boolean;
}

// ── Validators (each takes an unknown and narrows) ─────────────────────────────

const isString = (v: unknown): v is string => typeof v === 'string';
/** Whether a value is a number inside a declared range (whole-number ranges refuse fractions). */
const inRange = (v: unknown, r: SetupRange): boolean =>
  typeof v === 'number' && Number.isFinite(v) && (!r.whole || Number.isInteger(v))
  && v >= r.min && (r.max === undefined || v <= r.max);
/** A number setting's rule and range, from ONE declaration: the validator checks exactly the range the screen shows. */
const numberRule = (range: SetupRange, message: string): { readonly range: SetupRange; readonly validate: SetupValidator } =>
  ({ range, validate: (v) => (inRange(v, range) ? null : message) });
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * OB-402 (owner, 27 Oct 2026, in writing): the trading day ends at midnight. A later cut-off would let a bill's printed
 * date, its bill-number year and its GST month disagree (a bill at 00:30 on 1 April would belong to 31 March), so the
 * setting is held at 00:00 and any other time is refused by name. The engine still reads the value it is given.
 */
const validateCutoff: SetupValidator = (v) =>
  v === '00:00' ? null
    : isString(v) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
      ? 'The trading day ends at midnight (00:00) by the owner\'s decision (OB-402): the bill date, bill-number year and GST month must always agree.'
      : 'Use 00:00 — the trading day ends at midnight (OB-402).';
const validateTimeZone: SetupValidator = (v) => {
  if (!isString(v) || v.trim() === '') return 'Name the time zone the way the world does, like Asia/Kolkata.';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: v });
    return null;
  } catch {
    return `"${v}" is not a time zone this system knows. Use an IANA name like Asia/Kolkata.`;
  }
};
const validateCurrency: SetupValidator = (v) =>
  isString(v) && /^[A-Z]{3}$/.test(v) ? null : 'Use a 3-letter ISO currency code, e.g. INR.';
const validateLanguages: SetupValidator = (v) =>
  isStringArray(v) && v.length > 0 && v.every((s) => s.trim() !== '')
    ? null : 'Give at least one language code, e.g. en.';
const TAX_BPS = numberRule({ min: 0, max: 10_000, whole: true }, 'Give a GST rate in basis points (0–10000; 1800 = 18%).');
const AGE = numberRule({ min: 0, max: 120, whole: true }, 'Give an age in whole years.');
const RADIUS = numberRule({ min: 0, whole: false }, 'Give a distance in km (0 turns delivery off).');
const MINUTES = numberRule({ min: 1, max: 100_000, whole: true }, 'Give a number of minutes (at least 1).');
const BP = numberRule({ min: 0, max: 10_000, whole: true }, 'Give a level in basis points (0–10000; 5000 = half).');
const validateBool: SetupValidator = (v) =>
  typeof v === 'boolean' ? null : 'Choose on or off.';
const PRODUCT_COUNT = numberRule({ min: 1, max: 1_000_000, whole: true }, 'Give a whole number of products (at least 1).');
const LOYALTY_RATE = numberRule({ min: 0, max: 100, whole: true }, 'Give a whole number of points per ₹100, from 0 (loyalty off) to 100.');
const POINT_VALUE = numberRule({ min: 0, max: 10_000, whole: true }, 'Give the value of one point in paise, from 0 to 10000 (₹100).');
const TILL_SPEND_CAP = numberRule({ min: 0, max: 10_000_000, whole: true }, 'Give the most one member may spend at the till in a day, in paise, from 0 (off) to 10000000 (₹1,00,000).');
const GIFT_CARD_OFFLINE_CAP = numberRule({ min: 0, max: 10_000_000, whole: true }, 'Give the most one till may take from one gift card with head office out of reach, in paise, from 0 (none offline) to 10000000 (₹1,00,000).');
const validateStringList: SetupValidator = (v) =>
  isStringArray(v) ? null : 'Give a list of names (an empty list means none).';
const WARN_HOURS = numberRule({ min: 1, max: 720, whole: true }, 'Give a whole number of trading hours, from 1 to 720.');
const UNSENT_WARN_HOURS = numberRule({ min: 1, max: 72, whole: true }, 'Give a whole number of hours, from 1 to 72.');
const CLAIM_SLACK_NUMBERS = numberRule({ min: 0, max: 100, whole: true }, 'Give a whole number of bill numbers, from 0 to 100.');
const CLAIM_SLACK_PERCENT = numberRule({ min: 0, max: 50, whole: true }, 'Give a whole percentage, from 0 to 50.');
/** A22: a QR detail is empty (not set) or one this check accepts — never half a detail. */
const emptyOr = (check: (v: string) => boolean, message: string): SetupValidator => (v) =>
  (isString(v) && (v.trim() === '' || check(v.trim())) ? null : message);
const validateUpiId = emptyOr(isUpiId, 'Give the UPI ID as the bank gave it, like shopname@bank — or leave it empty (not set).');
const validateBankAccount = emptyOr(isBankAccountNo, 'Give the bank account number as digits only (9 to 18) — or leave it empty (not set).');
const validateIfsc = emptyOr((v) => isIfsc(v.toUpperCase()), 'Give the 11-character IFSC, like SBIN0001234 — or leave it empty (not set).');
/** OB-299: the delivery-fee product — empty (not set) or a product id (letters, digits, - _ . : only). */
const validateProductRef: SetupValidator = (v) =>
  (isString(v) && (v === '' || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(v)) ? null
    : 'Give the product id of the delivery-fee product as the catalogue holds it — or leave it empty (not set).');
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
    questionTa: 'ஒரு வகை தனியாக அமைக்கும் வரை எந்த இயல்புநிலை ஜிஎஸ்டி விகிதம் பொருந்தும்? வரி வகுப்பு இல்லாமல் ஒரு பொருளை விற்பனைக்கு வைக்க முடியாது.',
    ...TAX_BPS,
  },
  {
    setting: SETTINGS.TRADING_DAY_CUTOFF,
    group: 'give_now',
    required: false,
    question: 'When does one trading day end and the next begin? (Drives the daily close and the GST day.)',
    questionTa: 'ஒரு வியாபார நாள் எப்போது முடிந்து அடுத்தது தொடங்குகிறது? (தினசரி முடிப்பையும் ஜிஎஸ்டி நாளையும் இது தீர்மானிக்கிறது.)',
    validate: validateCutoff,
  },
  {
    setting: SETTINGS.STORE_TIME_ZONE,
    group: 'check_default',
    required: false,
    question: 'Which time zone do the shop\'s clocks keep? (Head office dates "today" on the dashboard and in the day\'s reports by it.)',
    questionTa: 'கடையின் கடிகாரங்கள் எந்த நேர மண்டலத்தில்? (தலைமை அலுவலகம் டாஷ்போர்டிலும் நாளின் அறிக்கைகளிலும் "இன்று" என்பதை இதன்படி குறிக்கிறது.)',
    validate: validateTimeZone,
  },
  {
    setting: SETTINGS.RECEIPT_PAPER_FORMAT,
    group: 'check_default',
    required: false,
    question: 'What size paper do the till receipts print on?',
    questionTa: 'கல்லா ரசீதுகள் எந்த அளவு காகிதத்தில் அச்சாகின்றன?',
    validate: validatePaperFormat,
  },
  {
    setting: SETTINGS.LANGUAGES,
    group: 'check_default',
    required: false,
    question: 'Which languages should the tills and app offer?',
    questionTa: 'கல்லாக்களும் ஆப்பும் எந்த மொழிகளை வழங்க வேண்டும்?',
    validate: validateLanguages,
  },
  {
    setting: SETTINGS.BASE_CURRENCY,
    group: 'check_default',
    required: false,
    question: 'What currency does the store trade in?',
    questionTa: 'கடை எந்த நாணயத்தில் வியாபாரம் செய்கிறது?',
    validate: validateCurrency,
  },
  {
    setting: SETTINGS.PRODUCTION_DEPARTMENTS,
    group: 'give_now',
    required: false,
    question: 'Which in-store production departments do you run (café, bakery…)? Empty means none.',
    questionTa: 'கடையில் எந்த உற்பத்தித் துறைகளை நடத்துகிறீர்கள் (கஃபே, பேக்கரி…)? காலி என்றால் எதுவும் இல்லை.',
    validate: validateStringList,
  },
  {
    setting: SETTINGS.PICK_ZONE_ORDER,
    group: 'give_now',
    required: false,
    question: 'In what order does a picker collect the store’s zones? Empty follows shelf position and says so.',
    questionTa: 'பொருள் எடுப்பவர் கடையின் பகுதிகளை எந்த வரிசையில் சேகரிக்கிறார்? காலி என்றால் அடுக்கு இடத்தைப் பின்பற்றி அதைச் சொல்லும்.',
    validate: validateStringList,
  },
  {
    setting: SETTINGS.DELIVERY_RADIUS_KM,
    group: 'check_default',
    required: false,
    question: 'How far from the store do you deliver (km)? 0 turns delivery off.',
    questionTa: 'கடையிலிருந்து எவ்வளவு தூரம் வரை டெலிவரி செய்கிறீர்கள் (கி.மீ.)? 0 என்றால் டெலிவரி இல்லை.',
    ...RADIUS,
  },
  {
    setting: SETTINGS.AGE_RESTRICTED_MINIMUM_AGE,
    group: 'check_default',
    required: false,
    question: 'What is the minimum age for age-restricted items?',
    questionTa: 'வயது வரம்புள்ள பொருட்களுக்கான குறைந்தபட்ச வயது என்ன?',
    ...AGE,
  },
  {
    setting: SETTINGS.LICENCE_HOURS_ENABLED,
    group: 'check_default',
    required: false,
    question: 'Do any items sell only during licensed hours?',
    questionTa: 'சில பொருட்கள் உரிமம் பெற்ற நேரங்களில் மட்டுமே விற்கப்படுகின்றனவா?',
    validate: validateBool,
  },
  {
    setting: SETTINGS.SHELF_COUNT_STALE_AFTER_MINUTES,
    group: 'check_default',
    required: false,
    question: 'How long does a shelf count stay worth acting on (minutes)?',
    questionTa: 'ஒரு அடுக்கு எண்ணிக்கை எவ்வளவு நேரம் செயல்படத் தகுந்ததாக இருக்கும் (நிமிடங்கள்)?',
    ...MINUTES,
  },
  {
    setting: SETTINGS.SHELF_REFILL_AT_BP,
    group: 'check_default',
    required: false,
    question: 'How empty must a facing be before it is worth a refill trip?',
    questionTa: 'ஒரு அடுக்கு எவ்வளவு காலியானால் நிரப்பச் செல்வது தகும்?',
    ...BP,
  },
  {
    setting: SETTINGS.CATALOGUE_BULK_PUBLISH_THRESHOLD,
    group: 'check_default',
    required: false,
    question: 'How many products may one catalogue publish add, change or remove before it counts as a bulk publish and asks the publisher to sign in again with a second factor?',
    questionTa: 'ஒரு பட்டியல் வெளியீடு எத்தனை பொருட்களைச் சேர்க்கலாம், மாற்றலாம் அல்லது நீக்கலாம் — அதற்கு மேல் அது மொத்த வெளியீடாகக் கருதப்பட்டு, வெளியிடுபவரை இரண்டாம் நிலையுடன் மீண்டும் உள்நுழையச் சொல்லும்?',
    ...PRODUCT_COUNT,
  },
  {
    setting: SETTINGS.LOYALTY_POINTS_PER_100_INR,
    group: 'check_default',
    required: false,
    question: 'How many loyalty points does a member earn for every ₹100 spent? (0 keeps loyalty off.)',
    questionTa: 'ஒரு உறுப்பினர் ₹100 செலவுக்கு எத்தனை விசுவாசப் புள்ளிகள் ஈட்டுகிறார்? (0 என்றால் விசுவாசத் திட்டம் இல்லை.)',
    ...LOYALTY_RATE,
  },
  {
    setting: SETTINGS.LOYALTY_POINT_VALUE_PAISE,
    group: 'check_default',
    required: false,
    question: 'What is one loyalty point worth when a customer spends it, in paise?',
    questionTa: 'வாடிக்கையாளர் செலவிடும்போது ஒரு விசுவாசப் புள்ளியின் மதிப்பு எவ்வளவு, பைசாவில்?',
    ...POINT_VALUE,
  },
  {
    // PF-09 step 3: the double-spend bound on spending at the till (M17-FR-01 / M17-FR-03 offline caps). 0 = off.
    setting: SETTINGS.LOYALTY_TILL_SPEND_CAP_PAISE,
    group: 'check_default',
    required: false,
    question: 'At most how much may one loyalty member spend at the till in a day — points and store credit together, in paise? (0 keeps spending at the till off.)',
    questionTa: 'ஒரு விசுவாச உறுப்பினர் ஒரு நாளில் கல்லாவில் அதிகபட்சம் எவ்வளவு செலவிடலாம் — புள்ளிகள் மற்றும் கடை கடன் சேர்த்து, பைசாவில்? (0 என்றால் கல்லாவில் செலவிட முடியாது.)',
    ...TILL_SPEND_CAP,
  },
  {
    // D07-FR-04 · OB-677: the offline gift-card limit per till per card (the owner's answer, ₹500, is the default).
    setting: SETTINGS.GIFT_CARD_OFFLINE_CAP_PAISE,
    group: 'check_default',
    required: false,
    question: 'At most how much may one till take from one gift card while the store computer cannot reach head office, in paise? (0 takes no gift card offline.)',
    questionTa: 'கடைக் கணினி தலைமை அலுவலகத்தை அடைய முடியாதபோது ஒரு கல்லா ஒரு பரிசு அட்டையிலிருந்து அதிகபட்சம் எவ்வளவு எடுக்கலாம், பைசாவில்? (0 என்றால் ஆஃப்லைனில் பரிசு அட்டை இல்லை.)',
    ...GIFT_CARD_OFFLINE_CAP,
  },
  {
    // OB-78 "A" (owner, 12 Oct 2026): the early disk warning for each store computer, in hours of trading left.
    setting: SETTINGS.BOX_DISK_WARN_HOURS,
    group: 'check_default',
    required: false,
    question: 'How many hours of trading before a store computer\'s disk would fill should head office warn you? (48 by default.)',
    questionTa: 'கடைக் கணினியின் வட்டு நிரம்புவதற்கு எத்தனை வியாபார மணி நேரத்துக்கு முன் தலைமை அலுவலகம் எச்சரிக்க வேண்டும்? (இயல்பாக 48.)',
    ...WARN_HOURS,
  },
  {
    // Verifier r21 UNSENT-CEILING: bills waiting on a store computer, unsent, longer than this are named on the health page.
    setting: SETTINGS.BOX_UNSENT_WARN_HOURS,
    group: 'check_default',
    required: false,
    question: 'How many hours may bills wait on a store computer, unsent, before head office warns you? (2 by default.)',
    questionTa: 'பில்கள் கடைக் கணினியில் அனுப்பப்படாமல் எத்தனை மணி நேரம் காத்திருக்கலாம் — அதற்கு மேல் தலைமை அலுவலகம் எச்சரிக்கும்? (இயல்பாக 2.)',
    ...UNSENT_WARN_HOURS,
  },
  {
    // OB-90 "C" (owner, 13 Oct 2026): how far a store computer's "I still hold N bills between X and Y" is believed.
    setting: SETTINGS.BOX_CLAIM_SLACK_NUMBERS,
    group: 'check_default',
    required: false,
    question: 'When a store computer says "I still hold N bills between X and Y", how many extra bill numbers (voided bills) may that range cover at least before head office checks every number in it? (5 by default; 0 is strictest.)',
    questionTa: 'கடைக் கணினி "X-க்கும் Y-க்கும் இடையே N பில்கள் உள்ளன" என்று சொல்லும்போது, தலைமை அலுவலகம் ஒவ்வொரு எண்ணையும் சரிபார்க்கும் முன் அந்த வரம்பு குறைந்தபட்சம் எத்தனை கூடுதல் பில் எண்களை (ரத்தான பில்கள்) உள்ளடக்கலாம்? (இயல்பாக 5; 0 மிகக் கடுமையானது.)',
    ...CLAIM_SLACK_NUMBERS,
  },
  {
    setting: SETTINGS.BOX_CLAIM_SLACK_PERCENT,
    group: 'check_default',
    required: false,
    question: '…or what percentage of N, when that is more? (5 by default; 0 is strictest.)',
    questionTa: '…அல்லது N-இன் எத்தனை சதவீதம், அது அதிகமாக இருக்கும்போது? (இயல்பாக 5; 0 மிகக் கடுமையானது.)',
    ...CLAIM_SLACK_PERCENT,
  },
  {
    // A22 · OB-326: built switched off. Only a shop above ₹500 crore aggregate turnover must print it.
    setting: SETTINGS.INVOICE_B2C_DYNAMIC_QR_ON,
    group: 'check_default',
    required: false,
    question: 'Print the GST dynamic QR on every customer bill? The law asks for it only above ₹500 crore turnover a year (off by default).',
    questionTa: 'ஒவ்வொரு வாடிக்கையாளர் பில்லிலும் ஜிஎஸ்டி டைனமிக் QR அச்சிடவா? ஆண்டுக்கு ₹500 கோடி வருவாய்க்கு மேல் மட்டுமே சட்டம் கேட்கிறது (இயல்பாக இல்லை).',
    validate: validateBool,
  },
  {
    setting: SETTINGS.INVOICE_B2C_DYNAMIC_QR_UPI_ID,
    group: 'check_default',
    required: false,
    question: 'For the dynamic QR: the shop\'s UPI ID the customer pays to. (Empty = not set; no QR prints until it is.)',
    questionTa: 'டைனமிக் QR-க்கு: வாடிக்கையாளர் செலுத்தும் கடையின் UPI ஐடி. (காலி = அமைக்கப்படவில்லை; அமைக்கும் வரை QR அச்சாகாது.)',
    validate: validateUpiId,
  },
  {
    setting: SETTINGS.INVOICE_B2C_DYNAMIC_QR_BANK_ACCOUNT,
    group: 'check_default',
    required: false,
    question: 'For the dynamic QR: the bank account number that UPI ID pays into. (Empty = not set.)',
    questionTa: 'டைனமிக் QR-க்கு: அந்த UPI ஐடி செலுத்தும் வங்கிக் கணக்கு எண். (காலி = அமைக்கப்படவில்லை.)',
    validate: validateBankAccount,
  },
  {
    setting: SETTINGS.INVOICE_B2C_DYNAMIC_QR_IFSC,
    group: 'check_default',
    required: false,
    question: 'For the dynamic QR: that bank account\'s IFSC. (Empty = not set.)',
    questionTa: 'டைனமிக் QR-க்கு: அந்த வங்கிக் கணக்கின் IFSC. (காலி = அமைக்கப்படவில்லை.)',
    validate: validateIfsc,
  },
  {
    // OB-299: the till's delivery sale — the fee line is this catalogue product at its signed price (₹0 allowed).
    setting: SETTINGS.TILL_DELIVERY_FEE_PRODUCT,
    group: 'give_now',
    required: false,
    question: 'When a customer pays at the till and wants the bill delivered, which product is the delivery fee? Publish it in the catalogue with its price (₹0 is allowed) and give its product id here. (Empty = not set; the till will not take delivery bills.)',
    questionTa: 'வாடிக்கையாளர் கல்லாவில் பணம் செலுத்தி பில்லை டெலிவரி செய்யக் கேட்கும்போது, டெலிவரி கட்டணம் எந்தப் பொருள்? அதை விலையுடன் பட்டியலில் வெளியிட்டு (₹0 அனுமதி) அதன் பொருள் ஐடியை இங்கே கொடுங்கள். (காலி = அமைக்கப்படவில்லை; அதுவரை கல்லா டெலிவரியை ஏற்காது.)',
    validate: validateProductRef,
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
  /** U3 (OB-699): the label and the question in Tamil, carried beside the English so the screen shows the reader's. */
  readonly labelTa: string;
  readonly question: string;
  readonly questionTa: string;
  readonly group: SetupGroup;
  readonly required: boolean;
  readonly state: ItemState;
  /** The value in force now — the tenant's answer, or the default. */
  readonly value: unknown;
  readonly isDefault: boolean;
  /** Current config version (0 when on the default) — the token a save sends back (concurrency). */
  readonly version: number;
  /** Who last chose this value, if anyone — the audit fact the screen shows. */
  readonly changedBy?: string;
  /** When it was last chosen (ISO-8601 UTC), if ever. */
  readonly changedAt?: string;
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
/** Build one item's status from the facts about it — shared by the sync and durable readers. */
export function setupItemStatus(
  item: SetupItem,
  facts: { readonly answered: boolean; readonly value: unknown; readonly version: number; readonly changedBy?: string; readonly changedAt?: string },
): SetupItemStatus {
  const state: ItemState = item.required && !facts.answered ? 'blocking' : facts.answered ? 'answered' : 'using_default';
  return {
    key: item.setting.key,
    label: item.setting.label,
    labelTa: item.setting.labelTa,
    question: item.question,
    questionTa: item.questionTa,
    group: item.group,
    required: item.required,
    state,
    value: facts.value,
    isDefault: !facts.answered,
    version: facts.version,
    changedBy: facts.changedBy,
    changedAt: facts.changedAt,
  };
}

/** Aggregate item statuses into the whole-tenant read-out — shared by the sync and durable readers. */
export function assembleSetupStatus(
  items: readonly SetupItemStatus[],
  catalogue: readonly SetupItem[] = SETUP_CATALOGUE,
): SetupStatus {
  const blocking = items.filter((i) => i.state === 'blocking').map((i) => i.key);
  const answered = items.filter((i) => !i.isDefault).length;
  const total = items.length;
  return {
    items: [...items],
    answered,
    total,
    requiredCount: catalogue.filter((i) => i.required).length,
    blocking,
    complete: blocking.length === 0,
    progressBp: total === 0 ? 10_000 : Math.round((answered / total) * 10_000),
  };
}

export function setupStatus(
  settings: TenantSettings,
  tenantId: string,
  catalogue: readonly SetupItem[] = SETUP_CATALOGUE,
): SetupStatus {
  const items = catalogue.map((item) => {
    const meta = settings.metaOf(tenantId, item.setting);
    return setupItemStatus(item, {
      answered: settings.isSet(tenantId, item.setting),
      value: settings.get(tenantId, item.setting),
      version: settings.versionOf(tenantId, item.setting),
      changedBy: meta?.author,
      changedAt: meta?.at,
    });
  });
  return assembleSetupStatus(items, catalogue);
}

// ── Applying an answer ─────────────────────────────────────────────────────────

export class InvalidSetupAnswerError extends Error {
  constructor(readonly key: string, message: string) {
    super(`Cannot accept ${key}: ${message}`);
    this.name = 'InvalidSetupAnswerError';
  }
}

/**
 * A save was made against a version that is no longer current — somebody else changed the setting
 * in between. The write is refused rather than silently overwriting the newer value; the caller is
 * told the current version so it can show the conflict and let a person decide.
 */
export class SetupVersionConflictError extends Error {
  constructor(readonly key: string, readonly expected: number, readonly actual: number) {
    super(`${key} changed since you loaded it (you had v${expected}, it is now v${actual}).`);
    this.name = 'SetupVersionConflictError';
  }
}

/** Validate a value against a setup item; throws InvalidSetupAnswerError, by name, if it does not fit. */
export function validateSetupAnswer(item: SetupItem, value: unknown): void {
  const problem = item.validate ? item.validate(value) : null;
  if (problem !== null) throw new InvalidSetupAnswerError(item.setting.key, problem);
}

/**
 * Record a tenant's answer to one setup item. Validated first (an invalid value is refused, by name,
 * never stored), optionally checked for a version conflict, then written through the versioned config
 * engine — so the change is audited, reversible, and isolated to this tenant.
 *
 * `ifVersion` is optimistic concurrency: when given, the write is refused unless it still matches the
 * setting's current version, so a save made against a stale reading cannot clobber a newer one.
 */
export function applyAnswer(
  settings: TenantSettings,
  tenantId: string,
  item: SetupItem,
  value: unknown,
  author: string,
  effectiveAt: string,
  reason = 'store setup',
  ifVersion?: number,
): void {
  validateSetupAnswer(item, value);
  if (ifVersion !== undefined) {
    const actual = settings.versionOf(tenantId, item.setting);
    if (actual !== ifVersion) throw new SetupVersionConflictError(item.setting.key, ifVersion, actual);
  }
  settings.set(tenantId, item.setting, value, author, reason, effectiveAt);
}
