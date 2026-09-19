// The stock-health dashboard — the manager's read-only view of the one true stock record (M08 · API-04 ·
// P-03 control-by-exception · P-08 no silent failure). Every stock CHANGE happens elsewhere (a POS sale, a
// goods receipt, a write-off) on its own screen; this screen changes nothing. It reads the numbers the system
// already projects from the append-only movement ledger and lays them out so a manager can see, at a glance,
// where the money tied up in stock is working and where it is asleep or bleeding:
//
//   • **Exceptions first** (P-03): negative stock — an impossible on-hand that means the ledger and the shelf
//     disagree — surfaced worst-first, because it is the one thing a manager must chase today.
//   • **The honest gaps are named, never papered over** (P-08): stock received with no cost recorded is shown
//     as its own figure, never valued at a guess; a ratio that cannot be computed (GMROI with no known tax
//     rate) is shown as "not meaningful", never a made-up number.
//   • **Freshness is a fact on the page**: every figure carries the moment it was true, and a page served from
//     the offline cache says so — nobody acts on this morning's numbers believing they are this minute's.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. It is read-only: no write path, no approval, no AI (hard rule #5 does not even
// arise — nothing here commits anything).

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import type { Ratio } from '../../../packages/stock/src/metrics';

// ── what the screen was last told (the five inventory reads, folded into one snapshot) ──────────────────────

/** On-hand availability for one product at one location (`GET /v1/inventory/availability`). */
export interface AvailabilityRowView {
  readonly productId: string;
  readonly locationId: string;
  /** On-hand quantity in minor units (×100). */
  readonly onHandMinor: number;
}

/** A negative on-hand — the ledger says less than nothing is on the shelf (`GET /v1/inventory/exceptions`). */
export interface NegativeStockView {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  /** The server's plain-English explanation and suggested owner action — data, shown as-is. */
  readonly detail: string;
  readonly ownerAction: string;
}

/** Stock valued at weighted-average cost (`GET /v1/inventory/valuation`). */
export interface ValuationView {
  readonly totalValueMinor: number;
  readonly currency: string;
}

/** Stock aged by how long the money has been asleep (`GET /v1/inventory/ageing`). */
export interface AgeingView {
  /** Value of the oldest bucket (over 90 days) — money that has been sitting longest. */
  readonly oldestBucketValueMinor: number;
  readonly totalValueMinor: number;
  /** On-hand received with no cost, so it cannot be valued — stated separately, never guessed (P-08). */
  readonly unvaluedMinor: number;
  readonly currency: string;
}

/** Stock productivity over a period (`GET /v1/inventory/performance`). Each ratio is honest about when it is
 *  not meaningful, and this screen passes that through rather than inventing a number. */
export interface PerformanceView {
  readonly turns: Ratio;
  readonly daysOfCover: Ratio;
  readonly gmroi: Ratio;
}

/**
 * Everything the box last told this screen about stock, each section optional and each carrying its own `asAt`.
 * A section the box knows nothing about is absent (not a zero) — the screen then simply does not show that
 * figure rather than reporting a false zero.
 */
export interface StockHealthData {
  readonly availability?: readonly AvailabilityRowView[];
  readonly negative?: readonly NegativeStockView[];
  readonly valuation?: ValuationView;
  readonly ageing?: AgeingView;
  readonly performance?: PerformanceView;
  /** When each section was true (ISO). The overall "as of" is the most recent of these. */
  readonly asAt?: {
    readonly availability?: string;
    readonly negative?: string;
    readonly valuation?: string;
    readonly ageing?: string;
    readonly performance?: string;
  };
}

export interface StockHealthPorts {
  /** The stock-health snapshot the shell last read (live from the cloud, or the injected stand-in). */
  snapshot(): StockHealthData;
  /** Whether this user may read stock health (`inventory.availability.read`). */
  mayRead(): boolean;
}

export interface StockHealthConfig {
  /** Who is looking. `null` means the box was not told who is at the screen (shown as a gentle note). */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'signalsHeading' | 'kpisHeading' | 'asOfLabel' | 'refresh'
  | 'sigHealthy' | 'sigNegative' | 'sigUncosted' | 'sigAged'
  | 'ownerActionLabel'
  | 'kpiStockValue' | 'kpiUncosted' | 'kpiAged' | 'kpiTurns' | 'kpiDaysOfCover' | 'kpiGmroi'
  | 'notMeaningful' | 'unitsWord'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const STOCK_HEALTH_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Stock health', langName: 'தமிழ்',
    lead: 'The health of the money tied up in your stock — read from the one true stock record. Nothing is changed here. What needs attention is at the top; the headline figures are below, each with the time it was true.',
    signalsHeading: 'What needs attention', kpisHeading: 'The numbers', asOfLabel: 'As of', refresh: 'Refresh',
    sigHealthy: 'Stock looks healthy — nothing to chase.',
    sigNegative: 'Negative stock — the record and the shelf disagree',
    sigUncosted: 'Stock with no cost recorded — it cannot be valued',
    sigAged: 'Stock over 90 days — money sitting still',
    ownerActionLabel: 'What to do',
    kpiStockValue: 'Stock value', kpiUncosted: 'Stock with no cost', kpiAged: 'Stock over 90 days',
    kpiTurns: 'Stock turns', kpiDaysOfCover: 'Days of cover', kpiGmroi: 'Margin per rupee of stock (GMROI)',
    notMeaningful: 'Not enough data to say',
    unitsWord: 'units',
    scrReady: 'Showing your stock health', scrEmpty: 'This screen has not been given any stock figures yet.',
    stateNotPermitted: 'You do not have permission to see stock health.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'சரக்கு நலன்', langName: 'English',
    lead: 'உங்கள் சரக்கில் முடங்கியுள்ள பணத்தின் நலன் — உண்மையான ஒரே சரக்குப் பதிவிலிருந்து வாசிக்கப்படுகிறது. இங்கே எதுவும் மாற்றப்படவில்லை. கவனம் தேவைப்படுவது மேலே; தலைப்பு எண்கள் கீழே, ஒவ்வொன்றும் அது உண்மையாக இருந்த நேரத்துடன்.',
    signalsHeading: 'கவனம் தேவைப்படுவது', kpisHeading: 'எண்கள்', asOfLabel: 'நிலவரம்', refresh: 'புதுப்பி',
    sigHealthy: 'சரக்கு நன்றாக உள்ளது — துரத்த எதுவும் இல்லை.',
    sigNegative: 'எதிர்மறை சரக்கு — பதிவும் அலமாரியும் ஒத்துப்போகவில்லை',
    sigUncosted: 'விலை பதிவு இல்லாத சரக்கு — மதிப்பிட முடியாது',
    sigAged: '90 நாட்களுக்கு மேற்பட்ட சரக்கு — அசையாமல் இருக்கும் பணம்',
    ownerActionLabel: 'என்ன செய்ய வேண்டும்',
    kpiStockValue: 'சரக்கு மதிப்பு', kpiUncosted: 'விலை இல்லாத சரக்கு', kpiAged: '90 நாட்களுக்கு மேற்பட்ட சரக்கு',
    kpiTurns: 'சரக்கு சுழற்சி', kpiDaysOfCover: 'ஈடுசெய்யும் நாட்கள்', kpiGmroi: 'சரக்கின் ஒரு ரூபாய்க்கு லாபம் (GMROI)',
    notMeaningful: 'சொல்ல போதிய தரவு இல்லை',
    unitsWord: 'அலகுகள்',
    scrReady: 'உங்கள் சரக்கு நலனைக் காட்டுகிறது', scrEmpty: 'இந்தத் திரைக்கு இன்னும் சரக்கு எண்கள் தரப்படவில்லை.',
    stateNotPermitted: 'சரக்கு நலனைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(STOCK_HEALTH_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export type SignalKind = 'healthy' | 'negative_stock' | 'uncosted_stock' | 'aged_stock';

/** One health signal, worst-first. `amountMinor` is a QUANTITY for negative stock (units ×100) and a MONEY
 *  value for uncosted/aged; the view reads `kind` to know which, so it never shows rupees as units. */
export interface PresentedSignal {
  readonly kind: SignalKind;
  readonly status: StatusPresentation;
  readonly productId: string | null;
  readonly locationId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /** Server-supplied specifics (e.g. the suggested owner action for a negative row); '' when none. */
  readonly detail: string;
}

/** A headline number. The value is typed so the view formats it right and never has to guess a unit; a ratio
 *  the engine could not compute arrives as `not_meaningful` with the reason, never a zero. */
export type KpiValue =
  | { readonly kind: 'money'; readonly minor: number; readonly currency: string }
  | { readonly kind: 'ratio'; readonly bp: number }
  | { readonly kind: 'not_meaningful'; readonly because: string };

export interface PresentedKpi {
  readonly key: 'stockValue' | 'uncosted' | 'aged' | 'turns' | 'daysOfCover' | 'gmroi';
  readonly label: string;
  readonly value: KpiValue;
  /** True when this figure is one to watch (uncosted or aged stock above zero) — a word, not a colour. */
  readonly attention: boolean;
}

export interface StockHealthView {
  readonly screenState: StatusPresentation;
  /** The most recent "as of" across the sections shown, or null when nothing has been read yet. */
  readonly asOf: string | null;
  /** Worst-first health signals — this is the primary list the shell renders. */
  readonly signals: readonly PresentedSignal[];
  readonly kpis: readonly PresentedKpi[];
  readonly nobodyNamed: boolean;
}

export interface StockHealthSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): StockHealthView;
}

const kpiFromRatio = (r: Ratio): KpiValue =>
  r.kind === 'ratio' ? { kind: 'ratio', bp: r.bp } : { kind: 'not_meaningful', because: r.because };

/** The most recent ISO timestamp among the sections present (string compare is correct for ISO-8601). */
const mostRecent = (times: readonly (string | undefined)[]): string | null => {
  const present = times.filter((t): t is string => typeof t === 'string' && t !== '');
  if (present.length === 0) return null;
  return present.reduce((a, b) => (a >= b ? a : b));
};

export function createStockHealthSession(config: StockHealthConfig, ports: StockHealthPorts): StockHealthSession {
  const text = (lang: Lang, key: CopyKey): string => translator(STOCK_HEALTH_COPY, lang)(key);

  return {
    text,
    view: (lang) => {
      const t = translator(STOCK_HEALTH_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          asOf: null, signals: [], kpis: [], nobodyNamed,
        };
      }

      const data = ports.snapshot();
      const hasAny = data.availability !== undefined || data.negative !== undefined
        || data.valuation !== undefined || data.ageing !== undefined || data.performance !== undefined;

      if (!hasAny) {
        return {
          screenState: presentScreenState({ state: 'empty', label: t('scrEmpty') }),
          asOf: null, signals: [], kpis: [], nobodyNamed,
        };
      }

      const signals: PresentedSignal[] = [];

      // Exceptions first (P-03). Negative stock, worst (most negative) first — the ledger and shelf disagree.
      for (const row of (data.negative ?? []).slice().sort((a, b) => a.onHandMinor - b.onHandMinor)) {
        signals.push({
          kind: 'negative_stock',
          status: presentStatus({
            tone: 'error', icon: '⚠', label: t('sigNegative'),
            announcement: `${t('sigNegative')}: ${row.productId} @ ${row.locationId}`, needsAttention: true,
          }),
          productId: row.productId, locationId: row.locationId, amountMinor: row.onHandMinor, currency: null,
          detail: row.ownerAction,
        });
      }

      // Uncosted stock — received without a cost, so it cannot be valued. Named, never valued at a guess (P-08).
      if (data.ageing !== undefined && data.ageing.unvaluedMinor > 0) {
        signals.push({
          kind: 'uncosted_stock',
          status: presentStatus({
            tone: 'degraded', icon: '❓', label: t('sigUncosted'),
            announcement: t('sigUncosted'), needsAttention: true,
          }),
          productId: null, locationId: null, amountMinor: data.ageing.unvaluedMinor, currency: data.ageing.currency,
          detail: '',
        });
      }

      // Aged stock — money asleep over 90 days.
      if (data.ageing !== undefined && data.ageing.oldestBucketValueMinor > 0) {
        signals.push({
          kind: 'aged_stock',
          status: presentStatus({
            tone: 'degraded', icon: '🕰', label: t('sigAged'),
            announcement: t('sigAged'), needsAttention: true,
          }),
          productId: null, locationId: null, amountMinor: data.ageing.oldestBucketValueMinor, currency: data.ageing.currency,
          detail: '',
        });
      }

      // Nothing to chase — a settled OK state that still carries an icon and a word (colour is never alone).
      if (signals.length === 0) {
        signals.push({
          kind: 'healthy',
          status: presentStatus({ tone: 'ok', icon: '✓', label: t('sigHealthy'), announcement: t('sigHealthy'), needsAttention: false }),
          productId: null, locationId: null, amountMinor: null, currency: null, detail: '',
        });
      }

      const kpis: PresentedKpi[] = [];
      if (data.valuation !== undefined) {
        kpis.push({ key: 'stockValue', label: t('kpiStockValue'), value: { kind: 'money', minor: data.valuation.totalValueMinor, currency: data.valuation.currency }, attention: false });
      }
      if (data.ageing !== undefined) {
        kpis.push({ key: 'uncosted', label: t('kpiUncosted'), value: { kind: 'money', minor: data.ageing.unvaluedMinor, currency: data.ageing.currency }, attention: data.ageing.unvaluedMinor > 0 });
        kpis.push({ key: 'aged', label: t('kpiAged'), value: { kind: 'money', minor: data.ageing.oldestBucketValueMinor, currency: data.ageing.currency }, attention: data.ageing.oldestBucketValueMinor > 0 });
      }
      if (data.performance !== undefined) {
        kpis.push({ key: 'turns', label: t('kpiTurns'), value: kpiFromRatio(data.performance.turns), attention: false });
        kpis.push({ key: 'daysOfCover', label: t('kpiDaysOfCover'), value: kpiFromRatio(data.performance.daysOfCover), attention: false });
        kpis.push({ key: 'gmroi', label: t('kpiGmroi'), value: kpiFromRatio(data.performance.gmroi), attention: false });
      }

      const asOf = mostRecent([
        data.asAt?.availability, data.asAt?.negative, data.asAt?.valuation, data.asAt?.ageing, data.asAt?.performance,
      ]);

      return {
        screenState: presentScreenState({ state: 'ready', label: t('scrReady') }),
        asOf, signals, kpis, nobodyNamed,
      };
    },
  };
}
