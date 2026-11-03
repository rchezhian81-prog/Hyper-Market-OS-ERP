// W4 · M11-FR-02 — Production costs: the page Finance reviews production costing on (§28 "costing reviewed by Finance"),
// a tested, DOM-free session over head office's `GET /v1/production/costs`. Per production run: what the ingredients it
// consumed were worth (each at its average buying cost, else its registered production cost — OB-68 / OB-70, the source
// named on every line), what one unit of the output therefore cost, and its yield against the recipe's.
//   • A YIELD OUTSIDE THE EXPECTED RANGE IS AN EXCEPTION (P-08): a run below or above the recipe's tolerance, or one that
//     consumed its inputs and made nothing, leads the list in error tone, with head office's own sentence and the money
//     the variance is worth. Never colour alone — a word rides with every tone.
//   • A RUN NOT VALUED says so by name (the ingredients with no cost), never as ₹0 (OB-75).
// The page asks its OWN permission, `production.cost.read` (the owner, the store manager and the accountant): it opens
// no production board, plan, release or cost registration. Head office re-checks it. Nothing is written from here.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { quantityLabel } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';

export interface CostLine { readonly productId: string; readonly quantityMinor: number; readonly uom: string; readonly unitCostMinor: number | null; readonly source: 'average_buying_cost' | 'registered_cost' | 'none'; readonly valueMinor: number | null }
export interface CostRun {
  readonly runId: string; readonly recipeId: string; readonly departmentId: string; readonly locationId: string;
  readonly outputProductId: string; readonly outputBatchId: string; readonly outputQuantityMinor: number; readonly outputUom: string;
  readonly at: string; readonly producedBy: string; readonly currency: string;
  readonly valued: boolean; readonly inputCostMinor: number | null; readonly unitCostPerWholeMinor: number | null;
  readonly lines: readonly CostLine[]; readonly notValuedBecause: readonly string[];
  readonly yieldBp: number; readonly yieldVerdict: string;
  readonly exceptions: readonly { readonly kind: string; readonly detail: string; readonly value?: { readonly minor: number; readonly currency: string } }[];
  readonly costBasis: 'run_cost' | 'registered_cost';
}
export interface CostsRead { readonly runs: readonly CostRun[]; readonly withExceptions: number; readonly notValued: number; readonly asAt: string }

export const PRODUCTION_COSTS_COPY = {
  en: {
    title: 'Production costs',
    lead: 'What each production run\'s output cost, from the ingredients it used — each at its average buying cost, or its registered production cost where there is none. A yield outside the recipe\'s range is an exception and comes first, with the money it is worth. A run with an ingredient that has no cost is shown as not valued, never as zero. This page only reads; nothing is changed from here.',
    cardRuns: 'Runs', cardExceptions: 'Yield exceptions', cardNotValued: 'Not valued',
    registerH: 'Runs and their cost', register: 'Production cost register',
    colWhen: 'Made', colBatch: 'Batch', colProduct: 'Product', colMade: 'Made', colInputCost: 'Ingredients cost', colUnitCost: 'Cost per unit', colYield: 'Yield', colState: 'State',
    w_exception: 'Exception', w_notValued: 'Not valued', w_ok: 'Costed',
    y_as_expected: 'as expected', y_low_yield: 'below the recipe', y_high_yield: 'above the recipe', y_not_measured: 'not measured',
    per: 'per', u_ea: 'piece', notValued: 'not valued', noCostFor: 'No cost for:', worth: 'worth',
    linesH: 'Ingredients used', src_average_buying_cost: 'average buying cost', src_registered_cost: 'registered production cost', src_none: 'no cost',
    basisRegistered: 'Recorded before run costing: shown on the registered production cost.',
    recipe: 'Recipe', department: 'Department', place: 'Made at', by: 'Recorded by', asAt: 'Head office answered at',
    emptyTitle: 'No production run recorded yet', emptyDetail: 'Runs recorded on the Production page appear here with their cost.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see production costs.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'உற்பத்திச் செலவு',
    lead: 'ஒவ்வொரு உற்பத்தி ஓட்டத்தின் விளைபொருளுக்கும் ஆன செலவு, அது பயன்படுத்திய பொருட்களிலிருந்து — ஒவ்வொன்றும் அதன் சராசரி வாங்கும் விலையில், அது இல்லையெனில் பதிவு செய்த உற்பத்திச் செலவில். சமையல் முறையின் வரம்புக்கு வெளியே உள்ள விளைச்சல் ஒரு விதிவிலக்கு, அது முதலில் வரும், அதன் பண மதிப்புடன். விலை இல்லாத பொருள் உள்ள ஓட்டம் மதிப்பிடப்படவில்லை என்று காட்டப்படும், பூஜ்யமாக அல்ல. இந்தப் பக்கம் படிக்க மட்டுமே; இங்கிருந்து எதுவும் மாற்றப்படாது.',
    cardRuns: 'ஓட்டங்கள்', cardExceptions: 'விளைச்சல் விதிவிலக்குகள்', cardNotValued: 'மதிப்பிடப்படாதவை',
    registerH: 'ஓட்டங்களும் அவற்றின் செலவும்', register: 'உற்பத்திச் செலவுப் பதிவேடு',
    colWhen: 'செய்த நேரம்', colBatch: 'தொகுதி', colProduct: 'பொருள்', colMade: 'செய்தது', colInputCost: 'பொருட்களின் செலவு', colUnitCost: 'அலகுச் செலவு', colYield: 'விளைச்சல்', colState: 'நிலை',
    w_exception: 'விதிவிலக்கு', w_notValued: 'மதிப்பிடப்படவில்லை', w_ok: 'செலவிடப்பட்டது',
    y_as_expected: 'எதிர்பார்த்தபடி', y_low_yield: 'முறைக்குக் கீழே', y_high_yield: 'முறைக்கு மேலே', y_not_measured: 'அளக்கப்படவில்லை',
    per: 'ஒன்றுக்கு', u_ea: 'எண்ணிக்கை', notValued: 'மதிப்பிடப்படவில்லை', noCostFor: 'விலை இல்லாதவை:', worth: 'மதிப்பு',
    linesH: 'பயன்படுத்திய பொருட்கள்', src_average_buying_cost: 'சராசரி வாங்கும் விலை', src_registered_cost: 'பதிவு செய்த உற்பத்திச் செலவு', src_none: 'விலை இல்லை',
    basisRegistered: 'ஓட்டச் செலவுக்கு முன் பதியப்பட்டது: பதிவு செய்த உற்பத்திச் செலவில் காட்டப்படுகிறது.',
    recipe: 'முறை', department: 'பிரிவு', place: 'செய்த இடம்', by: 'பதிந்தவர்', asAt: 'தலைமை அலுவலகம் பதிலளித்த நேரம்',
    emptyTitle: 'இன்னும் உற்பத்தி ஓட்டம் பதியப்படவில்லை', emptyDetail: 'உற்பத்திப் பக்கத்தில் பதியும் ஓட்டங்கள் அவற்றின் செலவுடன் இங்கே தெரியும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு உற்பத்திச் செலவைப் பார்க்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const productionCostsWords = (lang: Lang, key: string): string =>
  (PRODUCTION_COSTS_COPY[lang] as Record<string, string>)[key] ?? (PRODUCTION_COSTS_COPY.en as Record<string, string>)[key] ?? key;
export const productionCostsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => productionCostsWords(lang, k), out);

/** ₹ from paise. */
export const costRupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** How one run reads on the page: a state word and tone (exception → error, not valued → degraded), and its figures in words. */
export interface PresentedCostRun {
  readonly tone: 'error' | 'degraded' | 'ok';
  readonly stateWord: string;
  readonly made: string;
  readonly inputCost: string;
  readonly unitCost: string;
  readonly yieldWords: string;
  readonly exceptionLines: readonly string[];
  readonly notValuedLine: string | null;
  readonly lines: readonly string[];
}

export function presentCostRun(lang: Lang, r: CostRun): PresentedCostRun {
  const w = (k: string): string => productionCostsWords(lang, k);
  const amount = (q: number, uom: string): string => (uom === 'ea' ? `${quantityLabel(q, uom)} ${w('u_ea')}` : quantityLabel(q, uom));
  const unit = r.outputUom === 'ea' ? w('u_ea') : r.outputUom;
  const tone = r.exceptions.length > 0 ? 'error' : !r.valued ? 'degraded' : 'ok';
  return {
    tone,
    stateWord: w(tone === 'error' ? 'w_exception' : tone === 'degraded' ? 'w_notValued' : 'w_ok'),
    made: amount(r.outputQuantityMinor, r.outputUom),
    inputCost: r.inputCostMinor === null ? w('notValued') : costRupees(r.inputCostMinor),
    unitCost: r.unitCostPerWholeMinor === null ? w('notValued') : `${costRupees(r.unitCostPerWholeMinor)} ${w('per')} ${unit}`,
    yieldWords: `${(r.yieldBp / 100).toFixed(2)}% — ${w(`y_${r.yieldVerdict}`)}`,
    exceptionLines: r.exceptions.map((e) => (e.value === undefined ? e.detail : `${e.detail} (${w('worth')} ${costRupees(e.value.minor)})`)),
    notValuedLine: r.notValuedBecause.length === 0 ? null : `${w('noCostFor')} ${r.notValuedBecause.join(', ')}`,
    lines: r.lines.map((l) => `${l.productId} — ${amount(l.quantityMinor, l.uom)} — ${l.valueMinor === null ? w('notValued') : costRupees(l.valueMinor)} (${w(`src_${l.source}`)})`),
  };
}

type Why = 'nobody' | 'cannotRead';

export interface ProductionCostsSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(locationId?: string): Promise<Outcome<CostsRead, Why>>;
}

export function createProductionCostsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): ProductionCostsSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('production.cost.read') };
  const call = makeCaller({ keyPrefix: 'production-costs', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    read: async (locationId) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const place = (locationId ?? '').trim();
      return call<CostsRead>('GET', `/v1/production/costs${place === '' ? '' : `?locationId=${encodeURIComponent(place)}`}`);
    },
  };
}
