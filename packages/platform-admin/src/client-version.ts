// IS THIS BUILD STILL ALLOWED TO START A BILL? (OB-501 · M33-FR-02 · D12-FR-03 · A-10 · P-01 · P-08)
//
// Head office's version policy (services/platform/src/version-policy.ts: the current, previous and minimum supported
// versions, and the withdrawn "killed" list) travels to the store in the SIGNED store pack (`versionPolicy`), so the rule
// holds with no network. The till judges ITS OWN build against it:
//
//   • a build BELOW the minimum supported version, or one head office WITHDREW, may FINISH the bill in progress — a sale is
//     never interrupted mid-way (devices.ts: "a kill or an upgrade never interrupts a sale in progress") — and then refuses
//     to START a new bill until the till is updated, saying so in plain English and Tamil;
//   • a build that is merely behind the current version keeps trading (that is why the previous version is kept alive);
//   • no policy in the pack → nothing is enforced, and it says so (never a guessed rule).
//
// The store computer and head office judge the version each sale reports with the same function, and MARK a sale from a
// build that should not have started it — the sale stands (it happened), and the mark is visible (P-08).
//
// OB-521 (R8-A): the same rule for the handhelds (warehouse, picker, driver, queue till) and the phone apps (owner,
// customer): each names ITSELF (`ClientKind`) so the words say what it is and what work it may not start — the work in hand
// is always finished; only the START of new work is refused. `openNewWorkGate` keeps the last policy each app was told on
// the device, so a reload with no signal keeps the rule (the handhelds learn it from the store computer, offline).
//
// Pure: no clock, no I/O (the gate's storage is injected).

import { compareVersions, InvalidVersionError, type VersionPolicy } from './devices';

/**
 * THIS release's version — the one number every client built from this source reports (the till, the store computer).
 * Kept equal to the root package.json `version` by a guardrail test (tests/unit/r7a-client-version.test.ts); a release bumps both.
 */
export const APP_BUILD_VERSION = '0.0.0';

export type ClientVersionVerdict = 'ok' | 'upgrade_available' | 'upgrade_required' | 'version_killed' | 'no_policy' | 'not_comparable' | 'no_version_reported';

/** OB-521: which app is judging itself — so its refusal names it and the work it may not start. */
export type ClientKind = 'till' | 'queue_till' | 'warehouse' | 'picker' | 'driver' | 'owner_app' | 'customer_app';

export interface ClientVersionJudgement {
  readonly verdict: ClientVersionVerdict;
  /** May this build START a new bill? (A bill already in progress is always finished.) */
  readonly mayStartBill: boolean;
  /** OB-521: the same answer for any app — may it START new work? (The work in hand is always finished.) */
  readonly mayStartWork: boolean;
  readonly reported: string | null;
  readonly minimumSupportedVersion: string | null;
  readonly currentVersion: string | null;
  /** The plain words for a build that may not start a bill (English and Tamil); absent when it may. */
  readonly words?: { readonly en: string; readonly ta: string };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Read a version policy as the pack carries it, or undefined when it is not one (then nothing is being enforced). */
export function readPackVersionPolicy(v: unknown): VersionPolicy | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (!isStr(r['currentVersion']) || !isStr(r['minimumSupportedVersion'])) return undefined;
  const killed = Array.isArray(r['killedVersions']) ? r['killedVersions'].filter(isStr) : [];
  return {
    currentVersion: r['currentVersion'], minimumSupportedVersion: r['minimumSupportedVersion'],
    ...(isStr(r['previousVersion']) ? { previousVersion: r['previousVersion'] } : {}),
    ...(killed.length === 0 ? {} : { killedVersions: killed }),
  };
}

interface Phrase { readonly en: string; readonly ta: string }
/** OB-521: per app — what it is called, what it must finish, what it cannot start, and who to tell. */
const CLIENT_WORDS: Readonly<Record<Exclude<ClientKind, 'till'>, { readonly app: Phrase; readonly finish: Phrase; readonly start: Phrase; readonly updated: Phrase; readonly tell: Phrase }>> = Object.freeze({
  queue_till: {
    app: { en: "This queue till's app", ta: 'இந்த வரிசைக் கல்லாவின் செயலி' },
    finish: { en: 'Finish the basket on screen', ta: 'திரையில் உள்ள கூடையை முடியுங்கள்' },
    start: { en: 'a new basket cannot be started', ta: 'புதிய கூடை தொடங்க முடியாது' },
    updated: { en: 'the handheld is updated', ta: 'கருவி புதுப்பிக்கப்படும்' },
    tell: { en: 'Tell the manager.', ta: 'மேலாளரிடம் சொல்லுங்கள்.' },
  },
  warehouse: {
    app: { en: "This warehouse handheld's app", ta: 'இந்தக் கிடங்குக் கருவியின் செயலி' },
    finish: { en: 'Finish the work you have already started', ta: 'ஏற்கனவே தொடங்கிய வேலையை முடியுங்கள்' },
    start: { en: 'new work cannot be started', ta: 'புதிய வேலை தொடங்க முடியாது' },
    updated: { en: 'the handheld is updated', ta: 'கருவி புதுப்பிக்கப்படும்' },
    tell: { en: 'Tell the manager.', ta: 'மேலாளரிடம் சொல்லுங்கள்.' },
  },
  picker: {
    app: { en: "This picking handheld's app", ta: 'இந்த எடுப்புக் கருவியின் செயலி' },
    finish: { en: 'Finish the wave you have already started', ta: 'ஏற்கனவே தொடங்கிய தொகுப்பை முடியுங்கள்' },
    start: { en: 'a new wave cannot be started', ta: 'புதிய தொகுப்பைத் தொடங்க முடியாது' },
    updated: { en: 'the handheld is updated', ta: 'கருவி புதுப்பிக்கப்படும்' },
    tell: { en: 'Tell the manager.', ta: 'மேலாளரிடம் சொல்லுங்கள்.' },
  },
  driver: {
    app: { en: "This delivery phone's app", ta: 'இந்த விநியோகத் தொலைபேசியின் செயலி' },
    finish: { en: 'Finish the route you have already started', ta: 'ஏற்கனவே தொடங்கிய பயணத்தை முடியுங்கள்' },
    start: { en: 'a new route cannot be started', ta: 'புதிய பயணத்தைத் தொடங்க முடியாது' },
    updated: { en: 'the app is updated', ta: 'செயலி புதுப்பிக்கப்படும்' },
    tell: { en: 'Tell the manager.', ta: 'மேலாளரிடம் சொல்லுங்கள்.' },
  },
  owner_app: {
    app: { en: 'This owner app', ta: 'இந்த உரிமையாளர் செயலி' },
    finish: { en: 'Decisions you already made are kept', ta: 'நீங்கள் ஏற்கனவே எடுத்த முடிவுகள் வைக்கப்பட்டுள்ளன' },
    start: { en: 'a new decision cannot be made here', ta: 'இங்கே புதிய முடிவு எடுக்க முடியாது' },
    updated: { en: 'the app is updated', ta: 'செயலி புதுப்பிக்கப்படும்' },
    tell: { en: 'Update the app from the shop.', ta: 'கடையிலிருந்து செயலியைப் புதுப்பிக்கவும்.' },
  },
  customer_app: {
    app: { en: 'This shopping app', ta: 'இந்த ஷாப்பிங் செயலி' },
    finish: { en: 'Orders you already sent are kept and can still be paid, checked or cancelled', ta: 'நீங்கள் ஏற்கனவே அனுப்பிய ஆர்டர்கள் வைக்கப்பட்டுள்ளன; அவற்றைச் செலுத்தலாம், சரிபார்க்கலாம் அல்லது ரத்து செய்யலாம்' },
    start: { en: 'a new order cannot be started', ta: 'புதிய ஆர்டரைத் தொடங்க முடியாது' },
    updated: { en: 'the app is updated', ta: 'செயலி புதுப்பிக்கப்படும்' },
    tell: { en: 'Please update the app.', ta: 'தயவுசெய்து செயலியைப் புதுப்பிக்கவும்.' },
  },
});

/** OB-521: the refusal for an app other than the till, in English and Tamil. */
function clientWords(client: Exclude<ClientKind, 'till'>, why: 'killed' | 'too_old', v: string, minimum: string): Phrase {
  const w = CLIENT_WORDS[client];
  const reason = why === 'killed'
    ? { en: `(version ${v}) has been withdrawn by head office`, ta: `(பதிப்பு ${v}) தலைமை அலுவலகத்தால் திரும்பப் பெறப்பட்டது` }
    : { en: `(version ${v}) is too old — head office needs at least version ${minimum}`, ta: `(பதிப்பு ${v}) மிகப் பழையது — தலைமை அலுவலகத்துக்குக் குறைந்தது பதிப்பு ${minimum} தேவை` };
  return {
    en: `${w.app.en} ${reason.en}. ${w.finish.en}; ${w.start.en} until ${w.updated.en}. ${w.tell.en}`,
    ta: `${w.app.ta} ${reason.ta}. ${w.finish.ta}; ${w.updated.ta} வரை ${w.start.ta}. ${w.tell.ta}`,
  };
}

/** Judge a client's reported build against the policy. `client` (OB-521) names the app; the till is the default. */
export function judgeClientVersion(reported: string | null | undefined, policy: VersionPolicy | undefined, client: ClientKind = 'till'): ClientVersionJudgement {
  const j = judgeTill(reported, policy);
  if (client === 'till' || j.words === undefined) return j;
  return { ...j, words: clientWords(client, j.verdict === 'version_killed' ? 'killed' : 'too_old', j.reported ?? '', j.minimumSupportedVersion ?? '') };
}

function judgeTill(reported: string | null | undefined, policy: VersionPolicy | undefined): ClientVersionJudgement {
  const base = {
    reported: isStr(reported) ? reported.trim() : null,
    minimumSupportedVersion: policy?.minimumSupportedVersion ?? null,
    currentVersion: policy?.currentVersion ?? null,
  };
  if (policy === undefined) return { ...base, verdict: 'no_policy', mayStartBill: true, mayStartWork: true };
  if (base.reported === null) return { ...base, verdict: 'no_version_reported', mayStartBill: true, mayStartWork: true };
  const v = base.reported;
  if ((policy.killedVersions ?? []).includes(v)) {
    return {
      ...base, verdict: 'version_killed', mayStartBill: false, mayStartWork: false,
      words: {
        en: `This till's app (version ${v}) has been withdrawn by head office. Finish the bill on screen; a new bill cannot be started until the till is updated. Tell the manager.`,
        ta: `இந்தக் கல்லாவின் செயலி (பதிப்பு ${v}) தலைமை அலுவலகத்தால் திரும்பப் பெறப்பட்டது. திரையில் உள்ள பில்லை முடியுங்கள்; கல்லா புதுப்பிக்கப்படும் வரை புதிய பில் தொடங்க முடியாது. மேலாளரிடம் சொல்லுங்கள்.`,
      },
    };
  }
  try {
    if (compareVersions(v, policy.minimumSupportedVersion) < 0) {
      return {
        ...base, verdict: 'upgrade_required', mayStartBill: false, mayStartWork: false,
        words: {
          en: `This till's app (version ${v}) is too old — head office needs at least version ${policy.minimumSupportedVersion}. Finish the bill on screen; a new bill cannot be started until the till is updated. Tell the manager.`,
          ta: `இந்தக் கல்லாவின் செயலி (பதிப்பு ${v}) மிகப் பழையது — தலைமை அலுவலகத்துக்குக் குறைந்தது பதிப்பு ${policy.minimumSupportedVersion} தேவை. திரையில் உள்ள பில்லை முடியுங்கள்; கல்லா புதுப்பிக்கப்படும் வரை புதிய பில் தொடங்க முடியாது. மேலாளரிடம் சொல்லுங்கள்.`,
        },
      };
    }
    return { ...base, verdict: compareVersions(v, policy.currentVersion) < 0 ? 'upgrade_available' : 'ok', mayStartBill: true, mayStartWork: true };
  } catch (e) {
    // A version this system cannot compare is said, not guessed; head office refuses such a policy before storing it.
    if (e instanceof InvalidVersionError) return { ...base, verdict: 'not_comparable', mayStartBill: true, mayStartWork: true };
    throw e;
  }
}

// ── OB-521: the gate each handheld and phone app keeps ───────────────────────────────────────────────────────────────

/** The device storage the gate keeps its last-told policy in (localStorage on a phone; injectable for tests). */
export interface GateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface NewWorkGate {
  /** A policy as the app's source said it NOW (the store computer's signed pack, or head office); `null` = it has none. */
  apply(policy: unknown): ClientVersionJudgement;
  /** The verdict on this build by the policy last told. */
  judgement(): ClientVersionJudgement;
  /** The words to refuse NEW work with, or undefined when new work may start. The work in hand is never refused. */
  refusal(): Phrase | undefined;
  /** This build's own version. */
  readonly appVersion: string;
}

/**
 * OB-521: open an app's new-work gate. It starts from the policy the page was served with (`served`, when the source sent
 * one — `null` = the source said it has none) or, failing that, the last one this device was told (kept in `storage`, so
 * a reload with no signal keeps the rule). Only an answer from the source changes it; an unreachable source leaves it as
 * it was. A storage that cannot be read or written leaves the gate working in memory — never a guessed policy.
 */
export function openNewWorkGate(input: {
  readonly client: ClientKind;
  readonly appVersion?: string;
  readonly storage?: GateStorage;
  /** Where on the device the last-told policy is kept. */
  readonly key: string;
  /** The policy the page was served with: absent = the source said nothing; `null` = it has no policy. */
  readonly served?: unknown;
}): NewWorkGate {
  const appVersion = input.appVersion ?? APP_BUILD_VERSION;
  const read = (): unknown => {
    try { const raw = input.storage?.getItem(input.key); return raw === null || raw === undefined ? undefined : JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  const write = (p: VersionPolicy | undefined): void => {
    try { input.storage?.setItem(input.key, JSON.stringify(p ?? null)); } catch { /* kept in memory only */ }
  };
  let policy: VersionPolicy | undefined;
  const apply = (p: unknown): ClientVersionJudgement => {
    policy = readPackVersionPolicy(p);
    write(policy);
    return judgeClientVersion(appVersion, policy, input.client);
  };
  if (input.served !== undefined) apply(input.served);
  else policy = readPackVersionPolicy(read());
  const judgement = (): ClientVersionJudgement => judgeClientVersion(appVersion, policy, input.client);
  return {
    apply, judgement, appVersion,
    refusal: () => { const j = judgement(); return j.mayStartWork ? undefined : j.words; },
  };
}

/** OB-521: refused to START new work on a withdrawn or too-old build — the words are the gate's. */
export class NewWorkRefusedError extends Error {
  readonly refusedBecause = 'app_version_too_old';
  constructor(readonly laneMessage: string, readonly laneMessageTa: string) {
    super(laneMessage);
    this.name = 'NewWorkRefusedError';
  }
}

/** OB-521: a session that can be barred from STARTING new work (the work in hand is always finished). */
export interface BarsNewWork { barNewWork(words: { readonly en: string; readonly ta: string } | null): void }

/**
 * OB-521: tie a gate to the sessions it bars — each is barred (or freed) now, and again every time a policy is applied.
 * What the app's screen holds as `window.<app>Version`.
 */
export function bindNewWorkGate(gate: NewWorkGate, targets: readonly (BarsNewWork | null | undefined)[]): NewWorkGate {
  const push = (): void => { const w = gate.refusal() ?? null; for (const t of targets) t?.barNewWork(w); };
  push();
  return { apply: (p) => { const j = gate.apply(p); push(); return j; }, judgement: gate.judgement, refusal: gate.refusal, appVersion: gate.appVersion };
}
