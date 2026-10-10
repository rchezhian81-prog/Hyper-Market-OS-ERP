// API-12 Migrated HISTORY and ATTACHMENTS (GT-05 · MG-07 · §17.1 · §34 · ADR 0010 · hard rules #2 #6 #7 #10 · P-08).
//
// The register the old system's history lands in. Read the package file (packages/migration/src/history-load.ts) for the
// why; the rules this boundary enforces:
//
//   • a history document is recorded under the OLD system's id (kind + legacyId) and reads back by it — and by the old
//     party code it was booked to, which is how a customer's or supplier's history is found;
//   • it is READ-ONLY history: stored in its own append-only stream, flagged `readOnly`, and never posted to stock, sales,
//     loyalty, receivables or the ledger. There is no edit route and no delete route (asserted by test);
//   • the same document sent again is the same document (a re-run doubles nothing); the same id with DIFFERENT content is a
//     visible 409, never an overwrite (hard rule #10);
//   • an attachment is stored as its bytes (ADR 0010) only when the bytes hash to the SHA-256 the extract manifest gives;
//     every read recomputes the hash from the stored bytes and says whether it is still intact;
//   • a document naming an attachment that was never stored is refused by name — a link to nothing is not history;
//   • every handler refuses a production migration target first (hard rule #7), like the rest of this service.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertNonProduction, type LoadTarget } from '../../../packages/migration/src/trial';
import {
  historyDocumentProblems, attachmentProblems, isHistoryKind, strictBase64, sha256Hex,
  type HistoryKind, type HistoryLine, type HistoryTender,
} from '../../../packages/migration/src/history-load';

/** One migrated history document, as the register holds it. Never edited. */
export interface LegacyHistoryDocument {
  readonly kind: HistoryKind;
  readonly legacyId: string;
  readonly number: string;
  readonly date: string;
  readonly partyRef: string | null;
  readonly lines: readonly HistoryLine[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  readonly tenders: readonly HistoryTender[];
  readonly attachmentIds: readonly string[];
  readonly loadId: string;
  /** SHA-256 of the document's content as recorded — what a re-send is compared by. */
  readonly contentSha256: string;
  /** Always true: migrated history is a record of what happened in the old system, never a trading fact here. */
  readonly readOnly: true;
  readonly source: 'legacy';
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** One migrated document file's metadata (the bytes are kept beside it). */
export interface LegacyAttachmentMeta {
  readonly legacyId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The hash the bytes had when stored — equal to the manifest's, or it would not have been stored. */
  readonly sha256: string;
  readonly loadId: string;
  readonly readOnly: true;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface LegacyAttachment extends LegacyAttachmentMeta {
  readonly contentBase64: string;
}

export interface LegacyHistoryDeps {
  readonly target: (tenantId: string) => Promise<LoadTarget> | LoadTarget;
  readonly documents: (tenantId: string) => Promise<readonly LegacyHistoryDocument[]> | readonly LegacyHistoryDocument[];
  /** Append; resolve the document that STANDS under its kind + legacy id, and whether it was already there (`existed`). */
  readonly recordDocument: (tenantId: string, doc: LegacyHistoryDocument) => Promise<{ readonly standing: LegacyHistoryDocument; readonly existed: boolean }>;
  readonly attachments: (tenantId: string) => Promise<readonly LegacyAttachmentMeta[]> | readonly LegacyAttachmentMeta[];
  readonly attachment: (tenantId: string, legacyId: string) => Promise<LegacyAttachment | undefined> | LegacyAttachment | undefined;
  /** Append; resolve the attachment that STANDS under its legacy id, and whether it was already there (`existed`). */
  readonly recordAttachment: (tenantId: string, a: LegacyAttachment) => Promise<{ readonly standing: LegacyAttachmentMeta; readonly existed: boolean }>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The content a re-send is compared by — fixed key order, so the same document always hashes the same. */
function contentOf(d: Omit<LegacyHistoryDocument, 'contentSha256' | 'readOnly' | 'source' | 'recordedBy' | 'recordedAt' | 'loadId'>): string {
  return JSON.stringify([d.kind, d.legacyId, d.number, d.date, d.partyRef, d.lines.map((l) => [l.productId ?? null, l.description ?? null, l.quantityMinor, l.netMinor, l.taxMinor]),
    d.netMinor, d.taxMinor, d.grossMinor, d.tenders.map((t) => [t.method, t.amountMinor]), d.attachmentIds]);
}

/** An attachment without its bytes — what lists and the store's answer carry. */
export const metaOf = (a: LegacyAttachment | LegacyAttachmentMeta): LegacyAttachmentMeta => ({
  legacyId: a.legacyId, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256: a.sha256,
  loadId: a.loadId, readOnly: true, recordedBy: a.recordedBy, recordedAt: a.recordedAt,
});

const summary = (d: LegacyHistoryDocument) => ({
  kind: d.kind, legacyId: d.legacyId, number: d.number, date: d.date, partyRef: d.partyRef,
  netMinor: d.netMinor, taxMinor: d.taxMinor, grossMinor: d.grossMinor, attachmentIds: d.attachmentIds, loadId: d.loadId, readOnly: d.readOnly, source: d.source,
});

export function legacyHistoryRoutes(deps: LegacyHistoryDeps): readonly Route[] {
  const safe = async (tenantId: string): Promise<void> => {
    const assertion = assertNonProduction(await deps.target(tenantId));
    if (!assertion.permitted) {
      throw apiError(403, {
        code: 'target_is_production',
        whatHappened: `The migration target is ${assertion.detail}. Nothing in this service will run against production (hard rule #7).`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Point the migration at the rehearsal environment. Nothing was read or written.',
      });
    }
  };
  return [
    {
      // Store one document file from the old system's document store, checked against its manifest hash.
      api: 'API-12', method: 'POST', path: '/v1/migration/history/attachments/:legacyId',
      permission: 'migration.history.load', idempotent: true,
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const legacyId = (ctx.params['legacyId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['loadId'])) {
          throw apiError(400, { code: 'not_readable_as_an_attachment', whatHappened: 'An attachment needs { loadId, fileName, contentType, contentBase64, sha256 } with its legacy id in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Send the file as the extract manifest lists it. Nothing was stored.' });
        }
        const problems = attachmentProblems({ ...b, legacyId });
        if (problems.length > 0) {
          const mismatch = problems.some((p) => p.includes('hash to'));
          throw apiError(422, {
            code: mismatch ? 'attachment_checksum_mismatch' : 'attachment_not_storable',
            whatHappened: `Attachment ${legacyId}: ${problems.join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: mismatch ? 'Re-copy the file from the sealed extract and check its hash against the manifest. Nothing was stored.' : 'Fix the file as named, then send it again. Nothing was stored.',
          });
        }
        const bytes = strictBase64(b['contentBase64'])!;
        const a: LegacyAttachment = {
          legacyId, fileName: (b['fileName'] as string).trim(), contentType: b['contentType'] as string, sizeBytes: bytes.length,
          sha256: sha256Hex(bytes), loadId: (b['loadId'] as string).trim(), readOnly: true, recordedBy: ctx.userId, recordedAt: deps.now(),
          contentBase64: b['contentBase64'] as string,
        };
        const { standing: stood, existed } = await deps.recordAttachment(ctx.tenantId, a);
        if (existed) {
          if (stood.sha256 === a.sha256 && stood.fileName === a.fileName) return { status: 200, body: { attachment: stood, alreadyStored: true } };
          throw apiError(409, {
            code: 'legacy_attachment_conflict',
            whatHappened: `Attachment ${legacyId} is already stored as ${stood.fileName} (SHA-256 ${stood.sha256}). This file differs, and a stored document is never replaced.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find out which file is the old system\'s. The stored one stands; a different file needs its own id.',
          });
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'migration.history.attachment.store', objectType: 'legacy_attachment', objectId: legacyId,
          at: a.recordedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: {}, after: { fileName: a.fileName, sha256: a.sha256, sizeBytes: String(a.sizeBytes), loadId: a.loadId }, correlationId: a.loadId,
        });
        return { status: 201, body: { attachment: metaOf(a), alreadyStored: false } };
      },
    },
    {
      // Record one historical document under the old system's id. Read-only history: nothing else in the system moves.
      api: 'API-12', method: 'POST', path: '/v1/migration/history/documents/:kind/:legacyId',
      permission: 'migration.history.load', idempotent: true,
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const kind = ctx.params['kind'] ?? '';
        const legacyId = (ctx.params['legacyId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['loadId']) || !isStr(b['openingDate'])) {
          throw apiError(400, { code: 'not_readable_as_history', whatHappened: 'A history document needs { loadId, openingDate, number, date, netMinor, taxMinor, grossMinor } and optional partyRef, lines, tenders, attachmentIds — with its kind and legacy id in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Send the document as the old system holds it. Nothing was recorded.' });
        }
        const problems = historyDocumentProblems({ ...b, kind, legacyId }, b['openingDate'] as string);
        if (problems.length > 0 || !isHistoryKind(kind)) {
          throw apiError(422, { code: 'history_document_not_usable', whatHappened: `${kind} ${legacyId}: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct the row from the old system, or propose it as an exclusion for the owner to decide (MG-07). Nothing was recorded.' });
        }
        const attachmentIds = ((b['attachmentIds'] as string[] | undefined) ?? []).map((s) => s.trim());
        const stored = new Set((await deps.attachments(ctx.tenantId)).map((a) => a.legacyId));
        const missing = attachmentIds.filter((id) => !stored.has(id));
        if (missing.length > 0) {
          throw apiError(422, { code: 'attachment_not_stored', whatHappened: `${kind} ${legacyId} names attachment(s) ${missing.join(', ')} that are not stored — a link to nothing is not history.`, wasItSaved: 'not_saved', nextSafeAction: 'Store the attachments first (POST /v1/migration/history/attachments/:legacyId), then the document. Nothing was recorded.' });
        }
        const base = {
          kind, legacyId, number: (b['number'] as string).trim(), date: b['date'] as string,
          partyRef: isStr(b['partyRef']) ? (b['partyRef'] as string).trim() : null,
          lines: (b['lines'] as HistoryLine[] | undefined) ?? [], netMinor: b['netMinor'] as number, taxMinor: b['taxMinor'] as number, grossMinor: b['grossMinor'] as number,
          tenders: (b['tenders'] as HistoryTender[] | undefined) ?? [], attachmentIds,
        };
        const doc: LegacyHistoryDocument = {
          ...base, loadId: (b['loadId'] as string).trim(), contentSha256: sha256Hex(Buffer.from(contentOf(base), 'utf8')),
          readOnly: true, source: 'legacy', recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        const { standing: stood, existed } = await deps.recordDocument(ctx.tenantId, doc);
        if (existed) {
          if (stood.contentSha256 === doc.contentSha256) return { status: 200, body: { document: summary(stood), alreadyRecorded: true } };
          throw apiError(409, {
            code: 'legacy_history_conflict',
            whatHappened: `${kind} ${legacyId} is already recorded as number ${stood.number}, dated ${stood.date}, gross ${stood.grossMinor} paise (load ${stood.loadId}). This copy differs, and history is never overwritten.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find out which copy is the old system\'s. The recorded one stands.',
          });
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'migration.history.document.record', objectType: 'legacy_history', objectId: `${kind}/${legacyId}`,
          at: doc.recordedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: {}, after: { number: doc.number, grossMinor: String(doc.grossMinor), loadId: doc.loadId }, correlationId: doc.loadId,
        });
        return { status: 201, body: { document: summary(doc), alreadyRecorded: false } };
      },
    },
    {
      // The history register: by load, kind or party (a customer's / supplier's history), with count and totals per kind.
      api: 'API-12', method: 'GET', path: '/v1/migration/history/documents',
      permission: 'migration.history.read',
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const { loadId, kind, partyRef } = ctx.query;
        const rows = (await deps.documents(ctx.tenantId)).filter((d) => (loadId === undefined || d.loadId === loadId)
          && (kind === undefined || d.kind === kind) && (partyRef === undefined || d.partyRef === partyRef));
        const totals: Record<string, { count: number; netMinor: number; taxMinor: number; grossMinor: number }> = {};
        for (const d of rows) {
          const t = totals[d.kind] ?? { count: 0, netMinor: 0, taxMinor: 0, grossMinor: 0 };
          totals[d.kind] = { count: t.count + 1, netMinor: t.netMinor + d.netMinor, taxMinor: t.taxMinor + d.taxMinor, grossMinor: t.grossMinor + d.grossMinor };
        }
        return { status: 200, body: { documents: rows.map(summary), count: rows.length, totals, readOnly: true, asAt: deps.now() } };
      },
    },
    {
      // One document by the old system's id — with its lines, tenders and the attachments it links to.
      api: 'API-12', method: 'GET', path: '/v1/migration/history/documents/:kind/:legacyId',
      permission: 'migration.history.read',
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const kind = ctx.params['kind'] ?? '';
        const legacyId = ctx.params['legacyId'] ?? '';
        const doc = (await deps.documents(ctx.tenantId)).find((d) => d.kind === kind && d.legacyId === legacyId);
        if (doc === undefined) throw notFound(`history document ${kind}/${legacyId}`);
        const metas = (await deps.attachments(ctx.tenantId)).filter((a) => doc.attachmentIds.includes(a.legacyId));
        return { status: 200, body: { document: doc, attachments: metas } };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/history/attachments',
      permission: 'migration.history.read',
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const loadId = ctx.query['loadId'];
        const rows = (await deps.attachments(ctx.tenantId)).filter((a) => loadId === undefined || a.loadId === loadId);
        return { status: 200, body: { attachments: rows, count: rows.length, totalBytes: rows.reduce((s, a) => s + a.sizeBytes, 0), asAt: deps.now() } };
      },
    },
    {
      // One file, its bytes, and its hash RECOMPUTED from the stored bytes now — `intact` says whether it still matches.
      api: 'API-12', method: 'GET', path: '/v1/migration/history/attachments/:legacyId',
      permission: 'migration.history.read',
      handler: async (ctx) => {
        await safe(ctx.tenantId);
        const legacyId = ctx.params['legacyId'] ?? '';
        const a = await deps.attachment(ctx.tenantId, legacyId);
        if (a === undefined) throw notFound(`attachment ${legacyId}`);
        const bytes = strictBase64(a.contentBase64);
        const sha256Now = bytes === undefined ? null : sha256Hex(bytes);
        return { status: 200, body: { ...a, sha256Now, intact: sha256Now === a.sha256 } };
      },
    },
  ];
}
