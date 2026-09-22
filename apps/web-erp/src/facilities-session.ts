// The FACILITIES maintenance & compliance screen — the "what statutory / safety / cleaning task is overdue, and
// what a regulator would care about" desk (M26-FR-03 · API-11 · P-03 control-by-exception · P-04 least privilege
// · P-05 human-governed · P-08 no silent failure). The facilities service (services/platform/src/facilities.ts)
// raises recurring maintenance/compliance tasks and folds the overdue list (`GET /v1/facilities/overdue?asOf=`)
// through the pure `findOverdue`: a compliance-linked miss (fire, pest, electrical, statutory) ESCALATES BY
// ITSELF, because nothing ever going red is how nothing is ever wrong. This is the screen a facilities manager
// works it from: every overdue task — worst first — and the one action taken from here, MARK IT DONE, in the
// completer's own name.
//
// Truths the surface must carry, all already true in the service and re-stated so the screen cannot weaken them:
//   • **Worst first, and the fire check is never buried among mop alerts** (M26-FR-03, P-03). A compliance risk
//     (a regulator would care) is an error tone and shouts loudest; an escalated or plainly-late task is a
//     warning; a task due today is neutral but still needs a person. Colour is never the only signal (an icon +
//     a word ride with every tone).
//   • **A tick is worth nothing at an inspection; a dated photograph is worth everything** (M26-FR-03). Marking a
//     task done needs `facilities.task.record`; the SERVER refuses a completion with no required evidence, and a
//     safety check a second person has not verified (§28) — the screen never fakes a success it did not get
//     (P-08). A viewer with only `facilities.overdue.read` sees the list but is offered no done control.
//   • **Nobody completes in nobody's name** (hard rule #5 / P-05). A box never told who is at the screen records
//     nothing; the completion is a HUMAN decision in the completer's own name, and a self-verified safety check
//     is refused by the server (§28).
//   • **It self-heals.** The overdue list is re-READ from the cloud, so a task genuinely done drops off on its
//     own; this screen never carries a "done" flag that can go stale against reality. A box never told is `not
//     known`, never "nothing overdue" (P-08).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives; the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

/** How late a task is and how loudly it should shout — the escalation ladder the service's `findOverdue`
 *  computes. `compliance_risk` is a regulator-facing miss; `none` never appears in the overdue list. */
export type EscalationLevel = 'none' | 'due' | 'overdue' | 'escalated' | 'compliance_risk';

/** A maintenance/compliance category. Cleaning is deliberately never compliance-linked; a fire check always is. */
export type ScheduleCategory = 'cleaning' | 'pest_control' | 'fire_safety' | 'electrical_safety' | 'maintenance' | 'statutory';

/** One overdue task as the board last read it — the shape `GET /v1/facilities/overdue` hands each row over. Only
 *  the fields this screen renders or decides on are named; extra fields are ignored. */
export interface OverdueTask {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly title: string;
  readonly category: ScheduleCategory;
  readonly dueOn: string;
  readonly daysOverdue: number;
  readonly level: EscalationLevel;
  /** Who must be told. Present once it escalates. */
  readonly escalateTo?: string;
  /** True when a regulator would care. Cleaning is never this. */
  readonly complianceLinked: boolean;
  readonly detail: string;
}

/** The overdue board the shell last read. Empty means nothing overdue; absent means the box was never told. */
export interface FacilitiesData {
  readonly overdue: readonly OverdueTask[];
}

/** The outcome of a completion — recorded (done), refused by the server (permission / no evidence / not verified /
 *  self-verified), or a lost link. */
export type CompleteResult = 'completed' | 'refused' | 'lost_link';

/** What the completer optionally attaches: a piece of evidence (a photo/certificate reference) and, for a safety
 *  check, the second person who verified it (§28). */
export interface CompleteInput {
  readonly evidenceRef?: string;
  readonly verifiedBy?: string;
  readonly note?: string;
}

/** The authenticated POST of a facilities manager's "it's done" decision. Injected, so the model never opens a
 *  socket itself; the server records it in the caller's own name (`POST /v1/facilities/tasks/:taskId/complete`),
 *  re-checks `facilities.task.record`, and refuses a completion with no required evidence or a self-verified
 *  safety check. */
export interface CompletePort {
  post(input: {
    readonly taskId: string;
    readonly completedBy: string;
    readonly evidenceRefs?: readonly string[];
    readonly verifiedBy?: string;
    readonly note?: string;
  }): Promise<CompleteResult>;
}

export interface FacilitiesPorts {
  /** The overdue board the shell last read (live from the cloud, or the injected stand-in). */
  worklist(): FacilitiesData;
  /** Whether this user may read the overdue list (`facilities.overdue.read`). */
  mayRead(): boolean;
  /** Whether this user may mark a task done (`facilities.task.record`). */
  mayComplete(): boolean;
  /** Records a completion. Only reached from the explicit action, never on render. */
  completePort(): CompletePort;
}

export interface FacilitiesConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'listHeading' | 'overdueCount' | 'allDone' | 'notKnown' | 'complianceRiskCount'
  | 'categoryLabel' | 'dueLabel' | 'lateLabel' | 'escalatedToLabel'
  | 'catCleaning' | 'catPestControl' | 'catFireSafety' | 'catElectricalSafety' | 'catMaintenance' | 'catStatutory'
  | 'complianceWord' | 'escalatedWord' | 'overdueWord' | 'dueWord'
  | 'dueTodayText' | 'daysLateText'
  | 'completeBtn' | 'completeHint' | 'evidenceLabel' | 'verifierLabel'
  | 'completeRecorded' | 'completeRefused' | 'completeLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted' | 'noComplete'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const FACILITIES_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Maintenance & compliance', langName: 'தமிழ்',
    lead: 'Cleaning, pest control, fire and electrical safety and statutory checks that are overdue — worst first. A tick is worth nothing at an inspection and a dated photograph is worth everything, so a check the regulator would care about is marked done only with the evidence it needs and a second person to verify a safety check. Nothing ever going red is how nothing is ever wrong.',
    listHeading: 'Overdue', overdueCount: 'overdue', allDone: 'Nothing overdue — every scheduled check is up to date.',
    notKnown: 'This store computer has not been told the maintenance schedules yet, so it cannot say what is overdue.',
    complianceRiskCount: 'a regulator would care about',
    categoryLabel: 'Kind', dueLabel: 'Was due', lateLabel: 'Late by', escalatedToLabel: 'Escalated to',
    catCleaning: 'Cleaning', catPestControl: 'Pest control', catFireSafety: 'Fire safety', catElectricalSafety: 'Electrical safety', catMaintenance: 'Maintenance', catStatutory: 'Statutory',
    complianceWord: 'Compliance risk', escalatedWord: 'Escalated', overdueWord: 'Overdue', dueWord: 'Due today',
    dueTodayText: 'due today', daysLateText: 'day(s) late',
    completeBtn: 'Mark done', completeHint: 'Marking a check done records it in your name. A check that needs a photo or a second person will be refused until you attach them.',
    evidenceLabel: 'Evidence reference (photo / certificate)', verifierLabel: 'Verified by (a second person)',
    completeRecorded: 'Marked done and recorded.',
    completeRefused: 'Not accepted — this check needs its evidence attached, or a second person to verify it (a safety check you did yourself is a signature against nothing), or you do not have permission.',
    completeLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the overdue checks', scrEmpty: 'Nothing overdue — every scheduled check is up to date.',
    stateNotPermitted: 'You do not have permission to see maintenance and compliance.',
    noComplete: 'You can see the overdue checks, but marking one done needs the facilities-record permission.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'பராமரிப்பு & இணக்கம்', langName: 'English',
    lead: 'சுத்தம், பூச்சிக் கட்டுப்பாடு, தீ மற்றும் மின் பாதுகாப்பு, சட்டப்பூர்வச் சோதனைகள் தாமதமானவை — மோசமானது முதலில். ஒரு டிக் ஆய்வின்போது எந்த மதிப்பும் இல்லை, தேதியிட்ட புகைப்படமே முக்கியம்; எனவே ஒழுங்குமுறை அதிகாரி கவலைப்படும் சோதனை, தேவையான ஆதாரத்துடனும், பாதுகாப்புச் சோதனையை இரண்டாம் நபர் சரிபார்த்தாலும் மட்டுமே முடிந்ததாகக் குறிக்கப்படும். எதுவும் சிவப்பாகாமல் இருப்பதே எதுவும் தவறில்லை என்பதாகும்.',
    listHeading: 'தாமதமானவை', overdueCount: 'தாமதம்', allDone: 'தாமதம் எதுவும் இல்லை — ஒவ்வொரு சோதனையும் புதுப்பித்த நிலையில்.',
    notKnown: 'பராமரிப்பு அட்டவணைகள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை, எனவே எது தாமதம் என்று சொல்ல முடியாது.',
    complianceRiskCount: 'ஒழுங்குமுறை அதிகாரி கவலைப்படுவார்',
    categoryLabel: 'வகை', dueLabel: 'தேதி இருந்தது', lateLabel: 'தாமதம்', escalatedToLabel: 'மேலிடம் அறிவிக்கப்பட்டது',
    catCleaning: 'சுத்தம்', catPestControl: 'பூச்சிக் கட்டுப்பாடு', catFireSafety: 'தீ பாதுகாப்பு', catElectricalSafety: 'மின் பாதுகாப்பு', catMaintenance: 'பராமரிப்பு', catStatutory: 'சட்டப்பூர்வம்',
    complianceWord: 'இணக்க அபாயம்', escalatedWord: 'மேலிடம்', overdueWord: 'தாமதம்', dueWord: 'இன்று',
    dueTodayText: 'இன்று செய்ய வேண்டியது', daysLateText: 'நாள் தாமதம்',
    completeBtn: 'முடிந்ததெனக் குறி', completeHint: 'ஒரு சோதனையை முடிந்ததெனக் குறித்தல் அதை உங்கள் பெயரில் பதிவு செய்கிறது. புகைப்படம் அல்லது இரண்டாம் நபர் தேவைப்படும் சோதனை, அவற்றை இணைக்கும் வரை மறுக்கப்படும்.',
    evidenceLabel: 'ஆதாரக் குறிப்பு (புகைப்படம் / சான்றிதழ்)', verifierLabel: 'சரிபார்த்தவர் (இரண்டாம் நபர்)',
    completeRecorded: 'முடிந்ததெனக் குறிக்கப்பட்டு பதிவு செய்யப்பட்டது.',
    completeRefused: 'ஏற்கப்படவில்லை — இந்தச் சோதனைக்கு ஆதாரம் இணைக்கப்பட வேண்டும், அல்லது இரண்டாம் நபர் சரிபார்க்க வேண்டும் (நீங்களே செய்த பாதுகாப்புச் சோதனை ஒன்றுமில்லாத கையொப்பம்), அல்லது உங்களுக்கு அனுமதி இல்லை.',
    completeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'தாமதமான சோதனைகளைக் காட்டுகிறது', scrEmpty: 'தாமதம் எதுவும் இல்லை — ஒவ்வொரு சோதனையும் புதுப்பித்த நிலையில்.',
    stateNotPermitted: 'பராமரிப்பு & இணக்கத்தைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    noComplete: 'தாமதமான சோதனைகளைப் பார்க்கலாம், ஆனால் ஒன்றை முடிந்ததெனக் குறிக்க facilities-record அனுமதி தேவை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(FACILITIES_COPY.en) as CopyKey[]);

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedTask {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly title: string;
  readonly category: ScheduleCategory;
  readonly categoryWord: string;
  readonly dueOn: string;
  readonly daysOverdue: number;
  /** "due today" / "N day(s) late" — the lateness in words, never a bare number. */
  readonly lateWord: string;
  readonly detail: string;
  /** Who it escalated to, or `null` when it has not escalated. */
  readonly escalateTo: string | null;
  readonly complianceLinked: boolean;
  /** "Compliance risk" / "Escalated" / "Overdue" / "Due today" — a word, never colour alone. */
  readonly severityWord: string;
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
}

export interface FacilitiesView {
  readonly screenState: StatusPresentation;
  readonly tasks: readonly PresentedTask[];
  readonly overdueCount: number;
  /** How many are compliance risks — the headline a manager acts on first (P-03). */
  readonly complianceRiskCount: number;
  readonly nobodyNamed: boolean;
  /** Whether to offer the "mark done" action — this user holds `facilities.task.record`. */
  readonly mayComplete: boolean;
}

export interface FacilitiesSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): FacilitiesView;
  /** Mark an overdue task done — a HUMAN write in the completer's name. Runs only from an explicit action, never
   *  on render; refuses BEFORE any POST without the record permission, when the box was not told who is at the
   *  screen, or for a task it does not hold (the server re-checks and also refuses a completion with no required
   *  evidence or a self-verified safety check). */
  complete(taskId: string, input?: CompleteInput): Promise<CompleteResult>;
  /** Present a completion outcome as one glanceable status the shell shows after the action. */
  presentCompleteResult(lang: Lang, result: CompleteResult): StatusPresentation;
}

const EMPTY_VIEW = (screenState: StatusPresentation, nobodyNamed: boolean, mayComplete: boolean): FacilitiesView => ({
  screenState, tasks: [], overdueCount: 0, complianceRiskCount: 0, nobodyNamed, mayComplete,
});

const CATEGORY_KEY: Readonly<Record<ScheduleCategory, CopyKey>> = Object.freeze({
  cleaning: 'catCleaning', pest_control: 'catPestControl', fire_safety: 'catFireSafety',
  electrical_safety: 'catElectricalSafety', maintenance: 'catMaintenance', statutory: 'catStatutory',
});

/** The escalation rank (0 worst) and how each level presents — the ordering the manager acts on (P-03). */
const LEVEL: Readonly<Record<EscalationLevel, { rank: number; tone: 'error' | 'degraded' | 'idle'; icon: string; word: CopyKey }>> = Object.freeze({
  compliance_risk: { rank: 0, tone: 'error', icon: '✕', word: 'complianceWord' },
  escalated: { rank: 1, tone: 'degraded', icon: '⚠', word: 'escalatedWord' },
  overdue: { rank: 2, tone: 'degraded', icon: '⚠', word: 'overdueWord' },
  due: { rank: 3, tone: 'idle', icon: '•', word: 'dueWord' },
  none: { rank: 4, tone: 'idle', icon: '•', word: 'dueWord' },
});

export function createFacilitiesSession(config: FacilitiesConfig, ports: FacilitiesPorts): FacilitiesSession {
  const text = (lang: Lang, key: CopyKey): string => translator(FACILITIES_COPY, lang)(key);

  const present = (lang: Lang, task: OverdueTask): PresentedTask => {
    const t = translator(FACILITIES_COPY, lang);
    const lvl = LEVEL[task.level];
    const severityWord = t(lvl.word);
    const lateWord = task.daysOverdue <= 0 ? t('dueTodayText') : `${task.daysOverdue} ${t('daysLateText')}`;
    return {
      taskId: task.taskId,
      scheduleId: task.scheduleId,
      title: task.title,
      category: task.category,
      categoryWord: t(CATEGORY_KEY[task.category]),
      dueOn: task.dueOn,
      daysOverdue: task.daysOverdue,
      lateWord,
      detail: task.detail,
      escalateTo: task.escalateTo ?? null,
      complianceLinked: task.complianceLinked,
      severityWord,
      status: presentStatus({
        tone: lvl.tone,
        icon: lvl.icon,
        label: `${severityWord} · ${task.title}`,
        announcement: task.detail,
        needsAttention: true,
      }),
      needsAttention: true,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(FACILITIES_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayComplete = ports.mayComplete();

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, mayComplete);
      }

      const data = ports.worklist();
      // Worst first: a compliance risk before an escalated task before a plain-late one before a due-today one;
      // then the longest-overdue first, because a check that has rotted for a month is more urgent than one a day
      // late (P-03). The service already sorts this way; the screen re-sorts so it never depends on wire order.
      const tasks = data.overdue
        .slice()
        .sort((a, b) => LEVEL[a.level].rank - LEVEL[b.level].rank || b.daysOverdue - a.daysOverdue || a.taskId.localeCompare(b.taskId))
        .map((task) => present(lang, task));
      const state = tasks.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        tasks,
        overdueCount: tasks.length,
        complianceRiskCount: tasks.filter((task) => task.complianceLinked && task.status.tone === 'error').length,
        nobodyNamed,
        mayComplete,
      };
    },

    // Mark a task done. Refuse BEFORE any POST — no permission, nobody named, or a task the box does not hold is a
    // local refusal, not a round trip. The server re-checks the permission, refuses a completion with no required
    // evidence or a self-verified safety check, and records the decision in the caller's own name (hard rule #5).
    complete: async (taskId, input) => {
      if (!ports.mayComplete()) return 'refused';
      if (config.userId === null) return 'refused'; // a completion cannot be recorded in nobody's name
      const data = ports.worklist();
      const task = data.overdue.find((o) => o.taskId === taskId);
      if (task === undefined) return 'refused';
      const evidenceRef = input?.evidenceRef?.trim();
      const verifiedBy = input?.verifiedBy?.trim();
      const note = input?.note?.trim();
      return ports.completePort().post({
        taskId,
        completedBy: config.userId,
        ...(evidenceRef ? { evidenceRefs: [evidenceRef] } : {}),
        ...(verifiedBy ? { verifiedBy } : {}),
        ...(note ? { note } : {}),
      });
    },

    presentCompleteResult: (lang, result) => {
      const t = translator(FACILITIES_COPY, lang);
      if (result === 'completed') return presentStatus({ tone: 'ok', icon: '✓', label: t('completeRecorded'), needsAttention: false });
      if (result === 'lost_link') return presentStatus({ tone: 'degraded', icon: '⚠', label: t('completeLostLink'), needsAttention: true });
      return presentStatus({ tone: 'error', icon: '✕', label: t('completeRefused'), needsAttention: true });
    },
  };
}
