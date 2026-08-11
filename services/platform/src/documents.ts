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
// (Issuing/reproducing a document renders content and needs a concrete renderer; that is a deliberate
// follow-up. This increment lands the versioned-template register the rest depends on.)

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  publishTemplateVersion, currentVersion,
  type TemplateVersion, type DocumentKind,
} from '../../../packages/documents/src/index';

export type { TemplateVersion } from '../../../packages/documents/src/index';

const KINDS: readonly DocumentKind[] = ['receipt', 'tax_invoice', 'purchase_order', 'goods_receipt', 'statement', 'credit_note', 'notification'];
const LANGS = ['en', 'ta'] as const;

export interface DocumentsDeps {
  /** Every published version of one template — the publish folds over these to pick the next number. */
  readonly versions: (tenantId: string, templateId: string) => Promise<readonly TemplateVersion[]> | readonly TemplateVersion[];
  /** Append a newly published version. Idempotent on templateId+version. */
  readonly recordPublish: (tenantId: string, template: TemplateVersion) => Promise<void> | void;
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
  ];
}
