// Fleet manager — the device & version status view (M33-FR-02/04 · A-10 · §35 · §19 · P-03/P-08).
//
// The durable device registry (services/platform/src/device-registry.ts) keeps the shop's REAL fleet —
// every till, handheld, scale, printer, kiosk and phone — event-sourced and restart-safe, and the
// fleet-health call runs the tested `evaluateDevice`/`fleetSummary` over it. This is the screen a manager
// uses to SEE that fleet: which machines are fine, which must update before they can trade, which were
// pulled back off a recalled build, and — the one silence hides — which have gone QUIET (P-08: a machine
// that stopped reporting in is a warning, not health).
//
// The design bar the roadmap sets is A-10: keep a way back. Nothing here is shown as healthy by default —
// a device with no registered version, or one that stopped checking in, reads as *needs a look*, never as
// fine. Control by exception (P-03): the machines that need attention come FIRST, so a 40-lane estate is
// triaged, not scrolled.
//
// Like every ERP screen, the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only
// renders what this hands over. This increment is the READ view; registering / blocking / retiring a device
// is the audited write path to the durable registry, wired as the next increment. Tamil copy is
// placeholder pending a native-speaker review (OA-10); the bilingual guardrail enforces presence, not
// translation quality.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation, type Tone } from '../../../packages/a11y/src/signals';

/** A device's live verdict, as the fleet-health call computes it (mirrors packages/platform-admin DeviceVerdict). */
export type FleetVerdict =
  | 'ok' | 'upgrade_available' | 'upgrade_required' | 'version_killed'
  | 'unregistered' | 'blocked' | 'integrity_failed' | 'no_version_reported';
export const FLEET_VERDICTS: readonly FleetVerdict[] = [
  'ok', 'upgrade_available', 'upgrade_required', 'version_killed', 'unregistered', 'blocked', 'integrity_failed', 'no_version_reported',
];

/** One device as the box hands it over: its registry record flattened with its live health verdict. */
export interface FleetDeviceRow {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: string;
  readonly branchId: string;
  readonly status: string;
  readonly appVersion?: string;
  readonly lastSeenAt?: string;
  readonly verdict: FleetVerdict;
  readonly mayTrade: boolean;
  readonly mustUpgrade: boolean;
  readonly targetVersion?: string;
  readonly detail: string;
  /** True when this device has not reported in inside the freshness window (from the fleet summary). */
  readonly silent: boolean;
}

/** The fleet-at-a-glance rollup the box hands over from the fleet-health call. */
export interface FleetSummaryRollup {
  readonly total: number;
  readonly trading: number;
  readonly blocked: number;
  readonly mustUpgrade: number;
  readonly silent: number;
  readonly byVersion: Readonly<Record<string, number>>;
}

export interface FleetPorts {
  /** The stored fleet with each device's live verdict, and the rollup — the fleet-health response. */
  fleet(): { readonly summary: FleetSummaryRollup; readonly devices: readonly FleetDeviceRow[] };
  /** Whether this user may see the fleet (`platform.health.read`). */
  mayRead(): boolean;
  /** Whether this user may register / block / retire a device (`platform.device.manage`). */
  mayManage(): boolean;
}

export interface FleetConfig {
  /** Who is looking. `null` means the box was not told — nothing is attributed to a name that does not exist. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'vOk' | 'vUpgradeAvailable' | 'vUpgradeRequired' | 'vVersionKilled' | 'vUnregistered' | 'vBlocked' | 'vIntegrityFailed' | 'vNoVersion'
  | 'silentBadge' | 'versionLabel' | 'lastSeenLabel' | 'branchLabel' | 'neverSeen'
  | 'tileTotal' | 'tileTrading' | 'tileMustUpgrade' | 'tileBlocked' | 'tileSilent'
  | 'attentionLead' | 'allWell'
  | 'canManage' | 'readOnly'
  | 'stateReady' | 'stateEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const FLEET_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Devices', langName: 'தமிழ்',
    lead: 'Every till, scanner, scale and kiosk this shop runs on, and its health. The ones that need a look come first: a machine that must update before it can trade, one pulled off a recalled build, or one that has gone quiet. A machine that stopped reporting in is a warning, not health.',
    vOk: 'Up to date', vUpgradeAvailable: 'Update available', vUpgradeRequired: 'Must update before trading', vVersionKilled: 'On a recalled build — moving back',
    vUnregistered: 'Not registered', vBlocked: 'Blocked', vIntegrityFailed: 'Device tampered', vNoVersion: 'No version reported',
    silentBadge: 'Gone quiet', versionLabel: 'Version', lastSeenLabel: 'Last seen', branchLabel: 'Branch', neverSeen: 'never checked in',
    tileTotal: 'Devices', tileTrading: 'Trading', tileMustUpgrade: 'Must update', tileBlocked: 'Blocked', tileSilent: 'Gone quiet',
    attentionLead: 'need a look', allWell: 'Every device is up to date and checking in.',
    canManage: 'You can register, block or retire a device.', readOnly: 'You can see the fleet but not change it.',
    stateReady: 'Showing the fleet', stateEmpty: 'No devices are registered yet.',
    stateNotPermitted: 'You do not have permission to see the device fleet.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'Showing the last fleet this screen received.', sampleData: 'Sample fleet — no devices have been registered yet.',
  },
  ta: {
    title: 'சாதனங்கள்', langName: 'English',
    lead: 'இந்தக் கடை இயங்கும் ஒவ்வொரு பில்லிங் இயந்திரம், ஸ்கேனர், தராசு, கியாஸ்க் மற்றும் அதன் நிலை. கவனம் தேவைப்படுபவை முதலில்: வர்த்தகம் செய்ய முன் புதுப்பிக்க வேண்டிய இயந்திரம், திரும்பப் பெறப்பட்ட பதிப்பில் உள்ளது, அல்லது அமைதியாகிவிட்டது. தகவல் அனுப்புவதை நிறுத்திய இயந்திரம் ஒரு எச்சரிக்கை, ஆரோக்கியம் அல்ல.',
    vOk: 'புதுப்பித்தது', vUpgradeAvailable: 'புதுப்பிப்பு உள்ளது', vUpgradeRequired: 'வர்த்தகத்திற்கு முன் புதுப்பிக்க வேண்டும்', vVersionKilled: 'திரும்பப் பெறப்பட்ட பதிப்பு — பின்செல்கிறது',
    vUnregistered: 'பதிவு செய்யப்படவில்லை', vBlocked: 'தடுக்கப்பட்டது', vIntegrityFailed: 'சாதனம் சேதப்படுத்தப்பட்டது', vNoVersion: 'பதிப்பு தெரிவிக்கப்படவில்லை',
    silentBadge: 'அமைதியாகிவிட்டது', versionLabel: 'பதிப்பு', lastSeenLabel: 'கடைசியாக பார்த்தது', branchLabel: 'கிளை', neverSeen: 'ஒருபோதும் தெரிவிக்கவில்லை',
    tileTotal: 'சாதனங்கள்', tileTrading: 'வர்த்தகம்', tileMustUpgrade: 'புதுப்பிக்க வேண்டும்', tileBlocked: 'தடுக்கப்பட்டது', tileSilent: 'அமைதி',
    attentionLead: 'கவனம் தேவை', allWell: 'ஒவ்வொரு சாதனமும் புதுப்பித்து தகவல் அனுப்புகிறது.',
    canManage: 'நீங்கள் ஒரு சாதனத்தை பதிவு செய்யலாம், தடுக்கலாம் அல்லது நீக்கலாம்.', readOnly: 'நீங்கள் கடற்படையைப் பார்க்கலாம் ஆனால் மாற்ற முடியாது.',
    stateReady: 'கடற்படையைக் காட்டுகிறது', stateEmpty: 'இதுவரை எந்த சாதனமும் பதிவு செய்யப்படவில்லை.',
    stateNotPermitted: 'சாதனக் கடற்படையைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்த திரையை யார் பயன்படுத்துகிறார்கள் என்று இந்த கடை கணினிக்கு தெரிவிக்கப்படவில்லை.',
    staleShell: 'இந்த திரை பெற்ற கடைசி கடற்படையைக் காட்டுகிறது.', sampleData: 'மாதிரி கடற்படை — இதுவரை சாதனங்கள் பதிவு செய்யப்படவில்லை.',
  },
};

const VERDICT_LABEL: Readonly<Record<FleetVerdict, CopyKey>> = {
  ok: 'vOk', upgrade_available: 'vUpgradeAvailable', upgrade_required: 'vUpgradeRequired', version_killed: 'vVersionKilled',
  unregistered: 'vUnregistered', blocked: 'vBlocked', integrity_failed: 'vIntegrityFailed', no_version_reported: 'vNoVersion',
};

// Tone + icon per verdict. A machine that cannot trade is an error; one that trades but must move (a
// recalled build, or an available upgrade) is degraded; only a current, checked-in device is ok.
const VERDICT_FACE: Readonly<Record<FleetVerdict, { readonly tone: Tone; readonly icon: string }>> = {
  ok: { tone: 'ok', icon: '✓' },
  upgrade_available: { tone: 'degraded', icon: '↑' },
  upgrade_required: { tone: 'error', icon: '⚠' },
  version_killed: { tone: 'degraded', icon: '↩' },
  unregistered: { tone: 'error', icon: '?' },
  blocked: { tone: 'error', icon: '⛔' },
  integrity_failed: { tone: 'error', icon: '⛔' },
  no_version_reported: { tone: 'error', icon: '?' },
};

// Worst-first order: the more urgent the verdict, the earlier it sorts.
const SEVERITY: Readonly<Record<FleetVerdict, number>> = {
  blocked: 0, integrity_failed: 1, unregistered: 2, no_version_reported: 3, upgrade_required: 4, version_killed: 5, upgrade_available: 6, ok: 7,
};

export interface PresentedDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: string;
  readonly branchId: string;
  readonly version: string;
  readonly lastSeen: string;
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
  readonly silent: boolean;
  readonly detail: string;
}

export interface FleetView {
  readonly screenState: StatusPresentation;
  readonly devices: readonly PresentedDevice[];
  readonly summary: FleetSummaryRollup;
  readonly attentionCount: number;
  readonly total: number;
  readonly mayManage: boolean;
  readonly nobodyNamed: boolean;
}

export interface FleetSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): FleetView;
}

export function createFleetSession(config: FleetConfig, ports: FleetPorts): FleetSession {
  const text = (lang: Lang, key: CopyKey): string => translator(FLEET_COPY, lang)(key);

  const present = (lang: Lang, row: FleetDeviceRow): PresentedDevice => {
    const t = translator(FLEET_COPY, lang);
    const face = VERDICT_FACE[row.verdict];
    const verdictLabel = t(VERDICT_LABEL[row.verdict]);
    // A device that cannot trade, must upgrade, or has gone silent needs a look — the silence is escalated
    // even for a device whose version verdict is otherwise fine (P-08).
    const needsAttention = !row.mayTrade || row.mustUpgrade || row.silent;
    const tone: Tone = !row.mayTrade || row.mustUpgrade ? 'error' : row.silent ? 'degraded' : face.tone;
    const label = row.silent ? `${verdictLabel} · ${t('silentBadge')}` : verdictLabel;
    return {
      deviceId: row.deviceId,
      label: row.label,
      kind: row.kind,
      branchId: row.branchId,
      version: row.appVersion ?? '—',
      lastSeen: row.lastSeenAt ?? t('neverSeen'),
      status: presentStatus({ tone, icon: face.icon, label, announcement: `${row.label}: ${label}`, needsAttention }),
      needsAttention,
      silent: row.silent,
      detail: row.detail,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(FLEET_COPY, lang);
      const emptyRollup: FleetSummaryRollup = { total: 0, trading: 0, blocked: 0, mustUpgrade: 0, silent: 0, byVersion: {} };
      if (!ports.mayRead()) {
        return {
          screenState: presentScreenState({ state: 'error', label: t('stateNotPermitted') }),
          devices: [], summary: emptyRollup, attentionCount: 0, total: 0, mayManage: false, nobodyNamed: config.userId === null,
        };
      }
      const { summary, devices: raw } = ports.fleet();
      const severityOf = new Map(raw.map((r) => [r.deviceId, SEVERITY[r.verdict]] as const));
      const presented = raw.map((r) => present(lang, r));
      // Attention first; within that by verdict severity (worst first); then a stable deviceId order.
      const ordered = [...presented].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        const sa = severityOf.get(a.deviceId) ?? 99;
        const sb = severityOf.get(b.deviceId) ?? 99;
        if (sa !== sb) return sa - sb;
        return a.deviceId.localeCompare(b.deviceId);
      });
      const attentionCount = presented.filter((d) => d.needsAttention).length;
      const state = raw.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'stateEmpty' : 'stateReady') }),
        devices: ordered,
        summary,
        attentionCount,
        total: raw.length,
        mayManage: ports.mayManage(),
        nobodyNamed: config.userId === null,
      };
    },
  };
}
