// API-01 Org/config — versioned document templates (M01-FR-02).
//
// "Upload/version document templates (receipt, invoice, PO, GRN, statement) → approve → publish. A template
// change is versioned, never overwritten; old documents keep their original layout." The engine in
// `@sre/org` decides what a template may say and how a version moves; these routes make it durable and
// put the §28 shape on it: one person drafts, a DIFFERENT person approves, then it is published and the
// previous version is marked superseded — kept, never deleted, because the receipts printed under it
// still name it.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  DOCUMENT_KINDS, isDocumentKind, draftTemplate, approveTemplate, publishTemplate, latestTemplateVersions, currentTemplate,
  type DocumentKind, type DocumentTemplateVersion, type TemplateOutcome,
} from '../../../packages/org/src/index';

export type { DocumentTemplateVersion } from '../../../packages/org/src/index';

export interface DocumentTemplateDeps {
  /** Every recorded version state, oldest first; the routes fold the standing state of each version. */
  readonly versions: (tenantId: string) => Promise<readonly DocumentTemplateVersion[]> | readonly DocumentTemplateVersion[];
  readonly record: (tenantId: string, version: DocumentTemplateVersion) => Promise<void> | void;
  readonly now: () => string;
}

function kindOf(ctx: RequestContext): DocumentKind {
  const kind = ctx.params['kind'] ?? '';
  if (!isDocumentKind(kind)) {
    throw apiError(400, {
      code: 'unknown_document_kind',
      whatHappened: `'${kind}' is not a document kind. The kinds are ${DOCUMENT_KINDS.join(', ')}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Use one of the listed kinds.',
    });
  }
  return kind;
}

function versionOf(ctx: RequestContext): number {
  const n = Number(ctx.params['version']);
  if (!Number.isInteger(n) || n <= 0) {
    throw apiError(400, {
      code: 'bad_template_version',
      whatHappened: `'${ctx.params['version'] ?? ''}' is not a version number.`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Versions are whole numbers starting at 1 — read the kind to see them.',
    });
  }
  return n;
}

function refused(outcome: Extract<TemplateOutcome, { ok: false }>, kind: DocumentKind): never {
  switch (outcome.refusal) {
    case 'content_invalid':
      throw apiError(400, { code: 'template_content_invalid', whatHappened: outcome.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct the lines named and draft again. Nothing was saved.' });
    case 'unknown_version':
      throw notFound(`${kind} template version`);
    case 'maker_cannot_approve':
      throw apiError(403, { code: 'maker_cannot_approve', whatHappened: outcome.detail, wasItSaved: 'not_saved', nextSafeAction: 'Ask a second person with setup rights to approve it. The draft stands.' });
    case 'not_a_draft':
    case 'not_approved':
    case 'already_published':
      throw apiError(409, { code: outcome.refusal, whatHappened: outcome.detail, wasItSaved: 'not_saved', nextSafeAction: 'Read the kind to see each version\'s state; only a draft is approved and only an approved version is published.' });
    default:
      throw apiError(500, { code: 'template_refused', whatHappened: outcome.detail, wasItSaved: 'unknown', nextSafeAction: 'Read the kind and try again.' });
  }
}

const summary = (v: DocumentTemplateVersion) => ({
  kind: v.kind, version: v.version, state: v.state, content: v.content, ...(v.note === undefined ? {} : { note: v.note }),
  authoredBy: v.authoredBy, authoredAt: v.authoredAt,
  ...(v.approvedBy === undefined ? {} : { approvedBy: v.approvedBy, approvedAt: v.approvedAt }),
  ...(v.publishedBy === undefined ? {} : { publishedBy: v.publishedBy, publishedAt: v.publishedAt }),
  ...(v.supersededBy === undefined ? {} : { supersededBy: v.supersededBy, supersededAt: v.supersededAt }),
});

export function documentTemplateRoutes(deps: DocumentTemplateDeps): readonly Route[] {
  const standing = async (tenantId: string) => latestTemplateVersions(await deps.versions(tenantId));
  const apply = async (tenantId: string, outcome: TemplateOutcome, kind: DocumentKind) => {
    if (!outcome.ok) refused(outcome, kind);
    for (const r of (outcome as Extract<TemplateOutcome, { ok: true }>).records) await deps.record(tenantId, r);
    return (outcome as Extract<TemplateOutcome, { ok: true }>).records;
  };

  return [
    {
      // The STORE BOX's read (M01-FR-02 · §31): the version IN FORCE of every kind, and nothing else — no
      // drafts, no notes, no names. The box pulls this on its sync loop (edge/sync-agent `pullPublishedTemplates`)
      // and lays it into the lane's pack, so a receipt printed with the cable out carries the header and footer
      // head office published, under the version it was printed under. Narrower than `platform.setup.read` so
      // the box's identity (the cashier role) can hold it without seeing the setup surface. Registered BEFORE
      // `/:kind` so "published" is never read as a document kind.
      api: 'API-01', method: 'GET', path: '/v1/org/document-templates/published',
      permission: 'org.template.pull',
      handler: async (ctx) => {
        const versions = await standing(ctx.tenantId);
        const templates = DOCUMENT_KINDS.flatMap((kind) => {
          const current = currentTemplate(versions, kind);
          return current === undefined ? [] : [{
            kind, version: current.version, content: current.content,
            publishedAt: current.publishedAt ?? current.authoredAt,
          }];
        });
        return { status: 200, body: { tenantId: ctx.tenantId, generatedAt: deps.now(), templates } };
      },
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/org/document-templates',
      permission: 'platform.setup.read',
      handler: async (ctx) => {
        const versions = await standing(ctx.tenantId);
        return {
          status: 200,
          body: {
            kinds: DOCUMENT_KINDS.map((kind) => {
              const current = currentTemplate(versions, kind);
              return { kind, current: current === undefined ? null : summary(current), versions: versions.filter((v) => v.kind === kind).length };
            }),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/org/document-templates/:kind',
      permission: 'platform.setup.read',
      handler: async (ctx) => {
        const kind = kindOf(ctx);
        const versions = (await standing(ctx.tenantId)).filter((v) => v.kind === kind);
        const current = currentTemplate(versions, kind);
        return { status: 200, body: { kind, current: current === undefined ? null : summary(current), versions: versions.map(summary), asAt: deps.now() } };
      },
    },
    {
      api: 'API-01', method: 'POST', path: '/v1/org/document-templates/:kind/versions',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const kind = kindOf(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['note'] !== undefined && typeof b['note'] !== 'string') {
          throw apiError(400, { code: 'template_content_invalid', whatHappened: 'note must be text.', wasItSaved: 'not_saved', nextSafeAction: 'Send the note as text or leave it out.' });
        }
        const records = await apply(ctx.tenantId, draftTemplate({
          versions: await standing(ctx.tenantId), kind, content: b['content'], by: ctx.userId, at: deps.now(),
          ...(typeof b['note'] === 'string' ? { note: b['note'] } : {}),
        }), kind);
        return { status: 201, body: summary(records[0]!) };
      },
    },
    {
      api: 'API-01', method: 'POST', path: '/v1/org/document-templates/:kind/versions/:version/approve',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const kind = kindOf(ctx);
        const records = await apply(ctx.tenantId, approveTemplate({
          versions: await standing(ctx.tenantId), kind, version: versionOf(ctx), by: ctx.userId, at: deps.now(),
        }), kind);
        return { status: 200, body: summary(records[0]!) };
      },
    },
    {
      api: 'API-01', method: 'POST', path: '/v1/org/document-templates/:kind/versions/:version/publish',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const kind = kindOf(ctx);
        const records = await apply(ctx.tenantId, publishTemplate({
          versions: await standing(ctx.tenantId), kind, version: versionOf(ctx), by: ctx.userId, at: deps.now(),
        }), kind);
        const superseded = records.find((r) => r.state === 'superseded');
        return { status: 200, body: { ...summary(records[0]!), ...(superseded === undefined ? {} : { supersededVersion: superseded.version }) } };
      },
    },
  ];
}
