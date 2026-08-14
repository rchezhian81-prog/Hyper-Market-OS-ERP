// Category policy — the operator view (owner continuation directive; M03-FR-01·CAT-POLICY; §19 · §27).
// WP1 built the effective-dated category-policy engine and WP1b the per-category presets; both are tested and
// wired read-only at POST /v1/catalogue/category-policy/resolve. This is the screen a person uses to SEE what
// each category is configured to do on the trading day, and — the point of the screen — to spot the ones that
// need attention: a controlled vertical shipped OFF (gold, pharmacy-lite), an age/KYC/PAN/serial control, a
// category blocked from sale, or a sellable category with NO policy in force at all.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone) and the tested
// packages/product engine (`resolvePolicy`); the shell only renders what this hands over. Read-only: nothing
// here changes a policy (a change is a new effective-dated entry, made through the audited catalogue path).

import {
  resolvePolicy,
  type CategoryPolicy, type CategoryPolicyRules, type ControlledSaleControl,
} from '../../../packages/product/src/index';
import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** The triage status of a category on the trading day. */
export type CategoryStatus = 'ok' | 'controlled' | 'blocked' | 'no_policy';
export const CATEGORY_STATUSES: readonly CategoryStatus[] = ['ok', 'controlled', 'blocked', 'no_policy'];

export interface CategoryPolicyPorts {
  /** Whether this user may read the catalogue configuration (`catalogue.pack.read`). */
  mayRead(): boolean;
  /** The categories and their dated policy histories. */
  categories(): readonly CategoryPolicy[];
  /** The store's trading day the policies are resolved on (e.g. "2026-08-14"). */
  readonly onDate: string;
}

export interface CategoryPolicyConfig {
  /** Who is looking. `null` means the box was not told. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'statusOk' | 'statusControlled' | 'statusBlocked' | 'statusNoPolicy'
  | 'trace' | 'traceNone' | 'traceBatch' | 'traceSerial'
  | 'valuation' | 'valMrp' | 'valRateWeight' | 'valWac' | 'valCostPlus'
  | 'qtyEach' | 'qtyWeighed' | 'qtyCatch'
  | 'ctrlAge' | 'ctrlKyc' | 'ctrlPan' | 'ctrlPrescription' | 'ctrlSerial' | 'ctrlDisabled' | 'ctrlBlockedSale'
  | 'flagNotReturnable' | 'flagBlockExpiry' | 'flagNearExpiry' | 'flagPerishable'
  | 'controlsTitle' | 'noControls' | 'noPolicyDetail'
  | 'attentionCount' | 'allClear'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted' | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const CATEGORY_POLICY_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Category rules', langName: 'தமிழ்',
    lead: 'What each category is set to do today. The ones needing attention are first — a controlled line (gold, pharmacy) shipped off, an age or ID check, a blocked category, or a category with no rules in force. Changing a rule is done in the catalogue, never here.',
    statusOk: 'In force', statusControlled: 'Controlled — needs setup or sign-off', statusBlocked: 'Blocked from sale', statusNoPolicy: 'No rules in force — set them',
    trace: 'Traceability', traceNone: 'none', traceBatch: 'batch + expiry', traceSerial: 'per-unit serial',
    valuation: 'Priced by', valMrp: 'MRP / price list', valRateWeight: 'rate × weight', valWac: 'weighted-average cost', valCostPlus: 'cost plus markup',
    qtyEach: 'each', qtyWeighed: 'weighed', qtyCatch: 'catch-weight',
    ctrlAge: 'Age check', ctrlKyc: 'Customer ID (KYC)', ctrlPan: 'PAN capture', ctrlPrescription: 'Prescription', ctrlSerial: 'Serial / IMEI capture',
    ctrlDisabled: 'Shipped OFF — enable + sign-off before it sells', ctrlBlockedSale: 'Blocked from sale here',
    flagNotReturnable: 'Not returnable', flagBlockExpiry: 'No sale past use-by', flagNearExpiry: 'Near-expiry alert', flagPerishable: 'Perishable (rotate FEFO)',
    controlsTitle: 'Controls', noControls: 'No special controls', noPolicyDetail: 'This category has no rules in force today — every sellable category needs a policy.',
    attentionCount: 'need attention', allClear: 'Every category’s rules are in force and clear.',
    stateReady: 'Showing category rules', stateEmpty: 'No categories have been configured yet.',
    stateNotPermitted: 'You do not have permission to see category rules.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'வகை விதிகள்', langName: 'English',
    lead: 'ஒவ்வொரு வகையும் இன்று என்ன செய்ய அமைக்கப்பட்டுள்ளது. கவனம் தேவைப்படுபவை முதலில் — கட்டுப்படுத்தப்பட்ட வரி (தங்கம், மருந்து) அணைக்கப்பட்டது, வயது அல்லது அடையாளச் சோதனை, தடைசெய்யப்பட்ட வகை, அல்லது விதிகள் இல்லாத வகை. விதியை மாற்றுவது பட்டியலில் செய்யப்படும், இங்கு அல்ல.',
    statusOk: 'நடைமுறையில்', statusControlled: 'கட்டுப்படுத்தப்பட்டது — அமைப்பு அல்லது ஒப்புதல் தேவை', statusBlocked: 'விற்பனை தடை', statusNoPolicy: 'விதிகள் இல்லை — அமைக்கவும்',
    trace: 'தடமறிதல்', traceNone: 'இல்லை', traceBatch: 'தொகுதி + காலாவதி', traceSerial: 'ஒவ்வொரு அலகு வரிசை',
    valuation: 'விலை அடிப்படை', valMrp: 'MRP / விலைப் பட்டியல்', valRateWeight: 'விகிதம் × எடை', valWac: 'சராசரிச் செலவு', valCostPlus: 'செலவு + லாபம்',
    qtyEach: 'ஒவ்வொன்றாக', qtyWeighed: 'எடையால்', qtyCatch: 'மாறும்-எடை',
    ctrlAge: 'வயது சோதனை', ctrlKyc: 'வாடிக்கையாளர் அடையாளம் (KYC)', ctrlPan: 'PAN பதிவு', ctrlPrescription: 'மருந்துச் சீட்டு', ctrlSerial: 'வரிசை / IMEI பதிவு',
    ctrlDisabled: 'அணைக்கப்பட்டது — விற்பனைக்கு முன் இயக்கி ஒப்புதல் பெறவும்', ctrlBlockedSale: 'இங்கு விற்பனை தடை',
    flagNotReturnable: 'திரும்பப்பெற முடியாது', flagBlockExpiry: 'காலாவதிக்குப் பின் விற்பனை இல்லை', flagNearExpiry: 'காலாவதி நெருங்கும் எச்சரிக்கை', flagPerishable: 'அழிந்துபோகும் (FEFO சுழற்சி)',
    controlsTitle: 'கட்டுப்பாடுகள்', noControls: 'சிறப்புக் கட்டுப்பாடுகள் இல்லை', noPolicyDetail: 'இந்த வகைக்கு இன்று விதிகள் இல்லை — ஒவ்வொரு விற்பனை வகைக்கும் ஒரு கொள்கை தேவை.',
    attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வகையின் விதிகளும் நடைமுறையில் உள்ளன, தெளிவாக உள்ளன.',
    stateReady: 'வகை விதிகளைக் காட்டுகிறது', stateEmpty: 'இன்னும் எந்த வகையும் அமைக்கப்படவில்லை.',
    stateNotPermitted: 'வகை விதிகளைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(CATEGORY_POLICY_COPY.en) as CopyKey[]);

const STATUS_LABEL: Readonly<Record<CategoryStatus, CopyKey>> = {
  ok: 'statusOk', controlled: 'statusControlled', blocked: 'statusBlocked', no_policy: 'statusNoPolicy',
};
const STATUS_FACE: Readonly<Record<CategoryStatus, { readonly tone: 'ok' | 'degraded' | 'error' | 'idle'; readonly icon: string; readonly attention: boolean }>> = {
  ok: { tone: 'ok', icon: '✓', attention: false },
  controlled: { tone: 'degraded', icon: '⚠', attention: true },
  blocked: { tone: 'idle', icon: '⛔', attention: false }, // deliberate config, not an error
  no_policy: { tone: 'error', icon: '✕', attention: true },
};
const CONTROL_LABEL: Readonly<Record<ControlledSaleControl, CopyKey>> = {
  age: 'ctrlAge', kyc: 'ctrlKyc', pan: 'ctrlPan', prescription: 'ctrlPrescription', serial_capture: 'ctrlSerial',
};

/** The triage status of a category's rules on the day — undefined rules means none is in force. */
export function statusOf(rules: CategoryPolicyRules | undefined): CategoryStatus {
  if (rules === undefined) return 'no_policy';
  if (rules.controlledSale.blocked === true) return 'blocked';
  if (!rules.enabledByDefault
    || rules.controlledSale.minimumAge !== undefined
    || (rules.controlledSale.requires?.length ?? 0) > 0) return 'controlled';
  return 'ok';
}

// ── presented shapes ─────────────────────────────────────────────────────────────────────────────────

export interface PresentedCategory {
  readonly categoryId: string;
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
  readonly inForce: boolean;
  /** The rule summary, present only when a policy is in force. */
  readonly summary?: { readonly trace: string; readonly quantity: string; readonly valuation: string };
  /** Translated control labels (age / KYC / PAN / serial / disabled / blocked). */
  readonly controls: readonly string[];
  /** Translated behaviour flags (not returnable, no-sale-past-expiry, near-expiry, perishable). */
  readonly flags: readonly string[];
  readonly detail: string;
}

export interface CategoryPolicyView {
  readonly screenState: StatusPresentation;
  readonly categories: readonly PresentedCategory[];
  readonly attentionCount: number;
  readonly total: number;
  readonly nobodyNamed: boolean;
}

export interface CategoryPolicySession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): CategoryPolicyView;
}

export function createCategoryPolicySession(config: CategoryPolicyConfig, ports: CategoryPolicyPorts): CategoryPolicySession {
  const text = (lang: Lang, key: CopyKey): string => translator(CATEGORY_POLICY_COPY, lang)(key);

  const traceKey: Readonly<Record<string, CopyKey>> = { none: 'traceNone', batch: 'traceBatch', serial: 'traceSerial' };
  const qtyKey: Readonly<Record<string, CopyKey>> = { each: 'qtyEach', weighed: 'qtyWeighed', catch_weight: 'qtyCatch' };
  const valKey: Readonly<Record<string, CopyKey>> = { retail_mrp: 'valMrp', rate_per_unit_weight: 'valRateWeight', weighted_average_cost: 'valWac', cost_plus_markup: 'valCostPlus' };

  const present = (lang: Lang, category: CategoryPolicy): PresentedCategory => {
    const t = translator(CATEGORY_POLICY_COPY, lang);
    const rules = resolvePolicy(category.history, ports.onDate);
    const status = statusOf(rules);
    const face = STATUS_FACE[status];
    const label = t(STATUS_LABEL[status]);

    const controls: string[] = [];
    const flags: string[] = [];
    if (rules !== undefined) {
      if (rules.controlledSale.blocked === true) controls.push(t('ctrlBlockedSale'));
      if (!rules.enabledByDefault) controls.push(t('ctrlDisabled'));
      if (rules.controlledSale.minimumAge !== undefined) controls.push(`${t('ctrlAge')} (${rules.controlledSale.minimumAge}+)`);
      for (const c of rules.controlledSale.requires ?? []) controls.push(t(CONTROL_LABEL[c]));
      if (!rules.returns.returnable) flags.push(t('flagNotReturnable'));
      if (rules.shelfLife.perishable) flags.push(t('flagPerishable'));
      if (rules.shelfLife.blockSaleAfterExpiry) flags.push(t('flagBlockExpiry'));
      if ((rules.shelfLife.nearExpiryAlertDays ?? 0) > 0) flags.push(`${t('flagNearExpiry')} (${rules.shelfLife.nearExpiryAlertDays}d)`);
    }

    return {
      categoryId: category.categoryId,
      status: presentStatus({ tone: face.tone, icon: face.icon, label, announcement: `${category.categoryId}: ${label}`, needsAttention: face.attention }),
      needsAttention: face.attention,
      inForce: rules !== undefined,
      ...(rules === undefined ? {} : { summary: { trace: t(traceKey[rules.traceability] ?? 'traceNone'), quantity: t(qtyKey[rules.quantityMode] ?? 'qtyEach'), valuation: t(valKey[rules.valuation] ?? 'valMrp') } }),
      controls: controls.length > 0 ? controls : (rules === undefined ? [] : [t('noControls')]),
      flags,
      detail: rules === undefined ? t('noPolicyDetail') : '',
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(CATEGORY_POLICY_COPY, lang);
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          categories: [], attentionCount: 0, total: 0, nobodyNamed: config.userId === null,
        };
      }
      const raw = ports.categories();
      const presented = raw.map((c) => present(lang, c));
      const ordered = [...presented].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return a.categoryId.localeCompare(b.categoryId);
      });
      const attentionCount = presented.filter((c) => c.needsAttention).length;
      const state = presented.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        categories: ordered,
        attentionCount,
        total: presented.length,
        nobodyNamed: config.userId === null,
      };
    },
  };
}
