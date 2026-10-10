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
import { apiError, notFound, requireActorIsCaller, secondPersonIsASeparateAct } from '../../kernel/src/index';
import {
  draftTemplateVersion, approveTemplateVersion, type TemplateDraft, currentVersion, issueDocument, reproduceDocument,
  assessTemplateRetention, planDocumentRetention, decideDisposal,
  type TemplateVersion, type DocumentKind, type IssuedDocument, type DocumentDisposal,
} from '../../../packages/documents/src/index';

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

/**
 * What a document is OF (audit PA-09): the governed source record head office resolved itself — its type, id, version
 * and number — and the figures it supplies to the render. A document is never issued about a record that does not
 * exist, or about a draft, and its money comes from the record, never from the request.
 */
export type SourceResolution =
  | {
    readonly found: true;
    readonly sourceType: 'sale' | 'purchase_order' | 'goods_receipt';
    readonly sourceId: string;
    /** The record's version / state the document froze (e.g. a PO's amendment count). */
    readonly sourceVersion: string;
    /** The source's own number (receipt, PO, GRN number) — referenced, never re-allocated. */
    readonly number: string;
    /** What the source supplies to the render — every money figure on the document comes from here. */
    readonly data: Readonly<Record<string, string>>;
  }
  | { readonly found: false; readonly refusal: 'source_not_found' | 'source_is_a_draft' | 'source_not_resolvable'; readonly why: string };

/** Keys a caller may never supply: money and tax on a document come from its source record (PA-09). */
const MONEY_KEY = /(minor|amount|total|tax|gst|price|value|paise|rupee|cost|discount|balance)/i;

export interface DocumentsDeps {
  /**
   * Resolve the governed source of a document (PA-09) from head office's own records. Absent (a bare wiring), issuing
   * is refused — a document about a record nobody checked is the audit's finding.
   */
  readonly source?: (tenantId: string, kind: DocumentKind, subjectRef: string) => Promise<SourceResolution> | SourceResolution;
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
  readonly now: () => string;
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
      // Issue a document from a template — render NOW under the version in force and FREEZE the content
      // (M31-FR-02). The issuer is the AUTHENTICATED caller (never a body value). Idempotent on the document
      // id: a re-issue returns the same frozen document, never a second copy under a later version.
      api: 'API-11', method: 'POST', path: '/v1/documents/templates/:templateId/issue',
      permission: 'document.issue', idempotent: true,
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const data = (typeof b['data'] === 'object' && b['data'] !== null) ? (b['data'] as Record<string, unknown>) : {};
        if (!isStr(b['documentId']) || !KINDS.includes(b['kind'] as DocumentKind) || !isStr(b['subjectRef'])
          || (b['data'] !== undefined && (typeof b['data'] !== 'object' || b['data'] === null))
          || (b['retainUntil'] !== undefined && !isStr(b['retainUntil']))
          || (b['legalHold'] !== undefined && typeof b['legalHold'] !== 'boolean')) {
          throw apiError(400, {
            code: 'document_needs_id_kind_subject',
            whatHappened: 'Issuing a document needs a documentId, a valid kind, a subjectRef, and optionally data (an object), retainUntil and legalHold.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the document id, kind, what it is about, and the data to render into it.',
          });
        }
        const documentId = b['documentId'] as string;
        const existing = await deps.issued(ctx.tenantId, documentId);
        if (existing !== undefined) {
          // Idempotent: the SAME frozen document, whatever the second request carries.
          return { status: 200, body: { ...existing, reissued: false, detail: 'already issued — the frozen document is returned, never a second copy' } };
        }
        // PA-09: the document is OF a governed record head office resolves itself — refused when it does not exist or is
        // a draft — and its money comes from that record. A caller may add descriptive words, never a figure.
        if (deps.source === undefined) {
          throw apiError(503, { code: 'document_sources_not_wired', whatHappened: 'Head office cannot check what this document is about here, so nothing was issued.', wasItSaved: 'not_saved', nextSafeAction: 'Issue documents on the full head-office service.' });
        }
        const overridden = Object.keys(data).filter((k) => MONEY_KEY.test(k));
        if (overridden.length > 0) {
          throw apiError(422, {
            code: 'client_financial_override',
            whatHappened: `A document's money comes from its source record, never the request — ${overridden.join(', ')} cannot be sent.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Remove the money fields; head office fills them from the record the document is about.',
          });
        }
        const resolved = await deps.source(ctx.tenantId, b['kind'] as DocumentKind, (b['subjectRef'] as string).trim());
        if (!resolved.found) {
          throw apiError(422, { code: resolved.refusal, whatHappened: resolved.why, wasItSaved: 'not_saved', nextSafeAction: 'Issue the document about a record head office holds, once it is final. Nothing was recorded.' });
        }
        const clashes = Object.keys(data).filter((k) => k in resolved.data);
        if (clashes.length > 0) {
          throw apiError(422, { code: 'client_override', whatHappened: `${clashes.join(', ')} come from the ${resolved.sourceType} ${resolved.sourceId} and cannot be sent.`, wasItSaved: 'not_saved', nextSafeAction: 'Leave those out; head office fills them from the record.' });
        }
        const result = issueDocument({
          documentId, tenantId: ctx.tenantId, kind: b['kind'] as DocumentKind, subjectRef: `${resolved.sourceType}:${resolved.sourceId}`,
          templateId, versions: await deps.versions(ctx.tenantId, templateId), data: { ...data, ...resolved.data },
          render: renderTemplate, issuedBy: ctx.userId, at: deps.now(),
          ...(isStr(b['retainUntil']) ? { retainUntil: b['retainUntil'] as string } : {}),
          ...(typeof b['legalHold'] === 'boolean' ? { legalHold: b['legalHold'] } : {}),
          ...(existing === undefined ? {} : { alreadyIssued: [existing] }),
        });

        if (result.outcome === 'already_issued' && result.document !== undefined) {
          // Idempotent: you get back the SAME frozen document, not a second copy under a later version.
          return { status: 200, body: { ...result.document, reissued: false, detail: result.detail } };
        }
        if (result.outcome === 'no_template') {
          throw apiError(422, { code: 'no_template', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Publish and approve a template version first, then issue the document. Nothing was recorded.' });
        }
        if (result.outcome === 'render_failed') {
          throw apiError(422, { code: 'render_failed', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Check the template body and the data — the rendered document was empty or the renderer failed. Nothing was recorded.' });
        }
        // Issued: freeze it — content, template version AND the source it is of (type, id, version, number) — on its own
        // append-only record.
        const frozen = { ...(result.document as IssuedDocument), source: { type: resolved.sourceType, id: resolved.sourceId, version: resolved.sourceVersion, number: resolved.number } };
        await deps.recordIssued(ctx.tenantId, frozen);
        return { status: 201, body: { ...frozen, reissued: false, detail: result.detail } };
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
