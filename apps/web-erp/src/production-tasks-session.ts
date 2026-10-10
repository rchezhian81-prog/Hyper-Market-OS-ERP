// FUL-13 (Batch 2) — the PRODUCTION STAFF's task paths on the production screen, over the EXISTING production APIs
// (M11-FR-01/02/04 · API-04 · §28 · P-05 · P-07 · P-08). The quality-release desk (production-session.ts) was the only
// production surface; the staff who MAKE the food had no screen. Two tasks join it, each a human write on an explicit
// click, in the person's own session — the server re-checks every rule and the screen never fakes a success:
//
//   • **Record a run** (`production.plan.commit` → `POST /v1/production/runs/:runId`): which recipe, how many batches,
//     what actually came out, the batch id written on the trays, where it was made. The ingredients leave the shelf at
//     head office in the same write; the finished batch waits in QUARANTINE until quality releases it. Refused here for
//     a missing field or a number that is not whole — before anything is sent.
//   • **Print the label** (`production.recipe.manage` → `POST /v1/production/runs/:runId/label`): for a run on the
//     board — the product name, net quantity, packer details, price and allergens. The use-by and batch are the RUN's
//     (head office's), never typed here; a label missing a legally required field is refused by head office, in its words.
//
// DOM-free and bilingual like every ERP screen model; the shell renders only what this hands over.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

export type TaskPostResult<T> = { readonly result: 'done'; readonly value: T } | { readonly result: 'refused'; readonly reason: string } | { readonly result: 'lost_link' };

/** The authenticated POST of a run (body `{ recipeId, batches, actualOutputMinor, outputBatchId, locationId }`). */
export interface RunCommitPort {
  post(input: { readonly runId: string; readonly recipeId: string; readonly batches: number; readonly actualOutputMinor: number; readonly outputBatchId: string; readonly locationId: string }): Promise<TaskPostResult<{ readonly runId: string }>>;
}
/** The authenticated POST of a label; head office answers the rendered lines. */
export interface LabelPort {
  post(input: { readonly runId: string; readonly productName: string; readonly netQuantity: string; readonly packerDetails: string; readonly priceMinor: number; readonly allergens?: readonly string[] }): Promise<TaskPostResult<{ readonly lines: readonly string[] }>>;
}

export interface ProductionTasksPorts {
  /** `production.plan.commit` */
  mayCommit(): boolean;
  /** `production.recipe.manage` — the label route's own right. */
  mayLabel(): boolean;
  commitPort(): RunCommitPort | null;
  labelPort(): LabelPort | null;
  /** The runs on the board (any state) a label may be printed for. */
  runs(): readonly { readonly runId: string; readonly outputProductId: string; readonly outputBatchId: string; readonly expiresAt: string }[];
}

export interface ProductionTasksConfig {
  readonly userId: string | null;
  /** The kitchen / production location this screen records runs at, when the store computer said; else typed. */
  readonly defaultLocationId: string | null;
}

export type CopyKey =
  | 'runHeading' | 'runRecipeLabel' | 'runBatchesLabel' | 'runOutputLabel' | 'runBatchIdLabel' | 'runLocationLabel' | 'runBtn' | 'runHint'
  | 'runRecorded' | 'runRefused' | 'runLostLink' | 'runNotPermitted' | 'runNobody' | 'runMissing' | 'runBadNumber' | 'runNoLink'
  | 'labelHeading' | 'labelRunLabel' | 'labelNameLabel' | 'labelNetLabel' | 'labelPackerLabel' | 'labelPriceLabel' | 'labelAllergensLabel' | 'labelAllergensHint' | 'labelBtn'
  | 'labelPrinted' | 'labelRefused' | 'labelLostLink' | 'labelNotPermitted' | 'labelNobody' | 'labelNoRun' | 'labelMissingName' | 'labelBadPrice' | 'labelNoLink' | 'labelNoRuns'
  | 'noRun' | 'noLabel';

export const PRODUCTION_TASKS_COPY: BilingualCopy<CopyKey> = {
  en: {
    runHeading: 'Record a run', runRecipeLabel: 'Recipe', runBatchesLabel: 'How many batches', runOutputLabel: 'What actually came out', runBatchIdLabel: 'Batch id on the trays', runLocationLabel: 'Made at',
    runBtn: 'Record the run', runHint: 'The ingredients leave the shelf now; the finished batch waits in quarantine until quality releases it.',
    runRecorded: 'Run recorded — the batch is in quarantine until quality releases it.', runRefused: 'Head office refused the run:', runLostLink: 'No connection — the run was not recorded. Try again.',
    runNotPermitted: 'You do not have permission to record a production run.', runNobody: 'This store computer has not been told who is using this screen — a run carries a name.',
    runMissing: 'Fill in the recipe, the batch id and where it was made.', runBadNumber: 'Batches and what came out are whole numbers above zero.',
    runNoLink: 'This page cannot reach head office, so nothing can be recorded from it.',
    labelHeading: 'Print the label', labelRunLabel: 'Which batch', labelNameLabel: 'Name on the label', labelNetLabel: 'Net quantity', labelPackerLabel: 'Packed by',
    labelPriceLabel: 'Price (₹)', labelAllergensLabel: 'Allergens', labelAllergensHint: 'comma separated, e.g. wheat, milk — or "none"', labelBtn: 'Print the label',
    labelPrinted: 'Label ready — the batch and use-by are the run\'s own.', labelRefused: 'Head office refused the label:', labelLostLink: 'No connection — no label was made. Try again.',
    labelNotPermitted: 'You do not have permission to print production labels.', labelNobody: 'This store computer has not been told who is using this screen.',
    labelNoRun: 'That batch is not on the board.', labelMissingName: 'A label needs the name to print.', labelBadPrice: 'The price is rupees and paise, e.g. 120 or 120.50.',
    labelNoLink: 'This page cannot reach head office, so no label can be made from it.', labelNoRuns: 'No batch on the board to label yet.',
    noRun: 'You can see the board, but recording a run needs the production-planning permission.', noLabel: 'You can see the board, but printing labels needs the recipe permission.',
  },
  ta: {
    runHeading: 'உற்பத்தியைப் பதிவு செய்', runRecipeLabel: 'செய்முறை', runBatchesLabel: 'எத்தனை தொகுதிகள்', runOutputLabel: 'உண்மையில் வந்தது', runBatchIdLabel: 'தட்டுகளில் உள்ள தொகுதி எண்', runLocationLabel: 'செய்த இடம்',
    runBtn: 'உற்பத்தியைப் பதிவு செய்', runHint: 'பொருட்கள் இப்போதே அடுக்கிலிருந்து வெளியேறும்; தரம் விடுவிக்கும் வரை முடிந்த தொகுதி தனிமைப்படுத்தலில் இருக்கும்.',
    runRecorded: 'உற்பத்தி பதிவாகியது — தரம் விடுவிக்கும் வரை தொகுதி தனிமைப்படுத்தலில் உள்ளது.', runRefused: 'தலைமை அலுவலகம் மறுத்தது:', runLostLink: 'இணைப்பு இல்லை — பதிவாகவில்லை. மீண்டும் முயற்சிக்கவும்.',
    runNotPermitted: 'உற்பத்தியைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.', runNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை — பதிவில் பெயர் இருக்கும்.',
    runMissing: 'செய்முறை, தொகுதி எண், செய்த இடம் ஆகியவற்றை நிரப்புங்கள்.', runBadNumber: 'தொகுதிகளும் வந்ததும் பூஜ்ஜியத்திற்கு மேல் முழு எண்கள்.',
    runNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் இங்கிருந்து பதிவு செய்ய முடியாது.',
    labelHeading: 'லேபிளை அச்சிடு', labelRunLabel: 'எந்தத் தொகுதி', labelNameLabel: 'லேபிளில் பெயர்', labelNetLabel: 'நிகர அளவு', labelPackerLabel: 'பொதி செய்தவர்',
    labelPriceLabel: 'விலை (₹)', labelAllergensLabel: 'ஒவ்வாமைப் பொருட்கள்', labelAllergensHint: 'காற்புள்ளியால் பிரிக்கவும், எ.கா. கோதுமை, பால் — அல்லது "none"', labelBtn: 'லேபிளை அச்சிடு',
    labelPrinted: 'லேபிள் தயார் — தொகுதியும் காலாவதியும் உற்பத்தியினுடையவை.', labelRefused: 'தலைமை அலுவலகம் லேபிளை மறுத்தது:', labelLostLink: 'இணைப்பு இல்லை — லேபிள் உருவாகவில்லை. மீண்டும் முயற்சிக்கவும்.',
    labelNotPermitted: 'உற்பத்தி லேபிள்களை அச்சிட உங்களுக்கு அனுமதி இல்லை.', labelNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    labelNoRun: 'அந்தத் தொகுதி பலகையில் இல்லை.', labelMissingName: 'லேபிளுக்கு அச்சிட பெயர் தேவை.', labelBadPrice: 'விலை ரூபாய் மற்றும் பைசா, எ.கா. 120 அல்லது 120.50.',
    labelNoLink: 'இந்தப் பக்கம் தலைமை அலுவலகத்தை அடைய முடியாது, அதனால் லேபிள் உருவாக்க முடியாது.', labelNoRuns: 'லேபிளிட இன்னும் பலகையில் தொகுதி இல்லை.',
    noRun: 'பலகையைப் பார்க்கலாம், ஆனால் உற்பத்தியைப் பதிவு செய்ய உற்பத்தித் திட்ட அனுமதி தேவை.', noLabel: 'பலகையைப் பார்க்கலாம், ஆனால் லேபிள் அச்சிட செய்முறை அனுமதி தேவை.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(PRODUCTION_TASKS_COPY.en) as CopyKey[]);

export interface RunInput { readonly runId?: string; readonly recipeId: string; readonly batches: string; readonly actualOutput: string; readonly batchId: string; readonly locationId: string }
export interface LabelInput { readonly runId: string; readonly productName: string; readonly netQuantity: string; readonly packerDetails: string; readonly price: string; readonly allergens: string }

export type RunOutcome =
  | { readonly outcome: 'recorded'; readonly runId: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'lost_link' | 'not_permitted' | 'nobody' | 'missing' | 'bad_number' | 'no_link' };
export type LabelOutcome =
  | { readonly outcome: 'printed'; readonly lines: readonly string[] }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'lost_link' | 'not_permitted' | 'nobody' | 'no_run' | 'missing_name' | 'bad_price' | 'no_link' };

export interface ProductionTasksView {
  readonly canRecordRun: boolean;
  readonly canLabel: boolean;
  readonly nobodyNamed: boolean;
  readonly defaultLocationId: string | null;
  /** The batches a label may be printed for — newest use-by last, each named by its product and batch. */
  readonly labelRuns: readonly { readonly runId: string; readonly label: string }[];
}

export interface ProductionTasksSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ProductionTasksView;
  recordRun(input: RunInput): Promise<RunOutcome>;
  printLabel(input: LabelInput): Promise<LabelOutcome>;
  presentRun(lang: Lang, o: RunOutcome): StatusPresentation;
  presentLabel(lang: Lang, o: LabelOutcome): StatusPresentation;
}

const whole = (raw: string): number | undefined => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);
/** Rupees typed by a person → paise, exactly (no float): "120" → 12000, "120.5" → 12050, "120.50" → 12050. */
export function rupeesToPaise(raw: string): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (m === null) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
let counter = 0;
const freshRunId = (): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  counter += 1;
  return uuid === undefined ? `run-${Date.now()}-${counter}` : `run-${uuid.slice(0, 8)}`;
};

export function createProductionTasksSession(config: ProductionTasksConfig, ports: ProductionTasksPorts): ProductionTasksSession {
  const text = (lang: Lang, key: CopyKey): string => translator(PRODUCTION_TASKS_COPY, lang)(key);
  const nobodyNamed = config.userId === null;
  const result = (lang: Lang, tone: 'ok' | 'degraded' | 'error', key: CopyKey, extra = ''): StatusPresentation =>
    presentStatus({ tone, icon: tone === 'ok' ? '✓' : tone === 'error' ? '✕' : '⚠', label: `${text(lang, key)}${extra === '' ? '' : ` ${extra}`}`, needsAttention: tone !== 'ok' });
  return {
    text,
    view: () => ({
      canRecordRun: !nobodyNamed && ports.mayCommit() && ports.commitPort() !== null,
      canLabel: !nobodyNamed && ports.mayLabel() && ports.labelPort() !== null,
      nobodyNamed,
      defaultLocationId: config.defaultLocationId,
      labelRuns: ports.runs().slice().sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.runId.localeCompare(b.runId))
        .map((r) => ({ runId: r.runId, label: `${r.outputProductId} · ${r.outputBatchId}` })),
    }),

    recordRun: async (input) => {
      if (!ports.mayCommit()) return { outcome: 'not_permitted' };
      if (nobodyNamed) return { outcome: 'nobody' };
      const port = ports.commitPort();
      if (port === null) return { outcome: 'no_link' };
      const recipeId = input.recipeId.trim(); const batchId = input.batchId.trim(); const locationId = input.locationId.trim();
      if (recipeId === '' || batchId === '' || locationId === '') return { outcome: 'missing' };
      const batches = whole(input.batches); const out = whole(input.actualOutput);
      if (batches === undefined || batches <= 0 || out === undefined || out <= 0) return { outcome: 'bad_number' };
      const runId = (input.runId ?? '').trim() === '' ? freshRunId() : input.runId!.trim();
      const posted = await port.post({ runId, recipeId, batches, actualOutputMinor: out, outputBatchId: batchId, locationId });
      if (posted.result === 'done') return { outcome: 'recorded', runId: posted.value.runId };
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: 'lost_link' };
    },

    printLabel: async (input) => {
      if (!ports.mayLabel()) return { outcome: 'not_permitted' };
      if (nobodyNamed) return { outcome: 'nobody' };
      const port = ports.labelPort();
      if (port === null) return { outcome: 'no_link' };
      if (!ports.runs().some((r) => r.runId === input.runId)) return { outcome: 'no_run' };
      if (input.productName.trim() === '') return { outcome: 'missing_name' };
      const priceMinor = rupeesToPaise(input.price);
      if (priceMinor === undefined) return { outcome: 'bad_price' };
      // A BLANK allergen box is "not declared" — never "contains none" (a food-safety declaration is a person's act):
      // it is sent as no declaration, and head office refuses a label that needs one. "none" declares none.
      const typed = input.allergens.trim();
      const allergens = typed === '' ? undefined : typed.toLowerCase() === 'none' ? [] : typed.split(',').map((a) => a.trim()).filter((a) => a !== '');
      const posted = await port.post({ runId: input.runId, productName: input.productName.trim(), netQuantity: input.netQuantity.trim(), packerDetails: input.packerDetails.trim(), priceMinor, ...(allergens === undefined ? {} : { allergens }) });
      if (posted.result === 'done') return { outcome: 'printed', lines: posted.value.lines };
      if (posted.result === 'refused') return { outcome: 'refused', reason: posted.reason };
      return { outcome: 'lost_link' };
    },

    presentRun: (lang, o) => {
      switch (o.outcome) {
        case 'recorded': return result(lang, 'ok', 'runRecorded');
        case 'refused': return result(lang, 'error', 'runRefused', o.reason);
        case 'lost_link': return result(lang, 'degraded', 'runLostLink');
        case 'no_link': return result(lang, 'degraded', 'runNoLink');
        case 'not_permitted': return result(lang, 'error', 'runNotPermitted');
        case 'nobody': return result(lang, 'error', 'runNobody');
        case 'missing': return result(lang, 'error', 'runMissing');
        case 'bad_number': return result(lang, 'error', 'runBadNumber');
      }
    },
    presentLabel: (lang, o) => {
      switch (o.outcome) {
        case 'printed': return result(lang, 'ok', 'labelPrinted');
        case 'refused': return result(lang, 'error', 'labelRefused', o.reason);
        case 'lost_link': return result(lang, 'degraded', 'labelLostLink');
        case 'no_link': return result(lang, 'degraded', 'labelNoLink');
        case 'not_permitted': return result(lang, 'error', 'labelNotPermitted');
        case 'nobody': return result(lang, 'error', 'labelNobody');
        case 'no_run': return result(lang, 'error', 'labelNoRun');
        case 'missing_name': return result(lang, 'error', 'labelMissingName');
        case 'bad_price': return result(lang, 'error', 'labelBadPrice');
      }
    },
  };
}
