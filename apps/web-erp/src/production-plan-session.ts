// W4 · M11-FR-01 "plan production" and M11-FR-03 "which batches went into a batch" — a tested, DOM-free session for two
// sections of the Production page, over head office's D-25 reads (services/inventory/src/production-plan.ts):
//   • the PLAN — `GET /v1/production/plan?locationId=&forDay=`: per recipe of a department the shop runs, the whole batches
//     the forecast says will sell before they expire (bounded by shelf life and expected yield; OB-199 "round down"), what
//     is left over (demand not covered, what one more batch would leave unsold), and a product with no sales to go by SAID
//     as such. It is ADVICE: nothing is made from here — a person records each run in the form below it (hard rule #5).
//   • the BATCH TRACE — `GET /v1/production/batches/:outputBatchId/inputs`: the ingredient batches that went into one
//     finished batch (how each was named: typed by the person, assigned earliest-expiry-first, or not known), and
//     `GET /v1/production/input-batches/:batchId/trace`: forward from an ingredient batch to every finished batch made with
//     it and that batch's sales — what a recall of an ingredient walks. Runs recorded before inputs were kept are COUNTED,
//     so a trace never reads "none" by omission (P-08).
// Reading the plan and a batch's inputs needs `production.read`; the forward trace needs `quality.lottrace.read` (head
// office re-checks each). Nothing is written. Every word here has a Tamil twin; head office's own sentences stay English.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { quantityLabel } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';

export type PlanLineState = 'proposed' | 'nothing_needed' | 'no_sales_history' | 'batch_bigger_than_need';
export interface PlanLine {
  readonly recipeId: string; readonly departmentId: string; readonly outputProductId: string; readonly outputUom: string;
  readonly sellingWindowDays: number; readonly windowFrom: string; readonly windowTo: string;
  readonly demandMinor: number; readonly onHandUsableMinor: number; readonly needMinor: number;
  readonly perBatchMinor: number; readonly proposedBatches: number; readonly proposedOutputMinor: number;
  readonly unmetMinor: number; readonly oneMoreBatchUnsoldMinor: number; readonly state: PlanLineState;
}
export interface PlanRead {
  readonly forDay: string; readonly locationId: string; readonly lines: readonly PlanLine[];
  readonly notOperated: readonly { readonly recipeId: string; readonly departmentId: string }[];
  readonly historyFrom: string; readonly historyTo: string; readonly asAt: string;
}
export interface InputBatch { readonly productId: string; readonly batchId: string | null; readonly quantityMinor: number; readonly uom: string; readonly source: 'captured' | 'fefo_assigned' | 'not_known' }
export interface BatchInputs { readonly outputBatchId: string; readonly runs: readonly { readonly runId: string; readonly outputProductId: string; readonly inputsRecorded: boolean; readonly inputBatches: readonly InputBatch[] }[] }
export interface ForwardTrace {
  readonly batchId: string;
  readonly outputs: readonly {
    readonly runId: string; readonly recipeId: string; readonly locationId: string; readonly at: string;
    readonly outputProductId: string; readonly outputBatchId: string; readonly outputQuantityMinor: number;
    readonly inputUsed: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string; readonly source: string }[];
    readonly soldCount: number;
  }[];
  readonly runsWithoutRecordedInputs: number;
}

export const PRODUCTION_PLAN_COPY = {
  en: {
    planH: 'Plan production', planLead: 'How many batches of each recipe to make for a day, from what has been selling. It never plans more than will sell before the food expires. It is advice: nothing is made from here — record each run in the form below.',
    location: 'Kitchen or bakery (stock place)', forDay: 'For which day (YYYY-MM-DD, blank for tomorrow)', showPlan: 'Show the plan',
    planFor: 'Plan for', historyFrom: 'learnt from sales', to: 'to', noLines: 'No recipe to plan here — add a recipe on the Recipes page for a department this shop runs.',
    colRecipe: 'Recipe', colMakes: 'Makes', colBatches: 'Batches', colDemand: 'Will sell', colOnHand: 'Still good on hand', colLeft: 'Left over',
    s_proposed: 'Make these', s_nothing_needed: 'Nothing needed — enough on hand', s_no_sales_history: 'No sales to go by yet — decide yourself', s_batch_bigger_than_need: 'One batch is more than will sell — decide yourself',
    unmet: 'not covered', oneMore: 'one more batch would leave unsold', useInForm: 'Put in the run form', putInForm: 'Recipe and batches put in the run form below. Check them, then record the run.',
    notOperated: 'Not planned — its department is not switched on here:',
    traceH: 'Trace a batch', traceLead: 'Type a finished batch code to see which ingredient batches went into it. Or type an ingredient batch code to see every batch made with it and how much of each was sold — what a recall walks.',
    batch: 'Batch code', showInputs: 'What went into it', traceForward: 'What it went into',
    inputsOf: 'Ingredient batches in', inputsNotRecorded: 'This run was recorded before ingredient batches were kept — not known.', noInputs: 'No ingredient batch named.',
    src_captured: 'named by the person', src_fefo_assigned: 'earliest expiry first', src_not_known: 'batch not known',
    batchNotKnown: 'not known', went: 'went into', sold: 'sales', none: 'No batch was made with it.', withoutInputs: 'runs recorded before ingredient batches were kept — they cannot be traced here',
    u_ea: 'pieces',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see production.', cannotTrace: 'Tracing forward needs the batch-trace permission (quality).',
    needLocation: 'Type the kitchen or bakery stock place.', badDay: 'Type the day as YYYY-MM-DD, or leave it blank for tomorrow.', needBatch: 'Type a batch code.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read. The plan and the trace need head office.', reading: 'Reading from head office…',
  },
  ta: {
    planH: 'உற்பத்தித் திட்டம்', planLead: 'ஒரு நாளுக்கு ஒவ்வொரு சமையல் முறையிலும் எத்தனை தொகுதிகள் செய்ய வேண்டும் — விற்பனையிலிருந்து. உணவு காலாவதியாகும் முன் விற்பதை விட அதிகமாக ஒருபோதும் திட்டமிடாது. இது ஆலோசனை மட்டுமே: இங்கிருந்து எதுவும் செய்யப்படாது — ஒவ்வொரு ஓட்டத்தையும் கீழே உள்ள படிவத்தில் பதியுங்கள்.',
    location: 'சமையலறை அல்லது பேக்கரி (சரக்கு இடம்)', forDay: 'எந்த நாளுக்கு (YYYY-MM-DD, நாளைக்கு காலியாக விடுங்கள்)', showPlan: 'திட்டத்தைக் காட்டு',
    planFor: 'திட்டம்', historyFrom: 'விற்பனையிலிருந்து கற்றது', to: 'முதல்', noLines: 'இங்கே திட்டமிட சமையல் முறை இல்லை — இந்தக் கடை நடத்தும் பிரிவுக்கு சமையல் முறைகள் பக்கத்தில் ஒன்றைச் சேருங்கள்.',
    colRecipe: 'முறை', colMakes: 'செய்வது', colBatches: 'தொகுதிகள்', colDemand: 'விற்கும்', colOnHand: 'கையிருப்பில் நல்லது', colLeft: 'மீதம்',
    s_proposed: 'இவற்றைச் செய்யுங்கள்', s_nothing_needed: 'தேவையில்லை — கையிருப்பு போதும்', s_no_sales_history: 'இன்னும் விற்பனை இல்லை — நீங்களே முடிவு செய்யுங்கள்', s_batch_bigger_than_need: 'ஒரு தொகுதி விற்பதை விட அதிகம் — நீங்களே முடிவு செய்யுங்கள்',
    unmet: 'ஈடுசெய்யப்படவில்லை', oneMore: 'இன்னொரு தொகுதி விற்காமல் விடும்', useInForm: 'ஓட்டப் படிவத்தில் இடு', putInForm: 'முறையும் தொகுதிகளும் கீழே உள்ள ஓட்டப் படிவத்தில் இடப்பட்டன. சரிபார்த்து ஓட்டத்தைப் பதியுங்கள்.',
    notOperated: 'திட்டமிடப்படவில்லை — அதன் பிரிவு இங்கே இயக்கப்படவில்லை:',
    traceH: 'ஒரு தொகுதியைத் தடமறி', traceLead: 'முடிந்த தொகுதிக் குறியீட்டைத் தட்டச்சு செய்து அதில் எந்தப் பொருள் தொகுதிகள் சென்றன என்று பாருங்கள். அல்லது ஒரு பொருள் தொகுதிக் குறியீட்டைத் தட்டச்சு செய்து அதைக் கொண்டு செய்த ஒவ்வொரு தொகுதியையும் எவ்வளவு விற்றது என்றும் பாருங்கள் — திரும்பப் பெறுதல் செல்லும் வழி.',
    batch: 'தொகுதிக் குறியீடு', showInputs: 'இதில் என்ன சென்றது', traceForward: 'இது எதில் சென்றது',
    inputsOf: 'பொருள் தொகுதிகள்', inputsNotRecorded: 'பொருள் தொகுதிகள் வைக்கப்படும் முன் இந்த ஓட்டம் பதியப்பட்டது — தெரியாது.', noInputs: 'எந்தப் பொருள் தொகுதியும் குறிப்பிடப்படவில்லை.',
    src_captured: 'நபர் குறிப்பிட்டது', src_fefo_assigned: 'முதலில் காலாவதியாவது முதலில்', src_not_known: 'தொகுதி தெரியாது',
    batchNotKnown: 'தெரியாது', went: 'சென்றது', sold: 'விற்பனைகள்', none: 'இதைக் கொண்டு எந்தத் தொகுதியும் செய்யப்படவில்லை.', withoutInputs: 'பொருள் தொகுதிகள் வைக்கப்படும் முன் பதிந்த ஓட்டங்கள் — இங்கே தடமறிய முடியாது',
    u_ea: 'எண்ணிக்கை',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு உற்பத்தியைப் பார்க்க முடியாது.', cannotTrace: 'முன்னோக்கித் தடமறிய தொகுதித் தடமறிதல் அனுமதி (தரம்) தேவை.',
    needLocation: 'சமையலறை அல்லது பேக்கரி சரக்கு இடத்தைத் தட்டச்சு செய்யுங்கள்.', badDay: 'நாளை YYYY-MM-DD என்று தட்டச்சு செய்யுங்கள், அல்லது நாளைக்கு காலியாக விடுங்கள்.', needBatch: 'ஒரு தொகுதிக் குறியீட்டைத் தட்டச்சு செய்யுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை. திட்டத்திற்கும் தடமறிதலுக்கும் தலைமை அலுவலகம் தேவை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const productionPlanWords = (lang: Lang, key: string): string =>
  (PRODUCTION_PLAN_COPY[lang] as Record<string, string>)[key] ?? (PRODUCTION_PLAN_COPY.en as Record<string, string>)[key] ?? key;
export const productionPlanOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => productionPlanWords(lang, k), out);

/** An amount in its unit's words ("2.5 kg", "12 pieces"), from the stored smallest step. */
export const planAmount = (lang: Lang, quantityMinor: number, uom: string): string => {
  const said = quantityLabel(quantityMinor, uom);
  return uom === 'ea' ? `${said} ${productionPlanWords(lang, 'u_ea')}` : said;
};

/** The words for a plan line's state — always a word, never a colour alone. */
export const planStateWords = (lang: Lang, state: PlanLineState): string => productionPlanWords(lang, `s_${state}`);

type Why = 'nobody' | 'cannotRead' | 'cannotTrace' | 'needLocation' | 'badDay' | 'needBatch';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ProductionPlanSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly trace: boolean };
  plan(input: { readonly locationId: string; readonly forDay?: string }): Promise<Outcome<PlanRead, Why>>;
  inputsOf(outputBatchId: string): Promise<Outcome<BatchInputs, Why>>;
  traceForward(inputBatchId: string): Promise<Outcome<ForwardTrace, Why>>;
}

export function createProductionPlanSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): ProductionPlanSession {
  const named = input.viewer?.userId !== undefined;
  const held = input.viewer?.permissions ?? [];
  const may = { named, read: named && held.includes('production.read'), trace: named && held.includes('quality.lottrace.read') };
  const call = makeCaller({ keyPrefix: 'production-plan', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  return {
    may,
    plan: async ({ locationId, forDay }) => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const place = locationId.trim(); const day = (forDay ?? '').trim();
      if (place === '') return no('needLocation');
      if (day !== '' && !DAY.test(day)) return no('badDay');
      const q = new URLSearchParams({ locationId: place, ...(day === '' ? {} : { forDay: day }) });
      return call<PlanRead>('GET', `/v1/production/plan?${q.toString()}`);
    },
    inputsOf: async (outputBatchId) => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const id = outputBatchId.trim();
      if (id === '') return no('needBatch');
      return call<BatchInputs>('GET', `/v1/production/batches/${encodeURIComponent(id)}/inputs`);
    },
    traceForward: async (inputBatchId) => {
      if (!named) return no('nobody');
      if (!may.trace) return no('cannotTrace');
      const id = inputBatchId.trim();
      if (id === '') return no('needBatch');
      return call<ForwardTrace>('GET', `/v1/production/input-batches/${encodeURIComponent(id)}/trace`);
    },
  };
}
