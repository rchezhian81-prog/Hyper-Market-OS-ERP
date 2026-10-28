// The Packaging and crates page (M28-FR-03 "Carry bags, reusable packaging and packaging inventory" · P-08). A tested,
// DOM-free session over head office's own packaging back-office routes (services/inventory/src/packaging.ts):
//   • REGISTER an item — carry bag, reusable crate, delivery bag, cold box, wrapping — whether it comes back (returnable),
//     and its charge, tax and deposit (the item master the till's price pack carries; the carry-bag CHARGE itself is the
//     till's, priced offline from that pack — hard rule 1 — never here);
//   • RECORD a movement — received, given to a customer, sent out with a delivery, returned, written off (a write-off is a
//     compensating movement, never a deletion — hard rule 2);
//   • READ an item's position at a branch — on hand (shown NEGATIVE when it is: that is the evidence a goods-in was never
//     entered, never clamped to zero), and for a returnable how many are still out, and the loss rate.
// Head office re-checks every permission and every branch (another branch is refused by name); `may` only shapes what is
// offered. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';

export { rupees };
export type Lang = 'en' | 'ta';

export const PACKAGING_KINDS = ['carry_bag', 'reusable_crate', 'delivery_bag', 'cold_box', 'wrapping'] as const;
export const PACKAGING_MOVES = ['received', 'issued_to_customer', 'issued_to_delivery', 'returned', 'written_off'] as const;

export const PACKAGING_COPY = {
  en: {
    title: 'Packaging and crates', lead: 'Carry bags, crates, delivery bags and cold boxes kept like any other stock — what came in, what went out, what came back. For crates and cold boxes: how many are still out and never came back.',
    positionH: 'Where an item stands', item: 'Item code', branch: 'Branch code', show: 'Show the position',
    onHand: 'On hand', negativeWarn: 'NEGATIVE — more went out than was ever recorded coming in. A goods-in was probably never entered.',
    inCirculation: 'Still out (not come back)', issued: 'Sent out in all', returned: 'Came back in all', writtenOff: 'Written off', lossRate: 'Never came back', notMeaningful: 'not measurable yet',
    registerH: 'Register or restate an item', name: 'Name', kind: 'Kind', returnable: 'Comes back (returnable)', charge: 'Charge to the customer (₹, optional)', tax: 'Tax rate (%, optional)', deposit: 'Deposit (₹, optional)', register: 'Save the item',
    k_carry_bag: 'Carry bag', k_reusable_crate: 'Reusable crate', k_delivery_bag: 'Delivery bag', k_cold_box: 'Cold box', k_wrapping: 'Wrapping',
    moveH: 'Record a movement', move: 'What happened', qty: 'How many', reference: 'Reference (optional)', recordMove: 'Record it',
    m_received: 'Received', m_issued_to_customer: 'Given to a customer', m_issued_to_delivery: 'Sent out with a delivery', m_returned: 'Came back', m_written_off: 'Written off (lost or broken)',
    registered: 'Saved at head office.', moved: 'Recorded at head office.',
    needPosition: 'Write the item code and the branch code.', needItem: 'Write the item code, a name and its kind; charge, tax and deposit must be numbers if given.', needMove: 'Write the item code, the branch, what happened and a whole number more than 0.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read packaging stock.', cannotMove: 'Your role cannot register packaging or record its movements.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'பொதிப் பொருட்களும் கூடைகளும்', lead: 'பைகள், கூடைகள், டெலிவரிப் பைகள், குளிர்ப் பெட்டிகள் — மற்ற சரக்கைப் போலவே: வந்தது, போனது, திரும்பி வந்தது. கூடைகள், குளிர்ப் பெட்டிகளுக்கு: இன்னும் வெளியே இருப்பவை, திரும்பி வராதவை.',
    positionH: 'ஒரு பொருளின் நிலை', item: 'பொருள் குறியீடு', branch: 'கிளைக் குறியீடு', show: 'நிலையைக் காட்டு',
    onHand: 'கையிருப்பு', negativeWarn: 'எதிர்மறை — உள்ளே வந்ததாகப் பதிவானதை விட அதிகம் வெளியே போனது. ஒரு வரவு பதிவு செய்யப்படவில்லை போலும்.',
    inCirculation: 'இன்னும் வெளியே (திரும்பவில்லை)', issued: 'மொத்தம் வெளியே அனுப்பியது', returned: 'மொத்தம் திரும்பி வந்தது', writtenOff: 'தள்ளுபடி செய்தது', lossRate: 'திரும்பி வராதது', notMeaningful: 'இன்னும் அளவிட முடியாது',
    registerH: 'ஒரு பொருளைப் பதிவு செய் அல்லது மாற்று', name: 'பெயர்', kind: 'வகை', returnable: 'திரும்பி வரும் (திரும்பத்தக்கது)', charge: 'வாடிக்கையாளர் கட்டணம் (₹, விருப்பம்)', tax: 'வரி விகிதம் (%, விருப்பம்)', deposit: 'வைப்புத் தொகை (₹, விருப்பம்)', register: 'பொருளைச் சேமி',
    k_carry_bag: 'கைப்பை', k_reusable_crate: 'மறுபயன்பாட்டுக் கூடை', k_delivery_bag: 'டெலிவரிப் பை', k_cold_box: 'குளிர்ப் பெட்டி', k_wrapping: 'சுற்றுதாள்',
    moveH: 'ஒரு நகர்வைப் பதிவு செய்', move: 'என்ன நடந்தது', qty: 'எத்தனை', reference: 'குறிப்பு (விருப்பம்)', recordMove: 'பதிவு செய்',
    m_received: 'பெறப்பட்டது', m_issued_to_customer: 'வாடிக்கையாளருக்குக் கொடுத்தது', m_issued_to_delivery: 'டெலிவரியுடன் அனுப்பியது', m_returned: 'திரும்பி வந்தது', m_written_off: 'தள்ளுபடி (தொலைந்தது அல்லது உடைந்தது)',
    registered: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', moved: 'தலைமை அலுவலகத்தில் பதிவானது.',
    needPosition: 'பொருள் குறியீட்டையும் கிளைக் குறியீட்டையும் எழுதுங்கள்.', needItem: 'பொருள் குறியீடு, பெயர், வகை ஆகியவற்றை எழுதுங்கள்; கட்டணம், வரி, வைப்பு கொடுத்தால் எண்களாக இருக்க வேண்டும்.', needMove: 'பொருள் குறியீடு, கிளை, என்ன நடந்தது, 0-ஐ விட அதிகமான முழு எண் ஆகியவற்றை எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி பொதிப் பொருள் இருப்பைப் படிக்க முடியாது.', cannotMove: 'உங்கள் பணி பொதிப் பொருட்களைப் பதிவு செய்யவோ நகர்வுகளைப் பதிவு செய்யவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const packagingWords = (lang: Lang, key: string): string =>
  (PACKAGING_COPY[lang] as Record<string, string>)[key] ?? (PACKAGING_COPY.en as Record<string, string>)[key] ?? key;

export interface PackagingPosition {
  readonly packagingId: string; readonly name: string; readonly branchId: string; readonly onHand: number; readonly inCirculation: number;
  readonly issuedTotal: number; readonly returnedTotal: number; readonly writtenOff: number; readonly lossRateBps: number | 'not_meaningful'; readonly negative: boolean; readonly detail: string;
}
export interface ItemForm { readonly packagingId: string; readonly name: string; readonly kind: string; readonly returnable: boolean; readonly chargeRupees: string; readonly taxPercent: string; readonly depositRupees: string }
export interface MoveForm { readonly packagingId: string; readonly branchId: string; readonly kind: string; readonly qty: string; readonly reference: string }

type Why = 'nobody' | 'cannotRead' | 'cannotMove' | 'needPosition' | 'needItem' | 'needMove';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;

export interface PackagingSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly move: boolean };
  position(packagingId: string, branchId: string): Done<PackagingPosition>;
  register(form: ItemForm): Done<{ readonly packagingId: string; readonly kind: string; readonly returnable: boolean }>;
  move(form: MoveForm): Done<{ readonly movementId: string; readonly qty: number }>;
}

const seg = (s: string): string => encodeURIComponent(s.trim());
/** "5" or "12.5" percent → basis points (500, 1250). Empty → undefined; anything else → null. */
export function bpsOf(percentText: string): number | null | undefined {
  const v = percentText.replace(/[%\s]/g, '');
  if (v === '') return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
const optionalPaise = (t: string): number | null | undefined => (t.trim() === '' ? undefined : paiseOf(t));

export const packagingOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => packagingWords(lang, k), out);
  const v = (out.value ?? {}) as Record<string, unknown>;
  return packagingWords(lang, typeof v['movementId'] === 'string' ? 'moved' : 'registered');
};

export function createPackagingSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newMovementId?: () => string; readonly now?: () => string;
}): PackagingSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('inventory.availability.read'), move: named && held.has('inventory.movement.append') };
  const call = makeCaller({ keyPrefix: 'packaging', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const movementIdOf = input.newMovementId ?? (() => newId('pmv'));
  const now = input.now ?? (() => new Date().toISOString()); // the moment it was recorded, as head office stamps any act
  const gate = (need: 'read' | 'move', why: Why): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why } : undefined;
  return {
    may,
    position: async (packagingId, branchId) => {
      const no = gate('read', 'cannotRead'); if (no !== undefined) return no;
      if (packagingId.trim() === '' || branchId.trim() === '') return { result: 'invalid', why: 'needPosition' };
      return call('GET', `/v1/packaging/items/${seg(packagingId)}/position?branchId=${seg(branchId)}`);
    },
    register: async (f) => {
      const no = gate('move', 'cannotMove'); if (no !== undefined) return no;
      const chargeMinor = optionalPaise(f.chargeRupees); const depositMinor = optionalPaise(f.depositRupees); const taxRateBps = bpsOf(f.taxPercent);
      if (f.packagingId.trim() === '' || f.name.trim() === '' || !(PACKAGING_KINDS as readonly string[]).includes(f.kind)
        || chargeMinor === null || depositMinor === null || taxRateBps === null) return { result: 'invalid', why: 'needItem' };
      return call('POST', `/v1/packaging/items/${seg(f.packagingId)}`, {
        name: f.name.trim(), kind: f.kind, returnable: f.returnable,
        ...(chargeMinor === undefined ? {} : { chargeMinor }), ...(taxRateBps === undefined ? {} : { taxRateBps }), ...(depositMinor === undefined ? {} : { depositMinor }),
      });
    },
    move: async (f) => {
      const no = gate('move', 'cannotMove'); if (no !== undefined) return no;
      const qty = /^\d+$/.test(f.qty.trim()) ? Number(f.qty.trim()) : 0;
      if (f.packagingId.trim() === '' || f.branchId.trim() === '' || !(PACKAGING_MOVES as readonly string[]).includes(f.kind) || qty <= 0) return { result: 'invalid', why: 'needMove' };
      return call('POST', `/v1/packaging/items/${seg(f.packagingId)}/movements/${encodeURIComponent(movementIdOf())}`, {
        branchId: f.branchId.trim(), kind: f.kind, qty, at: now(), ...(f.reference.trim() === '' ? {} : { reference: f.reference.trim() }),
      });
    },
  };
}
