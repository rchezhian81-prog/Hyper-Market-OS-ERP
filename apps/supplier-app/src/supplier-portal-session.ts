// The supplier's self-service portal — the model behind the one screen a party OUTSIDE the business sees
// (M24-FR-01 · API-03 · §35 · P-03 · P-04). A supplier logs in and reads TWO things about ITS OWN account,
// and nothing else: what it has SENT the shop and whether the shop has acted on it yet, and its STATEMENT —
// the money the shop owes it. Both are scoped to the supplier's OWN partner id (derived from the session on
// the server, never a parameter the supplier can change — a request naming another partner is refused AND
// recorded as a probe), so this screen shows one supplier its own world and can never show it another's.
//
//   • **My submissions** (`GET /v1/supplier-portal/me/submissions`) — every catalogue, RFQ reply, delivery
//     note, invoice, order acknowledgement or claim the supplier sent. The ones still AWAITING the buyer's
//     decision lead, because those are the ones the supplier is waiting on: **nothing a supplier submits takes
//     effect on its own** — a buyer decides (§28) — so "awaiting review" is the honest state, never "accepted".
//   • **My statement** (`GET /v1/supplier-portal/me/statement`) — the closing balance built from the
//     supplier's own lines, with a **disputed** amount shown SEPARATELY (it is neither owed nor written off),
//     and a `reconciles` guard that goes false rather than letting a line vanish. When the login lacks the
//     statement grant the answer is **not accessible** — NOT a balance of zero, because those are not the same
//     thing (P-08: a missing permission is never silently a "you owe nothing").
//
// Like every screen in this product the rules live here in a tested, DOM-free session model on the shared
// packages/ui + packages/a11y primitives (colour is NEVER the only signal — an icon and a word ride with every
// tone). This is a READ surface: a supplier SUBMITS through separate write routes; here it only reads status
// and its account. Bilingual EN/TA — a supplier to a Tamil Nadu hypermarket reads whichever it prefers.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feeds, exactly as the cloud hands them over (the screen consumes the served JSON) ───────────────

export type SubmissionKind = 'rfq_response' | 'catalogue' | 'asn' | 'invoice' | 'po_acknowledgement' | 'claim';

/** One thing the supplier sent (`…/me/submissions`). `requiresReview` true = the buyer has not decided yet. */
export interface SubmissionView {
  readonly submissionId: string;
  readonly kind: SubmissionKind;
  readonly requiresReview: boolean;
  readonly receivedAt: string;
}

/** The supplier's statement (`…/me/statement`) — its own account with the shop. */
export interface StatementView {
  readonly partnerId: string;
  /** False when this login has no statement grant — an empty statement is NOT "you owe nothing". */
  readonly accessible: boolean;
  readonly openingMinor: number;
  readonly invoicedMinor: number;
  readonly debitedMinor: number;
  readonly creditedMinor: number;
  readonly paidMinor: number;
  readonly closingMinor: number;
  readonly disputedMinor: number;
  /** The closing balance is built from named buckets and cross-checked; false rather than let a line vanish. */
  readonly reconciles: boolean;
  readonly detail: string;
}

/** The two feeds the portal last read (live from the cloud, or the injected stand-in). */
export interface SupplierPortalData {
  readonly submissions: readonly SubmissionView[];
  readonly statement: StatementView | null;
  readonly asAt: string;
}

export interface SupplierPortalPorts {
  /** The feeds the portal last read. */
  portal(): SupplierPortalData;
  /** Whether this login is a supplier self-service login (`supplier.portal.self`). */
  mayRead(): boolean;
}

export interface SupplierPortalConfig {
  /** Who is looking. `null` means the login was not identified. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ─────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'refresh' | 'asOfLabel'
  | 'sentHeading' | 'awaitingLabel' | 'processedLabel' | 'sentNone'
  | 'statementHeading' | 'notAccessible'
  | 'openingLabel' | 'invoicedLabel' | 'creditedLabel' | 'debitedLabel' | 'paidLabel' | 'closingLabel' | 'disputedLabel'
  | 'reconciledLabel' | 'notReconciledLabel' | 'disputedSeparate'
  | 'kindRfq' | 'kindCatalogue' | 'kindAsn' | 'kindInvoice' | 'kindPoAck' | 'kindClaim'
  | 'awaitingState' | 'processedState'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'notIdentified' | 'staleShell' | 'sampleData';

export const SUPPLIER_PORTAL_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Your account with SRE', langName: 'தமிழ்',
    lead: 'What you have sent us and where each stands, and your statement — the money we owe you. Anything you send waits for a buyer to check it; it is never in force on its own. This page shows your own account only; it changes nothing.',
    refresh: 'Refresh', asOfLabel: 'As of',
    sentHeading: 'What you have sent us', awaitingLabel: 'Waiting on us', processedLabel: 'Processed', sentNone: 'You have not sent us anything yet.',
    statementHeading: 'Your statement', notAccessible: 'Your login cannot see the statement. Ask us to turn it on — this does not mean nothing is owed.',
    openingLabel: 'Opening balance', invoicedLabel: 'Invoiced', creditedLabel: 'Credit notes', debitedLabel: 'Debit notes', paidLabel: 'Paid to you', closingLabel: 'Outstanding',
    disputedLabel: 'Disputed (shown separately)',
    reconciledLabel: 'Balance reconciles', notReconciledLabel: 'Balance does not reconcile — please raise it with us',
    disputedSeparate: 'A disputed amount is shown on its own — it is neither owed nor written off until it is settled.',
    kindRfq: 'RFQ reply', kindCatalogue: 'Catalogue', kindAsn: 'Delivery note', kindInvoice: 'Invoice', kindPoAck: 'Order acknowledgement', kindClaim: 'Claim',
    awaitingState: 'Waiting on us', processedState: 'Processed',
    scrReady: 'Showing your account', scrEmpty: 'Nothing to show yet — you have sent us nothing and your statement is clear.',
    stateNotPermitted: 'This login is not a supplier login for this portal.',
    notIdentified: 'This login was not identified.',
    staleShell: 'No connection. This page is what you were last shown, at', sampleData: 'Sample data — this is not your account.',
  },
  ta: {
    title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
    lead: 'நீங்கள் எங்களுக்கு அனுப்பியவை மற்றும் அவற்றின் நிலை, மேலும் உங்கள் அறிக்கை — நாங்கள் உங்களுக்குச் செலுத்த வேண்டிய பணம். நீங்கள் அனுப்பும் எதுவும் ஒரு வாங்குபவர் சரிபார்க்கும் வரை காத்திருக்கும்; அது தானாகவே அமலுக்கு வராது. இந்தப் பக்கம் உங்கள் சொந்தக் கணக்கை மட்டுமே காட்டுகிறது; எதையும் மாற்றாது.',
    refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
    sentHeading: 'நீங்கள் அனுப்பியவை', awaitingLabel: 'எங்களிடம் காத்திருக்கிறது', processedLabel: 'செயலாக்கப்பட்டது', sentNone: 'நீங்கள் இன்னும் எதையும் அனுப்பவில்லை.',
    statementHeading: 'உங்கள் அறிக்கை', notAccessible: 'உங்கள் உள்நுழைவு அறிக்கையைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள் — இதற்கு எதுவும் நிலுவை இல்லை என்று அர்த்தம் அல்ல.',
    openingLabel: 'தொடக்க இருப்பு', invoicedLabel: 'விலைப்பட்டியல்', creditedLabel: 'வரவு குறிப்புகள்', debitedLabel: 'பற்று குறிப்புகள்', paidLabel: 'உங்களுக்குச் செலுத்தியது', closingLabel: 'நிலுவை',
    disputedLabel: 'தகராறு (தனியாகக் காட்டப்படுகிறது)',
    reconciledLabel: 'இருப்பு பொருந்துகிறது', notReconciledLabel: 'இருப்பு பொருந்தவில்லை — தயவுசெய்து எங்களிடம் தெரிவிக்கவும்',
    disputedSeparate: 'தகராறில் உள்ள தொகை தனியாகக் காட்டப்படுகிறது — தீர்க்கப்படும் வரை அது செலுத்த வேண்டியதோ தள்ளுபடி செய்யப்பட்டதோ அல்ல.',
    kindRfq: 'RFQ பதில்', kindCatalogue: 'பட்டியல்', kindAsn: 'விநியோகக் குறிப்பு', kindInvoice: 'விலைப்பட்டியல்', kindPoAck: 'ஆர்டர் ஒப்புகை', kindClaim: 'உரிமைகோரல்',
    awaitingState: 'எங்களிடம் காத்திருக்கிறது', processedState: 'செயலாக்கப்பட்டது',
    scrReady: 'உங்கள் கணக்கைக் காட்டுகிறது', scrEmpty: 'இன்னும் காட்ட எதுவும் இல்லை — நீங்கள் எதையும் அனுப்பவில்லை, உங்கள் அறிக்கையும் தெளிவாக உள்ளது.',
    stateNotPermitted: 'இந்த உள்நுழைவு இந்த போர்ட்டலுக்கான சப்ளையர் உள்நுழைவு அல்ல.',
    notIdentified: 'இந்த உள்நுழைவு அடையாளம் காணப்படவில்லை.',
    staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(SUPPLIER_PORTAL_COPY.en) as CopyKey[]);

const KIND_KEY: Record<SubmissionKind, CopyKey> = {
  rfq_response: 'kindRfq', catalogue: 'kindCatalogue', asn: 'kindAsn', invoice: 'kindInvoice',
  po_acknowledgement: 'kindPoAck', claim: 'kindClaim',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedSubmission {
  readonly submissionId: string;
  readonly kindLabel: string;
  readonly receivedAt: string;
  readonly awaiting: boolean;
  /** Awaiting the buyer's decision reads as a degraded "waiting" state; processed reads OK — icon + word, never colour alone. */
  readonly status: StatusPresentation;
}

export interface PresentedStatement {
  readonly accessible: boolean;
  readonly opening: string;
  readonly invoiced: string;
  readonly credited: string;
  readonly debited: string;
  readonly paid: string;
  readonly closing: string;
  readonly disputed: string;
  readonly disputedMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
  /** ok when it reconciles, error when it does not (a mismatch the supplier should raise) — icon + word. */
  readonly status: StatusPresentation;
}

export interface SupplierPortalView {
  readonly screenState: StatusPresentation;
  /** Submissions still awaiting the buyer's decision — the ones the supplier is waiting on, first. */
  readonly awaiting: readonly PresentedSubmission[];
  /** Submissions the buyer has already acted on. */
  readonly processed: readonly PresentedSubmission[];
  /** The statement, or null when it is not shown (either no feed, or the login lacks the grant — see below). */
  readonly statement: PresentedStatement | null;
  /** True when the statement feed IS present but the login lacks the grant — the screen shows the "ask us to
   *  turn it on" line, NOT a balance of zero (P-08: not accessible is never the same as "you owe nothing"). */
  readonly statementInaccessible: boolean;
  readonly awaitingCount: number;
  readonly notIdentified: boolean;
  /** True when at least one submission is awaiting the buyer, or the statement does not reconcile. */
  readonly anyAttention: boolean;
}

export interface SupplierPortalSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): SupplierPortalView;
}

const rupees = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const EMPTY_VIEW = (screenState: StatusPresentation, notIdentified: boolean): SupplierPortalView => ({
  screenState, awaiting: [], processed: [], statement: null, statementInaccessible: false, awaitingCount: 0, notIdentified, anyAttention: false,
});

export function createSupplierPortalSession(
  config: SupplierPortalConfig,
  ports: SupplierPortalPorts,
): SupplierPortalSession {
  const text = (lang: Lang, key: CopyKey): string => translator(SUPPLIER_PORTAL_COPY, lang)(key);

  const presentSubmission = (lang: Lang, s: SubmissionView): PresentedSubmission => {
    const t = translator(SUPPLIER_PORTAL_COPY, lang);
    const status = s.requiresReview
      ? presentStatus({ tone: 'degraded', icon: '⏳', label: t('awaitingState'), announcement: t('awaitingState'), needsAttention: true })
      : presentStatus({ tone: 'ok', icon: '✓', label: t('processedState'), announcement: t('processedState'), needsAttention: false });
    return { submissionId: s.submissionId, kindLabel: t(KIND_KEY[s.kind]), receivedAt: s.receivedAt, awaiting: s.requiresReview, status };
  };

  const presentStatement = (lang: Lang, s: StatementView): PresentedStatement => {
    const t = translator(SUPPLIER_PORTAL_COPY, lang);
    // Reconciled is a clean OK; a mismatch is an error the supplier should raise (icon + word ride with it).
    const status = s.reconciles
      ? presentStatus({ tone: 'ok', icon: '✓', label: t('reconciledLabel'), announcement: s.detail, needsAttention: false })
      : presentStatus({ tone: 'error', icon: '✕', label: t('notReconciledLabel'), announcement: s.detail, needsAttention: true });
    return {
      accessible: s.accessible,
      opening: rupees(s.openingMinor), invoiced: rupees(s.invoicedMinor), credited: rupees(s.creditedMinor),
      debited: rupees(s.debitedMinor), paid: rupees(s.paidMinor), closing: rupees(s.closingMinor),
      disputed: rupees(s.disputedMinor), disputedMinor: s.disputedMinor,
      reconciles: s.reconciles, detail: s.detail, status,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(SUPPLIER_PORTAL_COPY, lang);
      const notIdentified = config.userId === null;

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), notIdentified);
      }

      const data = ports.portal();
      // Awaiting the buyer's decision leads — those are the ones the supplier is waiting on (P-03). Within each
      // group the newest first, so a supplier sees what it most recently sent at the top.
      const byNewest = (a: SubmissionView, b: SubmissionView): number => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0);
      const awaiting = data.submissions.filter((s) => s.requiresReview).sort(byNewest).map((s) => presentSubmission(lang, s));
      const processed = data.submissions.filter((s) => !s.requiresReview).sort(byNewest).map((s) => presentSubmission(lang, s));
      // The statement is presented only when accessible; an inaccessible statement is a permission answer, not a
      // balance, so the screen shows the "ask us to turn it on" line rather than a misleading set of zeros.
      const statement = data.statement !== null && data.statement.accessible ? presentStatement(lang, data.statement) : null;

      const anyAttention = awaiting.length > 0 || (statement !== null && !statement.reconciles);
      // Anything worth a page: any submission, an accessible statement, OR a statement the login cannot see
      // (the "ask us to turn it on" line is content, not a calm blank).
      const anythingShown = data.submissions.length > 0 || data.statement !== null;
      const state = anythingShown ? 'ready' : 'empty';

      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        awaiting,
        processed,
        statement,
        statementInaccessible: data.statement !== null && !data.statement.accessible,
        awaitingCount: awaiting.length,
        notIdentified,
        anyAttention,
      };
    },
  };
}
