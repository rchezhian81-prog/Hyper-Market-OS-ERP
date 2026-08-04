// Versioned templates and immutable issued documents (M31-FR-01 / §28 / hard rule #6).
//
// The rule this module exists for is one sentence in the roadmap and one of the most
// commonly broken things in retail software: **"a template change is a new version,
// never overwriting issued documents."**
//
// It gets broken because the wrong design is the obvious one. Store the template; render
// the invoice from it whenever someone asks. Then in August the shop changes its address
// on the invoice template — and every invoice it has ever issued silently changes its
// address too. July's invoice now shows an address the shop did not have in July. The
// customer's copy and the shop's copy no longer match. For a tax document that is not a
// cosmetic problem: the two copies are supposed to be the same document.
//
// So an issued document is **frozen at issue**:
//
//   • It stores the **rendered content**, not a promise to re-render it.
//   • It records the **exact template version** it came from.
//   • Re-rendering it later uses **that version**, never the current one.
//   • A template version that any issued document depends on **can never be deleted**
//     (hard rule #6) — retention is a property of the whole chain, not of one row.
//
// Two supporting rules:
//   • **A template change needs approval by someone other than its author** (§28). The
//     invoice layout carries the shop's legal identity, tax numbers and terms.
//   • **Branding is per-tenant** (M36-FR-02) and lives in the template version, so one
//     tenant's rebrand cannot reach into another tenant's issued paperwork.
//
// Pure and deterministic: the clock is injected, rendering is a supplied function so this
// module never depends on a formatter.

export type DocumentKind =
  | 'receipt'
  | 'tax_invoice'
  | 'purchase_order'
  | 'goods_receipt'
  | 'statement'
  | 'credit_note'
  | 'notification';

export interface TemplateVersion {
  readonly templateId: string;
  /** Monotonic per template. A change is always a NEW number, never an edit. */
  readonly version: number;
  readonly tenantId: string;
  readonly kind: DocumentKind;
  /** The layout body — whatever the renderer understands. */
  readonly body: string;
  /** Per-tenant branding frozen into the version (M36-FR-02). */
  readonly branding?: Readonly<Record<string, string>>;
  readonly language?: 'en' | 'ta';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly changeNote: string;
}

export interface IssuedDocument {
  readonly documentId: string;
  readonly tenantId: string;
  readonly kind: DocumentKind;
  /** The subject — the sale, order, PO or notification this document is about. */
  readonly subjectRef: string;
  readonly templateId: string;
  /** The exact version used. Re-rendering later uses THIS, never the latest. */
  readonly templateVersion: number;
  /** The rendered content, frozen at issue. This is the document. */
  readonly content: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  /** When retention allows disposal. Absent means keep indefinitely. */
  readonly retainUntil?: string;
  /** True when a legal hold or statutory basis blocks disposal regardless of date. */
  readonly legalHold?: boolean;
}

export type PublishRefusal =
  | 'published'
  | 'not_approved'
  | 'self_approved'
  | 'no_change_note'
  | 'empty_body'
  | 'wrong_tenant';

export interface PublishResult {
  readonly templateId: string;
  readonly published: boolean;
  readonly outcome: PublishRefusal;
  readonly version?: number;
  readonly detail: string;
  readonly template?: TemplateVersion;
}

/**
 * Publish a template change **as a new version**. There is deliberately no way to edit an
 * existing version anywhere in this module, and a test asserts that absence: an edited
 * template version would silently rewrite documents already in customers' hands.
 */
export function publishTemplateVersion(input: {
  readonly templateId: string;
  readonly tenantId: string;
  readonly kind: DocumentKind;
  readonly body: string;
  readonly branding?: Readonly<Record<string, string>>;
  readonly language?: 'en' | 'ta';
  readonly createdBy: string;
  readonly approvedBy: string;
  readonly changeNote: string;
  readonly at: string;
  /** Every version already published for this template. */
  readonly existing: readonly TemplateVersion[];
}): PublishResult {
  const base = { templateId: input.templateId };
  const mine = input.existing.filter((v) => v.templateId === input.templateId);

  if (input.body.trim() === '') {
    return { ...base, published: false, outcome: 'empty_body', detail: 'a template version needs a body' };
  }
  if (input.changeNote.trim() === '') {
    return {
      ...base,
      published: false,
      outcome: 'no_change_note',
      detail: 'a template change needs a note saying what changed — an invoice layout carries the shop\'s legal identity',
    };
  }
  if (input.approvedBy.trim() === '') {
    return { ...base, published: false, outcome: 'not_approved', detail: 'a template change needs an approver (§28)' };
  }
  if (input.approvedBy === input.createdBy) {
    return {
      ...base,
      published: false,
      outcome: 'self_approved',
      detail: 'the person who changed the template cannot be the one who approves it (§28)',
    };
  }
  const foreign = mine.find((v) => v.tenantId !== input.tenantId);
  if (foreign !== undefined) {
    // One tenant's rebrand must never reach another tenant's paperwork.
    return {
      ...base,
      published: false,
      outcome: 'wrong_tenant',
      detail: `template ${input.templateId} belongs to ${foreign.tenantId}`,
    };
  }

  const version = mine.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const template: TemplateVersion = {
    templateId: input.templateId,
    version,
    tenantId: input.tenantId,
    kind: input.kind,
    body: input.body,
    ...(input.branding === undefined ? {} : { branding: input.branding }),
    ...(input.language === undefined ? {} : { language: input.language }),
    createdBy: input.createdBy,
    createdAt: input.at,
    approvedBy: input.approvedBy,
    approvedAt: input.at,
    changeNote: input.changeNote,
  };

  return {
    ...base,
    published: true,
    outcome: 'published',
    version,
    template,
    detail:
      version === 1
        ? `${input.templateId} v1 published`
        : `${input.templateId} v${version} published — v${version - 1} is kept, and every document issued under it keeps its original layout`,
  };
}

/** The version in force at a given instant — used at issue, never at re-render. */
export function currentVersion(
  versions: readonly TemplateVersion[],
  templateId: string,
  at: string,
): TemplateVersion | undefined {
  return versions
    .filter((v) => v.templateId === templateId && v.approvedAt <= at)
    .sort((a, b) => b.version - a.version)[0];
}

export type IssueRefusal = 'issued' | 'no_template' | 'already_issued' | 'render_failed';

export interface IssueResult {
  readonly documentId: string;
  readonly issued: boolean;
  readonly outcome: IssueRefusal;
  readonly detail: string;
  readonly document?: IssuedDocument;
}

export type Renderer = (
  template: TemplateVersion,
  data: Readonly<Record<string, unknown>>,
) => string;

/**
 * Issue a document. The content is **rendered now and frozen** — this is the document,
 * not a recipe for producing one later.
 *
 * Idempotent on the document id: re-issuing returns what was already issued rather than
 * producing a second copy with a later template version, which is the subtle version of
 * the same bug.
 */
export function issueDocument(input: {
  readonly documentId: string;
  readonly tenantId: string;
  readonly kind: DocumentKind;
  readonly subjectRef: string;
  readonly templateId: string;
  readonly versions: readonly TemplateVersion[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly render: Renderer;
  readonly issuedBy: string;
  readonly at: string;
  readonly retainUntil?: string;
  readonly legalHold?: boolean;
  readonly alreadyIssued?: readonly IssuedDocument[];
}): IssueResult {
  const base = { documentId: input.documentId };

  const existing = (input.alreadyIssued ?? []).find((d) => d.documentId === input.documentId);
  if (existing !== undefined) {
    return {
      ...base,
      issued: false,
      outcome: 'already_issued',
      document: existing,
      detail: `document ${input.documentId} was already issued under ${existing.templateId} v${existing.templateVersion} — re-issuing would produce a second, different copy of the same document`,
    };
  }

  const template = currentVersion(input.versions, input.templateId, input.at);
  if (template === undefined || template.tenantId !== input.tenantId) {
    return {
      ...base,
      issued: false,
      outcome: 'no_template',
      detail: `no approved version of ${input.templateId} exists for this tenant at ${input.at}`,
    };
  }

  let content: string;
  try {
    content = input.render(template, input.data);
  } catch (error) {
    return { ...base, issued: false, outcome: 'render_failed', detail: `rendering failed: ${(error as Error).message}` };
  }
  if (content.trim() === '') {
    return { ...base, issued: false, outcome: 'render_failed', detail: 'rendering produced an empty document' };
  }

  return {
    ...base,
    issued: true,
    outcome: 'issued',
    detail: `issued under ${template.templateId} v${template.version}`,
    document: {
      documentId: input.documentId,
      tenantId: input.tenantId,
      kind: input.kind,
      subjectRef: input.subjectRef,
      templateId: template.templateId,
      templateVersion: template.version,
      content,
      issuedAt: input.at,
      issuedBy: input.issuedBy,
      ...(input.retainUntil === undefined ? {} : { retainUntil: input.retainUntil }),
      ...(input.legalHold === undefined ? {} : { legalHold: input.legalHold }),
    },
  };
}

/**
 * Reproduce an issued document. Returns the **stored content** — the same bytes the
 * customer received — and never re-renders from the current template.
 *
 * The `templateVersion` is returned alongside so a viewer can state which layout it is
 * looking at, which is the question an auditor actually asks.
 */
export function reproduceDocument(document: IssuedDocument): {
  readonly content: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly detail: string;
} {
  return {
    content: document.content,
    templateId: document.templateId,
    templateVersion: document.templateVersion,
    detail: `reproduced exactly as issued on ${document.issuedAt} under ${document.templateId} v${document.templateVersion}`,
  };
}

export interface RetentionDecision {
  readonly templateId: string;
  readonly version: number;
  readonly disposable: boolean;
  readonly dependentDocuments: number;
  readonly detail: string;
}

/**
 * Whether a template version may ever be disposed of.
 *
 * **A version any issued document depends on can never go** (hard rule #6). It is not
 * enough that the *documents* are retained: the version records what the layout meant,
 * the branding in force, and who approved it — and an auditor asking "why does this
 * invoice look like this?" is asking about the version, not the render.
 */
export function assessTemplateRetention(input: {
  readonly versions: readonly TemplateVersion[];
  readonly documents: readonly IssuedDocument[];
}): readonly RetentionDecision[] {
  return input.versions
    .map((v): RetentionDecision => {
      const dependents = input.documents.filter(
        (d) => d.templateId === v.templateId && d.templateVersion === v.version,
      ).length;
      return {
        templateId: v.templateId,
        version: v.version,
        disposable: dependents === 0,
        dependentDocuments: dependents,
        detail:
          dependents === 0
            ? `no document was ever issued under ${v.templateId} v${v.version}`
            : `${dependents} issued document(s) depend on ${v.templateId} v${v.version} — it can never be removed, because it is the record of what that layout meant`,
      };
    })
    .sort((a, b) => a.templateId.localeCompare(b.templateId) || a.version - b.version);
}

export interface DocumentRetentionPlan {
  readonly documentId: string;
  readonly kind: DocumentKind;
  readonly action: 'keep' | 'propose_disposal';
  readonly reason: string;
}

/**
 * Which issued documents a human may be asked about disposing of.
 *
 * It **proposes**, never deletes — the same discipline as `packages/audit`. A legal hold
 * beats a retention date, a document with no retention date is kept (silence never means
 * discard), and a tax document is never proposed at all.
 */
export function planDocumentRetention(input: {
  readonly documents: readonly IssuedDocument[];
  readonly today: string;
  /** Kinds that are never proposed for disposal whatever the date says. */
  readonly statutoryKinds?: readonly DocumentKind[];
}): readonly DocumentRetentionPlan[] {
  const statutory = new Set<DocumentKind>(
    input.statutoryKinds ?? ['tax_invoice', 'credit_note', 'goods_receipt', 'statement'],
  );

  return input.documents.map((d): DocumentRetentionPlan => {
    if (d.legalHold === true) {
      return { documentId: d.documentId, kind: d.kind, action: 'keep', reason: 'a legal hold beats any retention date' };
    }
    if (statutory.has(d.kind)) {
      return {
        documentId: d.documentId,
        kind: d.kind,
        action: 'keep',
        reason: `a ${d.kind.replace('_', ' ')} is a statutory record and is never proposed for disposal`,
      };
    }
    if (d.retainUntil === undefined) {
      return { documentId: d.documentId, kind: d.kind, action: 'keep', reason: 'no retention policy applies, and silence never means discard' };
    }
    if (d.retainUntil > input.today) {
      return { documentId: d.documentId, kind: d.kind, action: 'keep', reason: `retained until ${d.retainUntil}` };
    }
    return {
      documentId: d.documentId,
      kind: d.kind,
      action: 'propose_disposal',
      reason: `retention ended on ${d.retainUntil} — proposed for a person to decide, never deleted automatically`,
    };
  });
}
