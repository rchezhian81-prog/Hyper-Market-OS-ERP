// The PRODUCTS NOBODY CAN SELL screen (SP-8c-ii · F08 · P-08 · M03-FR-03 · M10-FR-04 · Stage G slice 5c · hard rule: no
// silent failure). The store box builds the till's catalogue from the pack and, since G5c, EXCLUDES and COUNTS every product
// the lane cannot judge — no tax rate, no status, a unit of measure the pricing maths cannot make a quantity in — and ships a
// RECALLED product with its block so the lane refuses the scan by name. Those products reach the till payload as a list
// (`excludedProducts`) that no served screen ever showed a person (recorded 30 Sep 2026). A product missing from the till is
// a product nobody can sell, and the person who can fix it — the catalogue owner — had nowhere to see it.
//
// This screen shows that list, from the SAME function the till payload is built with (`unsellableProducts` in the box), so
// the two cannot disagree: whatever the till refuses or was never given is here, grouped by WHY, each with what to do about
// it, in both languages. Read-only — the fix is made on the Products screen and republished; nothing is decided here.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui primitives; the
// shell renders only what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** Why a product cannot be sold at the till — the box's own reasons, in the order a person should look at them (recall first). */
export const UNSELLABLE_REASONS = Object.freeze(['recall_block', 'no_tax_rate', 'no_status', 'unknown_uom', 'not_on_sale'] as const);
export type UnsellableReason = (typeof UNSELLABLE_REASONS)[number];

/** One product the till cannot sell, as the box found it. */
export interface UnsellableRow {
  readonly productId: string;
  readonly name: string;
  readonly nameTa?: string;
  readonly reason: UnsellableReason;
  /** The box's own sentence about the record (the unit it could not read, the status it saw…). */
  readonly detail: string;
}

/** What the box tells this screen. Absent means the box was told no catalogue at all. */
export interface UnsellableData {
  readonly storeId?: string;
  /** When the box received the pack these were judged from — the screen's "as of". */
  readonly asAt?: string;
  readonly rows?: readonly UnsellableRow[];
  /** How many products the till WAS given and can sell, so the list reads against something. */
  readonly sellableCount?: number;
}

export type CopyKey =
  | 'title' | 'lead' | 'asOf' | 'sellable' | 'oneProduct' | 'manyProducts' | 'whatToDo' | 'record'
  | 'scrReady' | 'scrClean' | 'scrUnknown'
  | 'r_recall_block' | 'd_recall_block' | 'r_no_tax_rate' | 'd_no_tax_rate' | 'r_no_status' | 'd_no_status'
  | 'r_unknown_uom' | 'd_unknown_uom' | 'r_not_on_sale' | 'd_not_on_sale';

export const UNSELLABLE_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Products nobody can sell',
    lead: 'What the till refuses or was never given, and why. The fix is made on the Products screen and published again; nothing is decided here.',
    asOf: 'From the catalogue the store computer received',
    sellable: 'products the till can sell',
    oneProduct: '1 product nobody can sell',
    manyProducts: '{n} products nobody can sell',
    whatToDo: 'What to do',
    record: 'On the record',
    scrReady: 'Every product below is refused at the till or was never given to it.',
    scrClean: 'Every product in the catalogue can be sold at the till.',
    scrUnknown: 'The store computer has not been given a catalogue, so it cannot say which products the till can sell.',
    r_recall_block: 'Under recall — the till refuses it by name, even offline',
    d_recall_block: 'Keep it off the shelf and out of the stockroom picks. The Expiry & recalls screen closes the recall; it stays blocked until then.',
    r_no_tax_rate: 'No tax rate on the catalogue — the till cannot price it',
    d_no_tax_rate: 'Give the product a tax class (HSN) on the Products screen and publish the catalogue again.',
    r_no_status: 'No status on the catalogue — the till cannot tell active from discontinued',
    d_no_status: 'Set the product active, clearance or discontinued on the Products screen and publish again.',
    r_unknown_uom: 'A unit of measure the till cannot price',
    d_unknown_uom: 'Use one of the known units (ea, kg, g, l, ml, pack…) on the Products screen and publish again.',
    r_not_on_sale: 'Not on sale — draft or discontinued',
    d_not_on_sale: 'Nothing to do unless it should sell: then set it active on the Products screen and publish again.',
  },
  ta: {
    title: 'யாரும் விற்க முடியாத பொருட்கள்',
    lead: 'கல்லா மறுக்கும் அல்லது கல்லாவுக்கு வழங்கப்படாத பொருட்கள், ஏன் என்ற காரணத்துடன். திருத்தம் பொருட்கள் திரையில் செய்து மீண்டும் வெளியிடப்படுகிறது; இங்கே எதுவும் முடிவு செய்யப்படுவதில்லை.',
    asOf: 'கடைக் கணினி பெற்ற பட்டியலின்படி',
    sellable: 'கல்லா விற்கக்கூடிய பொருட்கள்',
    oneProduct: 'யாரும் விற்க முடியாத பொருள் 1',
    manyProducts: 'யாரும் விற்க முடியாத பொருட்கள் {n}',
    whatToDo: 'என்ன செய்ய வேண்டும்',
    record: 'பதிவில்',
    scrReady: 'கீழே உள்ள ஒவ்வொரு பொருளும் கல்லாவில் மறுக்கப்படுகிறது அல்லது கல்லாவுக்கு வழங்கப்படவில்லை.',
    scrClean: 'பட்டியலில் உள்ள ஒவ்வொரு பொருளையும் கல்லாவில் விற்க முடியும்.',
    scrUnknown: 'கடைக் கணினிக்குப் பட்டியல் வழங்கப்படவில்லை. எனவே கல்லா எந்தப் பொருட்களை விற்க முடியும் என்று சொல்ல முடியாது.',
    r_recall_block: 'திரும்பப்பெறலில் உள்ளது — கல்லா பெயர் சொல்லி மறுக்கிறது, இணையம் இல்லாவிட்டாலும்',
    d_recall_block: 'அலமாரியிலும் கிடங்கு எடுப்பிலும் வைக்க வேண்டாம். காலாவதி மற்றும் திரும்பப்பெறல் திரை இதை முடிக்கும்; அதுவரை தடை நீடிக்கும்.',
    r_no_tax_rate: 'பட்டியலில் வரி விகிதம் இல்லை — கல்லா விலை போட முடியாது',
    d_no_tax_rate: 'பொருட்கள் திரையில் வரி வகுப்பு (HSN) கொடுத்து பட்டியலை மீண்டும் வெளியிடுங்கள்.',
    r_no_status: 'பட்டியலில் நிலை இல்லை — செயலில் உள்ளதா நிறுத்தப்பட்டதா என்று கல்லாவுக்குத் தெரியாது',
    d_no_status: 'பொருட்கள் திரையில் செயலில் / தீர்வு / நிறுத்தப்பட்டது என்று நிலையை அமைத்து மீண்டும் வெளியிடுங்கள்.',
    r_unknown_uom: 'கல்லா விலை போட முடியாத அளவு அலகு',
    d_unknown_uom: 'தெரிந்த அலகுகளில் ஒன்றை (ea, kg, g, l, ml, pack…) பொருட்கள் திரையில் பயன்படுத்தி மீண்டும் வெளியிடுங்கள்.',
    r_not_on_sale: 'விற்பனையில் இல்லை — வரைவு அல்லது நிறுத்தப்பட்டது',
    d_not_on_sale: 'விற்க வேண்டும் என்றால் மட்டும்: பொருட்கள் திரையில் செயலில் என்று அமைத்து மீண்டும் வெளியிடுங்கள்.',
  },
};
export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(UNSELLABLE_COPY.en) as CopyKey[]);

export interface PresentedUnsellable {
  readonly status: StatusPresentation;
  readonly productId: string;
  readonly name: string;
  readonly reason: UnsellableReason;
  readonly reasonLabel: string;
  readonly whatToDo: string;
  readonly detail: string;
}

export interface UnsellableGroup {
  readonly reason: UnsellableReason;
  readonly label: string;
  readonly whatToDo: string;
  readonly rows: readonly PresentedUnsellable[];
}

export interface UnsellableView {
  readonly screenState: StatusPresentation;
  readonly asOf: string | null;
  readonly count: number;
  readonly countLabel: string;
  readonly sellableCount: number | null;
  /** Recall first — a safety block before a catalogue gap — then the gaps in the order the box judges them. */
  readonly groups: readonly UnsellableGroup[];
  readonly rows: readonly PresentedUnsellable[];
}

export interface UnsellableSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): UnsellableView;
}

const REASON_COPY: Readonly<Record<UnsellableReason, { readonly r: CopyKey; readonly d: CopyKey }>> = Object.freeze({
  recall_block: { r: 'r_recall_block', d: 'd_recall_block' },
  no_tax_rate: { r: 'r_no_tax_rate', d: 'd_no_tax_rate' },
  no_status: { r: 'r_no_status', d: 'd_no_status' },
  unknown_uom: { r: 'r_unknown_uom', d: 'd_unknown_uom' },
  not_on_sale: { r: 'r_not_on_sale', d: 'd_not_on_sale' },
});

const isReason = (v: unknown): v is UnsellableReason => typeof v === 'string' && (UNSELLABLE_REASONS as readonly string[]).includes(v);

export function createUnsellableSession(data: UnsellableData): UnsellableSession {
  const text = (lang: Lang, key: CopyKey): string => translator(UNSELLABLE_COPY, lang)(key);
  return {
    text,
    view: (lang) => {
      const t = translator(UNSELLABLE_COPY, lang);
      const rows = data.rows;
      if (rows === undefined) {
        return { screenState: presentScreenState({ state: 'empty', label: t('scrUnknown') }), asOf: null, count: 0, countLabel: '', sellableCount: null, groups: [], rows: [] };
      }
      // A row with a reason this screen does not know is still a row nobody can sell: shown under "not on sale" rather than dropped.
      const present = (r: UnsellableRow): PresentedUnsellable => {
        const reason: UnsellableReason = isReason(r.reason) ? r.reason : 'not_on_sale';
        const reasonLabel = t(REASON_COPY[reason].r);
        const name = lang === 'ta' && r.nameTa !== undefined && r.nameTa !== '' ? r.nameTa : r.name;
        const status = reason === 'recall_block'
          ? presentStatus({ tone: 'error', icon: '⛔', label: reasonLabel, announcement: `${reasonLabel}: ${name}`, needsAttention: true })
          : presentStatus({ tone: 'degraded', icon: '⚠', label: reasonLabel, announcement: `${reasonLabel}: ${name}`, needsAttention: true });
        return { status, productId: r.productId, name, reason, reasonLabel, whatToDo: t(REASON_COPY[reason].d), detail: r.detail };
      };
      const presented = rows.map(present);
      const groups: UnsellableGroup[] = UNSELLABLE_REASONS
        .map((reason) => ({
          reason, label: t(REASON_COPY[reason].r), whatToDo: t(REASON_COPY[reason].d),
          rows: presented.filter((p) => p.reason === reason).sort((a, b) => a.productId.localeCompare(b.productId)),
        }))
        .filter((g) => g.rows.length > 0);
      const count = presented.length;
      return {
        screenState: count === 0
          ? presentScreenState({ state: 'empty', label: t('scrClean') })
          : presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf: data.asAt ?? null,
        count,
        countLabel: count === 1 ? t('oneProduct') : t('manyProducts').replace('{n}', String(count)),
        sellableCount: data.sellableCount ?? null,
        groups,
        rows: groups.flatMap((g) => g.rows),
      };
    },
  };
}
