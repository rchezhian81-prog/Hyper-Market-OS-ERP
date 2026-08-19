// The product-publish REVIEW QUEUE — the operator screen (ADR-0013 slice 3, M03-FR-01/03, P-03 · P-04 · P-08,
// hard rule #6 · #10). ADR-0013 recorded the owner's decision: a product authored offline is delivered to the
// shared truth by the SIGNED-IN OPERATOR, as themselves, from a REVIEW QUEUE — never blindly drained by a
// background service identity, and never auto-published after login. This is that queue's screen.
//
// It shows every queued `ProductPublishRequested` command with the state the operator sees RIGHT NOW —
// `pending`, `ready`, `validation_failed`, `approval_required`, `conflict`, `published`, `permanently_refused`
// — computed by the tested classifier (`product-publish-queue.ts`) from the operator's CURRENT authenticated
// context, never the permissions captured when the item was queued (ADR-0013 controls 3, 5, 10). The point of
// the screen is triage: the ones needing a person are first — an item routed for someone who holds the
// authority, a stale-validation item, a conflict surfaced instead of last-write-wins, a dead-lettered refusal
// kept for review (hard rule #6). Publishing is a SEPARATE, EXPLICIT action (`deliver`) a person triggers on
// the ready items only — it delegates to the tested delivery step (`product-publish-delivery.ts`), which sends
// each ready command under the operator's own session and never auto-publishes (ADR-0013 controls 6, 8).
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone) over the already
// tested classifier and delivery engines; the shell only renders what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation, type Tone } from '../../../packages/a11y/src/signals';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { ProductPublishPayload } from './catalogue-publish-command';
import {
  summarizePublishQueue,
  type PublishQueueState, type PublishReviewContext,
} from './product-publish-queue';
import {
  deliverReadyPublishes, toQueuedPublishItem,
  type PublishDeliveryPort, type PublishDeliveryReport,
} from './product-publish-delivery';

export interface ProductPublishReviewConfig {
  /** Who is looking. `null` means the store computer was not told who — refuse to publish (hard rule #4). */
  readonly userId: string | null;
}

export interface ProductPublishReviewPorts {
  /** The operator's CURRENT authenticated context — re-read every render, NEVER the queued snapshot (control 3). */
  context(): PublishReviewContext;
  /** The durable publish outbox to review (and, only on the explicit deliver action, to drain). */
  outbox(): SyncOutbox<string, ProductPublishPayload>;
  /** Operator-authenticated POST of a ready publish — carries the operator's own session, never a token
   *  (ADR-0013). Injected, so the screen never opens a socket itself. */
  deliveryPort(): PublishDeliveryPort;
}

// ── the copy: ONE bilingual object for the whole screen (a guardrail binds to it) ────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'colReference' | 'colBy' | 'colWhen' | 'colStatus'
  | 'stPending' | 'stReady' | 'stValidationFailed' | 'stApprovalRequired' | 'stConflict' | 'stPublished' | 'stPermanentlyRefused'
  | 'detailApproval' | 'detailValidation' | 'detailConflict' | 'detailRefused'
  | 'deliverBtn' | 'deliverNone'
  | 'resultDelivered' | 'resultHeld' | 'resultRefused' | 'resultSkipped' | 'resultNothing'
  | 'readyCount' | 'attentionCount' | 'allClear'
  | 'scrReady' | 'scrEmpty' | 'scrLocked' | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const PRODUCT_PUBLISH_REVIEW_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Products waiting to publish', langName: 'தமிழ்',
    lead: 'Products saved on this computer, waiting to reach the shared catalogue. The ones needing a person are first — waiting for someone with authority, a detail to fix, a clash to settle, or a refusal to look at. Publishing sends only the ready ones, as you, when you press the button — nothing sends on its own.',
    colReference: 'Product', colBy: 'Saved by', colWhen: 'Saved at', colStatus: 'Status',
    stPending: 'Waiting', stReady: 'Ready to publish', stValidationFailed: 'Needs a fix before it can publish',
    stApprovalRequired: 'Needs someone with authority', stConflict: 'Clashes with another change — settle it',
    stPublished: 'Published', stPermanentlyRefused: 'Refused — kept for review',
    detailApproval: 'You cannot publish this one right now — it is routed to someone who holds the authority.',
    detailValidation: 'This product did not pass the checks — open it, fix what is missing, and save again.',
    detailConflict: 'Someone else changed this product too. It will not overwrite them — decide which change wins.',
    detailRefused: 'The shared catalogue refused this and it was kept, not dropped. Someone must look at why.',
    deliverBtn: 'Publish the ready ones', deliverNone: 'Nothing is ready to publish',
    resultDelivered: 'published', resultHeld: 'held to try again', resultRefused: 'refused', resultSkipped: 'left for a person',
    resultNothing: 'Nothing was ready to publish.',
    readyCount: 'ready to publish', attentionCount: 'need a person', allClear: 'Nothing is waiting — the catalogue is up to date.',
    scrReady: 'Showing products waiting to publish', scrEmpty: 'Nothing is waiting to publish.',
    scrLocked: 'Sign in on this computer to review products waiting to publish.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'வெளியிட காத்திருக்கும் பொருட்கள்', langName: 'English',
    lead: 'இந்தக் கணினியில் சேமிக்கப்பட்ட பொருட்கள், பகிரப்பட்ட பட்டியலை அடைய காத்திருக்கின்றன. ஒருவர் தேவைப்படுபவை முதலில் — அதிகாரம் உள்ளவருக்காக, சரிசெய்ய வேண்டிய விவரம், தீர்க்க வேண்டிய மோதல், அல்லது பார்க்க வேண்டிய மறுப்பு. வெளியிடும்போது தயாராக உள்ளவை மட்டுமே, நீங்களாக, பொத்தானை அழுத்தும்போது அனுப்பப்படும் — எதுவும் தானாக அனுப்பப்படாது.',
    colReference: 'பொருள்', colBy: 'சேமித்தவர்', colWhen: 'சேமித்த நேரம்', colStatus: 'நிலை',
    stPending: 'காத்திருக்கிறது', stReady: 'வெளியிட தயார்', stValidationFailed: 'வெளியிடுவதற்கு முன் சரிசெய்ய வேண்டும்',
    stApprovalRequired: 'அதிகாரம் உள்ளவர் தேவை', stConflict: 'மற்றொரு மாற்றத்துடன் மோதுகிறது — தீர்க்கவும்',
    stPublished: 'வெளியிடப்பட்டது', stPermanentlyRefused: 'மறுக்கப்பட்டது — பரிசீலனைக்காக வைக்கப்பட்டுள்ளது',
    detailApproval: 'இதை இப்போது உங்களால் வெளியிட முடியாது — அதிகாரம் உள்ள ஒருவருக்கு அனுப்பப்பட்டுள்ளது.',
    detailValidation: 'இந்தப் பொருள் சோதனைகளில் தேர்ச்சி பெறவில்லை — திறந்து, குறையைச் சரிசெய்து, மீண்டும் சேமிக்கவும்.',
    detailConflict: 'வேறு ஒருவரும் இந்தப் பொருளை மாற்றியுள்ளார். இது அவர்களை மேலெழுதாது — எந்த மாற்றம் வெல்லும் என்று தீர்மானிக்கவும்.',
    detailRefused: 'பகிரப்பட்ட பட்டியல் இதை மறுத்தது, ஆனால் கைவிடப்படவில்லை, வைக்கப்பட்டுள்ளது. காரணத்தை ஒருவர் பார்க்க வேண்டும்.',
    deliverBtn: 'தயாராக உள்ளவற்றை வெளியிடு', deliverNone: 'வெளியிட எதுவும் தயாராக இல்லை',
    resultDelivered: 'வெளியிடப்பட்டது', resultHeld: 'மீண்டும் முயற்சிக்க வைக்கப்பட்டது', resultRefused: 'மறுக்கப்பட்டது', resultSkipped: 'ஒருவருக்காக விடப்பட்டது',
    resultNothing: 'வெளியிட எதுவும் தயாராக இல்லை.',
    readyCount: 'வெளியிட தயார்', attentionCount: 'ஒருவர் தேவை', allClear: 'எதுவும் காத்திருக்கவில்லை — பட்டியல் புதுப்பித்த நிலையில் உள்ளது.',
    scrReady: 'வெளியிட காத்திருக்கும் பொருட்களைக் காட்டுகிறது', scrEmpty: 'வெளியிட எதுவும் காத்திருக்கவில்லை.',
    scrLocked: 'வெளியிட காத்திருக்கும் பொருட்களைப் பரிசீலிக்க இந்தக் கணினியில் உள்நுழையவும்.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(PRODUCT_PUBLISH_REVIEW_COPY.en) as CopyKey[]);

/** The label, tone, icon and whether-a-person-is-needed for each queue state. Colour is never the only
 *  signal (§ design system): an icon and a word ride with every tone, and ordering is by attention. */
const STATE_FACE: Readonly<Record<PublishQueueState, {
  readonly tone: Tone; readonly icon: string; readonly attention: boolean;
  readonly label: CopyKey; readonly detail?: CopyKey;
}>> = {
  pending: { tone: 'idle', icon: '⋯', attention: false, label: 'stPending' },
  ready: { tone: 'ok', icon: '✓', attention: false, label: 'stReady' },
  validation_failed: { tone: 'error', icon: '✕', attention: true, label: 'stValidationFailed', detail: 'detailValidation' },
  approval_required: { tone: 'degraded', icon: '⚠', attention: true, label: 'stApprovalRequired', detail: 'detailApproval' },
  conflict: { tone: 'error', icon: '⚠', attention: true, label: 'stConflict', detail: 'detailConflict' },
  published: { tone: 'ok', icon: '✓', attention: false, label: 'stPublished' },
  permanently_refused: { tone: 'error', icon: '⛔', attention: true, label: 'stPermanentlyRefused', detail: 'detailRefused' },
};

// ── presented shapes ─────────────────────────────────────────────────────────────────────────────────

export interface PresentedPublishItem {
  readonly key: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly tenantId: string;
  readonly state: PublishQueueState;
  readonly status: StatusPresentation;
  readonly needsAttention: boolean;
  /** True only for `ready` — the deliver action may send this one, and no other (control 6, 8). */
  readonly deliverable: boolean;
  /** A plain-English line telling the operator what to do about an exception; empty for ok states. */
  readonly detail: string;
}

export interface ProductPublishReviewView {
  readonly screenState: StatusPresentation;
  readonly rows: readonly PresentedPublishItem[];
  readonly counts: Readonly<Record<PublishQueueState, number>>;
  readonly readyCount: number;
  readonly attentionCount: number;
  readonly total: number;
  readonly nobodyNamed: boolean;
}

export interface ProductPublishReviewSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): ProductPublishReviewView;
  /** Present a delivery result as one glanceable status — ok if all sent, degraded if any held, error if any
   *  refused. The shell shows this after the operator presses publish. */
  presentDeliveryReport(lang: Lang, report: PublishDeliveryReport): StatusPresentation;
  /** The EXPLICIT publish action: deliver the ready items as the signed-in operator. Delegates to the tested
   *  delivery step (only the ready keys are sent; nothing auto-publishes). Runs only when a person calls it. */
  deliver(): Promise<PublishDeliveryReport>;
}

export function createProductPublishReviewSession(
  config: ProductPublishReviewConfig,
  ports: ProductPublishReviewPorts,
): ProductPublishReviewSession {
  const text = (lang: Lang, key: CopyKey): string => translator(PRODUCT_PUBLISH_REVIEW_COPY, lang)(key);

  return {
    text,
    view: (lang) => {
      const t = translator(PRODUCT_PUBLISH_REVIEW_COPY, lang);

      // A publish is an authenticated act — a screen that does not know who is using it must not review a
      // queue for delivery (hard rule #4, no shared logins). Refuse before reading anything.
      if (config.userId === null) {
        return {
          screenState: presentScreenState({ state: 'locked', label: t('scrLocked') }),
          rows: [], counts: { ...ZERO_COUNTS }, readyCount: 0, attentionCount: 0, total: 0, nobodyNamed: true,
        };
      }

      const ctx = ports.context();
      // Read EVERY item, not just the pending ones — a dead-lettered refusal and an already-published item
      // are shown too (hard rule #6: a dead letter is VISIBLE, never dropped; the classifier maps the terminal
      // outbox states to `permanently_refused` / `published`). The classifier reads the operator's CURRENT
      // context for every still-deliverable item — never the queued snapshot.
      const items = ports.outbox().all().map((i) => toQueuedPublishItem(i));
      const summary = summarizePublishQueue(items, ctx);

      const rows: PresentedPublishItem[] = summary.rows.map(({ item, state }) => {
        const face = STATE_FACE[state];
        const label = t(face.label);
        return {
          key: item.key,
          createdBy: item.createdBy,
          createdAt: item.createdAt,
          tenantId: item.tenantId,
          state,
          status: presentStatus({
            tone: face.tone, icon: face.icon, label,
            announcement: `${item.createdBy}: ${label}`, needsAttention: face.attention,
          }),
          needsAttention: face.attention,
          deliverable: state === 'ready',
          detail: face.detail ? t(face.detail) : '',
        };
      });

      // Attention first (control-by-exception, P-03), then oldest-queued first — the longest-waiting is nearest.
      const ordered = [...rows].sort((a, b) => {
        if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      });

      const attentionCount = rows.filter((r) => r.needsAttention).length;
      const state = rows.length === 0 ? 'empty' : 'ready';
      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        rows: ordered,
        counts: summary.counts,
        readyCount: summary.readyKeys.length,
        attentionCount,
        total: rows.length,
        nobodyNamed: false,
      };
    },

    presentDeliveryReport: (lang, report) => {
      const t = translator(PRODUCT_PUBLISH_REVIEW_COPY, lang);
      const parts: string[] = [];
      if (report.delivered.length > 0) parts.push(`${report.delivered.length} ${t('resultDelivered')}`);
      if (report.held.length > 0) parts.push(`${report.held.length} ${t('resultHeld')}`);
      if (report.refused.length > 0) parts.push(`${report.refused.length} ${t('resultRefused')}`);
      if (report.skipped.length > 0) parts.push(`${report.skipped.length} ${t('resultSkipped')}`);
      if (parts.length === 0) {
        return presentStatus({ tone: 'idle', icon: '⋯', label: t('resultNothing'), needsAttention: false });
      }
      const label = parts.join(', ');
      // Refused is the loud one (a person must look); held is a slow-link retry; all-delivered is calm.
      const tone: Tone = report.refused.length > 0 ? 'error' : report.held.length > 0 ? 'degraded' : 'ok';
      return presentStatus({
        tone, icon: tone === 'ok' ? '✓' : tone === 'degraded' ? '⚠' : '⛔',
        label, announcement: label, needsAttention: tone !== 'ok',
      });
    },

    deliver: async () => deliverReadyPublishes(ports.outbox(), ports.context(), ports.deliveryPort()),
  };
}

const ZERO_COUNTS: Readonly<Record<PublishQueueState, number>> = Object.freeze({
  pending: 0, ready: 0, validation_failed: 0, approval_required: 0, conflict: 0, published: 0, permanently_refused: 0,
});
