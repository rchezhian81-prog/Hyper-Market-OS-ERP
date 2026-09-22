// The integration-health desk — the owner / admin's control-by-exception screen for whether the shop's
// OUTSIDE connections are actually alive (M32-FR-04 · API-11 · P-03 · P-08 · hard rule #1). Tally, the GST
// portal, the payment providers, WhatsApp — each is an adapter that can die not with an outage but with a
// slow quiet slide nobody was measuring, staying green on any dashboard that reports *configuration* while it
// has not actually worked in nine days. This screen folds the one cloud feed — `GET /v1/integration/health`,
// gated `platform.health.read` — into a worst-first view that reads health from WHEN EACH ADAPTER LAST WORKED:
//
//   • **silent** — never reported a success, or nothing for over an hour: the integration that died quietly,
//     ranked first because it is the one a configuration dashboard hides.
//   • **failing** — several failures in a row (traffic queued where the adapter queues on outage).
//   • **degraded** — a recent failure or two, last success still within the window: a watch, not a stop.
//   • **healthy** / **disabled** — working, or switched off on purpose: the calm states, below the exceptions.
//
// And the reassurance that matters more than any of them: **the till keeps trading regardless.** No integration
// failure may reach a sale (hard rule #1, P-01) — a cloud adapter down is a queue getting longer, never a shop
// that has stopped selling — so `posUnaffected` is surfaced plainly, so the owner reads a red row as "a queue
// to clear", not "we cannot sell". Like every ERP screen the rules live here in a tested, DOM-free session
// model on the shared packages/ui + packages/a11y primitives (colour is NEVER the only signal — an icon and a
// word ride with every tone). This is a READ surface: it shows what is silent and asks for a person's eyes; it
// commits nothing.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feed, exactly as the cloud hands it over (the screen consumes the served JSON) ──────────────────

export type AdapterHealthState = 'healthy' | 'degraded' | 'failing' | 'silent' | 'disabled';

/** One adapter's health, computed by the cloud from when it last actually worked (`GET /v1/integration/health`). */
export interface AdapterHealthView {
  readonly adapterId: string;
  readonly category: string;
  readonly state: AdapterHealthState;
  /** Minutes since the last success, or `'never'` when it has never reported one. */
  readonly minutesSinceLastSuccess: number | 'never';
  readonly consecutiveFailures: number;
  /** True when the shop keeps trading regardless — hard rule #1. */
  readonly shopKeepsTrading: boolean;
  readonly detail: string;
}

/** The integration health picture the shell last read (live from the cloud, or the injected stand-in). */
export interface IntegrationHealthData {
  readonly adapters: readonly AdapterHealthView[];
  /** True in every report the cloud can produce — nothing here stops a sale (hard rule #1). */
  readonly posUnaffected: boolean;
  readonly asAt: string;
}

export interface IntegrationHealthPorts {
  /** The integration health picture the shell last read. */
  health(): IntegrationHealthData;
  /** Whether this user may read the integration health (`platform.health.read`). */
  mayRead(): boolean;
}

export interface IntegrationHealthConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ─────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'refresh' | 'asOfLabel'
  | 'attentionHeading' | 'attentionNone' | 'calmHeading'
  | 'tillSafe' | 'tillWarn'
  | 'adapterLabel' | 'categoryLabel' | 'lastWorkedLabel' | 'failuresLabel'
  | 'neverWorked' | 'minutesAgo'
  | 'kindHealthy' | 'kindDegraded' | 'kindFailing' | 'kindSilent' | 'kindDisabled'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const INTEGRATION_HEALTH_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Integration health', langName: 'தமிழ்',
    lead: 'Whether the shop’s outside connections — Tally, the GST portal, the card and UPI providers, WhatsApp — are actually working, judged by when each last succeeded, not by whether it is switched on. The ones that have gone quiet are first. This screen reads and reports; it changes nothing.',
    refresh: 'Refresh', asOfLabel: 'As of',
    attentionHeading: 'Needs a look', attentionNone: 'Every connection has worked recently — nothing has gone quiet.',
    calmHeading: 'Working / switched off',
    tillSafe: 'Your till keeps trading. No connection here can stop a sale — a connection being down is a queue to clear later, never a shop that cannot sell.',
    tillWarn: 'Check the till: a connection is reporting it could affect selling.',
    adapterLabel: 'Connection', categoryLabel: 'Kind', lastWorkedLabel: 'Last worked', failuresLabel: 'Failures in a row',
    neverWorked: 'never worked', minutesAgo: 'min ago',
    kindHealthy: 'Working', kindDegraded: 'Wobbling', kindFailing: 'Failing', kindSilent: 'Gone quiet', kindDisabled: 'Switched off',
    scrReady: 'Showing connection health', scrEmpty: 'No connections are configured yet.',
    stateNotPermitted: 'You do not have permission to see the integration health.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'இணைப்பு நலன்', langName: 'English',
    lead: 'கடையின் வெளி இணைப்புகள் — Tally, GST போர்ட்டல், அட்டை/UPI வழங்குநர்கள், WhatsApp — உண்மையில் வேலை செய்கின்றனவா என்பதை, அவை இயக்கத்தில் உள்ளனவா என்பதால் அல்ல, ஒவ்வொன்றும் கடைசியாக எப்போது வெற்றி பெற்றது என்பதால் தீர்மானிக்கிறது. அமைதியாகிவிட்டவை முதலில். இந்தத் திரை படித்து அறிக்கை செய்கிறது; எதையும் மாற்றாது.',
    refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
    attentionHeading: 'கவனிக்க வேண்டியவை', attentionNone: 'ஒவ்வொரு இணைப்பும் சமீபத்தில் வேலை செய்துள்ளது — எதுவும் அமைதியாகவில்லை.',
    calmHeading: 'வேலை செய்கிறது / அணைக்கப்பட்டது',
    tillSafe: 'உங்கள் பணப்பெட்டி தொடர்ந்து விற்பனை செய்யும். இங்குள்ள எந்த இணைப்பும் விற்பனையை நிறுத்த முடியாது — ஒரு இணைப்பு செயலிழந்தால் அது பின்னர் அழிக்க வேண்டிய வரிசை, விற்க முடியாத கடை அல்ல.',
    tillWarn: 'பணப்பெட்டியைச் சரிபார்க்கவும்: ஒரு இணைப்பு விற்பனையைப் பாதிக்கக்கூடும் என்று தெரிவிக்கிறது.',
    adapterLabel: 'இணைப்பு', categoryLabel: 'வகை', lastWorkedLabel: 'கடைசியாக வேலை செய்தது', failuresLabel: 'தொடர்ச்சியான தோல்விகள்',
    neverWorked: 'ஒருபோதும் வேலை செய்யவில்லை', minutesAgo: 'நிமிடங்களுக்கு முன்',
    kindHealthy: 'வேலை செய்கிறது', kindDegraded: 'தள்ளாடுகிறது', kindFailing: 'தோல்வியுறுகிறது', kindSilent: 'அமைதியாகிவிட்டது', kindDisabled: 'அணைக்கப்பட்டது',
    scrReady: 'இணைப்பு நலனைக் காட்டுகிறது', scrEmpty: 'இன்னும் எந்த இணைப்பும் அமைக்கப்படவில்லை.',
    stateNotPermitted: 'இணைப்பு நலனைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(INTEGRATION_HEALTH_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedAdapter {
  readonly adapterId: string;
  readonly category: string;
  readonly state: AdapterHealthState;
  /** The last-worked figure already formatted for the screen ("never worked" / "12 min ago"). */
  readonly lastWorked: string;
  readonly consecutiveFailures: number;
  readonly shopKeepsTrading: boolean;
  readonly detail: string;
  /** Tone + icon + word, never colour alone. silent/failing = error, degraded = watch, healthy/disabled = calm. */
  readonly status: StatusPresentation;
}

export interface IntegrationHealthView {
  readonly screenState: StatusPresentation;
  /** The connections that have gone quiet or are failing/wobbling — worst first. */
  readonly attention: readonly PresentedAdapter[];
  /** The connections working or switched off on purpose — the calm remainder. */
  readonly calm: readonly PresentedAdapter[];
  readonly attentionCount: number;
  /** True while no integration failure can reach a sale (hard rule #1) — surfaced as the reassurance line. */
  readonly posUnaffected: boolean;
  readonly nobodyNamed: boolean;
  /** True when at least one connection has gone quiet or is failing — the things that need action. */
  readonly anyException: boolean;
}

export interface IntegrationHealthSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): IntegrationHealthView;
}

// Worst-first: the connection that died quietly is the one a configuration dashboard hides, so it leads.
const RANK: Record<AdapterHealthState, number> = { silent: 0, failing: 1, degraded: 2, healthy: 3, disabled: 4 };
const NEEDS_ATTENTION: ReadonlySet<AdapterHealthState> = new Set<AdapterHealthState>(['silent', 'failing', 'degraded']);

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, posUnaffected: boolean): IntegrationHealthView => ({
  screenState, attention: [], calm: [], attentionCount: 0, posUnaffected, nobodyNamed, anyException: false,
});

export function createIntegrationHealthSession(
  config: IntegrationHealthConfig,
  ports: IntegrationHealthPorts,
): IntegrationHealthSession {
  const text = (lang: Lang, key: CopyKey): string => translator(INTEGRATION_HEALTH_COPY, lang)(key);

  const presentAdapter = (lang: Lang, a: AdapterHealthView): PresentedAdapter => {
    const t = translator(INTEGRATION_HEALTH_COPY, lang);
    const lastWorked = a.minutesSinceLastSuccess === 'never'
      ? t('neverWorked')
      : `${a.minutesSinceLastSuccess} ${t('minutesAgo')}`;
    // silent + failing are settled problems (error); degraded is a watch; healthy/disabled are calm.
    const status =
      a.state === 'silent' || a.state === 'failing'
        ? presentStatus({ tone: 'error', icon: '✕', label: t(a.state === 'silent' ? 'kindSilent' : 'kindFailing'), announcement: a.detail, needsAttention: true })
        : a.state === 'degraded'
          ? presentStatus({ tone: 'degraded', icon: '⚠', label: t('kindDegraded'), announcement: a.detail, needsAttention: true })
          : a.state === 'healthy'
            ? presentStatus({ tone: 'ok', icon: '✓', label: t('kindHealthy'), announcement: a.detail, needsAttention: false })
            : presentStatus({ tone: 'idle', icon: '•', label: t('kindDisabled'), announcement: a.detail, needsAttention: false });
    return {
      adapterId: a.adapterId, category: a.category, state: a.state, lastWorked,
      consecutiveFailures: a.consecutiveFailures, shopKeepsTrading: a.shopKeepsTrading, detail: a.detail, status,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(INTEGRATION_HEALTH_COPY, lang);
      const nobodyNamed = config.userId === null;

      if (!ports.mayRead()) {
        // A not-permitted reader learns nothing, not even the till-safe reassurance state.
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, true);
      }

      const data = ports.health();
      // The screen guarantees the worst-first order so the eye lands on what died quietly (P-03); the engine's
      // own ordering is not relied on here.
      const ordered = [...data.adapters].sort((a, b) => RANK[a.state] - RANK[b.state] || a.adapterId.localeCompare(b.adapterId));
      const attention = ordered.filter((a) => NEEDS_ATTENTION.has(a.state)).map((a) => presentAdapter(lang, a));
      const calm = ordered.filter((a) => !NEEDS_ATTENTION.has(a.state)).map((a) => presentAdapter(lang, a));

      const anyException = attention.length > 0;
      const anythingShown = ordered.length > 0;
      const state = anythingShown ? 'ready' : 'empty';

      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        attention,
        calm,
        attentionCount: attention.length,
        posUnaffected: data.posUnaffected,
        nobodyNamed,
        anyException,
      };
    },
  };
}
