// The in-store PRODUCTION quality-release screen — the "which finished batches are still in quarantine, and
// which may go on sale" desk (M11-FR-03 · API-04 · P-03 control-by-exception · P-04 least privilege · P-05
// human-governed · P-08 no silent failure). The production service (services/inventory/src/production.ts) commits
// a run's finished batch into QUARANTINE and folds the board (`GET /v1/production/runs`); freshly produced food
// is NOT sellable because it exists — it is sellable when someone has looked at it and said so. This is the
// screen a QC operator works it from: every batch awaiting release — worst first — and the one action taken from
// here, RELEASE FOR SALE (or hold it on a failed check), in the releaser's own name.
//
// Truths the surface must carry, all already true in the service and re-stated so the screen cannot weaken them:
//   • **A batch in quarantine is not sellable** (M11-FR-03). The board shows batches whose run has NOT been
//     released, worst-first: a run carrying a production EXCEPTION (a yield variance, no output) shouts loudest
//     (error tone); a batch whose cost is NOT KNOWN (an uncosted ingredient — never faked as zero, P-08) or whose
//     yield drifted is a warning; a clean batch merely awaiting a look is neutral but still needs a human. Colour
//     is never the only signal (an icon + a word ride with every tone).
//   • **Releasing needs the release permission** (§28 / P-04 least privilege). A viewer with only
//     `production.read` sees the board but is offered no release control; the write needs `production.release`,
//     enforced here AND at the cloud route. Nothing is released automatically — this records what a QC operator
//     decided (hard rule #5: no AI releases food for sale), and a box never told who is at the screen releases
//     nothing at all.
//   • **You cannot release past a use-by date.** The server refuses a release for a failed check, an expired
//     batch or an already-released one; the screen never fakes a success it did not get (P-08). A FAILED check is
//     a real, recorded outcome that KEEPS the batch in quarantine — not a no-op.
//   • **It self-heals.** The board is re-READ from the cloud, so a released batch drops off on its own; this
//     screen never carries a "released" flag that can go stale against reality. A day the box was never told is
//     `not known`, never "nothing to release" (P-08).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives; the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** One production run's finished batch as the board last read it — the shape `GET /v1/production/runs` hands each
 *  row over. Only the fields this screen renders or decides on are named; extra fields are ignored. */
export interface ProductionRun {
  readonly runId: string;
  readonly departmentId: string;
  readonly outputProductId: string;
  readonly outputBatchId: string;
  readonly outputQuantityMinor: number;
  readonly outputUom: string;
  readonly expiresAt: string;
  readonly outputUnitCostMinor: number;
  readonly currency: string;
  /** True when every ingredient had a registered cost — the cost is then authoritative. */
  readonly costKnown: boolean;
  readonly uncostedProducts: readonly string[];
  readonly yieldVerdict: 'as_expected' | 'low_yield' | 'high_yield' | 'not_measured';
  readonly exceptions: readonly { readonly kind: string; readonly detail: string }[];
  /** Set by the service's fold of release events; absent/false means the batch is still in quarantine. */
  readonly released?: boolean;
}

/** The production board the shell last read: the day's runs. Empty means nothing produced; absent means the box
 *  was never told. */
export interface ProductionData {
  readonly runs: readonly ProductionRun[];
}

/** The outcome of a release — recorded (released or held), refused by the server (permission / expired /
 *  qc-failed at the server), or a lost link. */
export type ReleaseResult = 'released' | 'held' | 'refused' | 'lost_link';

/** The authenticated POST of a QC operator's release decision. Injected, so the model never opens a socket
 *  itself; the server records it in the caller's own name (`POST /v1/production/runs/:runId/release`), re-checks
 *  `production.release`, and refuses an expired or failed batch. */
export interface ReleasePort {
  post(input: { readonly runId: string; readonly qcPassed: boolean; readonly notes?: string }): Promise<ReleaseResult>;
}

export interface ProductionPorts {
  /** The production board the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): ProductionData;
  /** Whether this user may read the board (`production.read`). */
  mayRead(): boolean;
  /** Whether this user may release a batch for sale (`production.release`). */
  mayRelease(): boolean;
  /** Records a release decision. Only reached from the explicit action, never on render. */
  releasePort(): ReleasePort;
}

export interface ProductionConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'listHeading' | 'toReleaseCount' | 'allReleased' | 'notKnown'
  | 'productLabel' | 'batchLabel' | 'qtyLabel' | 'expiryLabel' | 'costLabel' | 'costNotKnown' | 'yieldLabel' | 'departmentLabel'
  | 'yieldAsExpected' | 'yieldLow' | 'yieldHigh' | 'yieldNotMeasured'
  | 'exceptionWord' | 'costUnknownWord' | 'yieldOffWord' | 'awaitingWord'
  | 'releaseBtn' | 'holdBtn' | 'releaseHint'
  | 'releaseRecorded' | 'releaseHeld' | 'releaseRefused' | 'releaseLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noRelease'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const PRODUCTION_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Release for sale', langName: 'தமிழ்',
    lead: 'Finished batches still in quarantine, waiting for a quality check before they can be sold — worst first. Freshly made food is not for sale because it exists; it is for sale when someone has looked at it and released it. A failed check keeps the batch in quarantine and is recorded. You cannot release past a use-by date.',
    listHeading: 'To release', toReleaseCount: 'to release', allReleased: 'Nothing waiting — every finished batch has been released or held.',
    notKnown: 'This store computer has not been told the production runs yet, so it cannot say what is waiting to be released.',
    productLabel: 'Product', batchLabel: 'Batch', qtyLabel: 'Quantity', expiryLabel: 'Use by', costLabel: 'Unit cost', costNotKnown: 'cost not known', yieldLabel: 'Yield', departmentLabel: 'Department',
    yieldAsExpected: 'as expected', yieldLow: 'below standard', yieldHigh: 'above standard', yieldNotMeasured: 'not measured',
    exceptionWord: 'Exception', costUnknownWord: 'Cost not known', yieldOffWord: 'Yield off', awaitingWord: 'Awaiting',
    releaseBtn: 'Release for sale', holdBtn: 'Hold — check failed', releaseHint: 'Release makes the batch sellable in your name; hold keeps it in quarantine.',
    releaseRecorded: 'Released for sale.', releaseHeld: 'Held in quarantine — check failed.',
    releaseRefused: 'Could not release — the batch may be expired or already released, or you do not have permission to release for sale.',
    releaseLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the batches to release', scrEmpty: 'Nothing waiting — every finished batch has been released or held.',
    stateNotPermitted: 'You do not have permission to see production.',
    noRelease: 'You can see the batches, but releasing one for sale needs quality-release permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'விற்பனைக்கு விடுவி', langName: 'English',
    lead: 'தரச் சோதனைக்குப் பிறகே விற்கக்கூடிய, இன்னும் தனிமைப்படுத்தலில் உள்ள முடிக்கப்பட்ட தொகுதிகள் — மோசமானது முதலில். புதிதாகச் செய்யப்பட்ட உணவு இருப்பதால் விற்பனைக்கு அல்ல; யாராவது பார்த்து விடுவித்தபோதே விற்பனைக்கு. தோல்வியுற்ற சோதனை தொகுதியைத் தனிமைப்படுத்தலில் வைத்திருந்து பதிவு செய்யப்படும். காலாவதி தேதியைத் தாண்டி விடுவிக்க முடியாது.',
    listHeading: 'விடுவிக்க வேண்டியவை', toReleaseCount: 'விடுவிக்க', allReleased: 'காத்திருப்பது எதுவும் இல்லை — ஒவ்வொரு தொகுதியும் விடுவிக்கப்பட்டது அல்லது தடுத்து வைக்கப்பட்டது.',
    notKnown: 'உற்பத்தி இயக்கங்கள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை, எனவே விடுவிக்கக் காத்திருப்பது என்ன என்று சொல்ல முடியாது.',
    productLabel: 'பொருள்', batchLabel: 'தொகுதி', qtyLabel: 'அளவு', expiryLabel: 'காலாவதி', costLabel: 'அலகு விலை', costNotKnown: 'விலை தெரியாது', yieldLabel: 'விளைச்சல்', departmentLabel: 'துறை',
    yieldAsExpected: 'எதிர்பார்த்தபடி', yieldLow: 'தரத்திற்குக் கீழே', yieldHigh: 'தரத்திற்கு மேலே', yieldNotMeasured: 'அளக்கப்படவில்லை',
    exceptionWord: 'விதிவிலக்கு', costUnknownWord: 'விலை தெரியாது', yieldOffWord: 'விளைச்சல் மாறுபாடு', awaitingWord: 'காத்திருக்கிறது',
    releaseBtn: 'விற்பனைக்கு விடுவி', holdBtn: 'தடு — சோதனை தோல்வி', releaseHint: 'விடுவித்தல் தொகுதியை உங்கள் பெயரில் விற்பனைக்கு ஆக்குகிறது; தடுத்தல் தனிமைப்படுத்தலில் வைக்கிறது.',
    releaseRecorded: 'விற்பனைக்கு விடுவிக்கப்பட்டது.', releaseHeld: 'தனிமைப்படுத்தலில் வைக்கப்பட்டது — சோதனை தோல்வி.',
    releaseRefused: 'விடுவிக்க முடியவில்லை — தொகுதி காலாவதியாகியிருக்கலாம் அல்லது ஏற்கனவே விடுவிக்கப்பட்டிருக்கலாம், அல்லது விடுவிக்க உங்களுக்கு அனுமதி இல்லை.',
    releaseLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'விடுவிக்க வேண்டிய தொகுதிகளைக் காட்டுகிறது', scrEmpty: 'காத்திருப்பது எதுவும் இல்லை — ஒவ்வொரு தொகுதியும் விடுவிக்கப்பட்டது அல்லது தடுத்து வைக்கப்பட்டது.',
    stateNotPermitted: 'உற்பத்தியைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noRelease: 'தொகுதிகளைப் பார்க்கலாம், ஆனால் விற்பனைக்கு விடுவிக்க தரக் கட்டுப்பாட்டு அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(PRODUCTION_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedRun {
  readonly runId: string;
  readonly departmentId: string;
  readonly productId: string;
  readonly batchId: string;
  readonly quantity: string;
  readonly expiresAt: string;
  /** The formatted unit cost, or `null` when the cost is not known (never faked as zero — P-08). */
  readonly cost: string | null;
  readonly yieldWord: string;
  readonly exceptionDetails: readonly string[];
  /** "Exception" / "Cost not known" / "Yield off" / "Awaiting" — a word, never colour alone. */
  readonly severityWord: string;
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface ProductionView {
  readonly screenState: StatusPresentation;
  readonly runs: readonly PresentedRun[];
  readonly toReleaseCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the release action — this user holds `production.release`. */
  readonly mayRelease: boolean;
}

export interface ProductionSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ProductionView;
  /** Release a batch for sale, or hold it on a failed check — a HUMAN write in the releaser's name. Runs only
   *  from an explicit action, never on render; refuses BEFORE any POST without the release permission, when the
   *  box was not told who is releasing, or for a run it does not hold / already released (the server re-checks
   *  and also refuses an expired batch). */
  release(runId: string, qcPassed: boolean, notes?: string): Promise<ReleaseResult>;
  /** Present a release outcome as one glanceable status the shell shows after the action. */
  presentReleaseResult(lang: Lang, result: ReleaseResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayRelease: boolean): ProductionView => ({
  screenState, runs: [], toReleaseCount: 0, nobodyNamed, mayRelease,
});

/** ₹ from paise, the store's own currency. A whole-number-safe format for the counter. */
function formatMoney(minor: number, currency: string): string {
  const major = (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'INR' ? `₹${major}` : `${major} ${currency}`;
}

const YIELD_KEY: Readonly<Record<ProductionRun['yieldVerdict'], CopyKey>> = Object.freeze({
  as_expected: 'yieldAsExpected', low_yield: 'yieldLow', high_yield: 'yieldHigh', not_measured: 'yieldNotMeasured',
});

export function createProductionSession(config: ProductionConfig, ports: ProductionPorts): ProductionSession {
  const text = (lang: Lang, key: CopyKey): string => translator(PRODUCTION_COPY, lang)(key);

  /** The severity rank (0 worst) and how it presents — the ordering the QC operator acts on (P-03). */
  const severityOf = (run: ProductionRun): { rank: number; tone: 'error' | 'degraded' | 'idle'; icon: string; word: CopyKey } => {
    if (run.exceptions.length > 0) return { rank: 0, tone: 'error', icon: '✕', word: 'exceptionWord' };
    if (!run.costKnown) return { rank: 1, tone: 'degraded', icon: '⚠', word: 'costUnknownWord' };
    if (run.yieldVerdict === 'low_yield' || run.yieldVerdict === 'high_yield') return { rank: 2, tone: 'degraded', icon: '⚠', word: 'yieldOffWord' };
    return { rank: 3, tone: 'idle', icon: '•', word: 'awaitingWord' };
  };

  const present = (lang: Lang, run: ProductionRun): PresentedRun => {
    const t = translator(PRODUCTION_COPY, lang);
    const sev = severityOf(run);
    const severityWord = t(sev.word);
    return {
      runId: run.runId,
      departmentId: run.departmentId,
      productId: run.outputProductId,
      batchId: run.outputBatchId,
      quantity: `${run.outputQuantityMinor} ${run.outputUom}`,
      expiresAt: run.expiresAt,
      cost: run.costKnown ? formatMoney(run.outputUnitCostMinor, run.currency) : null,
      yieldWord: t(YIELD_KEY[run.yieldVerdict]),
      exceptionDetails: run.exceptions.map((e) => e.detail),
      severityWord,
      status: presentStatus({
        tone: sev.tone,
        icon: sev.icon,
        label: `${severityWord} · ${run.outputProductId}`,
        announcement: run.exceptions[0]?.detail ?? `${severityWord} — batch ${run.outputBatchId}`,
        needsAttention: true,
      }),
      needsAttention: true,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(PRODUCTION_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayRelease = ports.mayRelease();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayRelease);
      }

      const data = ports.worklist();
      // Only batches still in quarantine (not released) are the QC operator's work; released ones drop off.
      // Worst first: an exception before a cost-unknown before a yield drift before a clean awaiting batch; then
      // the soonest use-by first, because a batch closest to expiry is the most urgent to look at (P-03).
      const runs = data.runs
        .filter((r) => r.released !== true)
        .slice()
        .sort((a, b) => severityOf(a).rank - severityOf(b).rank || a.expiresAt.localeCompare(b.expiresAt))
        .map((r) => present(lang, r));
      const state = runs.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        runs,
        toReleaseCount: runs.length,
        nobodyNamed,
        mayRelease,
      };
    },

    // Release (or hold) a batch. Refuse BEFORE any POST — no permission, nobody named, or a run the box does not
    // hold / already released is a local refusal, not a round trip. The server re-checks the permission, refuses
    // an expired or failed batch, and records the decision in the caller's own name (hard rule #5).
    release: async (runId, qcPassed, notes) => {
      if (!ports.mayRelease()) return 'refused';
      if (config.userId === null) return 'refused'; // a release cannot be recorded in nobody's name
      const data = ports.worklist();
      const run = data.runs.find((r) => r.runId === runId);
      if (run === undefined || run.released === true) return 'refused';
      return ports.releasePort().post({ runId, qcPassed, ...(notes === undefined ? {} : { notes }) });
    },

    presentReleaseResult: (lang, result) => {
      const t = translator(PRODUCTION_COPY, lang);
      if (result === 'released') return presentStatus({ tone: 'ok', icon: '✓', label: t('releaseRecorded'), needsAttention: false });
      if (result === 'held') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('releaseHeld'), needsAttention: true });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('releaseLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('releaseRefused'), needsAttention: true });
    },
  };
}
