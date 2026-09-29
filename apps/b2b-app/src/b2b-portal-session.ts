// The business customer's portal — the model behind the one screen a CREDIT CUSTOMER outside the business sees
// (M22-FR-04 · API-09 · §35 · P-03 · P-04 · P-08). A caterer or canteen that buys from the shop on account logs in
// and reads FOUR things about ITS OWN account, and nothing else: its credit terms and what it owes, its invoices
// (each with what is settled and still open, a disputed one shown as such), its statement (the ageing of its own
// invoices from their DUE dates), and the documents issued to it (quotations, orders, proformas, challans, tax
// invoices). Every read is scoped to the customer's OWN id ON THE SERVER — derived from a binding a member of
// staff made, never a parameter the browser can change; a request naming another customer is refused AND
// recorded as a probe — so this screen shows one customer its own world and can never show it another's.
//
// Two honesty rules this surface carries, both already true in the engine and re-stated here so the screen
// cannot weaken them:
//   • **A missing grant is a permission answer, never a zero.** A login without `view_statement` is told its
//     login cannot see the statement — NOT shown an outstanding balance of ₹0.00 (P-08). Each feed refuses on its
//     own; the others still show.
//   • **The figures are the shop's figures.** The same adapters the accountant's screens read project these
//     numbers, so the customer sees what the shop sees. Nothing here writes money — a READ surface.
//
// Like every screen in this product the rules live here in a tested, DOM-free session model on the shared
// packages/ui + packages/a11y primitives (colour is NEVER the only signal — an icon and a word ride with every
// tone). Bilingual EN/TA — a business customer of a Tamil Nadu hypermarket reads whichever it prefers.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feeds, exactly as the cloud hands them over (the screen consumes the served JSON) ───────────────

/** `GET /v1/b2b-portal/me/account` — credit terms and what I owe; or "no credit terms set", never a made-up zero. */
export interface B2BAccountView {
  readonly customerId: string;
  readonly hasCreditAccount: boolean;
  readonly creditLimitMinor?: number;
  readonly currency?: string;
  readonly outstandingMinor: number;
  readonly availableCreditMinor?: number;
  readonly detail?: string;
}

/** One of my invoices (`…/me/invoices`) — what was billed, what is settled, what is still open. */
export interface B2BInvoiceView {
  readonly invoiceId: string;
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly grossMinor: number;
  readonly settledMinor: number;
  readonly outstandingMinor: number;
  readonly disputed: boolean;
  readonly disputeReason?: string;
}

export type AgeBucket = 'not_due' | 'due_0_30' | 'due_31_60' | 'due_61_90' | 'due_90_plus';
export const AGE_BUCKETS: readonly AgeBucket[] = ['not_due', 'due_0_30', 'due_31_60', 'due_61_90', 'due_90_plus'];

/** The ageing of my invoices from their due dates (`…/me/statement`), as the collections engine builds it. */
export interface B2BAgeingView {
  readonly totalOutstandingMinor: number;
  readonly overdueMinor: number;
  readonly disputedMinor: number;
  readonly buckets: Readonly<Record<AgeBucket, number>>;
  readonly detail: string;
}

export interface B2BStatementView {
  readonly customerId: string;
  readonly asAt: string;
  /** `null` when no invoices were ever recorded — said plainly, never a zero-balance statement. */
  readonly ageing: B2BAgeingView | null;
  readonly detail?: string;
}

export type B2BDocumentKind = 'quotation' | 'sales_order' | 'proforma' | 'challan' | 'tax_invoice';
export const B2B_DOCUMENT_KINDS: readonly B2BDocumentKind[] = ['quotation', 'sales_order', 'proforma', 'challan', 'tax_invoice'];

/** One document issued to me (`…/me/documents`). */
export interface B2BDocumentView {
  readonly documentId: string;
  readonly kind: B2BDocumentKind;
  readonly number: string;
  readonly grossMinor: number;
  readonly derivedFrom?: string;
  readonly orderId?: string;
  readonly validUntil?: string;
}

export type B2BFeed = 'account' | 'invoices' | 'statement' | 'documents';
export const B2B_FEEDS: readonly B2BFeed[] = ['account', 'invoices', 'statement', 'documents'];

/** Why a feed is absent: the login lacks the grant (a permission answer, shown as such), or it could not be read. */
export type FeedRefusal = 'no_grant' | 'unavailable';

/** The four feeds the portal last read (live from the cloud, or the injected stand-in). A feed the login may not
 *  see is `null` WITH its refusal recorded — the screen says so instead of showing a zero. */
export interface B2BPortalData {
  readonly account: B2BAccountView | null;
  readonly invoices: readonly B2BInvoiceView[] | null;
  readonly statement: B2BStatementView | null;
  readonly documents: readonly B2BDocumentView[] | null;
  readonly refusals: Readonly<Partial<Record<B2BFeed, FeedRefusal>>>;
  readonly asAt: string;
}

export interface B2BPortalPorts {
  /** The feeds the portal last read. */
  portal(): B2BPortalData;
  /** Whether this login is a business-customer portal login (`b2b.portal.self`). */
  mayRead(): boolean;
}

export interface B2BPortalConfig {
  /** Who is looking. `null` means the login was not identified. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ─────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'refresh' | 'asOfLabel'
  | 'accountHeading' | 'creditLimitLabel' | 'outstandingLabel' | 'availableLabel' | 'noTerms' | 'accountRefused'
  | 'invoicesHeading' | 'invoicesNone' | 'invoicesRefused' | 'issuedLabel' | 'dueLabel' | 'billedLabel' | 'settledLabel' | 'openLabel'
  | 'invOverdue' | 'invDisputed' | 'invOpen' | 'invSettled'
  | 'statementHeading' | 'statementNone' | 'statementRefused' | 'totalOutstandingLabel' | 'overdueLabel' | 'disputedLabel'
  | 'bucketNotDue' | 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90Plus'
  | 'documentsHeading' | 'documentsNone' | 'documentsRefused' | 'validUntilLabel' | 'fromLabel'
  | 'kindQuotation' | 'kindSalesOrder' | 'kindProforma' | 'kindChallan' | 'kindTaxInvoice'
  | 'unavailable'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'notIdentified' | 'staleShell' | 'sampleData';

export const B2B_PORTAL_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Your account with SRE', langName: 'தமிழ்',
    lead: 'Your credit terms and what you owe, your invoices and how each stands, your statement aged from the due dates, and the documents we issued you. These are the same figures our accounts team sees. This page shows your own account only; it changes nothing.',
    refresh: 'Refresh', asOfLabel: 'As of',
    accountHeading: 'Your credit account', creditLimitLabel: 'Credit limit', outstandingLabel: 'You owe', availableLabel: 'Available to spend',
    noTerms: 'No credit terms have been set for your account — purchases are settled as they are made.',
    accountRefused: 'Your login cannot see the account balance. Ask us to turn it on — this does not mean nothing is owed.',
    invoicesHeading: 'Your invoices', invoicesNone: 'No invoices on your account.',
    invoicesRefused: 'Your login cannot see invoices. Ask us to turn it on.',
    issuedLabel: 'Issued', dueLabel: 'Due', billedLabel: 'Billed', settledLabel: 'Settled', openLabel: 'Still open',
    invOverdue: 'Overdue', invDisputed: 'In dispute — with a person, not a reminder', invOpen: 'Open', invSettled: 'Settled',
    statementHeading: 'Your statement', statementNone: 'No invoices have been recorded on your account, so there is no statement to age.',
    statementRefused: 'Your login cannot see the statement. Ask us to turn it on — this does not mean nothing is owed.',
    totalOutstandingLabel: 'Total outstanding', overdueLabel: 'Overdue', disputedLabel: 'Disputed (shown separately)',
    bucketNotDue: 'Not yet due', bucket0_30: '1–30 days overdue', bucket31_60: '31–60 days overdue', bucket61_90: '61–90 days overdue', bucket90Plus: 'Over 90 days overdue',
    documentsHeading: 'Documents issued to you', documentsNone: 'No documents issued yet.',
    documentsRefused: 'Your login cannot see documents. Ask us to turn it on.',
    validUntilLabel: 'Valid until', fromLabel: 'From',
    kindQuotation: 'Quotation', kindSalesOrder: 'Sales order', kindProforma: 'Proforma invoice', kindChallan: 'Delivery challan', kindTaxInvoice: 'Tax invoice',
    unavailable: 'Could not be read just now — try Refresh.',
    scrReady: 'Showing your account', scrEmpty: 'Nothing to show yet — no terms, invoices or documents on your account.',
    stateNotPermitted: 'This login is not a business-customer login for this portal.',
    notIdentified: 'This login was not identified.',
    staleShell: 'No connection. This page is what you were last shown, at', sampleData: 'Sample data — this is not your account.',
  },
  ta: {
    title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
    lead: 'உங்கள் கடன் நிபந்தனைகளும் நீங்கள் செலுத்த வேண்டியதும், உங்கள் விலைப்பட்டியல்களும் அவற்றின் நிலையும், நிலுவைத் தேதிகளிலிருந்து வயதிடப்பட்ட உங்கள் அறிக்கை, மற்றும் நாங்கள் உங்களுக்கு வழங்கிய ஆவணங்கள். இவை எங்கள் கணக்குக் குழு பார்க்கும் அதே எண்கள். இந்தப் பக்கம் உங்கள் சொந்தக் கணக்கை மட்டுமே காட்டுகிறது; எதையும் மாற்றாது.',
    refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
    accountHeading: 'உங்கள் கடன் கணக்கு', creditLimitLabel: 'கடன் வரம்பு', outstandingLabel: 'நீங்கள் செலுத்த வேண்டியது', availableLabel: 'செலவழிக்கக் கிடைப்பது',
    noTerms: 'உங்கள் கணக்கிற்குக் கடன் நிபந்தனைகள் அமைக்கப்படவில்லை — வாங்கும்போதே செலுத்தப்படுகிறது.',
    accountRefused: 'உங்கள் உள்நுழைவு கணக்கு இருப்பைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள் — இதற்கு எதுவும் நிலுவை இல்லை என்று அர்த்தம் அல்ல.',
    invoicesHeading: 'உங்கள் விலைப்பட்டியல்கள்', invoicesNone: 'உங்கள் கணக்கில் விலைப்பட்டியல்கள் இல்லை.',
    invoicesRefused: 'உங்கள் உள்நுழைவு விலைப்பட்டியல்களைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள்.',
    issuedLabel: 'வழங்கியது', dueLabel: 'நிலுவைத் தேதி', billedLabel: 'பில் தொகை', settledLabel: 'செலுத்தியது', openLabel: 'நிலுவை',
    invOverdue: 'தாமதம்', invDisputed: 'தகராறில் — நினைவூட்டல் அல்ல, ஒரு நபரிடம்', invOpen: 'திறந்தது', invSettled: 'செலுத்தப்பட்டது',
    statementHeading: 'உங்கள் அறிக்கை', statementNone: 'உங்கள் கணக்கில் விலைப்பட்டியல்கள் பதிவு செய்யப்படவில்லை, எனவே வயதிட அறிக்கை இல்லை.',
    statementRefused: 'உங்கள் உள்நுழைவு அறிக்கையைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள் — இதற்கு எதுவும் நிலுவை இல்லை என்று அர்த்தம் அல்ல.',
    totalOutstandingLabel: 'மொத்த நிலுவை', overdueLabel: 'தாமதம்', disputedLabel: 'தகராறு (தனியாகக் காட்டப்படுகிறது)',
    bucketNotDue: 'இன்னும் நிலுவையாகவில்லை', bucket0_30: '1–30 நாட்கள் தாமதம்', bucket31_60: '31–60 நாட்கள் தாமதம்', bucket61_90: '61–90 நாட்கள் தாமதம்', bucket90Plus: '90 நாட்களுக்கு மேல் தாமதம்',
    documentsHeading: 'உங்களுக்கு வழங்கிய ஆவணங்கள்', documentsNone: 'இன்னும் ஆவணங்கள் வழங்கப்படவில்லை.',
    documentsRefused: 'உங்கள் உள்நுழைவு ஆவணங்களைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள்.',
    validUntilLabel: 'செல்லுபடியாகும் தேதி', fromLabel: 'இருந்து',
    kindQuotation: 'விலைப்புள்ளி', kindSalesOrder: 'விற்பனை ஆர்டர்', kindProforma: 'முன் விலைப்பட்டியல்', kindChallan: 'விநியோக சலான்', kindTaxInvoice: 'வரி விலைப்பட்டியல்',
    unavailable: 'இப்போது படிக்க முடியவில்லை — புதுப்பி என்பதை முயற்சிக்கவும்.',
    scrReady: 'உங்கள் கணக்கைக் காட்டுகிறது', scrEmpty: 'இன்னும் காட்ட எதுவும் இல்லை — உங்கள் கணக்கில் நிபந்தனைகள், விலைப்பட்டியல்கள் அல்லது ஆவணங்கள் இல்லை.',
    stateNotPermitted: 'இந்த உள்நுழைவு இந்த போர்ட்டலுக்கான வணிக வாடிக்கையாளர் உள்நுழைவு அல்ல.',
    notIdentified: 'இந்த உள்நுழைவு அடையாளம் காணப்படவில்லை.',
    staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(B2B_PORTAL_COPY.en) as CopyKey[]);

const KIND_KEY: Readonly<Record<B2BDocumentKind, CopyKey>> = {
  quotation: 'kindQuotation', sales_order: 'kindSalesOrder', proforma: 'kindProforma', challan: 'kindChallan', tax_invoice: 'kindTaxInvoice',
};
const BUCKET_KEY: Readonly<Record<AgeBucket, CopyKey>> = {
  not_due: 'bucketNotDue', due_0_30: 'bucket0_30', due_31_60: 'bucket31_60', due_61_90: 'bucket61_90', due_90_plus: 'bucket90Plus',
};
const REFUSED_KEY: Readonly<Record<B2BFeed, CopyKey>> = {
  account: 'accountRefused', invoices: 'invoicesRefused', statement: 'statementRefused', documents: 'documentsRefused',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedAccount {
  readonly hasCreditAccount: boolean;
  readonly creditLimit: string | null;
  readonly outstanding: string;
  readonly outstandingMinor: number;
  readonly available: string | null;
  /** Over the limit or nothing left reads as attention; otherwise ok — icon + word, never colour alone. */
  readonly status: StatusPresentation;
}

export interface PresentedInvoice {
  readonly invoiceId: string;
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly billed: string;
  readonly settled: string;
  readonly open: string;
  readonly outstandingMinor: number;
  readonly disputed: boolean;
  readonly disputeReason: string | null;
  readonly overdue: boolean;
  /** settled → ok; disputed → degraded (with a person); overdue → error; open → idle — icon + word. */
  readonly status: StatusPresentation;
}

export interface PresentedStatement {
  readonly asAt: string;
  readonly totalOutstanding: string;
  readonly overdue: string;
  readonly disputed: string;
  readonly disputedMinor: number;
  readonly buckets: readonly { readonly bucket: AgeBucket; readonly label: string; readonly amount: string; readonly amountMinor: number }[];
  /** Anything overdue reads as attention (error when over 90 days); otherwise ok. */
  readonly status: StatusPresentation;
}

export interface PresentedDocument {
  readonly documentId: string;
  readonly kind: B2BDocumentKind;
  readonly kindLabel: string;
  readonly number: string;
  readonly amount: string;
  readonly validUntil: string | null;
  readonly derivedFrom: string | null;
}

/** How each feed stands on the screen: shown, refused (a permission answer), unreadable, or empty. */
export type FeedState = 'shown' | 'no_grant' | 'unavailable' | 'empty';

export interface B2BPortalView {
  readonly screenState: StatusPresentation;
  readonly account: PresentedAccount | null;
  /** True when the account feed said "no credit terms" — a plain fact, not a zero balance. */
  readonly noTerms: boolean;
  readonly invoices: readonly PresentedInvoice[];
  readonly statement: PresentedStatement | null;
  readonly documents: readonly PresentedDocument[];
  readonly feeds: Readonly<Record<B2BFeed, FeedState>>;
  /** The human line for a refused / unreadable feed, in the current language; absent when shown or empty. */
  readonly feedNotes: Readonly<Partial<Record<B2BFeed, string>>>;
  readonly overdueCount: number;
  readonly disputedCount: number;
  readonly notIdentified: boolean;
  readonly anyAttention: boolean;
}

export interface B2BPortalSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): B2BPortalView;
}

const rupees = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const ALL_EMPTY: Readonly<Record<B2BFeed, FeedState>> = { account: 'empty', invoices: 'empty', statement: 'empty', documents: 'empty' };
const EMPTY_VIEW = (screenState: StatusPresentation, notIdentified: boolean): B2BPortalView => ({
  screenState, account: null, noTerms: false, invoices: [], statement: null, documents: [], feeds: ALL_EMPTY, feedNotes: {},
  overdueCount: 0, disputedCount: 0, notIdentified, anyAttention: false,
});

export function createB2BPortalSession(config: B2BPortalConfig, ports: B2BPortalPorts): B2BPortalSession {
  const text = (lang: Lang, key: CopyKey): string => translator(B2B_PORTAL_COPY, lang)(key);

  const presentAccount = (lang: Lang, a: B2BAccountView): PresentedAccount => {
    const t = translator(B2B_PORTAL_COPY, lang);
    const limit = a.creditLimitMinor;
    const available = a.availableCreditMinor;
    const exhausted = a.hasCreditAccount && limit !== undefined && a.outstandingMinor >= limit;
    const status = exhausted
      ? presentStatus({ tone: 'degraded', icon: '⚠', label: `${t('availableLabel')}: ${rupees(Math.max(0, (limit ?? 0) - a.outstandingMinor))}`, announcement: `${t('outstandingLabel')} ${rupees(a.outstandingMinor)}`, needsAttention: true })
      : presentStatus({ tone: 'ok', icon: '✓', label: `${t('outstandingLabel')}: ${rupees(a.outstandingMinor)}`, announcement: `${t('outstandingLabel')} ${rupees(a.outstandingMinor)}`, needsAttention: false });
    return {
      hasCreditAccount: a.hasCreditAccount,
      creditLimit: limit === undefined ? null : rupees(limit),
      outstanding: rupees(a.outstandingMinor), outstandingMinor: a.outstandingMinor,
      available: available === undefined ? null : rupees(available),
      status,
    };
  };

  const presentInvoice = (lang: Lang, i: B2BInvoiceView, today: string): PresentedInvoice => {
    const t = translator(B2B_PORTAL_COPY, lang);
    const settled = i.outstandingMinor <= 0;
    // A disputed invoice is with a person, not a reminder — it is not counted as overdue even past its date.
    const overdue = !settled && !i.disputed && i.dueOn < today;
    const status = settled
      ? presentStatus({ tone: 'ok', icon: '✓', label: t('invSettled'), announcement: `${i.number} ${t('invSettled')}`, needsAttention: false })
      : i.disputed
        ? presentStatus({ tone: 'degraded', icon: '⚠', label: t('invDisputed'), announcement: `${i.number} ${t('invDisputed')}`, needsAttention: true })
        : overdue
          ? presentStatus({ tone: 'error', icon: '✕', label: `${t('invOverdue')} · ${t('dueLabel')} ${i.dueOn}`, announcement: `${i.number} ${t('invOverdue')} ${rupees(i.outstandingMinor)}`, needsAttention: true })
          : presentStatus({ tone: 'idle', icon: '○', label: `${t('invOpen')} · ${t('dueLabel')} ${i.dueOn}`, announcement: `${i.number} ${t('invOpen')}`, needsAttention: false });
    return {
      invoiceId: i.invoiceId, number: i.number, issuedOn: i.issuedOn, dueOn: i.dueOn,
      billed: rupees(i.grossMinor), settled: rupees(i.settledMinor), open: rupees(i.outstandingMinor), outstandingMinor: i.outstandingMinor,
      disputed: i.disputed, disputeReason: i.disputeReason ?? null, overdue, status,
    };
  };

  const presentStatement = (lang: Lang, s: B2BStatementView, ageing: B2BAgeingView): PresentedStatement => {
    const t = translator(B2B_PORTAL_COPY, lang);
    const oldest = ageing.buckets.due_90_plus > 0;
    const status = ageing.overdueMinor > 0
      ? presentStatus({ tone: oldest ? 'error' : 'degraded', icon: oldest ? '✕' : '⚠', label: `${t('overdueLabel')}: ${rupees(ageing.overdueMinor)}`, announcement: ageing.detail, needsAttention: true })
      : presentStatus({ tone: 'ok', icon: '✓', label: `${t('totalOutstandingLabel')}: ${rupees(ageing.totalOutstandingMinor)}`, announcement: ageing.detail, needsAttention: false });
    return {
      asAt: s.asAt,
      totalOutstanding: rupees(ageing.totalOutstandingMinor), overdue: rupees(ageing.overdueMinor),
      disputed: rupees(ageing.disputedMinor), disputedMinor: ageing.disputedMinor,
      buckets: AGE_BUCKETS.map((bucket) => ({ bucket, label: t(BUCKET_KEY[bucket]), amount: rupees(ageing.buckets[bucket] ?? 0), amountMinor: ageing.buckets[bucket] ?? 0 })),
      status,
    };
  };

  const presentDocument = (lang: Lang, d: B2BDocumentView): PresentedDocument => {
    const t = translator(B2B_PORTAL_COPY, lang);
    return {
      documentId: d.documentId, kind: d.kind, kindLabel: t(KIND_KEY[d.kind]), number: d.number, amount: rupees(d.grossMinor),
      validUntil: d.validUntil ?? null, derivedFrom: d.derivedFrom ?? null,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(B2B_PORTAL_COPY, lang);
      const notIdentified = config.userId === null;
      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), notIdentified);
      }
      const data = ports.portal();
      const today = data.asAt.slice(0, 10);

      // Each feed stands on its own: shown, refused (the login lacks the grant — a permission answer, never a
      // zero), unreadable just now, or genuinely empty. A refused statement is NOT "you owe nothing" (P-08).
      const feedState = (feed: B2BFeed, present: boolean, empty: boolean): FeedState => {
        const refusal = data.refusals[feed];
        if (refusal !== undefined) return refusal;
        if (!present) return 'unavailable';
        return empty ? 'empty' : 'shown';
      };
      const feeds: Record<B2BFeed, FeedState> = {
        account: feedState('account', data.account !== null, false),
        invoices: feedState('invoices', data.invoices !== null, (data.invoices ?? []).length === 0),
        statement: feedState('statement', data.statement !== null, data.statement?.ageing === null),
        documents: feedState('documents', data.documents !== null, (data.documents ?? []).length === 0),
      };
      const feedNotes: Partial<Record<B2BFeed, string>> = {};
      for (const feed of B2B_FEEDS) {
        if (feeds[feed] === 'no_grant') feedNotes[feed] = t(REFUSED_KEY[feed]);
        else if (feeds[feed] === 'unavailable') feedNotes[feed] = t('unavailable');
      }

      const account = data.account !== null && data.account.hasCreditAccount ? presentAccount(lang, data.account) : null;
      const noTerms = data.account !== null && !data.account.hasCreditAccount;
      // Invoices as the cloud ordered them (by due date, then number): the earliest due first.
      const invoices = (data.invoices ?? []).map((i) => presentInvoice(lang, i, today));
      const statement = data.statement !== null && data.statement.ageing !== null ? presentStatement(lang, data.statement, data.statement.ageing) : null;
      const documents = (data.documents ?? []).map((d) => presentDocument(lang, d));

      const overdueCount = invoices.filter((i) => i.overdue).length;
      const disputedCount = invoices.filter((i) => i.disputed && i.outstandingMinor > 0).length;
      const anyAttention = overdueCount > 0 || disputedCount > 0 || (account?.status.needsAttention ?? false);
      // Anything worth a page: a shown feed, a "no terms" fact, or a refused feed (the "ask us" line is content).
      const anythingShown = B2B_FEEDS.some((f) => feeds[f] === 'shown' || feeds[f] === 'no_grant') || noTerms;
      const state = anythingShown ? 'ready' : 'empty';

      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        account, noTerms, invoices, statement, documents, feeds, feedNotes,
        overdueCount, disputedCount, notIdentified, anyAttention,
      };
    },
  };
}
