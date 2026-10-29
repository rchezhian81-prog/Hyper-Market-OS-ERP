// The Floor heat map page (M04-FR-04 "heat-map readiness and sales per square foot" · OB-308, owner, 23 Oct 2026: the full
// floor-plan heat-map screen — coordinates per shelf area, coloured by sales or margin per square foot, English and Tamil).
// A tested, DOM-free session.
//
// It reads head office's heat map (GET /v1/merchandising/stores/:storeId/heat-map?from&to&measure) on a click. Head office
// folds every figure from its own records — the banked bills, the average buying cost, the planograms — so nothing on
// this page is typed. An area whose margin is not known (a product sold with no buying cost) shows "not known" with the
// products named, never a colour; a product sold with no shelf place on the plan is listed under the map. Read-only.

import type { ViewerIdentity } from './browser-entry';
import type { Outcome } from './r4-insight-call';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

/** Today in the shop's own zone (packages/calendar shop-clock), never the browser's or UTC — the reading window's default
 *  last day (its first day is the 1st of that month). From 18:30 UTC, and in a browser on UTC, the browser's own date is
 *  still yesterday in the shop. */
export const todayAtShop = (nowIso: string = new Date().toISOString()): string => shopDateIn(nowIso);

export type Lang = 'en' | 'ta';
export type Measure = 'sales' | 'margin';
export type Ratio = { readonly kind: 'per_sq_ft'; readonly minorPerSqFt: number } | { readonly kind: 'not_meaningful'; readonly because: string };

export interface HeatAreaView {
  readonly areaId: string; readonly name: string; readonly nameTa: string | null;
  readonly x: number; readonly y: number; readonly width: number; readonly depth: number; readonly squareFeet: number;
  readonly products: readonly string[]; readonly salesMinor: number; readonly marginMinor: number | null; readonly marginNotKnownFor: readonly string[];
  readonly salesPerSqFt: Ratio; readonly marginPerSqFt: Ratio; readonly heat: number | null; readonly underperforming: boolean;
}
export interface HeatMapRead {
  readonly storeId: string; readonly from: string; readonly to: string; readonly measure: Measure; readonly planVersion: number;
  readonly widthFt: number; readonly depthFt: number; readonly areas: readonly HeatAreaView[];
  readonly notOnFloorPlan: { readonly products: readonly string[]; readonly salesMinor: number }; readonly asAt: string;
}

export const HEAT_MAP_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Floor heat map',
    lead: 'Each shelf area on the shop floor, coloured by what it earns per square foot — from the bills, the buying cost and the shelf plans head office holds. Darker earns more. Nothing here is typed.',
    store: 'Store', from: 'From', to: 'To', sales: 'Sales per sq ft', margin: 'Margin per sq ft', show: 'Show the heat map',
    area: 'Area', sqft: 'Sq ft', perSqFt: 'per sq ft', heat: 'Heat', note: 'Note', earned: 'Taken', marginK: 'Margin',
    notKnown: 'Not known', marginNotKnown: 'Margin not known — no buying cost for', noSpace: 'No floor space recorded', nothingSold: 'Nothing sold here',
    underperforming: 'Earns less than its share of space', offPlan: 'Sold but not on the floor plan', offPlanNone: 'Every product sold has a place on the floor plan.',
    legendLow: 'Earns least', legendHigh: 'Earns most', legendUnknown: 'Not known', plan: 'Floor plan version', asAt: 'As at', mapLabel: 'The shop floor, seen from above; the entrance is at the bottom.',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot read space performance.',
    needStore: 'Type the store first.', needDates: 'Choose the first and the last day.', noPlan: 'This store has no floor plan yet — the merchandiser draws one first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    lang: 'English', title: 'தள வெப்ப வரைபடம்',
    lead: 'கடைத் தளத்தின் ஒவ்வொரு அலமாரிப் பகுதியும், சதுர அடிக்கு அது ஈட்டுவதைப் பொறுத்து வண்ணமிடப்பட்டுள்ளது — தலைமை அலுவலகத்தின் பில்கள், கொள்முதல் விலை மற்றும் அலமாரித் திட்டங்களிலிருந்து. அடர்ந்த வண்ணம் அதிகம் ஈட்டுகிறது. இங்கு எதுவும் தட்டச்சு செய்யப்படவில்லை.',
    store: 'கடை', from: 'முதல்', to: 'வரை', sales: 'சதுர அடிக்கு விற்பனை', margin: 'சதுர அடிக்கு லாபம்', show: 'வெப்ப வரைபடத்தைக் காட்டு',
    area: 'பகுதி', sqft: 'சதுர அடி', perSqFt: 'சதுர அடிக்கு', heat: 'வெப்பம்', note: 'குறிப்பு', earned: 'வசூல்', marginK: 'லாபம்',
    notKnown: 'தெரியவில்லை', marginNotKnown: 'லாபம் தெரியவில்லை — கொள்முதல் விலை இல்லை:', noSpace: 'தள இடம் பதிவு செய்யப்படவில்லை', nothingSold: 'இங்கு எதுவும் விற்கப்படவில்லை',
    underperforming: 'இடத்தின் பங்கை விடக் குறைவாக ஈட்டுகிறது', offPlan: 'விற்கப்பட்டது, ஆனால் தளத் திட்டத்தில் இல்லை', offPlanNone: 'விற்கப்பட்ட ஒவ்வொரு பொருளுக்கும் தளத் திட்டத்தில் இடம் உள்ளது.',
    legendLow: 'குறைவாக ஈட்டுகிறது', legendHigh: 'அதிகம் ஈட்டுகிறது', legendUnknown: 'தெரியவில்லை', plan: 'தளத் திட்டப் பதிப்பு', asAt: 'நிலவரம்', mapLabel: 'மேலிருந்து பார்க்கும் கடைத் தளம்; நுழைவாயில் கீழே உள்ளது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு இட செயல்திறனைப் படிக்க முடியாது.',
    needStore: 'முதலில் கடையைத் தட்டச்சு செய்யவும்.', needDates: 'முதல் மற்றும் கடைசி நாளைத் தேர்ந்தெடுக்கவும்.', noPlan: 'இந்தக் கடைக்கு இன்னும் தளத் திட்டம் இல்லை — வணிகப் பொறுப்பாளர் முதலில் வரைய வேண்டும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;

export const heatMapWords = (lang: Lang, key: string): string =>
  (HEAT_MAP_COPY[lang] as Record<string, string>)[key] ?? (HEAT_MAP_COPY.en as Record<string, string>)[key] ?? key;

export function heatMapOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return out.status === 404 && /floor plan/.test(out.whatHappened) ? heatMapWords(lang, 'noPlan') : `${heatMapWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return heatMapWords(lang, out.why);
  if (out.result === 'lost_link') return heatMapWords(lang, 'unreachable');
  return '';
}

/** Rupees from paise, Indian grouping. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The colour step (0 lightest … 4 darkest) for a heat of 0–100; null when the figure is not known. */
export function heatBand(heat: number | null): number | null {
  if (heat === null) return null;
  return Math.min(4, Math.max(0, Math.floor(heat / 20)));
}

/** An area's name in the reader's language (Tamil when the plan gives one). */
export const areaName = (lang: Lang, a: Pick<HeatAreaView, 'name' | 'nameTa'>): string => (lang === 'ta' && a.nameTa !== null ? a.nameTa : a.name);

/** The figure shown for an area on the chosen measure, in words. */
export function figureWords(lang: Lang, a: HeatAreaView, measure: Measure): string {
  const w = (k: string) => heatMapWords(lang, k);
  if (measure === 'margin' && a.marginMinor === null) return `${w('notKnown')}`;
  const r = measure === 'sales' ? a.salesPerSqFt : a.marginPerSqFt;
  return r.kind === 'per_sq_ft' ? `${rupees(r.minorPerSqFt)} ${w('perSqFt')}` : w('noSpace');
}

/** Everything a person should know about one area beyond its figure — each in words. */
export function areaNotes(lang: Lang, a: HeatAreaView, measure: Measure): readonly string[] {
  const w = (k: string) => heatMapWords(lang, k);
  const notes: string[] = [];
  if (measure === 'margin' && a.marginMinor === null) notes.push(`${w('marginNotKnown')} ${a.marginNotKnownFor.join(', ')}`);
  if (a.salesMinor === 0) notes.push(w('nothingSold'));
  if (a.underperforming) notes.push(w('underperforming'));
  return notes;
}

export interface HeatMapSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(input: { readonly storeId: string; readonly from: string; readonly to: string; readonly measure: Measure }): Promise<Outcome<HeatMapRead>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createHeatMapSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch }): HeatMapSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('merchandising.space.read') };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  return {
    may,
    read: async ({ storeId, from, to, measure }) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      if (storeId.trim() === '') return { result: 'invalid', why: 'needStore' };
      if (!DAY.test(from) || !DAY.test(to)) return { result: 'invalid', why: 'needDates' };
      const q = new URLSearchParams({ from, to, measure });
      try {
        const res = await http(`/v1/merchandising/stores/${encodeURIComponent(storeId.trim())}/heat-map?${q.toString()}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) { const e = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: e.code ?? String(res.status), whatHappened: e.whatHappened ?? `status ${res.status}` }; }
        return { result: 'ok', value: json as unknown as HeatMapRead };
      } catch { return { result: 'lost_link' }; }
    },
  };
}
