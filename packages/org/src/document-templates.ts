// M01-FR-02 — versioned document templates: "a template change is versioned, never overwritten; old
// documents keep their original layout."
//
// A template (the receipt header and footer, an invoice's terms, a PO's or GRN's standing lines, a
// statement's wording) is what a customer, a supplier and the tax officer read; a wrong GSTIN or a missing
// store name on it is a tax error (OC-15). So a change is a NEW version, drafted by one person and approved
// by another (§28: the maker cannot approve their own change), then published — and the version that was
// in force when a document was printed stays on that document, so a reprint next year looks like the
// original, not like today's template.
//
// This is the pure engine: what a template may contain, and how versions move. Where they live and who may
// touch them is the service's; how a lane renders one is `@sre/receipt`'s.

export const DOCUMENT_KINDS = ['receipt', 'invoice', 'purchase_order', 'grn', 'statement'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const isDocumentKind = (v: unknown): v is DocumentKind => typeof v === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(v);

export type TemplateLanguage = 'en' | 'ta' | 'en_ta';
export const TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = ['en', 'ta', 'en_ta'];

export interface DocumentTemplateContent {
  /** Printed above the body — the store name first (a bill must say whose it is). */
  readonly header: readonly string[];
  /** Printed below the body — thanks, returns terms, the helpline. */
  readonly footer: readonly string[];
  /** Standing terms (invoice / PO / statement); optional for a receipt. */
  readonly terms?: readonly string[];
  readonly language: TemplateLanguage;
  /** Receipt only: the paper the header/footer were written for (`thermal-58` / `thermal-80` / `thermal-112`). */
  readonly paperFormat?: string;
}

export type TemplateState = 'draft' | 'approved' | 'published' | 'superseded';

/** One version of one kind's template, as recorded. State changes append a new record of the same version. */
export interface DocumentTemplateVersion {
  readonly kind: DocumentKind;
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

/** Line limits that fit a 3-inch thermal bill and keep a statement readable; a template is not an essay. */
export const TEMPLATE_LIMITS = { headerLines: 8, footerLines: 6, termsLines: 20, lineChars: 64 } as const;
const GSTIN_SHAPE = /^[0-9A-Z]{15}$/;
const GSTIN_LINE = /GSTIN\s*[:-]?\s*([0-9A-Za-z]+)/i;

/** Every problem at once, in plain words; an empty list means the content may be drafted. */
export function validateTemplateContent(kind: DocumentKind, content: unknown): readonly string[] {
  const problems: string[] = [];
  const c = content as Partial<DocumentTemplateContent> | null | undefined;
  if (c === null || c === undefined || typeof c !== 'object') return ['the template content must be an object with header, footer and language'];
  const lines = (name: string, v: unknown, max: number, required: boolean): readonly string[] => {
    if (v === undefined) { if (required) problems.push(`${name} is required`); return []; }
    if (!Array.isArray(v) || !v.every((l) => typeof l === 'string')) { problems.push(`${name} must be a list of lines`); return []; }
    if (v.length > max) problems.push(`${name} has ${v.length} lines; at most ${max} fit`);
    v.forEach((l: string, i) => { if (l.length > TEMPLATE_LIMITS.lineChars) problems.push(`${name} line ${i + 1} is ${l.length} characters; at most ${TEMPLATE_LIMITS.lineChars} fit on the widest paper`); });
    return v as readonly string[];
  };
  const header = lines('header', c.header, TEMPLATE_LIMITS.headerLines, true);
  lines('footer', c.footer, TEMPLATE_LIMITS.footerLines, true);
  lines('terms', c.terms, TEMPLATE_LIMITS.termsLines, false);
  if (Array.isArray(c.header) && (header.length === 0 || header[0]!.trim() === '')) {
    problems.push(`the first header line must name the ${kind === 'receipt' ? 'store' : 'issuer'} — a document must say whose it is`);
  }
  for (const l of header) {
    const m = GSTIN_LINE.exec(l);
    if (m !== null && !GSTIN_SHAPE.test(m[1]!.toUpperCase())) problems.push(`'${l.trim()}' carries a GSTIN that is not 15 characters — a wrong GSTIN on a document is a tax error`);
  }
  if (!TEMPLATE_LANGUAGES.includes(c.language as TemplateLanguage)) problems.push(`language must be one of ${TEMPLATE_LANGUAGES.join(', ')}`);
  if (c.paperFormat !== undefined) {
    if (kind !== 'receipt') problems.push('paperFormat applies to receipts only');
    else if (typeof c.paperFormat !== 'string' || !/^thermal-(58|80|112)$/.test(c.paperFormat)) problems.push('paperFormat must be thermal-58, thermal-80 or thermal-112');
  }
  return problems;
}

const STATE_RANK: Readonly<Record<TemplateState, number>> = { draft: 0, approved: 1, published: 2, superseded: 3 };

/** The standing record of each version: the furthest state wins (a version only ever moves forward). */
export function latestTemplateVersions(records: readonly DocumentTemplateVersion[]): readonly DocumentTemplateVersion[] {
  const byKey = new Map<string, DocumentTemplateVersion>();
  for (const r of records) {
    const key = `${r.kind}#${r.version}`;
    const seen = byKey.get(key);
    if (seen === undefined || STATE_RANK[r.state] >= STATE_RANK[seen.state]) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.version - b.version);
}

/** The version in force for a kind — the published one; nothing, if none was ever published. */
export function currentTemplate(versions: readonly DocumentTemplateVersion[], kind: DocumentKind): DocumentTemplateVersion | undefined {
  return versions.filter((v) => v.kind === kind && v.state === 'published').sort((a, b) => b.version - a.version)[0];
}

export type TemplateRefusal =
  | 'content_invalid'
  | 'unknown_version'
  | 'maker_cannot_approve'
  | 'not_a_draft'
  | 'not_approved'
  | 'already_published';

export type TemplateOutcome =
  | { readonly ok: true; readonly records: readonly DocumentTemplateVersion[] }
  | { readonly ok: false; readonly refusal: TemplateRefusal; readonly detail: string; readonly problems?: readonly string[] };

/** A new draft: the next version number for the kind, authored now. Nothing published changes. */
export function draftTemplate(input: {
  readonly versions: readonly DocumentTemplateVersion[];
  readonly kind: DocumentKind;
  readonly content: unknown;
  readonly note?: string;
  readonly by: string;
  readonly at: string;
}): TemplateOutcome {
  const problems = validateTemplateContent(input.kind, input.content);
  if (problems.length > 0) return { ok: false, refusal: 'content_invalid', detail: `the ${input.kind} template cannot be drafted: ${problems.join('; ')}`, problems };
  const mine = input.versions.filter((v) => v.kind === input.kind);
  const version = mine.reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const content = input.content as DocumentTemplateContent;
  return {
    ok: true,
    records: [{
      kind: input.kind, version, state: 'draft',
      content: { header: [...content.header], footer: [...content.footer], language: content.language,
        ...(content.terms === undefined ? {} : { terms: [...content.terms] }),
        ...(content.paperFormat === undefined ? {} : { paperFormat: content.paperFormat }) },
      ...(input.note === undefined ? {} : { note: input.note }),
      authoredBy: input.by, authoredAt: input.at,
    }],
  };
}

/** Approval is a second person's act (§28): the author may not approve their own draft. */
export function approveTemplate(input: {
  readonly versions: readonly DocumentTemplateVersion[];
  readonly kind: DocumentKind;
  readonly version: number;
  readonly by: string;
  readonly at: string;
}): TemplateOutcome {
  const v = input.versions.find((x) => x.kind === input.kind && x.version === input.version);
  if (v === undefined) return { ok: false, refusal: 'unknown_version', detail: `there is no ${input.kind} template version ${input.version}` };
  if (v.state !== 'draft') return { ok: false, refusal: 'not_a_draft', detail: `${input.kind} v${input.version} is ${v.state}; only a draft can be approved` };
  if (v.authoredBy === input.by) {
    return { ok: false, refusal: 'maker_cannot_approve', detail: `${input.by} drafted ${input.kind} v${input.version} and cannot also approve it (§28) — a second person must` };
  }
  return { ok: true, records: [{ ...v, state: 'approved', approvedBy: input.by, approvedAt: input.at }] };
}

/** Publishing puts an APPROVED version in force and marks the previously published one superseded — never deleted. */
export function publishTemplate(input: {
  readonly versions: readonly DocumentTemplateVersion[];
  readonly kind: DocumentKind;
  readonly version: number;
  readonly by: string;
  readonly at: string;
}): TemplateOutcome {
  const v = input.versions.find((x) => x.kind === input.kind && x.version === input.version);
  if (v === undefined) return { ok: false, refusal: 'unknown_version', detail: `there is no ${input.kind} template version ${input.version}` };
  if (v.state === 'published') return { ok: false, refusal: 'already_published', detail: `${input.kind} v${input.version} is already the version in force` };
  if (v.state !== 'approved') return { ok: false, refusal: 'not_approved', detail: `${input.kind} v${input.version} is ${v.state}; only an approved version can be published` };
  const previous = currentTemplate(input.versions, input.kind);
  const records: DocumentTemplateVersion[] = [{ ...v, state: 'published', publishedBy: input.by, publishedAt: input.at }];
  if (previous !== undefined) records.push({ ...previous, state: 'superseded', supersededBy: input.version, supersededAt: input.at });
  return { ok: true, records };
}
