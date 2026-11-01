// The Expiry page's "Taken off sale" tab (M10-FR-01 "expired stock auto-moves to expired state (not sellable)" · P-08 ·
// Round 4b — the re-audit's note that `GET /v1/inventory/expired-batches` was read by no screen). A tested, DOM-free THIN
// client: head office's own expired register — every batch the daily sweep moved off sale, newest first, with how much of
// it is STILL on the shelf to be binned and the write-offs that binned it. Quantities in the item's own unit ("2.500 kg").
// It reads only; binning is a write-off on the Record a write-off page. Nothing is read on open.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { quantityLabel } from '../../../packages/contracts/src/quantity';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const EXPIRED_REGISTER_COPY = {
  en: {
    tab: 'Taken off sale', title: 'Taken off sale', lead: 'Every batch head office moved off sale because its date passed — newest first — and how much of it is still on the shelf to throw away.',
    place: 'Place (leave for every place you cover)', show: 'Show what was taken off sale', none: 'Nothing has been taken off sale.',
    toBin: 'still on the shelf — throw it away and record a write-off', binned: 'Thrown away', batch: 'Batch', noBatch: 'no batch number', expired: 'expired', at: 'at',
    moved: 'Taken off sale', left: 'Still on the shelf', writeOffs: 'Write-offs', countToBin: 'batches still to throw away', movedBy: 'by the daily expiry check',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read stock.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    tab: 'விற்பனையிலிருந்து நீக்கியவை', title: 'விற்பனையிலிருந்து நீக்கியவை', lead: 'தேதி கடந்ததால் தலைமை அலுவலகம் விற்பனையிலிருந்து நீக்கிய ஒவ்வொரு தொகுதியும் — புதியவை முதலில் — அதில் இன்னும் எவ்வளவு அடுக்கில் எறிய வேண்டியுள்ளது.',
    place: 'இடம் (நீங்கள் பார்க்கும் எல்லா இடங்களுக்கும் விடுங்கள்)', show: 'விற்பனையிலிருந்து நீக்கியதைக் காட்டு', none: 'எதுவும் விற்பனையிலிருந்து நீக்கப்படவில்லை.',
    toBin: 'இன்னும் அடுக்கில் உள்ளது — எறிந்து தள்ளுபடியைப் பதிவு செய்யுங்கள்', binned: 'எறியப்பட்டது', batch: 'தொகுதி', noBatch: 'தொகுதி எண் இல்லை', expired: 'காலாவதி', at: 'இடம்',
    moved: 'விற்பனையிலிருந்து நீக்கியது', left: 'இன்னும் அடுக்கில்', writeOffs: 'தள்ளுபடிகள்', countToBin: 'இன்னும் எறிய வேண்டிய தொகுதிகள்', movedBy: 'தினசரி காலாவதி சோதனையால்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி இருப்பைப் படிக்க முடியாது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;

export const expiredWords = (lang: Lang, key: string): string =>
  (EXPIRED_REGISTER_COPY[lang] as Record<string, string>)[key] ?? (EXPIRED_REGISTER_COPY.en as Record<string, string>)[key] ?? key;

export interface ExpiredRow {
  readonly productId: string; readonly locationId: string; readonly batchId: string | null; readonly expiry: string; readonly onHandMinor: number;
  readonly shopDay: string; readonly movedAt: string; readonly remainingMinor: number; readonly toBin: boolean;
  readonly writeOffs: readonly { readonly id: string; readonly qtyRemoved: number; readonly at: string }[];
}
export interface ExpiredRegister { readonly batches: readonly ExpiredRow[]; readonly count: number; readonly toBinCount: number; readonly asAt: string }

/** One row as a person reads it — the item's name and quantities in its own unit when the store computer was told them. */
export function expiredRowView(lang: Lang, r: ExpiredRow, names: Readonly<Record<string, string>>, units: Readonly<Record<string, string>>) {
  const u = units[r.productId] ?? '';
  const q = (n: number): string => quantityLabel(n, u);
  return {
    key: `${r.locationId}|${r.productId}|${r.batchId ?? ''}`, toBin: r.toBin,
    heading: `${names[r.productId] ?? r.productId} · ${r.batchId === null ? expiredWords(lang, 'noBatch') : `${expiredWords(lang, 'batch')} ${r.batchId}`} · ${expiredWords(lang, 'expired')} ${r.expiry} · ${expiredWords(lang, 'at')} ${r.locationId}`,
    figures: `${expiredWords(lang, 'moved')} ${q(r.onHandMinor)} (${r.shopDay}, ${expiredWords(lang, 'movedBy')}) · ${expiredWords(lang, 'left')} ${q(r.remainingMinor)}`,
    state: r.toBin ? `⚠ ${expiredWords(lang, 'toBin')}` : expiredWords(lang, 'binned'),
    writeOffs: r.writeOffs.length === 0 ? '' : `${expiredWords(lang, 'writeOffs')}: ${r.writeOffs.map((w) => `${q(w.qtyRemoved)} (${shopDateIn(w.at, servedShopZone())})`).join(' · ')}`,
  };
}

export const expiredOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => expiredWords(lang, k), out);

export interface ExpiredRegisterSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(locationId: string): Promise<Outcome<ExpiredRegister, 'nobody' | 'cannotRead'>>;
}

export function createExpiredRegisterSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
}): ExpiredRegisterSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('inventory.availability.read') };
  const call = makeCaller({ keyPrefix: 'expired', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    read: async (locationId) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const place = locationId.trim();
      return call('GET', `/v1/inventory/expired-batches${place === '' ? '' : `?locationId=${encodeURIComponent(place)}`}`);
    },
  };
}
