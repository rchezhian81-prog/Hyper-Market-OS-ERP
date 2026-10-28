// The facilities screen's QUALITY-HOLD RELEASES through the store computer — OB-333 (owner, 23 Oct 2026, in writing) ·
// M10-FR-02 "quality release by authorized QC" · §31 · P-01 · P-08 · hard rules #6 #10.
//
// A batch on quality hold is not sold. When the person who may release it (the quality-release right) has checked it,
// they release it here — with the line down too. Served by the store computer, the screen lists the batches head office
// holds (as the box last heard, with how old that is), and a release is written to this device's durable queue first,
// then handed to the store computer, which carries it to head office. Head office RE-CHECKS the person from their own
// grants and re-runs its release rules; a refusal comes back with its reason, shown, and the batch stays held. This
// screen can never PLACE a hold — there is no such action here, and the store computer could not relay one.
// DOM-free and tested; English and Tamil for every word; the shell renders what this hands over.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';

export const QUALITY_HOLD_RELEASE_DECIDED = 'QualityHoldReleaseDecided';
export const qualityReleaseKeyFor = (batchId: string): string => `quality-release:${batchId}`;
export const RELEASE_PERMISSION = 'quality.hold.release';

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
  }[];
}

/** One quality sample recorded on a hold, as head office said it. */
export interface HeldSample { readonly sampleId: string; readonly test: string; readonly result: 'pass' | 'fail' | 'pending'; readonly takenBy: string; readonly takenAt: string }

export type CopyKey =
  | 'qhHeading' | 'qhLead' | 'qhAsOf' | 'qhNotKnown' | 'qhNone' | 'qhHeld' | 'qhReleasedHere' | 'qhWhy' | 'qhNotes' | 'qhRelease'
  | 'qhSaved' | 'qhNobody' | 'qhNoStore' | 'qhNoRight' | 'qhNeedNotes' | 'qhUnknown' | 'qhAlready'
  | 'stSavedHere' | 'stRetrying' | 'stHanded' | 'stPosted' | 'stRefused'
  | 'qhSamples' | 'qhNoSamples' | 'qhSamplesNotKnown' | 'qhPass' | 'qhFail' | 'qhPending' | 'qhTakenBy' | 'qhBlockedFail' | 'qhBlockedPending';

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
  },
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
   * computer was not told them (never an empty list that would read as "no samples").
   */
  readonly samples: readonly (HeldSample & { readonly resultWord: string; readonly icon: string })[] | null;
  readonly samplesWords: string;
  /** A failed or pending sample: the release is not offered, and this says why. */
  readonly blockedWords?: string;
}

export interface QualityHoldView { readonly known: boolean; readonly asAtWords: string; readonly rows: readonly QualityHoldRow[] }
export type ReleaseOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly words: string };

export interface QualityReleaseQueue {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): QualityHoldView;
  release(lang: Lang, input: { readonly batchId: string; readonly notes: string }): ReleaseOutcome;
  handedKeys(): readonly string[];
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

const STATE_WORD: Readonly<Record<DeviceItemState, CopyKey>> = Object.freeze({ saved_here: 'stSavedHere', retrying: 'stRetrying', handed_to_box: 'stHanded', posted: 'stPosted', refused: 'stRefused' });

export function createQualityReleaseQueue(
  config: { readonly userId: string | null; readonly storeId: string | null; readonly permissions: readonly string[]; readonly now: () => string },
  held: HeldQualityHolds | null | undefined, outbox: SyncOutbox, boxWords: Map<string, BoxItemStatus> = new Map(),
): QualityReleaseQueue {
  const text = (lang: Lang, key: CopyKey): string => translator(QUALITY_RELEASE_COPY, lang)(key);
  const mayRelease = config.permissions.includes(RELEASE_PERMISSION);
  const savedHere = (): ReadonlyMap<string, { state: DeviceItemState; reason?: string }> => new Map(outbox.all()
    .filter((i) => i.event.type === QUALITY_HOLD_RELEASE_DECIDED)
    .map((i) => {
      const box = boxWords.get(i.key);
      const reason = deviceItemReason(i, box);
      return [(i.event.payload as { batchId: string }).batchId, { state: deviceItemState(i, box), ...(reason === undefined ? {} : { reason }) }] as const;
    }));
  return {
    text,
    view: (lang) => {
      if (held === undefined || held === null) return { known: false, asAtWords: text(lang, 'qhNotKnown'), rows: [] };
      const mine = savedHere();
      const rows = held.holds.map((h): QualityHoldRow => {
        const saved = mine.get(h.batchId);
        const state: QualityHoldRow['state'] = (saved !== undefined && saved.state !== 'refused') || (saved === undefined && h.releasedOnThisBox === true) ? 'released_here' : 'held';
        const samples = Array.isArray(h.samples) ? h.samples.map((s) => ({
          ...s, resultWord: text(lang, s.result === 'pass' ? 'qhPass' : s.result === 'fail' ? 'qhFail' : 'qhPending'), icon: s.result === 'pass' ? '✓' : s.result === 'fail' ? '✕' : '…',
        })) : null;
        // The same rule head office releases by: a failed sample can never be released; a pending one waits.
        const blocked: CopyKey | undefined = samples?.some((s) => s.result === 'fail') === true ? 'qhBlockedFail' : samples?.some((s) => s.result === 'pending') === true ? 'qhBlockedPending' : undefined;
        return {
          batchId: h.batchId, productId: h.productId, reason: h.reason, heldAt: h.heldAt, state,
          stateWord: text(lang, state === 'held' ? 'qhHeld' : 'qhReleasedHere'), icon: state === 'held' ? '⏸' : '✓',
          samples, samplesWords: text(lang, samples === null ? 'qhSamplesNotKnown' : samples.length === 0 ? 'qhNoSamples' : 'qhSamples'),
          ...(blocked === undefined || state !== 'held' ? {} : { blockedWords: text(lang, blocked) }),
          canRelease: state === 'held' && blocked === undefined && mayRelease && config.userId !== null && config.storeId !== null && saved === undefined && h.releasedOnThisBox !== true,
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
      // M10-FR-02: the samples on record decide first — a failed one is never released, a pending one waits (head office
      // re-judges on its own records either way).
      const samples = held.holds.find((h) => h.batchId === input.batchId)?.samples ?? [];
      if (samples.some((s) => s.result === 'fail')) return refuse('sample_failed', 'qhBlockedFail');
      if (samples.some((s) => s.result === 'pending')) return refuse('sample_pending', 'qhBlockedPending');
      const notes = input.notes.trim();
      if (notes === '') return refuse('notes_required', 'qhNeedNotes');
      const at = config.now();
      const key = qualityReleaseKeyFor(input.batchId);
      outbox.enqueue(makeEvent({
        id: key, type: QUALITY_HOLD_RELEASE_DECIDED, occurredAt: at, idempotencyKey: key, source: 'web-erp/facilities',
        payload: { batchId: input.batchId, storeId: config.storeId, releasedBy: config.userId, at, notes, source: 'facilities-screen' },
      }));
      return { ok: true };
    },
    handedKeys: () => outbox.all().filter((i) => i.event.type === QUALITY_HOLD_RELEASE_DECIDED && i.state === 'acknowledged').map((i) => i.key),
    noteBoxStatus: (statuses) => { for (const s of statuses) boxWords.set(s.key, s); },
  };
}
