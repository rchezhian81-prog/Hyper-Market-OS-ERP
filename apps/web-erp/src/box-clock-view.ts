// The manager's view of THIS STORE COMPUTER'S CLOCK against head office's — OB-288 lane 2 · P2 · OB-327 (owner, in writing,
// 23 Oct 2026) · §31.1 · P-08 · hard rule #1.
//
// The box measures its clock against head office's on every reply (`edge/store-edge/src/clock-guard.ts`). At 2 minutes'
// difference the manager is WARNED; at 5 minutes bills still commit — a sale is never blocked by a clock — but every bill
// taken in that time is MARKED for checking, and listed here by number so a person can check each one. Both numbers are
// the store computer's settings (OB-327's by default). In step, nothing is shown: control by exception (P-03). A box that
// has not compared its clock since it started says so rather than saying "fine" (P-08: never a fake zero).
// DOM-free and tested; English and Tamil; the shell (web/app.js) paints what this hands over.

export type Lang = 'en' | 'ta';

/** The box's clock check as the manager payload carries it (`ClockCheck`, read loosely: it is data from the box). */
export interface BoxClockCheck {
  readonly verdict: 'not_checked' | 'in_step' | 'warning' | 'flag_bills' | string;
  readonly offsetSeconds: number | null;
  readonly lastCheckedAt: string | null;
  readonly thresholds?: { readonly warnSeconds: number; readonly flagSeconds: number };
  readonly needsAttention: boolean;
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}
/** R1a (M01-FR-02 · P-08): the box's time zone against the shop's (`ZoneCheck`, read loosely). */
export interface BoxZoneCheck {
  readonly verdict: 'in_step' | 'differs' | string;
  readonly needsAttention: boolean;
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}
/**
 * OB-403 "A" · §31.1: what the box is holding while its clock is 5+ minutes out (`ActivationHoldReport`, read loosely) —
 * new prices, offers and a new bill-number year wait until the clock is back in step; selling goes on.
 */
export interface BoxActivationHold {
  readonly held: boolean;
  readonly heldPromotions?: readonly { readonly id: string; readonly startsAt: string }[];
  readonly heldPrices?: readonly { readonly id: string; readonly productId: string; readonly effectiveFrom: string }[];
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}
export interface BoxClockFlaggedBill { readonly saleId: string; readonly number?: string; readonly laneId?: string; readonly committedAt: string; readonly offsetSeconds: number }

export interface BoxClockView {
  readonly show: boolean;
  readonly tone: 'ok' | 'warn' | 'error';
  /** The icon beside the words (the one icon set): a clock for a warning, an alert when bills are being marked. */
  readonly icon: 'clock' | 'circle-alert';
  readonly words: string;
  /** R1a: the words about the machine's time zone when it is not the shop's; empty otherwise. */
  readonly zoneWords: string;
  /** OB-403: "Price change held: store clock is X min out" and what is held, while the hold is on; empty otherwise. */
  readonly holdWords: string;
  readonly billsHeading: string;
  readonly bills: readonly { readonly saleId: string; readonly label: string }[];
}

const WORDS = {
  en: { billsHeading: (min: number) => `Bills taken while this store computer's clock was ${min} minutes or more out — check each one`, lane: 'lane', out: 'out by' },
  ta: { billsHeading: (min: number) => `இந்தக் கடைக் கணினியின் கடிகாரம் ${min} நிமிடம் அல்லது அதிகம் விலகியிருந்தபோது எடுத்த பில்கள் — ஒவ்வொன்றையும் சரிபாருங்கள்`, lane: 'வரிசை', out: 'விலகல்' },
} as const;

const seconds = (s: number): string => {
  const a = Math.abs(Math.round(s));
  return a >= 60 ? `${Math.floor(a / 60)} min ${a % 60} s` : `${a} s`;
};

/** An ISO-8601 moment as the box writes it ("2026-11-15T17:17:11.002Z") — said in the shop's own time words instead. */
const ISO_MOMENT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * `when` (D-028): how the page says a moment in the shop's time words (the chrome's `sreShopDay.dateTimeOf`). Absent, or when
 * it cannot say one, the moment stays as written — never dropped.
 */
export function boxClockView(lang: Lang, clock: BoxClockCheck | undefined | null, bills: readonly BoxClockFlaggedBill[] | undefined | null, zone?: BoxZoneCheck | null, hold?: BoxActivationHold | null, when?: (iso: string) => string): BoxClockView {
  const w = WORDS[lang];
  const shop = (text: string): string => (when === undefined ? text : text.replace(ISO_MOMENT, (iso) => { const said = when(iso); return typeof said === 'string' && said.trim() !== '' ? said : iso; }));
  const list = Array.isArray(bills) ? bills : [];
  const flagMinutes = Math.round((clock?.thresholds?.flagSeconds ?? 300) / 60);
  const rows = list.map((b) => ({
    saleId: b.saleId,
    label: `${b.number ?? b.saleId}${b.laneId === undefined ? '' : ` · ${w.lane} ${b.laneId}`} · ${shop(b.committedAt)} · ${w.out} ${seconds(b.offsetSeconds)}`,
  }));
  const attention = clock !== undefined && clock !== null && clock.needsAttention === true;
  const zoneAttention = zone !== undefined && zone !== null && zone.needsAttention === true;
  const held = hold !== undefined && hold !== null && hold.held === true;
  const show = attention || rows.length > 0 || zoneAttention || held;
  const tone: BoxClockView['tone'] = clock?.verdict === 'flag_bills' || held || (rows.length > 0 && clock?.verdict !== 'in_step') ? 'error' : attention || zoneAttention ? 'warn' : rows.length > 0 ? 'warn' : 'ok';
  // D-028: the clock line is said only when the clock is OUT or NOT KNOWN — a clock that agrees with head office says nothing
  // (control by exception, P-03), even while the strip is up for the time zone or a hold.
  const words = clock === undefined || clock === null || clock.verdict === 'in_step' ? '' : shop(lang === 'ta' ? clock.staffMessageTa : clock.staffMessage);
  const zoneWords = !zoneAttention ? '' : shop(lang === 'ta' ? zone.staffMessageTa : zone.staffMessage);
  const holdWords = !held ? '' : shop(lang === 'ta' ? hold.staffMessageTa : hold.staffMessage);
  return { show, tone, icon: tone === 'error' ? 'circle-alert' : 'clock', words, zoneWords, holdWords, billsHeading: w.billsHeading(flagMinutes), bills: rows };
}
