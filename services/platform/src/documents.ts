// API-11 Versioned document templates (M31-FR-01 / M36-FR-02) — on the live API, run on the tested
// `packages/documents` engine.
//
// The rule the whole package exists for: **a template change is a NEW VERSION, never an overwrite of
// documents already issued.** July's tax invoice must still show July's address and branding after the
// template changes in August. So a publish is append-only — there is no edit path anywhere — it needs a
// change note (an invoice layout carries the shop's legal identity), and it needs a SEPARATE approver
// (§28: the person who changed the template cannot approve it). Per-tenant branding is frozen INTO the
// version (M36-FR-02), and one tenant's rebrand can never reach another tenant's paperwork.
//
// `currentVersion` resolves the version in force at a moment — used at issue, never at re-render.
//
// **Issuing a document renders content NOW and FREEZES it** (M31-FR-02): the document is the bytes, not a
// recipe to re-render later. July's invoice must still read as July's invoice after the template changes in
// August, so re-rendering later uses the version FROM ISSUE, never the current one — `reproduceDocument`
// returns the stored bytes and never re-renders. The renderer is a SUPPLIED function (the engine is layout-
// agnostic); this surface supplies a deterministic text renderer — a real PDF/HTML renderer is a production
// concern, and whatever the renderer returns is what the engine freezes. Issuing is append-only and
// idempotent on the document id: a re-issue returns what was already issued, never a second, different copy.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, secondPersonIsASeparateAct, assertRecordBranchInScope } from '../../kernel/src/index';
import {
  draftTemplateVersion, approveTemplateVersion, type TemplateDraft, currentVersion, issueDocument, reproduceDocument,
  assessTemplateRetention, planDocumentRetention, decideDisposal,
  type TemplateVersion, type DocumentKind, type IssuedDocument, type DocumentDisposal, type FrozenFigures, type IssueResult,
} from '../../../packages/documents/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

export type { TemplateVersion } from '../../../packages/documents/src/index';
export type { IssuedDocument } from '../../../packages/documents/src/index';

const KINDS: readonly DocumentKind[] = ['receipt', 'tax_invoice', 'purchase_order', 'goods_receipt', 'statement', 'credit_note', 'notification'];
const LANGS = ['en', 'ta'] as const;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * A deterministic text renderer: substitute `{{field}}` in the template body with the data value. An unknown
 * field is left as its literal placeholder so a missing value is VISIBLE, never a silent blank. Pure — no
 * clock, no I/O — so the frozen content is reproducible. A real PDF/HTML renderer is a production concern; the
 * engine freezes whatever this returns.
 */
export function renderTemplate(template: TemplateVersion, data: Readonly<Record<string, unknown>>): string {
  return template.body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(data, key) ? String((data as Record<string, unknown>)[key]) : whole);
}

/** The records a business document is issued FROM (PA-09) — and the kind of document each one becomes. */
export type DocumentSourceType = 'purchase_order' | 'goods_receipt' | 'sale' | 'supplier_statement' | 'customer_statement';
/** The first kind is what the source is issued as by default; a sale may also be issued as its receipt. */
export const SOURCE_KINDS: Readonly<Record<DocumentSourceType, readonly DocumentKind[]>> = {
  purchase_order: ['purchase_order'], goods_receipt: ['goods_receipt'], sale: ['tax_invoice', 'receipt'],
  supplier_statement: ['statement'], customer_statement: ['statement'],
};
const SOURCE_TYPES = Object.keys(SOURCE_KINDS) as DocumentSourceType[];
/** Everything a caller might try to decide for a business document — its words, its number, its money. Never accepted. */
const CALLER_MAY_NOT_SEND = ['data', 'documentId', 'subjectRef', 'figures', 'number', 'documentNumber', 'totalMinor', 'taxMinor', 'amountMinor', 'lines', 'version'] as const;

/** What head office read when asked to issue a document from a record. */
export type ResolvedSource =
  | { readonly outcome: 'missing'; readonly detail: string }
  /** The record exists but is not final — a proposed (unapproved) order, a draft — and is never issued. */
  | { readonly outcome: 'not_final'; readonly detail: string }
  /** The record cannot carry this document honestly — e.g. a sale whose lines do not say the GST rate they were sold at. */
  | { readonly outcome: 'incomplete'; readonly detail: string }
  | {
    readonly outcome: 'ready';
    readonly id: string;
    /** A fingerprint of the record exactly as read: a changed record is a different document. */
    readonly version: string;
    /** The record's own number, or null when it has none (a statement) — then one is allocated from `numberSeries`. */
    readonly number: string | null;
    readonly numberSeries?: { readonly series: string; readonly prefix: string };
    /** The branch the record belongs to; null for a shop-wide record (a supplier's or customer's statement). */
    readonly branchId: string | null;
    readonly subjectRef: string;
    /** The words the template renders (`{{field}}`), all read from the record. */
    readonly fields: Readonly<Record<string, string>>;
    readonly figures: FrozenFigures;
  };

/** One reprint of an issued document — append-only, for ever. */
export interface DocumentReprint {
  readonly documentId: string;
  readonly copyNumber: number;
  readonly reprintedBy: string;
  readonly reprintedAt: string;
  readonly reason: string;
}

export interface DocumentsDeps {
  /** Every published version of one template — the publish folds over these to pick the next number. */
  readonly versions: (tenantId: string, templateId: string) => Promise<readonly TemplateVersion[]> | readonly TemplateVersion[];
  /** Append a newly published version. Idempotent on templateId+version. */
  readonly recordPublish: (tenantId: string, template: TemplateVersion) => Promise<void> | void;
  /** Every DRAFT of one template (Wave 2b · PA-03) — the maker's act, awaiting the checker's. */
  readonly drafts: (tenantId: string, templateId: string) => Promise<readonly TemplateDraft[]> | readonly TemplateDraft[];
  /** Append a draft. Idempotent on templateId+version. */
  readonly recordDraft: (tenantId: string, draft: TemplateDraft) => Promise<void> | void;
  /** A previously issued document by its id — for the idempotency check and for reproduction. */
  readonly issued: (tenantId: string, documentId: string) => Promise<IssuedDocument | undefined> | IssuedDocument | undefined;
  /** Store an issued document with its FROZEN content, append-only. Idempotent on the document id. */
  readonly recordIssued: (tenantId: string, doc: IssuedDocument) => Promise<void> | void;
  /** EVERY published version across all of a tenant's templates — for the retention assessment. */
  readonly allVersions: (tenantId: string) => Promise<readonly TemplateVersion[]> | readonly TemplateVersion[];
  /** EVERY issued document for a tenant — for the retention plan. */
  readonly allIssued: (tenantId: string) => Promise<readonly IssuedDocument[]> | readonly IssuedDocument[];
  /** Every recorded disposal decision — the append-only fold that says which documents are already disposed. */
  readonly disposals: (tenantId: string) => Promise<readonly DocumentDisposal[]> | readonly DocumentDisposal[];
  /** Record a disposal decision, append-only. Idempotent on the document id — a re-send collapses. */
  readonly recordDisposal: (tenantId: string, disposal: DocumentDisposal) => Promise<void> | void;
  /** PA-09: read the record a document is issued from. Absent → only notifications can be issued here. */
  readonly resolveSource?: (tenantId: string, type: DocumentSourceType, id: string, asAt: string) => Promise<ResolvedSource>;
  /** PA-09: the shop's gap-free number series, for a record with no number of its own. */
  readonly allocateNumber?: (tenantId: string, series: string) => Promise<number>;
  /** PA-09: every reprint of a document, and recording one. */
  readonly reprints?: (tenantId: string, documentId: string) => Promise<readonly DocumentReprint[]>;
  readonly recordReprint?: (tenantId: string, reprint: DocumentReprint) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** Answer an issue: the frozen document (201), or the engine's refusal by name. */
async function settleIssue(deps: DocumentsDeps, tenantId: string, result: IssueResult): Promise<{ status: number; body: unknown }> {
  if (result.outcome === 'already_issued' && result.document !== undefined) {
    // Idempotent: you get back the SAME frozen document, not a second copy under a later version.
    return { status: 200, body: { ...result.document, reissued: false, detail: result.detail } };
  }
  if (result.outcome === 'no_template') {
    throw apiError(422, { code: 'no_template', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Publish and approve a template version first, then issue the document. Nothing was recorded.' });
  }
  if (result.outcome === 'render_failed' || result.document === undefined) {
    throw apiError(422, { code: 'render_failed', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Check the template body and the data — the rendered document was empty or the renderer failed. Nothing was recorded.' });
  }
  // Issued: freeze it on its own append-only record.
  await deps.recordIssued(tenantId, result.document);
  return { status: 201, body: { ...result.document, reissued: false, detail: result.detail } };
}

export function documentsRoutes(deps: DocumentsDeps): readonly Route[] {
  return [
    {
      // THE MAKER's act (Wave 2b · audit PA-03): draft a template change as the next version. The author is the caller
      // — a body that names a different author, or names an approver at all, is refused by name; the approver acts
      // under their own sign-in through …/versions/:version/approve. A draft is not in force.
      api: 'API-11', method: 'POST', path: '/v1/documents/templates/:templateId/versions',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['approvedBy'] !== undefined) throw secondPersonIsASeparateAct('approvedBy', 'POST /v1/documents/templates/:templateId/versions/:version/approve');
        requireActorIsCaller(ctx, b, 'createdBy');
        if (!KINDS.includes(b['kind'] as DocumentKind) || typeof b['body'] !== 'string' || typeof b['changeNote'] !== 'string') {
          throw apiError(400, {
            code: 'template_needs_kind_body_note',
            whatHappened: 'Drafting a template version needs a valid kind, a body and a changeNote. Who drafts it is taken from your sign-in.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the template’s kind, layout body and what changed; a second person then approves it under their own sign-in.',
          });
        }
        if (b['language'] !== undefined && !LANGS.includes(b['language'] as typeof LANGS[number])) {
          throw apiError(400, { code: 'template_language_invalid', whatHappened: 'language, if given, must be "en" or "ta".', wasItSaved: 'not_saved', nextSafeAction: 'Send a supported language or omit it.' });
        }
        const existing = [...await deps.versions(ctx.tenantId, templateId), ...await deps.drafts(ctx.tenantId, templateId)];
        const result = draftTemplateVersion({
          templateId, tenantId: ctx.tenantId, kind: b['kind'] as DocumentKind, body: b['body'],
          ...(typeof b['branding'] === 'object' && b['branding'] !== null ? { branding: b['branding'] as Record<string, string> } : {}),
          ...(b['language'] !== undefined ? { language: b['language'] as 'en' | 'ta' } : {}),
          createdBy: ctx.userId, changeNote: b['changeNote'], at: typeof b['at'] === 'string' ? b['at'] : deps.now(), existing,
        });
        if (!result.drafted || result.draft === undefined) {
          throw apiError(422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named problem and draft again — a template change is always a new version.' });
        }
        await deps.recordDraft(ctx.tenantId, result.draft);
        return { status: 201, body: { templateId, version: result.draft.version, kind: result.draft.kind, state: 'draft', createdBy: ctx.userId } };
      },
    },
    {
      // THE CHECKER's act: approve a draft under your own sign-in — a different person from its author (§28). From
      // then the version is in force; a document already issued under an earlier version keeps its layout.
      api: 'API-11', method: 'POST', path: '/v1/documents/templates/:templateId/versions/:version/approve',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const version = Number(ctx.params['version']);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'approvedBy');
        const published = (await deps.versions(ctx.tenantId, templateId)).find((v) => v.version === version);
        if (published !== undefined) {
          return { status: 201, body: { templateId, version, kind: published.kind, outcome: 'published', approvedBy: published.approvedBy, alreadyApproved: true } };
        }
        const draft = (await deps.drafts(ctx.tenantId, templateId)).find((d) => d.version === version);
        if (draft === undefined) throw notFound(`draft v${ctx.params['version'] ?? ''} of template ${templateId}`);
        const result = approveTemplateVersion({ draft, approvedBy: ctx.userId, at: typeof b['at'] === 'string' ? b['at'] : deps.now() });
        if (!result.published || result.template === undefined) {
          throw apiError(422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Have a different person approve the draft. Nothing changed.' });
        }
        await deps.recordPublish(ctx.tenantId, result.template);
        return { status: 201, body: { templateId, version: result.version, kind: result.template.kind, outcome: result.outcome, approvedBy: ctx.userId } };
      },
    },
    {
      // The version in force at a moment — the newest approved at or before ?at= (default now).
      api: 'API-11', method: 'GET', path: '/v1/documents/templates/:templateId/current',
      permission: 'document.template.read',
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const at = ctx.query['at'] ?? deps.now();
        const version = currentVersion(await deps.versions(ctx.tenantId, templateId), templateId, at);
        if (version === undefined) throw notFound(`an approved version of template ${templateId} at ${at}`);
        return { status: 200, body: version };
      },
    },
    {
      // Issue a document (M31-FR-02 · audit PA-09). A business document is issued FROM ITS RECORD: the caller names the
      // source ({ type, id }) and head office reads it — its state, its number, its money and tax — refusing a source
      // that does not exist or is not final, and refusing any figure, number or free data sent with it. The content is
      // rendered NOW under the template version in force and FROZEN with exactly what was read: the source's version
      // (a fingerprint of the record as read), its number (its own, or one allocated from the shop's gap-free series for
      // a record that has none), the money and tax, and the template version. The issuer is the authenticated caller.
      // Idempotent: the same source in the same state is the same document — issuing again returns it, never a second
      // copy (and never takes a second number). A notification alone carries no money and keeps its free-form data.
      api: 'API-11', method: 'POST', path: '/v1/documents/templates/:templateId/issue',
      permission: 'document.issue', idempotent: true,
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const finishIssue = (result: IssueResult): Promise<{ status: number; body: unknown }> => settleIssue(deps, ctx.tenantId, result);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const retention = (): { retainUntil?: string; legalHold?: boolean } => {
          if ((b['retainUntil'] !== undefined && !isStr(b['retainUntil'])) || (b['legalHold'] !== undefined && typeof b['legalHold'] !== 'boolean')) {
            throw apiError(400, { code: 'document_retention_unreadable', whatHappened: 'retainUntil, when sent, is a date; legalHold, when sent, is true or false.', wasItSaved: 'not_saved', nextSafeAction: 'Send them in that shape, or leave them out.' });
          }
          return { ...(isStr(b['retainUntil']) ? { retainUntil: b['retainUntil'] } : {}), ...(typeof b['legalHold'] === 'boolean' ? { legalHold: b['legalHold'] } : {}) };
        };

        if (b['source'] === undefined) {
          // Only a notification is issued without a source record: it carries no money and no tax.
          if (b['kind'] !== 'notification') {
            throw apiError(400, {
              code: 'document_needs_its_source',
              whatHappened: `A ${isStr(b['kind']) ? String(b['kind']).replace('_', ' ') : 'business document'} is issued from its record — send { source: { type (${SOURCE_TYPES.join(', ')}), id } } and head office reads the rest.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Name the purchase order, goods receipt, sale or statement it is for. Nothing was issued.',
            });
          }
          const data = (typeof b['data'] === 'object' && b['data'] !== null) ? (b['data'] as Record<string, unknown>) : {};
          if (!isStr(b['documentId']) || !isStr(b['subjectRef']) || (b['data'] !== undefined && (typeof b['data'] !== 'object' || b['data'] === null))) {
            throw apiError(400, { code: 'document_needs_id_kind_subject', whatHappened: 'A notification needs a documentId, a subjectRef, and optionally data (an object).', wasItSaved: 'not_saved', nextSafeAction: 'Send the document id, what it is about, and the words to put in it.' });
          }
          const documentId = b['documentId'] as string;
          const existing = await deps.issued(ctx.tenantId, documentId);
          const notificationVersions = await deps.versions(ctx.tenantId, templateId);
          const inForce = currentVersion(notificationVersions, templateId, deps.now());
          if (existing === undefined && inForce !== undefined && inForce.kind !== 'notification') {
            throw apiError(422, { code: 'template_is_for_another_kind', whatHappened: `Template ${templateId} lays out a ${inForce.kind.replace('_', ' ')}, not a notification.`, wasItSaved: 'not_saved', nextSafeAction: 'Issue it with a notification template. Nothing was issued.' });
          }
          const result = issueDocument({
            documentId, tenantId: ctx.tenantId, kind: 'notification', subjectRef: b['subjectRef'] as string,
            templateId, versions: notificationVersions, data,
            render: renderTemplate, issuedBy: ctx.userId, at: deps.now(), ...retention(),
            ...(existing === undefined ? {} : { alreadyIssued: [existing] }),
          });
          return finishIssue(result);
        }

        // ── a business document: from its record, never from the caller's figures ─────────────────────────────────
        const supplied = CALLER_MAY_NOT_SEND.filter((k) => b[k] !== undefined);
        if (supplied.length > 0) {
          throw apiError(400, { code: 'figures_come_from_the_source', whatHappened: `A document's number, money, tax and words are read from its record by head office — never sent with it (${supplied.join(', ')}).`, wasItSaved: 'not_saved', nextSafeAction: 'Send only { source: { type, id } } (and asAt for a statement). Nothing was issued.' });
        }
        const src = b['source'];
        const type = typeof src === 'object' && src !== null ? (src as Record<string, unknown>)['type'] : undefined;
        const id = typeof src === 'object' && src !== null ? (src as Record<string, unknown>)['id'] : undefined;
        if (!SOURCE_TYPES.includes(type as DocumentSourceType) || !isStr(id)) {
          throw apiError(400, { code: 'document_source_unreadable', whatHappened: `A source is { type (${SOURCE_TYPES.join(', ')}), id }.`, wasItSaved: 'not_saved', nextSafeAction: 'Name the record the document is for. Nothing was issued.' });
        }
        const sourceType = type as DocumentSourceType;
        const allowedKinds = SOURCE_KINDS[sourceType];
        const kind = (b['kind'] ?? allowedKinds[0]) as DocumentKind;
        if (!allowedKinds.includes(kind)) {
          throw apiError(400, { code: 'kind_follows_the_source', whatHappened: `A ${sourceType.replace('_', ' ')} is issued as ${allowedKinds.map((k) => `a ${k.replace('_', ' ')}`).join(' or ')}, not a ${String(b['kind'])}.`, wasItSaved: 'not_saved', nextSafeAction: 'Leave the kind out; it follows the source. Nothing was issued.' });
        }
        const asAt = b['asAt'] ?? deps.now().slice(0, 10);
        if (typeof asAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asAt)) {
          throw apiError(400, { code: 'statement_needs_a_date', whatHappened: 'asAt, when sent, is a YYYY-MM-DD date.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or leave it out for today. Nothing was issued.' });
        }
        if (deps.resolveSource === undefined) {
          throw apiError(422, { code: 'document_sources_not_readable_here', whatHappened: 'This service cannot read the records documents are issued from, so it issues none.', wasItSaved: 'not_saved', nextSafeAction: 'Issue it from head office. Nothing was issued.' });
        }
        const resolved = await deps.resolveSource(ctx.tenantId, sourceType, (id as string).trim(), asAt);
        if (resolved.outcome === 'missing') {
          throw apiError(404, { code: 'document_source_not_found', whatHappened: resolved.detail, wasItSaved: 'not_saved', nextSafeAction: 'Check the record id. A document is never issued for a record head office does not hold. Nothing was issued.' });
        }
        if (resolved.outcome === 'not_final') {
          throw apiError(409, { code: 'document_source_not_final', whatHappened: resolved.detail, wasItSaved: 'not_saved', nextSafeAction: 'Finish the record first (approve the order, settle the receipt). A draft is never issued as a document. Nothing was issued.' });
        }
        if (resolved.outcome === 'incomplete') {
          throw apiError(422, { code: 'document_source_incomplete', whatHappened: resolved.detail, wasItSaved: 'not_saved', nextSafeAction: 'The record does not hold what this document must state, and head office never fills the gap with a guess. Nothing was issued.' });
        }
        assertRecordBranchInScope(ctx, resolved.branchId); // PA-01: a document about a branch the caller holds; shop-wide needs company scope

        const sourceKey = sourceType === 'supplier_statement' || sourceType === 'customer_statement' ? `${resolved.id}~${asAt}` : resolved.id;
        const documentId = `${kind}~${sourceType}~${sourceKey}~${resolved.version}`;
        const existing = await deps.issued(ctx.tenantId, documentId);
        if (existing !== undefined) {
          return { status: 200, body: { ...existing, reissued: false, detail: `this ${sourceType.replace('_', ' ')} in this state was already issued as ${existing.source?.number ?? documentId} — the same document, not a second copy` } };
        }
        const versions = await deps.versions(ctx.tenantId, templateId);
        const at = deps.now();
        const template = currentVersion(versions, templateId, at);
        if (template !== undefined && template.kind !== kind) {
          throw apiError(422, { code: 'template_is_for_another_kind', whatHappened: `Template ${templateId} lays out a ${template.kind.replace('_', ' ')}, not a ${kind.replace('_', ' ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Issue it with a template made for this kind of document. Nothing was issued.' });
        }

        const issueWith = (number: string, allocated: boolean) => issueDocument({
          documentId, tenantId: ctx.tenantId, kind, subjectRef: resolved.subjectRef, templateId, versions,
          data: { ...resolved.fields, documentNumber: number, sourceVersion: resolved.version },
          render: renderTemplate, issuedBy: ctx.userId, at, ...retention(),
          frozen: {
            source: { type: sourceType, id: resolved.id, version: resolved.version, number, numberAllocated: allocated, ...(resolved.branchId === null ? {} : { branchId: resolved.branchId }) },
            figures: resolved.figures,
          },
        });
        // A record with no number of its own takes one from the shop's gap-free series — but only once the document is
        // known to issue (a template in force that renders), so a refused issue never leaves a gap in the series.
        if (resolved.number === null) {
          const trial = issueWith('(to be numbered)', true);
          if (trial.outcome !== 'issued') return finishIssue(trial);
          if (deps.allocateNumber === undefined || resolved.numberSeries === undefined) {
            throw apiError(422, { code: 'document_number_series_not_available', whatHappened: `A ${sourceType.replace('_', ' ')} has no number of its own and this service cannot allocate one.`, wasItSaved: 'not_saved', nextSafeAction: 'Issue it from head office. Nothing was issued.' });
          }
          const seq = await deps.allocateNumber(ctx.tenantId, resolved.numberSeries.series);
          return finishIssue(issueWith(`${resolved.numberSeries.prefix}-${String(seq).padStart(6, '0')}`, true));
        }
        return finishIssue(issueWith(resolved.number, false));
      },
    },
    {
      // REPRINT an issued document — the SAME frozen bytes, marked as a numbered duplicate, and AUDITED: who reprinted
      // which document, which copy, when and why (PA-09). A reprint never re-renders and never re-reads the source.
      api: 'API-11', method: 'POST', path: '/v1/documents/issued/:documentId/reprint',
      permission: 'document.issue', idempotent: true,
      handler: async (ctx) => {
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'reprint_needs_a_reason', whatHappened: 'A reprint says why (the customer lost it, the printer jammed…).', wasItSaved: 'not_saved', nextSafeAction: 'Send a { reason }. Nothing was printed.' });
        }
        const doc = await deps.issued(ctx.tenantId, documentId);
        if (doc === undefined) throw notFound(`an issued document ${documentId}`);
        assertRecordBranchInScope(ctx, doc.source?.branchId ?? null);
        if (deps.recordReprint === undefined || deps.reprints === undefined) {
          throw apiError(422, { code: 'reprints_not_recorded_here', whatHappened: 'This service cannot record a reprint, so it prints none (a reprint is always on record).', wasItSaved: 'not_saved', nextSafeAction: 'Reprint it from head office. Nothing was printed.' });
        }
        const copyNumber = (await deps.reprints(ctx.tenantId, documentId)).length + 1;
        const at = deps.now();
        const reprint: DocumentReprint = { documentId, copyNumber, reprintedBy: ctx.userId, reprintedAt: at, reason: (b['reason'] as string).trim() };
        await deps.recordReprint(ctx.tenantId, reprint);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'document.reprint', objectType: 'document', objectId: documentId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { copyNumber: String(copyNumber), kind: doc.kind, templateVersion: String(doc.templateVersion), ...(doc.source === undefined ? {} : { sourceVersion: doc.source.version, number: doc.source.number }) },
          reason: reprint.reason, correlationId: documentId,
        });
        const reproduced = reproduceDocument(doc);
        return {
          status: 200,
          body: {
            documentId, copyNumber, marking: `DUPLICATE — copy ${copyNumber}${doc.source === undefined ? '' : ` of ${doc.source.number}`}`,
            content: reproduced.content, templateId: reproduced.templateId, templateVersion: reproduced.templateVersion,
            ...(doc.source === undefined ? {} : { source: doc.source }), ...(doc.figures === undefined ? {} : { figures: doc.figures }),
            issuedAt: doc.issuedAt, issuedBy: doc.issuedBy, reprintedBy: ctx.userId, reprintedAt: at,
          },
        };
      },
    },
    {
      // Reproduce an issued document — the SAME frozen bytes the customer received, never a re-render from the
      // current template (M31-FR-02). Registered AFTER the literal `/templates/...` routes; `issued` is its own
      // segment so a document id is never captured as a template id.
      api: 'API-11', method: 'GET', path: '/v1/documents/issued/:documentId',
      permission: 'document.template.read',
      handler: async (ctx) => {
        const documentId = ctx.params['documentId'] ?? '';
        const doc = await deps.issued(ctx.tenantId, documentId);
        if (doc === undefined) throw notFound(`an issued document ${documentId}`);
        const reproduced = reproduceDocument(doc);
        return {
          status: 200,
          body: {
            documentId, kind: doc.kind, subjectRef: doc.subjectRef,
            content: reproduced.content, templateId: reproduced.templateId, templateVersion: reproduced.templateVersion,
            issuedAt: doc.issuedAt, issuedBy: doc.issuedBy, detail: reproduced.detail,
            ...(doc.source === undefined ? {} : { source: doc.source }), ...(doc.figures === undefined ? {} : { figures: doc.figures }),
            reprints: deps.reprints === undefined ? [] : await deps.reprints(ctx.tenantId, documentId),
          },
        };
      },
    },
    {
      // TEMPLATE-VERSION retention: which versions may EVER be disposed of. A version any issued document
      // depends on can never go — it is the record of what that layout meant, the branding in force and who
      // approved it, and an auditor asking "why does this invoice look like this?" is asking about the
      // version, not the render (hard rule #6). A read; it disposes of nothing.
      api: 'API-11', method: 'GET', path: '/v1/documents/retention/templates',
      permission: 'document.template.read',
      handler: async (ctx) => {
        const decisions = assessTemplateRetention({
          versions: await deps.allVersions(ctx.tenantId),
          documents: await deps.allIssued(ctx.tenantId),
        });
        return { status: 200, body: { count: decisions.length, disposableCount: decisions.filter((d) => d.disposable).length, decisions } };
      },
    },
    {
      // ISSUED-DOCUMENT retention: which documents a person may be ASKED about disposing of. It PROPOSES,
      // never deletes — a legal hold beats any retention date, a statutory record (tax invoice, credit note,
      // goods receipt, statement) is never proposed at all, and a document with no retention date is kept
      // because silence never means discard. The statutory set is the engine's policy, not a query override.
      api: 'API-11', method: 'GET', path: '/v1/documents/retention/documents',
      permission: 'document.template.read',
      handler: async (ctx) => {
        const today = ctx.query['today'];
        if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
          throw apiError(400, { code: 'retention_date_invalid', whatHappened: '?today=, if given, must be a YYYY-MM-DD date.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or omit it for today.' });
        }
        const on = today ?? deps.now().slice(0, 10);
        // A document already disposed drops off the plan — it is no longer a live thing to decide about
        // (the disposal fact is kept forever; hard rule #6). Everything else is assessed as before.
        const disposedIds = new Set((await deps.disposals(ctx.tenantId)).map((x) => x.documentId));
        const live = (await deps.allIssued(ctx.tenantId)).filter((d) => !disposedIds.has(d.documentId));
        const plan = planDocumentRetention({ documents: live, today: on });
        return { status: 200, body: { today: on, count: plan.length, disposedCount: disposedIds.size, proposedForDisposalCount: plan.filter((p) => p.action === 'propose_disposal').length, plan } };
      },
    },
    {
      // ISSUED-DOCUMENT disposal EXECUTION (M31): record an authorised human's decision to dispose of a
      // document whose retention has ended. It NEVER deletes a legal-held or statutory record, nor one still
      // inside its retention, nor one with no retention policy (hard rule #6) — `decideDisposal` re-checks
      // eligibility from the document itself, trusting no client verdict. A disposer is named (the
      // authenticated caller) and a reason is required (§28). Append-only; a re-send collapses on the id.
      api: 'API-11', method: 'POST', path: '/v1/documents/:documentId/disposal',
      permission: 'document.retention.dispose', idempotent: true,
      handler: async (ctx) => {
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = typeof b['reason'] === 'string' ? b['reason'] : '';
        const document = await deps.issued(ctx.tenantId, documentId);
        const alreadyDisposed = (await deps.disposals(ctx.tenantId)).some((x) => x.documentId === documentId);
        const decision = decideDisposal({ document, today: deps.now().slice(0, 10), disposedBy: ctx.userId, reason, alreadyDisposed });
        if (!decision.allowed) {
          const status = decision.outcome === 'unknown_document' ? 404
            : decision.outcome === 'already_disposed' ? 409
              : decision.outcome === 'needs_a_reason' || decision.outcome === 'nobody_named' ? 400
                : 409; // legal_hold / statutory / within_retention / no_retention_policy — not eligible
          throw apiError(status, {
            code: `disposal_refused_${decision.outcome}`,
            whatHappened: decision.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: status === 400
              ? 'Send a { reason } for the disposal. Nothing was disposed.'
              : status === 404
                ? 'Check the document id. Nothing was disposed.'
                : 'This document may not be disposed — a hold, a statutory record, still-in-retention, or already disposed. Nothing was disposed.',
          });
        }
        await deps.recordDisposal(ctx.tenantId, decision.disposal!);
        return { status: 200, body: { disposed: true, disposal: decision.disposal } };
      },
    },
  ];
}
