// DOCUMENT TEMPLATES — the setup person's screen for the wording every bill, invoice, purchase order, GRN and
// statement carries (M01-FR-02 · API-01 · §28 · P-08 · OC-15). A template is what a customer, a supplier and the
// tax officer read: the store name, the GSTIN, the returns terms, the thanks line. A wrong GSTIN on it is a tax
// error, so a change is never an edit — it is a NEW version, drafted by one person, approved by a DIFFERENT
// person, then published; the version it replaces is marked superseded and KEPT, because the receipts printed
// under it still name it.
//
// This screen shows the register as the cloud holds it (`GET /v1/org/document-templates` — the version in force
// of every kind), one kind's versions with their state (`GET …/:kind`), and carries the three writes a setup
// person makes from here, each a POST in their own name with an idempotency key:
//   • DRAFT the next version (`POST …/:kind/versions`) — content refused at the door when it would be a tax
//     error or a broken bill (no store name, a malformed GSTIN, too many lines); the same check runs HERE first
//     so nothing is sent that the cloud would refuse;
//   • APPROVE a draft (`POST …/:version/approve`) — a second person's act: the screen withholds the button from
//     the draft's own author and says why (§28), and the cloud refuses the maker regardless (403);
//   • PUBLISH an approved version (`POST …/:version/publish`) — puts it in force; the previous one is superseded.
//
// Truths the screen carries, already true in the engine and re-stated so the surface cannot weaken them:
//   • **A kind with nothing in force is a warning, not a blank** — documents print with defaults (P-08).
//   • **Only a draft can be approved, only an approved version published** — offered exactly so; the cloud
//     re-checks every move (409 by name when the state moved under the screen).
//   • **Nothing is edited in place.** The screen offers no edit of a published version; a change is a new draft.
//
// Like every ERP screen the rules live here in a tested, DOM-free session model on the shared packages/ui
// primitives (colour is never the only signal — an icon and a word ride with every tone); the shell only renders
// what this hands over.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';
import {
  DOCUMENT_KINDS, TEMPLATE_LANGUAGES, TEMPLATE_LIMITS, isDocumentKind, validateTemplateContent,
  type DocumentKind, type DocumentTemplateContent, type TemplateLanguage, type TemplateState,
} from '../../../packages/org/src/document-templates';

// ── the raw feeds, exactly as the cloud hands them over ───────────────────────────────────────────────────

/** One version as the routes summarise it. */
export interface TemplateVersionView {
  readonly kind: string;
  readonly version: number;
  readonly state: TemplateState;
  readonly content: DocumentTemplateContent;
  readonly note?: string;
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly publishedBy?: string;
  readonly publishedAt?: string;
  readonly supersededBy?: number;
  readonly supersededAt?: string;
}

/** `GET /v1/org/document-templates` — the register: every kind, its version in force, how many versions exist. */
export interface TemplateRegisterData {
  readonly kinds: readonly { readonly kind: string; readonly current: TemplateVersionView | null; readonly versions: number }[];
  readonly asAt: string;
}

/** `GET /v1/org/document-templates/:kind` — one kind's version in force and every version's original content. */
export interface TemplateKindData {
  readonly kind: string;
  readonly current: TemplateVersionView | null;
  readonly versions: readonly TemplateVersionView[];
  readonly asAt: string;
}

export type ActResult =
  | { readonly result: 'drafted' | 'approved'; readonly version: TemplateVersionView }
  | { readonly result: 'published'; readonly version: TemplateVersionView; readonly supersededVersion?: number }
  /** The content would be a tax error or a broken bill — named problems, nothing saved (400 / local). */
  | { readonly result: 'content_invalid'; readonly problems: readonly string[] }
  /** The maker tried to approve their own draft (§28) — 403 / local. */
  | { readonly result: 'maker_cannot_approve' }
  /** The version is not in the state the act needs (409 `not_a_draft` / `not_approved` / `already_published`). */
  | { readonly result: 'state_conflict'; readonly code: string }
  | { readonly result: 'refused' | 'lost_link' };

/** The authenticated POSTs. Injected, so the model never opens a socket itself. */
export interface DocumentTemplateActPort {
  draft(input: { readonly kind: DocumentKind; readonly content: DocumentTemplateContent; readonly note?: string }): Promise<ActResult>;
  approve(input: { readonly kind: DocumentKind; readonly version: number }): Promise<ActResult>;
  publish(input: { readonly kind: DocumentKind; readonly version: number }): Promise<ActResult>;
}

export interface DocumentTemplatePorts {
  /** The register the shell last read (live from the cloud), or null when nothing was read yet. */
  register(): TemplateRegisterData | null;
  /** The chosen kind as the shell last read it, or null. */
  kind(): TemplateKindData | null;
  /** Whether this user may read the templates (`platform.setup.read`). */
  mayRead(): boolean;
  /** Whether this user may draft / approve / publish (`platform.setup.write`). §28 is checked on top of this. */
  mayWrite(): boolean;
  /** The writes. Only reached from an explicit act, never on render. */
  actPort(): DocumentTemplateActPort;
}

export interface DocumentTemplatesConfig {
  /** Who is looking. `null` means the store computer was not told who is at the screen. */
  readonly userId: string | null;
}

/** What the draft form collects — text as typed; the model turns it into lines and validates it. */
export interface DraftForm {
  readonly header: string;
  readonly footer: string;
  readonly terms: string;
  readonly language: string;
  /** Receipt only: `thermal-58` / `thermal-80` / `thermal-112`; empty for none. */
  readonly paperFormat: string;
  readonly note: string;
}

/** One line per non-empty row, trailing spaces trimmed — a blank row is not a line on a bill. */
export const linesOf = (text: string): readonly string[] =>
  text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');

/** The form as the content the engine validates. Pure — the same shape the cloud receives. */
export function contentFromForm(kind: DocumentKind, form: DraftForm): DocumentTemplateContent {
  const terms = linesOf(form.terms);
  return {
    header: linesOf(form.header),
    footer: linesOf(form.footer),
    language: form.language as TemplateLanguage,
    ...(terms.length === 0 ? {} : { terms }),
    ...(kind === 'receipt' && form.paperFormat.trim() !== '' ? { paperFormat: form.paperFormat.trim() } : {}),
  };
}

// ── the copy: ONE bilingual object for the whole screen ───────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'kindLabel' | 'loadBtn' | 'registerHeading' | 'versionsHeading' | 'draftHeading'
  | 'kindReceipt' | 'kindInvoice' | 'kindPurchaseOrder' | 'kindGrn' | 'kindStatement'
  | 'inForce' | 'nothingInForce' | 'versionsCount'
  | 'headerLabel' | 'footerLabel' | 'termsLabel' | 'languageLabel' | 'paperLabel' | 'noteLabel' | 'limitsHint'
  | 'langEn' | 'langTa' | 'langEnTa' | 'paperNone'
  | 'draftBtn' | 'approveBtn' | 'publishBtn'
  | 'stateDraft' | 'stateApproved' | 'statePublished' | 'stateSuperseded' | 'supersededByLabel'
  | 'authoredByLabel' | 'approvedByLabel' | 'publishedByLabel' | 'noteHeading'
  | 'makerCannotApprove' | 'noVersions'
  | 'actDrafted' | 'actApproved' | 'actPublished' | 'actSuperseded' | 'actContentInvalid' | 'actMakerRefused'
  | 'actStateConflict' | 'actRefused' | 'actLostLink'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'nobodyNamed' | 'staleShell' | 'sampleData';

export const DOCUMENT_TEMPLATES_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Document templates', langName: 'தமிழ்',
    lead: 'The wording on every bill, invoice, purchase order, GRN and statement — the store name, the GSTIN, the terms, the thanks line. A change is a new version: one person drafts it, a different person approves it, then it is published. The version it replaces is kept, so a bill printed under it still reads as it did.',
    kindLabel: 'Document kind', loadBtn: 'Show the versions', registerHeading: 'In force now', versionsHeading: 'Versions', draftHeading: 'Draft the next version',
    kindReceipt: 'Receipt', kindInvoice: 'Invoice', kindPurchaseOrder: 'Purchase order', kindGrn: 'Goods receipt note', kindStatement: 'Statement',
    inForce: 'in force', nothingInForce: 'Nothing in force — documents print with the defaults', versionsCount: 'versions',
    headerLabel: 'Header lines (the store name first)', footerLabel: 'Footer lines', termsLabel: 'Standing terms (optional)', languageLabel: 'Language', paperLabel: 'Paper (receipts only)', noteLabel: 'What changed and why',
    limitsHint: 'At most 8 header lines, 6 footer lines, 20 terms lines; 64 characters a line. A GSTIN must be 15 characters.',
    langEn: 'English', langTa: 'Tamil', langEnTa: 'English and Tamil', paperNone: 'Not stated',
    draftBtn: 'Save as a draft', approveBtn: 'Approve', publishBtn: 'Publish',
    stateDraft: 'Draft — waiting for a second person to approve', stateApproved: 'Approved — ready to publish', statePublished: 'In force', stateSuperseded: 'Kept — superseded', supersededByLabel: 'Superseded by',
    authoredByLabel: 'Drafted by', approvedByLabel: 'Approved by', publishedByLabel: 'Published by', noteHeading: 'Note',
    makerCannotApprove: 'You drafted this version — a different person must approve it.', noVersions: 'No versions yet for this kind.',
    actDrafted: 'Draft saved as version', actApproved: 'Approved version', actPublished: 'Published version', actSuperseded: 'superseded version',
    actContentInvalid: 'Not saved — the template would be wrong on a document:', actMakerRefused: 'Not approved — the person who drafted a version cannot approve it. Ask a second person with setup rights.',
    actStateConflict: 'Not done — this version has moved on since the screen was read. Show the versions again.', actRefused: 'Could not do that — you may not have permission. Nothing was saved.',
    actLostLink: 'No connection — not saved. Try again.',
    scrReady: 'Showing the document templates', scrEmpty: 'The templates have not been read yet.',
    stateNotPermitted: 'You do not have permission to see the document templates.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'ஆவண வார்ப்புருக்கள்', langName: 'English',
    lead: 'ஒவ்வொரு பில், விலைப்பட்டியல், கொள்முதல் ஆணை, சரக்கு ரசீது மற்றும் அறிக்கையின் வார்த்தைகள் — கடையின் பெயர், GSTIN, நிபந்தனைகள், நன்றி வரி. மாற்றம் ஒரு புதிய பதிப்பு: ஒருவர் வரைவு செய்கிறார், வேறு ஒருவர் ஒப்புதல் அளிக்கிறார், பின்னர் வெளியிடப்படுகிறது. மாற்றப்பட்ட பதிப்பு வைக்கப்படுகிறது, அதன் கீழ் அச்சிட்ட பில் அப்படியே படிக்கும்.',
    kindLabel: 'ஆவண வகை', loadBtn: 'பதிப்புகளைக் காட்டு', registerHeading: 'இப்போது நடைமுறையில்', versionsHeading: 'பதிப்புகள்', draftHeading: 'அடுத்த பதிப்பை வரைவு செய்',
    kindReceipt: 'ரசீது', kindInvoice: 'விலைப்பட்டியல்', kindPurchaseOrder: 'கொள்முதல் ஆணை', kindGrn: 'சரக்கு ரசீது குறிப்பு', kindStatement: 'அறிக்கை',
    inForce: 'நடைமுறையில்', nothingInForce: 'எதுவும் நடைமுறையில் இல்லை — ஆவணங்கள் இயல்புநிலையில் அச்சிடப்படுகின்றன', versionsCount: 'பதிப்புகள்',
    headerLabel: 'தலைப்பு வரிகள் (கடையின் பெயர் முதலில்)', footerLabel: 'அடிக்குறிப்பு வரிகள்', termsLabel: 'நிலையான நிபந்தனைகள் (விருப்பம்)', languageLabel: 'மொழி', paperLabel: 'காகிதம் (ரசீதுகளுக்கு மட்டும்)', noteLabel: 'என்ன மாறியது, ஏன்',
    limitsHint: 'அதிகபட்சம் 8 தலைப்பு வரிகள், 6 அடிக்குறிப்பு வரிகள், 20 நிபந்தனை வரிகள்; ஒரு வரிக்கு 64 எழுத்துகள். GSTIN 15 எழுத்துகள் இருக்க வேண்டும்.',
    langEn: 'ஆங்கிலம்', langTa: 'தமிழ்', langEnTa: 'ஆங்கிலம் மற்றும் தமிழ்', paperNone: 'குறிப்பிடப்படவில்லை',
    draftBtn: 'வரைவாகச் சேமி', approveBtn: 'ஒப்புதல்', publishBtn: 'வெளியிடு',
    stateDraft: 'வரைவு — இரண்டாம் நபரின் ஒப்புதலுக்குக் காத்திருக்கிறது', stateApproved: 'ஒப்புதல் — வெளியிடத் தயார்', statePublished: 'நடைமுறையில்', stateSuperseded: 'வைக்கப்பட்டது — மாற்றப்பட்டது', supersededByLabel: 'மாற்றியது',
    authoredByLabel: 'வரைவு செய்தவர்', approvedByLabel: 'ஒப்புதல் அளித்தவர்', publishedByLabel: 'வெளியிட்டவர்', noteHeading: 'குறிப்பு',
    makerCannotApprove: 'இந்தப் பதிப்பை நீங்கள் வரைவு செய்தீர்கள் — வேறு ஒருவர் ஒப்புதல் அளிக்க வேண்டும்.', noVersions: 'இந்த வகைக்கு இன்னும் பதிப்புகள் இல்லை.',
    actDrafted: 'வரைவு சேமிக்கப்பட்டது, பதிப்பு', actApproved: 'ஒப்புதல் அளிக்கப்பட்ட பதிப்பு', actPublished: 'வெளியிடப்பட்ட பதிப்பு', actSuperseded: 'மாற்றப்பட்ட பதிப்பு',
    actContentInvalid: 'சேமிக்கப்படவில்லை — வார்ப்புரு ஆவணத்தில் தவறாக இருக்கும்:', actMakerRefused: 'ஒப்புதல் இல்லை — வரைவு செய்தவர் ஒப்புதல் அளிக்க முடியாது. அமைப்பு உரிமையுள்ள இரண்டாம் நபரைக் கேளுங்கள்.',
    actStateConflict: 'செய்யப்படவில்லை — திரை படித்த பிறகு இந்தப் பதிப்பு மாறிவிட்டது. பதிப்புகளை மீண்டும் காட்டுங்கள்.', actRefused: 'செய்ய முடியவில்லை — உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம். எதுவும் சேமிக்கப்படவில்லை.',
    actLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    scrReady: 'ஆவண வார்ப்புருக்களைக் காட்டுகிறது', scrEmpty: 'வார்ப்புருக்கள் இன்னும் படிக்கப்படவில்லை.',
    stateNotPermitted: 'ஆவண வார்ப்புருக்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(DOCUMENT_TEMPLATES_COPY.en) as CopyKey[]);

const KIND_COPY: Readonly<Record<DocumentKind, CopyKey>> = {
  receipt: 'kindReceipt', invoice: 'kindInvoice', purchase_order: 'kindPurchaseOrder', grn: 'kindGrn', statement: 'kindStatement',
};
const LANGUAGE_COPY: Readonly<Record<TemplateLanguage, CopyKey>> = { en: 'langEn', ta: 'langTa', en_ta: 'langEnTa' };

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedVersion {
  readonly kind: string;
  readonly version: number;
  readonly state: TemplateState;
  readonly header: readonly string[];
  readonly footer: readonly string[];
  readonly terms: readonly string[];
  readonly language: string;
  readonly languageLabel: string;
  readonly paperFormat: string | null;
  readonly note: string | null;
  readonly authoredBy: string;
  readonly authoredAt: string;
  readonly approvedBy: string | null;
  readonly publishedBy: string | null;
  readonly supersededBy: number | null;
  /** In force = ok; approved = degraded (an act is pending); draft / superseded = idle. A word and an icon ride with it. */
  readonly status: StatusPresentation;
  /** Offer APPROVE: a draft, this user may write, and this user is NOT its author (§28). */
  readonly mayApprove: boolean;
  /** Why approve is withheld on a draft this user could otherwise act on — the §28 sentence, or null. */
  readonly approveWithheldWhy: string | null;
  /** Offer PUBLISH: approved, and this user may write. */
  readonly mayPublish: boolean;
}

export interface PresentedKind {
  readonly kind: string;
  readonly kindLabel: string;
  readonly currentVersion: number | null;
  readonly versions: number;
  /** Nothing in force = degraded (documents print with defaults, P-08); in force = ok. */
  readonly status: StatusPresentation;
}

export interface DocumentTemplatesView {
  readonly screenState: StatusPresentation;
  readonly kinds: readonly PresentedKind[];
  readonly chosenKind: string | null;
  readonly chosenKindLabel: string | null;
  /** Newest first. */
  readonly versions: readonly PresentedVersion[];
  readonly inForce: PresentedVersion | null;
  readonly nobodyNamed: boolean;
  /** Whether to offer the draft form and the acts — this user holds `platform.setup.write`. */
  readonly mayWrite: boolean;
  readonly kindOptions: readonly { readonly kind: DocumentKind; readonly label: string }[];
  readonly languageOptions: readonly { readonly language: TemplateLanguage; readonly label: string }[];
  readonly limits: typeof TEMPLATE_LIMITS;
}

export interface DocumentTemplatesSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): DocumentTemplatesView;
  /** Draft the next version of a kind, in the caller's own name — refuses BEFORE any POST without permission, for
   *  an unknown kind, or for content the engine would refuse (the same check the cloud runs). */
  draft(kind: string, form: DraftForm): Promise<ActResult>;
  /** Approve a draft — a SECOND person's act. Refuses locally without permission, when the version is not a
   *  draft, or when this user drafted it (§28). The cloud re-checks all three. */
  approve(kind: string, version: number): Promise<ActResult>;
  /** Publish an approved version. Refuses locally without permission or when the version is not approved. */
  publish(kind: string, version: number): Promise<ActResult>;
  /** Present an act's outcome as one glanceable status the shell shows after the action. */
  presentActResult(lang: Lang, result: ActResult): StatusPresentation;
}

const EMPTY_VIEW = (
  screenState: StatusPresentation, nobodyNamed: boolean, mayWrite: boolean, lang: Lang,
): DocumentTemplatesView => {
  const t = translator(DOCUMENT_TEMPLATES_COPY, lang);
  return {
    screenState, kinds: [], chosenKind: null, chosenKindLabel: null, versions: [], inForce: null, nobodyNamed, mayWrite,
    kindOptions: DOCUMENT_KINDS.map((kind) => ({ kind, label: t(KIND_COPY[kind]) })),
    languageOptions: TEMPLATE_LANGUAGES.map((language) => ({ language, label: t(LANGUAGE_COPY[language]) })),
    limits: TEMPLATE_LIMITS,
  };
};

export function createDocumentTemplatesSession(config: DocumentTemplatesConfig, ports: DocumentTemplatePorts): DocumentTemplatesSession {
  const text = (lang: Lang, key: CopyKey): string => translator(DOCUMENT_TEMPLATES_COPY, lang)(key);
  const kindLabel = (lang: Lang, kind: string): string => (isDocumentKind(kind) ? text(lang, KIND_COPY[kind]) : kind);

  const presentVersion = (lang: Lang, v: TemplateVersionView, mayWrite: boolean): PresentedVersion => {
    const t = translator(DOCUMENT_TEMPLATES_COPY, lang);
    const label = `${kindLabel(lang, v.kind)} v${v.version}`;
    const status = v.state === 'published'
      ? presentStatus({ tone: 'ok', icon: '✓', label: t('statePublished'), announcement: `${label}: ${t('statePublished')}`, needsAttention: false })
      : v.state === 'approved'
        ? presentStatus({ tone: 'degraded', icon: '⚠', label: t('stateApproved'), announcement: `${label}: ${t('stateApproved')}`, needsAttention: true })
        : v.state === 'draft'
          ? presentStatus({ tone: 'idle', icon: '○', label: t('stateDraft'), announcement: `${label}: ${t('stateDraft')}`, needsAttention: true })
          : presentStatus({ tone: 'idle', icon: '○', label: `${t('stateSuperseded')}${v.supersededBy === undefined ? '' : ` — ${t('supersededByLabel')} v${v.supersededBy}`}`, announcement: `${label}: ${t('stateSuperseded')}`, needsAttention: false });
    const isMaker = config.userId !== null && v.authoredBy === config.userId;
    const language = (LANGUAGE_COPY as Readonly<Record<string, CopyKey | undefined>>)[v.content.language];
    return {
      kind: v.kind, version: v.version, state: v.state,
      header: v.content.header, footer: v.content.footer, terms: v.content.terms ?? [],
      language: v.content.language, languageLabel: language === undefined ? v.content.language : t(language),
      paperFormat: v.content.paperFormat ?? null, note: v.note ?? null,
      authoredBy: v.authoredBy, authoredAt: v.authoredAt, approvedBy: v.approvedBy ?? null, publishedBy: v.publishedBy ?? null,
      supersededBy: v.supersededBy ?? null,
      status,
      mayApprove: mayWrite && v.state === 'draft' && !isMaker,
      approveWithheldWhy: mayWrite && v.state === 'draft' && isMaker ? t('makerCannotApprove') : null,
      mayPublish: mayWrite && v.state === 'approved',
    };
  };

  const presentKind = (lang: Lang, k: TemplateRegisterData['kinds'][number]): PresentedKind => {
    const t = translator(DOCUMENT_TEMPLATES_COPY, lang);
    const label = kindLabel(lang, k.kind);
    return {
      kind: k.kind, kindLabel: label, currentVersion: k.current?.version ?? null, versions: k.versions,
      status: k.current === null
        ? presentStatus({ tone: 'degraded', icon: '⚠', label: t('nothingInForce'), announcement: `${label}: ${t('nothingInForce')}`, needsAttention: true })
        : presentStatus({ tone: 'ok', icon: '✓', label: `v${k.current.version} ${t('inForce')}`, announcement: `${label}: v${k.current.version} ${t('inForce')}`, needsAttention: false }),
    };
  };

  /** The version as the shell last read it, or undefined — the local state checks run on this. */
  const held = (kind: string, version: number): TemplateVersionView | undefined => {
    const data = ports.kind();
    if (data === null || data.kind !== kind) return undefined;
    return data.versions.find((v) => v.version === version);
  };

  return {
    text,
    view: (lang) => {
      const t = translator(DOCUMENT_TEMPLATES_COPY, lang);
      const nobodyNamed = config.userId === null;
      const mayWrite = ports.mayWrite();
      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), nobodyNamed, false, lang);
      }
      const register = ports.register();
      const chosen = ports.kind();
      if (register === null && chosen === null) {
        return EMPTY_VIEW(presentScreenState({ state: 'empty', label: t('scrEmpty') }), nobodyNamed, mayWrite, lang);
      }
      const versions = (chosen?.versions ?? []).slice().sort((a, b) => b.version - a.version).map((v) => presentVersion(lang, v, mayWrite));
      const inForce = versions.find((v) => v.state === 'published') ?? null;
      return {
        ...EMPTY_VIEW(presentScreenState({ state: 'ready', label: t('scrReady') }), nobodyNamed, mayWrite, lang),
        kinds: (register?.kinds ?? []).map((k) => presentKind(lang, k)),
        chosenKind: chosen?.kind ?? null,
        chosenKindLabel: chosen === null ? null : kindLabel(lang, chosen.kind),
        versions, inForce,
      };
    },

    // Draft. Refuse BEFORE any POST: no permission, an unknown kind, or content the engine would refuse — the same
    // validator the cloud runs, so nothing is sent that would come back 400. The cloud re-checks everything.
    draft: async (kind, form) => {
      if (!ports.mayWrite() || !isDocumentKind(kind)) return { result: 'refused' };
      const content = contentFromForm(kind, form);
      const problems = validateTemplateContent(kind, content);
      if (problems.length > 0) return { result: 'content_invalid', problems };
      const note = form.note.trim();
      return ports.actPort().draft({ kind, content, ...(note === '' ? {} : { note }) });
    },

    // Approve — a SECOND person's act (§28). Refuse locally what the cloud would refuse: no permission, not a draft
    // as last read, or the caller drafted it. The cloud refuses the maker regardless of what the screen showed.
    approve: async (kind, version) => {
      if (!ports.mayWrite() || !isDocumentKind(kind)) return { result: 'refused' };
      const v = held(kind, version);
      if (v !== undefined && v.state !== 'draft') return { result: 'state_conflict', code: 'not_a_draft' };
      if (v !== undefined && config.userId !== null && v.authoredBy === config.userId) return { result: 'maker_cannot_approve' };
      return ports.actPort().approve({ kind, version });
    },

    publish: async (kind, version) => {
      if (!ports.mayWrite() || !isDocumentKind(kind)) return { result: 'refused' };
      const v = held(kind, version);
      if (v !== undefined && v.state !== 'approved') return { result: 'state_conflict', code: v.state === 'published' ? 'already_published' : 'not_approved' };
      return ports.actPort().publish({ kind, version });
    },

    presentActResult: (lang, r) => {
      const t = translator(DOCUMENT_TEMPLATES_COPY, lang);
      switch (r.result) {
        case 'drafted':
          return presentStatus({ tone: 'ok', icon: '✓', label: `${t('actDrafted')} ${r.version.version} — ${t('stateDraft')}`, needsAttention: true });
        case 'approved':
          return presentStatus({ tone: 'ok', icon: '✓', label: `${t('actApproved')} ${r.version.version} — ${t('stateApproved')}`, needsAttention: true });
        case 'published':
          return presentStatus({ tone: 'ok', icon: '✓', label: `${t('actPublished')} ${r.version.version}${r.supersededVersion === undefined ? '' : ` — ${t('actSuperseded')} ${r.supersededVersion}`}`, needsAttention: false });
        case 'content_invalid':
          return presentStatus({ tone: 'error', icon: '✕', label: `${t('actContentInvalid')} ${r.problems.join('; ')}`, needsAttention: true });
        case 'maker_cannot_approve':
          return presentStatus({ tone: 'error', icon: '✕', label: t('actMakerRefused'), needsAttention: true });
        case 'state_conflict':
          return presentStatus({ tone: 'error', icon: '✕', label: `${t('actStateConflict')} (${r.code})`, needsAttention: true });
        case 'lost_link':
          return presentStatus({ tone: 'degraded', icon: '⚠', label: t('actLostLink'), needsAttention: true });
        default:
          return presentStatus({ tone: 'error', icon: '✕', label: t('actRefused'), needsAttention: true });
      }
    },
  };
}
