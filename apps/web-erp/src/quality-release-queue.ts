// The facilities screen's QUALITY-HOLD RELEASES through the store computer — OB-333 (owner, 23 Oct 2026, in writing) ·
// M10-FR-02 "quality release by authorized QC" · §31 · P-01 · P-08 · hard rules #6 #10.
//
// A batch on quality hold is not sold. When the person who may release it (the quality-release right) has checked it,
// they release it here — with the line down too. Served by the store computer, the screen lists the batches head office
// holds (as the box last heard, with how old that is), and a release is written to this device's durable queue first,
// then handed to the store computer, which carries it to head office. Head office RE-CHECKS the person from their own
// grants and re-runs its release rules; a refusal comes back with its reason, shown, and the batch stays held. This
// screen can never PLACE a hold — there is no such action here, and the store computer could not relay one.
//
// M10-FR-02 "Offline (§31): evidence captured offline; queued" (with OB-513): a person who may record samples (the
// quality-hold right) records a SAMPLE result on a held batch here too — saved on this device's durable queue first, then
// handed to the store computer, which carries it to head office BEFORE any release decided on it (the same queue, in
// order). The screen says plainly where each sample is: saved here, waiting on the store computer for head office,
// recorded at head office, or refused there (then it does not count, and the reason is shown). A release here honours a
// sample recorded on this store computer exactly as head office would: a pass lets a held food batch go, a failed one
// never, a pending one waits. Head office re-checks the recorder and the hold either way; a conflict (the batch already
// released there) is a visible refusal, never written over (hard rule #10).
// DOM-free and tested; English and Tamil for every word; the shell renders what this hands over.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';

export const QUALITY_HOLD_RELEASE_DECIDED = 'QualityHoldReleaseDecided';
export const qualityReleaseKeyFor = (batchId: string): string => `quality-release:${batchId}`;
export const RELEASE_PERMISSION = 'quality.hold.release';
export const QUALITY_SAMPLE_RECORDED = 'QualitySampleRecorded';
/** One device item per sample per result: pending → pass is a new item (a new version at head office), a resend is not. */
export const qualitySampleKeyFor = (batchId: string, sampleId: string, result: string): string => `quality-sample:${batchId}:${sampleId}:${result}`;
/** M10-FR-02: recording a sample is the quality-hold right head office asks for on its own sample route. */
export const SAMPLE_PERMISSION = 'quality.hold.manage';

/** Head office's held batches, as the store computer last heard them (`facilitiesData.qualityHolds`). */
export interface HeldQualityHolds {
  readonly asAt: string;
  readonly ageMinutes: number;
  readonly holds: readonly {
    readonly batchId: string; readonly productId: string; readonly reason: string; readonly heldAt: string; readonly heldBy?: string;
    /** The store computer already holds a release of it from a screen (this one or another), not refused. */
    readonly releasedOnThisBox?: boolean;
    /** M10-FR-02: the samples recorded on the hold at head office (each one's current result). Absent = not told. */
    readonly samples?: readonly HeldSample[];
    /** OB-513: head office's word on whether this hold needs a recorded sample before release, and why. Absent = not told. */
    readonly sampleRule?: { readonly required: boolean; readonly because: 'food' | 'food_not_known' | 'not_food' };
    /** M10-FR-02 offline: samples recorded on this hold on the store computer (any of its screens), with the box's state. */
    readonly samplesOnThisBox?: readonly BoxSample[];
  }[];
}

/** A sample the store computer holds for head office (its device-events queue): pending, acknowledged, or dead_letter. */
export interface BoxSample {
  readonly sampleId: string; readonly test: string; readonly result: string; readonly takenAt: string; readonly recordedBy: string; readonly at: string;
  readonly key?: string; readonly state?: string; readonly reason?: string | null;
}

/** Where a sample recorded at the store has got to — said in words beside it. */
export type SampleHereState = 'saved_here' | 'retrying' | 'on_box' | 'at_head_office' | 'refused';

/** One quality sample recorded on a hold, as head office said it. */
export interface HeldSample { readonly sampleId: string; readonly test: string; readonly result: 'pass' | 'fail' | 'pending'; readonly takenBy: string; readonly takenAt: string }

export type CopyKey =
  | 'qhHeading' | 'qhLead' | 'qhAsOf' | 'qhNotKnown' | 'qhNone' | 'qhHeld' | 'qhReleasedHere' | 'qhWhy' | 'qhNotes' | 'qhRelease'
  | 'qhSaved' | 'qhNobody' | 'qhNoStore' | 'qhNoRight' | 'qhNeedNotes' | 'qhUnknown' | 'qhAlready'
  | 'stSavedHere' | 'stRetrying' | 'stHanded' | 'stPosted' | 'stRefused'
  | 'qhSamples' | 'qhNoSamples' | 'qhSamplesNotKnown' | 'qhPass' | 'qhFail' | 'qhPending' | 'qhTakenBy' | 'qhBlockedFail' | 'qhBlockedPending'
  | 'qhRuleFood' | 'qhRuleFoodNotKnown' | 'qhRuleNotFood' | 'qhBlockedNoSample'
  | 'qsHeading' | 'qsTest' | 'qsResult' | 'qsNotes' | 'qsRecord' | 'qsSaved' | 'qsCameBack'
  | 'qsSavedHere' | 'qsRetrying' | 'qsOnBox' | 'qsAtHeadOffice' | 'qsRefused'
  | 'qsNoRight' | 'qsNeedTest' | 'qsBadResult' | 'qsFinal' | 'qsAnotherTest' | 'qsNotHeld';

export const QUALITY_RELEASE_COPY: BilingualCopy<CopyKey> = {
  en: {
    qhHeading: 'Batches on quality hold', qhLead: 'A held batch is not sold. Release one only when you have checked it — the store computer carries your release to head office, even with the line down, and head office checks you may release it.',
    qhAsOf: 'Head office\'s held batches as the store computer last heard them, at', qhNotKnown: 'The store computer has not been told which batches are on hold yet.', qhNone: 'No batch is on quality hold.',
    qhHeld: 'On hold — not sold', qhReleasedHere: 'Released on this screen', qhWhy: 'Why it is held', qhNotes: 'What you checked (kept on the record)', qhRelease: 'Release for sale',
    qhSaved: 'Release saved on this screen — the store computer carries it to head office.', qhNobody: 'This store computer has not been told who is using this screen — a release carries a name.',
    qhNoStore: 'This store computer has not said which store this is, so nothing can be saved.', qhNoRight: 'You may not release a batch for sale — someone with the quality-release right must.',
    qhNeedNotes: 'Write what you checked before releasing.', qhUnknown: 'That batch is not on hold here.', qhAlready: 'This batch was already released on this screen.',
    stSavedHere: 'Saved on this screen', stRetrying: 'Trying to reach the store computer', stHanded: 'With the store computer', stPosted: 'Released at head office', stRefused: 'Refused — the batch stays held; a person must look',
    qhSamples: 'Samples recorded on this hold', qhNoSamples: 'No sample is recorded on this hold.', qhSamplesNotKnown: 'The store computer was not told this hold\'s samples.',
    qhPass: 'Passed', qhFail: 'Failed', qhPending: 'Waiting for the result', qhTakenBy: 'taken by',
    qhBlockedFail: 'A sample failed — this batch cannot be released for sale.', qhBlockedPending: 'A sample has not come back yet — the release waits for its result.',
    // OB-513: a held FOOD batch needs at least one recorded sample before release; other holds may release without.
    qhRuleFood: 'Food item — at least one quality sample must be recorded on this hold before it can be released.',
    qhRuleFoodNotKnown: 'Head office cannot tell whether this item is food, so at least one quality sample must be recorded before it is released.',
    qhRuleNotFood: 'Not a food item — it may be released without a recorded sample.',
    qhBlockedNoSample: 'No sample is recorded yet — a held food batch is not released until one is.',
    // M10-FR-02 offline: a sample result recorded here, carried to head office by the store computer.
    qsHeading: 'Record a quality sample', qsTest: 'What was tested', qsResult: 'Result', qsNotes: 'Notes (optional)', qsRecord: 'Record the sample',
    qsSaved: 'Sample saved on the store computer — it is waiting to reach head office, and goes before any release.',
    qsCameBack: 'The result came back:',
    qsSavedHere: 'Saved on this screen — waiting to reach the store computer', qsRetrying: 'Trying to reach the store computer',
    qsOnBox: 'Saved on the store computer — waiting to reach head office', qsAtHeadOffice: 'Recorded at head office',
    qsRefused: 'Refused by head office — this sample does not count; a person must look',
    qsNoRight: 'You may not record a quality sample — someone with the quality-hold right must.',
    qsNeedTest: 'Write what was tested before recording the sample.', qsBadResult: 'Choose the result: passed, failed or waiting for the result.',
    qsFinal: 'This sample already has its final result — a re-test is recorded as a new sample.',
    qsAnotherTest: 'That sample is a different test — record this one as a new sample.',
    qsNotHeld: 'This batch is not held here any more, so no sample can be recorded on it.',
  },
  ta: {
    qhHeading: 'தரத் தடையில் உள்ள தொகுதிகள்', qhLead: 'தடையில் உள்ள தொகுதி விற்கப்படாது. நீங்கள் சரிபார்த்த பின்னரே ஒன்றை விடுவியுங்கள் — இணைப்பு இல்லாவிட்டாலும் கடைக் கணினி உங்கள் விடுவிப்பைத் தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும்; நீங்கள் விடுவிக்கலாமா என்பதைத் தலைமை அலுவலகம் சரிபார்க்கும்.',
    qhAsOf: 'கடைக் கணினி கடைசியாகக் கேட்ட தலைமை அலுவலகத்தின் தடைத் தொகுதிகள், நேரம்', qhNotKnown: 'எந்தத் தொகுதிகள் தடையில் உள்ளன என்று இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.', qhNone: 'எந்தத் தொகுதியும் தரத் தடையில் இல்லை.',
    qhHeld: 'தடையில் — விற்கப்படாது', qhReleasedHere: 'இந்தத் திரையில் விடுவிக்கப்பட்டது', qhWhy: 'ஏன் தடை', qhNotes: 'நீங்கள் சரிபார்த்தது (பதிவில் வைக்கப்படும்)', qhRelease: 'விற்பனைக்கு விடுவி',
    qhSaved: 'விடுவிப்பு இந்தத் திரையில் சேமிக்கப்பட்டது — கடைக் கணினி அதைத் தலைமை அலுவலகத்திற்குக் கொண்டு செல்லும்.', qhNobody: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை — விடுவிப்பில் பெயர் இருக்கும்.',
    qhNoStore: 'இது எந்தக் கடை என்று கடைக் கணினி சொல்லவில்லை, அதனால் எதுவும் சேமிக்க முடியாது.', qhNoRight: 'நீங்கள் தொகுதியை விற்பனைக்கு விடுவிக்க முடியாது — தர விடுவிப்பு உரிமை உள்ளவர் செய்ய வேண்டும்.',
    qhNeedNotes: 'விடுவிக்கும் முன் நீங்கள் சரிபார்த்ததை எழுதுங்கள்.', qhUnknown: 'அந்தத் தொகுதி இங்கே தடையில் இல்லை.', qhAlready: 'இந்தத் தொகுதி ஏற்கனவே இந்தத் திரையில் விடுவிக்கப்பட்டது.',
    stSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது', stRetrying: 'கடைக் கணினியை அடைய முயல்கிறது', stHanded: 'கடைக் கணினியிடம் உள்ளது', stPosted: 'தலைமை அலுவலகத்தில் விடுவிக்கப்பட்டது', stRefused: 'மறுக்கப்பட்டது — தொகுதி தடையிலேயே உள்ளது; ஒருவர் பார்க்க வேண்டும்',
    qhSamples: 'இந்தத் தடையில் பதிவான மாதிரிகள்', qhNoSamples: 'இந்தத் தடையில் எந்த மாதிரியும் பதிவாகவில்லை.', qhSamplesNotKnown: 'இந்தத் தடையின் மாதிரிகள் கடைக் கணினிக்குச் சொல்லப்படவில்லை.',
    qhPass: 'தேர்ச்சி', qhFail: 'தோல்வி', qhPending: 'முடிவுக்குக் காத்திருக்கிறது', qhTakenBy: 'எடுத்தவர்',
    qhBlockedFail: 'ஒரு மாதிரி தோல்வியடைந்தது — இந்தத் தொகுதியை விற்பனைக்கு விடுவிக்க முடியாது.', qhBlockedPending: 'ஒரு மாதிரியின் முடிவு இன்னும் வரவில்லை — விடுவிப்பு அதன் முடிவுக்குக் காத்திருக்கிறது.',
    qhRuleFood: 'உணவுப் பொருள் — விடுவிக்கும் முன் இந்தத் தடையில் குறைந்தது ஒரு தர மாதிரி பதிவாக வேண்டும்.',
    qhRuleFoodNotKnown: 'இது உணவுப் பொருளா என்று தலைமை அலுவலகத்துக்குத் தெரியவில்லை, அதனால் விடுவிக்கும் முன் குறைந்தது ஒரு தர மாதிரி பதிவாக வேண்டும்.',
    qhRuleNotFood: 'உணவுப் பொருள் அல்ல — பதிவான மாதிரி இல்லாமலும் விடுவிக்கலாம்.',
    qhBlockedNoSample: 'இன்னும் எந்த மாதிரியும் பதிவாகவில்லை — தடையில் உள்ள உணவுத் தொகுதி ஒன்று பதிவாகும் வரை விடுவிக்கப்படாது.',
    qsHeading: 'தர மாதிரியைப் பதிவு செய்', qsTest: 'எது சோதிக்கப்பட்டது', qsResult: 'முடிவு', qsNotes: 'குறிப்பு (விருப்பம்)', qsRecord: 'மாதிரியைப் பதிவு செய்',
    qsSaved: 'மாதிரி கடைக் கணினியில் சேமிக்கப்பட்டது — தலைமை அலுவலகத்தை அடையக் காத்திருக்கிறது, எந்த விடுவிப்புக்கும் முன்பே செல்லும்.',
    qsCameBack: 'வந்த முடிவு:',
    qsSavedHere: 'இந்தத் திரையில் சேமிக்கப்பட்டது — கடைக் கணினியை அடையக் காத்திருக்கிறது', qsRetrying: 'கடைக் கணினியை அடைய முயல்கிறது',
    qsOnBox: 'கடைக் கணினியில் சேமிக்கப்பட்டது — தலைமை அலுவலகத்தை அடையக் காத்திருக்கிறது', qsAtHeadOffice: 'தலைமை அலுவலகத்தில் பதிவானது',
    qsRefused: 'தலைமை அலுவலகம் மறுத்தது — இந்த மாதிரி கணக்கில் இல்லை; ஒருவர் பார்க்க வேண்டும்',
    qsNoRight: 'நீங்கள் தர மாதிரியைப் பதிவு செய்ய முடியாது — தரத் தடை உரிமை உள்ளவர் செய்ய வேண்டும்.',
    qsNeedTest: 'மாதிரியைப் பதிவு செய்யும் முன் எது சோதிக்கப்பட்டது என்று எழுதுங்கள்.', qsBadResult: 'முடிவைத் தேர்ந்தெடுங்கள்: தேர்ச்சி, தோல்வி அல்லது முடிவுக்குக் காத்திருக்கிறது.',
    qsFinal: 'இந்த மாதிரிக்கு ஏற்கனவே இறுதி முடிவு உள்ளது — மறுசோதனை புதிய மாதிரியாகப் பதிவாகும்.',
    qsAnotherTest: 'அந்த மாதிரி வேறு சோதனை — இதைப் புதிய மாதிரியாகப் பதிவு செய்யுங்கள்.',
    qsNotHeld: 'இந்தத் தொகுதி இங்கே இனி தடையில் இல்லை, அதனால் அதில் மாதிரி பதிவு செய்ய முடியாது.',
  },
};

/** One sample as the screen shows it — head office's, or recorded at the store (`here`: where it has got to). */
export type ShownSample = HeldSample & {
  readonly resultWord: string;
  readonly icon: string;
  /** Recorded on this store computer and not yet known to be at head office's — or refused there (then it does not count). */
  readonly here?: { readonly state: SampleHereState; readonly stateWord: string; readonly reason?: string };
};

export interface QualityHoldRow {
  readonly batchId: string;
  readonly productId: string;
  readonly reason: string;
  readonly heldAt: string;
  readonly state: 'held' | 'released_here';
  readonly stateWord: string;
  readonly icon: string;
  readonly canRelease: boolean;
  /** For a release this screen saved: where it has got to (refused → the batch is held again, said). */
  readonly saved?: { readonly state: DeviceItemState; readonly stateWord: string; readonly reason?: string };
  /**
   * M10-FR-02: the samples recorded on the hold, each with its result in words and an icon — or null when the store
   * computer was not told them (never an empty list that would read as "no samples"). Samples recorded at the store are
   * among them, each saying where it has got to; one head office refused is shown with its reason and does not count.
   */
  readonly samples: readonly ShownSample[] | null;
  readonly samplesWords: string;
  /** A failed or pending sample: the release is not offered, and this says why. */
  readonly blockedWords?: string;
  /** OB-513: why this hold does or does not need a recorded sample before release — null when head office did not say. */
  readonly sampleRuleWords: string | null;
  /** M10-FR-02 offline: whether this person may record a sample on this hold here (the quality-hold right, still held). */
  readonly canRecordSample: boolean;
}

export interface QualityHoldView { readonly known: boolean; readonly asAtWords: string; readonly rows: readonly QualityHoldRow[] }
export type ReleaseOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly words: string };

export interface QualityReleaseQueue {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): QualityHoldView;
  release(lang: Lang, input: { readonly batchId: string; readonly notes: string }): ReleaseOutcome;
  /**
   * M10-FR-02 offline: record a sample result on a held batch — a new sample (no `sampleId`), or the result of a pending
   * one (its `sampleId`; the test is the one on record). Saved on this device's durable queue first.
   */
  recordSample(lang: Lang, input: { readonly batchId: string; readonly sampleId?: string; readonly test?: string; readonly result: string; readonly notes?: string }): ReleaseOutcome;
  handedKeys(): readonly string[];
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

const STATE_WORD: Readonly<Record<DeviceItemState, CopyKey>> = Object.freeze({ saved_here: 'stSavedHere', retrying: 'stRetrying', handed_to_box: 'stHanded', posted: 'stPosted', refused: 'stRefused' });
const SAMPLE_STATE_WORD: Readonly<Record<SampleHereState, CopyKey>> = Object.freeze({ saved_here: 'qsSavedHere', retrying: 'qsRetrying', on_box: 'qsOnBox', at_head_office: 'qsAtHeadOffice', refused: 'qsRefused' });
const RESULTS: readonly HeldSample['result'][] = ['pass', 'fail', 'pending'];
const isResult = (v: unknown): v is HeldSample['result'] => RESULTS.includes(v as HeldSample['result']);
const fromDevice = (s: DeviceItemState): SampleHereState => (s === 'handed_to_box' ? 'on_box' : s === 'posted' ? 'at_head_office' : s);
const fromBox = (s: string | undefined): SampleHereState => (s !== undefined && /refused|dead/.test(s) ? 'refused' : s === 'acknowledged' || s === 'posted' ? 'at_head_office' : 'on_box');

/** A sample recorded at the store, before it is merged with head office's word. */
interface LocalSample extends HeldSample { readonly key: string; readonly holdHeldAt: string; readonly here: SampleHereState; readonly reason?: string }

export function createQualityReleaseQueue(
  config: { readonly userId: string | null; readonly storeId: string | null; readonly permissions: readonly string[]; readonly now: () => string; readonly newId?: () => string },
  held: HeldQualityHolds | null | undefined, outbox: SyncOutbox, boxWords: Map<string, BoxItemStatus> = new Map(),
): QualityReleaseQueue {
  const text = (lang: Lang, key: CopyKey): string => translator(QUALITY_RELEASE_COPY, lang)(key);
  const mayRelease = config.permissions.includes(RELEASE_PERMISSION);
  const mayRecord = config.permissions.includes(SAMPLE_PERMISSION);
  const newId = config.newId ?? ((): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`));
  const savedHere = (): ReadonlyMap<string, { state: DeviceItemState; reason?: string }> => new Map(outbox.all()
    .filter((i) => i.event.type === QUALITY_HOLD_RELEASE_DECIDED)
    .map((i) => {
      const box = boxWords.get(i.key);
      const reason = deviceItemReason(i, box);
      return [(i.event.payload as { batchId: string }).batchId, { state: deviceItemState(i, box), ...(reason === undefined ? {} : { reason }) }] as const;
    }));
  type Hold = HeldQualityHolds['holds'][number];
  /**
   * The samples recorded at the store on THIS hold: this device's own (its queue, with the box's word on each once asked),
   * then any the store computer holds from another screen. Oldest first, so a later result of the same sample comes last.
   */
  const localSamples = (h: Hold): readonly LocalSample[] => {
    const own = outbox.all().filter((i) => i.event.type === QUALITY_SAMPLE_RECORDED).flatMap((i): LocalSample[] => {
      const p = i.event.payload as Record<string, unknown>;
      if (p['batchId'] !== h.batchId || p['holdHeldAt'] !== h.heldAt || !isResult(p['result'])) return [];
      const box = boxWords.get(i.key);
      const reason = deviceItemReason(i, box);
      return [{ key: i.key, holdHeldAt: h.heldAt, sampleId: String(p['sampleId']), test: String(p['test']), result: p['result'], takenBy: String(p['recordedBy']), takenAt: String(p['takenAt']), here: fromDevice(deviceItemState(i, box)), ...(reason === undefined ? {} : { reason }) }];
    });
    const ownKeys = new Set(own.map((s) => s.key));
    const onBox = (h.samplesOnThisBox ?? []).filter((s) => isResult(s.result) && (s.key === undefined || !ownKeys.has(s.key))).map((s): LocalSample => ({
      key: s.key ?? qualitySampleKeyFor(h.batchId, s.sampleId, s.result), holdHeldAt: h.heldAt, sampleId: s.sampleId, test: s.test, result: s.result as HeldSample['result'],
      takenBy: s.recordedBy, takenAt: s.takenAt, here: fromBox(s.state), ...(typeof s.reason === 'string' && s.reason !== '' ? { reason: s.reason } : {}),
    }));
    return [...onBox, ...own];
  };
  /**
   * Head office's samples with the store's laid over them — the list a release here is judged on, as head office will judge
   * it once the store's samples arrive: a store result stands in for head office's when head office has none for that
   * sample, or holds it only as pending. A sample head office refused never counts (it is listed apart, with its reason).
   * Null when head office never said this hold's samples and none was recorded here.
   */
  const samplesOf = (h: Hold): { effective: readonly (HeldSample & { here?: LocalSample })[] | null; refused: readonly LocalSample[] } => {
    const local = localSamples(h);
    const refused = local.filter((s) => s.here === 'refused');
    if (!Array.isArray(h.samples) && local.length === 0) return { effective: null, refused };
    const merged = new Map<string, HeldSample & { here?: LocalSample }>((h.samples ?? []).map((s) => [s.sampleId, s]));
    for (const s of local) {
      if (s.here === 'refused') continue;
      const ho = merged.get(s.sampleId);
      if (ho === undefined || ho.result === 'pending' || ho.here !== undefined) merged.set(s.sampleId, { sampleId: s.sampleId, test: ho?.test ?? s.test, result: s.result, takenBy: ho?.takenBy ?? s.takenBy, takenAt: ho?.takenAt ?? s.takenAt, here: s });
    }
    // A sample head office already holds with the same result is head office's — nothing is waiting for it.
    const effective = [...merged.values()].map((s) => {
      const ho = (h.samples ?? []).find((x) => x.sampleId === s.sampleId);
      return s.here !== undefined && ho !== undefined && ho.result === s.result ? ho : s;
    });
    return { effective, refused };
  };
  const blockOf = (h: Hold, samples: readonly HeldSample[] | null): { code: string; key: CopyKey } | undefined =>
    samples?.some((s) => s.result === 'fail') === true ? { code: 'sample_failed', key: 'qhBlockedFail' }
      : samples?.some((s) => s.result === 'pending') === true ? { code: 'sample_pending', key: 'qhBlockedPending' }
        // OB-513: a hold head office says needs a sample, with none recorded (at head office or here), is not released.
        : h.sampleRule?.required === true && (samples === null || samples.length === 0) ? { code: 'sample_required', key: 'qhBlockedNoSample' } : undefined;
  const isReleasedHere = (h: Hold): boolean => {
    const saved = savedHere().get(h.batchId);
    return (saved !== undefined && saved.state !== 'refused') || (saved === undefined && h.releasedOnThisBox === true);
  };
  const shown = (lang: Lang, s: HeldSample & { here?: LocalSample }): ShownSample => ({
    sampleId: s.sampleId, test: s.test, result: s.result, takenBy: s.takenBy, takenAt: s.takenAt,
    resultWord: text(lang, s.result === 'pass' ? 'qhPass' : s.result === 'fail' ? 'qhFail' : 'qhPending'), icon: s.result === 'pass' ? '✓' : s.result === 'fail' ? '✕' : '…',
    ...(s.here === undefined ? {} : { here: { state: s.here.here, stateWord: text(lang, SAMPLE_STATE_WORD[s.here.here]), ...(s.here.reason === undefined ? {} : { reason: s.here.reason }) } }),
  });
  return {
    text,
    view: (lang) => {
      if (held === undefined || held === null) return { known: false, asAtWords: text(lang, 'qhNotKnown'), rows: [] };
      const mine = savedHere();
      const rows = held.holds.map((h): QualityHoldRow => {
        const saved = mine.get(h.batchId);
        const state: QualityHoldRow['state'] = isReleasedHere(h) ? 'released_here' : 'held';
        const { effective, refused } = samplesOf(h);
        const samples = effective === null && refused.length === 0 ? null
          : [...(effective ?? []).map((s) => shown(lang, s)), ...refused.map((s) => shown(lang, { ...s, here: s }))];
        // The same rule head office releases by: a failed sample can never be released; a pending one waits.
        const blocked = blockOf(h, effective);
        const ruleKey: CopyKey | undefined = h.sampleRule === undefined ? undefined : h.sampleRule.because === 'food' ? 'qhRuleFood' : h.sampleRule.because === 'food_not_known' ? 'qhRuleFoodNotKnown' : 'qhRuleNotFood';
        return {
          batchId: h.batchId, productId: h.productId, reason: h.reason, heldAt: h.heldAt, state,
          stateWord: text(lang, state === 'held' ? 'qhHeld' : 'qhReleasedHere'), icon: state === 'held' ? '⏸' : '✓',
          samples, samplesWords: text(lang, samples === null ? 'qhSamplesNotKnown' : samples.length === 0 ? 'qhNoSamples' : 'qhSamples'),
          sampleRuleWords: ruleKey === undefined ? null : text(lang, ruleKey),
          ...(blocked === undefined || state !== 'held' ? {} : { blockedWords: text(lang, blocked.key) }),
          canRelease: state === 'held' && blocked === undefined && mayRelease && config.userId !== null && config.storeId !== null && saved === undefined && h.releasedOnThisBox !== true,
          canRecordSample: state === 'held' && mayRecord && config.userId !== null && config.storeId !== null,
          ...(saved === undefined ? {} : { saved: { state: saved.state, stateWord: text(lang, STATE_WORD[saved.state]), ...(saved.reason === undefined ? {} : { reason: saved.reason }) } }),
        };
      });
      return { known: true, asAtWords: `${text(lang, 'qhAsOf')} ${held.asAt}`, rows };
    },
    release: (lang, input) => {
      const refuse = (code: string, key: CopyKey): ReleaseOutcome => ({ ok: false, code, words: text(lang, key) });
      if (config.userId === null) return refuse('nobody', 'qhNobody');
      if (config.storeId === null) return refuse('no_store', 'qhNoStore');
      if (!mayRelease) return refuse('no_right', 'qhNoRight');
      if (held === undefined || held === null || !held.holds.some((h) => h.batchId === input.batchId)) return refuse('unknown_batch', 'qhUnknown');
      if (savedHere().has(input.batchId)) return refuse('already_released_here', 'qhAlready');
      // M10-FR-02: the samples on record decide first — head office's and those recorded on this store computer — a failed
      // one is never released, a pending one waits (head office re-judges on its own records either way).
      const hold = held.holds.find((h) => h.batchId === input.batchId)!;
      const { effective } = samplesOf(hold);
      const blocked = blockOf(hold, effective ?? []);
      if (blocked !== undefined) return refuse(blocked.code, blocked.key);
      const notes = input.notes.trim();
      if (notes === '') return refuse('notes_required', 'qhNeedNotes');
      const at = config.now();
      const key = qualityReleaseKeyFor(input.batchId);
      // The samples recorded at the store that this release rests on: head office waits for each to arrive before it judges
      // (they are queued ahead of this release on the same queue, so they normally arrive first).
      const recordedHere = (effective ?? []).filter((s) => s.here !== undefined).map((s) => ({ sampleId: s.sampleId, result: s.result }));
      outbox.enqueue(makeEvent({
        id: key, type: QUALITY_HOLD_RELEASE_DECIDED, occurredAt: at, idempotencyKey: key, source: 'web-erp/facilities',
        payload: { batchId: input.batchId, storeId: config.storeId, releasedBy: config.userId, at, notes, source: 'facilities-screen', ...(recordedHere.length === 0 ? {} : { samplesRecordedHere: recordedHere }) },
      }));
      return { ok: true };
    },
    recordSample: (lang, input) => {
      const refuse = (code: string, key: CopyKey): ReleaseOutcome => ({ ok: false, code, words: text(lang, key) });
      if (config.userId === null) return refuse('nobody', 'qhNobody');
      if (config.storeId === null) return refuse('no_store', 'qhNoStore');
      if (!mayRecord) return refuse('no_right', 'qsNoRight');
      const hold = held?.holds.find((h) => h.batchId === input.batchId);
      if (hold === undefined) return refuse('unknown_batch', 'qhUnknown');
      if (isReleasedHere(hold)) return refuse('not_held', 'qsNotHeld');
      if (!isResult(input.result)) return refuse('bad_result', 'qsBadResult');
      const { effective } = samplesOf(hold);
      const current = input.sampleId === undefined ? undefined : (effective ?? []).find((s) => s.sampleId === input.sampleId);
      const test = (input.test ?? '').trim() !== '' ? (input.test ?? '').trim() : current?.test;
      if (test === undefined) return refuse('test_required', 'qsNeedTest');
      // The same rules head office records by: a final result never changes; a re-test is a new sample.
      if (current !== undefined && current.test !== test) return refuse('sample_is_another_test', 'qsAnotherTest');
      if (current !== undefined && current.result !== 'pending') return refuse('sample_result_final', 'qsFinal');
      const sampleId = input.sampleId ?? `s-${newId()}`;
      const at = config.now();
      const key = qualitySampleKeyFor(input.batchId, sampleId, input.result);
      if (outbox.all().some((i) => i.key === key)) return { ok: true }; // the same result for the same sample: one sample
      const notes = (input.notes ?? '').trim();
      outbox.enqueue(makeEvent({
        id: key, type: QUALITY_SAMPLE_RECORDED, occurredAt: at, idempotencyKey: key, source: 'web-erp/facilities',
        payload: {
          batchId: input.batchId, sampleId, holdHeldAt: hold.heldAt, storeId: config.storeId, test, result: input.result,
          takenAt: current?.takenAt ?? at, recordedBy: config.userId, at, ...(notes === '' ? {} : { notes }), source: 'facilities-screen',
        },
      }));
      return { ok: true };
    },
    handedKeys: () => outbox.all().filter((i) => (i.event.type === QUALITY_HOLD_RELEASE_DECIDED || i.event.type === QUALITY_SAMPLE_RECORDED) && i.state === 'acknowledged').map((i) => i.key),
    noteBoxStatus: (statuses) => { for (const s of statuses) boxWords.set(s.key, s); },
  };
}
