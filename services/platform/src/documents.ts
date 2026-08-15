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
import { apiError, notFound } from '../../kernel/src/index';
import {
  publishTemplateVersion, currentVersion, issueDocument, reproduceDocument,
  type TemplateVersion, type DocumentKind, type IssuedDocument,
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

export interface DocumentsDeps {
  /** Every published version of one template — the publish folds over these to pick the next number. */
  readonly versions: (tenantId: string, templateId: string) => Promise<readonly TemplateVersion[]> | readonly TemplateVersion[];
  /** Append a newly published version. Idempotent on templateId+version. */
  readonly recordPublish: (tenantId: string, template: TemplateVersion) => Promise<void> | void;
  /** A previously issued document by its id — for the idempotency check and for reproduction. */
  readonly issued: (tenantId: string, documentId: string) => Promise<IssuedDocument | undefined> | IssuedDocument | undefined;
  /** Store an issued document with its FROZEN content, append-only. Idempotent on the document id. */
  readonly recordIssued: (tenantId: string, doc: IssuedDocument) => Promise<void> | void;
  readonly now: () => string;
}

export function documentsRoutes(deps: DocumentsDeps): readonly Route[] {
  return [
    {
      // Publish a template change AS A NEW VERSION — append-only, needs a change note and a separate approver.
      api: 'API-11', method: 'POST', path: '/v1/documents/templates/:templateId/publish',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = ctx.params['templateId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!KINDS.includes(b['kind'] as DocumentKind) || typeof b['body'] !== 'string' || typeof b['createdBy'] !== 'string' || typeof b['approvedBy'] !== 'string' || typeof b['changeNote'] !== 'string') {
          throw apiError(400, {
            code: 'template_needs_kind_body_people_note',
            whatHappened: 'Publishing a template version needs a valid kind, a body, createdBy, approvedBy and a changeNote.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the template’s kind, layout body, who wrote it, who approves it (a different person, §28) and what changed.',
          });
        }
        if (b['language'] !== undefined && !LANGS.includes(b['language'] as typeof LANGS[number])) {
          throw apiError(400, { code: 'template_language_invalid', whatHappened: 'language, if given, must be "en" or "ta".', wasItSaved: 'not_saved', nextSafeAction: 'Send a supported language or omit it.' });
        }
        const existing = await deps.versions(ctx.tenantId, templateId);
        const result = publishTemplateVersion({
          templateId,
          tenantId: ctx.tenantId,
          kind: b['kind'] as DocumentKind,
          body: b['body'],
          ...(typeof b['branding'] === 'object' && b['branding'] !== null ? { branding: b['branding'] as Record<string, string> } : {}),
          ...(b['language'] !== undefined ? { language: b['language'] as 'en' | 'ta' } : {}),
          createdBy: b['createdBy'],
          approvedBy: b['approvedBy'],
          changeNote: b['changeNote'],
          at: typeof b['at'] === 'string' ? b['at'] : deps.now(),
          existing,
        });
        if (!result.published || result.template === undefined) {
          // A governance refusal (empty body / no change note / not- or self-approved / wrong tenant).
          throw apiError(422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named problem and publish again — a template change is always a new version.' });
        }
        await deps.recordPublish(ctx.tenantId, result.template);
        return { status: 201, body: { templateId, version: result.version, kind: result.template.kind, outcome: result.outcome } };
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
        const result = issueDocument({
          documentId, tenantId: ctx.tenantId, kind: b['kind'] as DocumentKind, subjectRef: b['subjectRef'] as string,
          templateId, versions: await deps.versions(ctx.tenantId, templateId), data,
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
        // Issued: freeze it on its own append-only record.
        await deps.recordIssued(ctx.tenantId, result.document as IssuedDocument);
        return { status: 201, body: { ...(result.document as IssuedDocument), reissued: false, detail: result.detail } };
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
  ];
}
