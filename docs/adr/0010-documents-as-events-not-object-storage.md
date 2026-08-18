# ADR 0010 — Documents stored as append-only events, not object storage (§19 substitution)

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Roadmap §19 lists "object storage for documents." No object store (S3/MinIO/GCS) is built
  or present in `pnpm-lock.yaml`. Instead, an issued document is rendered once under the template version
  in force and **frozen as an append-only `DocumentIssued` event** in the Postgres event ledger
  (`services/platform/src/documents.ts`, folded by `documentsAdapter` in `services/api/src/adapters.ts`);
  reproduction returns those exact frozen bytes and never re-renders (ADR/ledger, M31-FR-02). The current
  renderer emits text (a deterministic `{{field}}` substitution); a binary PDF/HTML renderer stays a
  production concern.

## Decision

Store issued documents as **frozen append-only events in the ledger**, not as objects in a blob store.
The document *is* the bytes captured at issue time, event-sourced like every other fact, inheriting the
ledger's append-only guarantee, tenant isolation and audit chain. **Do not** add an object store now.
Keep rendering behind an injected function so a binary renderer can be supplied without changing the
storage decision.

## §19-substitution impact

- **Offline:** Neutral-to-positive. Documents live in the same event stream that already syncs; there is
  no separate blob channel to reconcile offline.
- **Support:** Lower — one datastore to run, back up and restore; a document is recovered by the same
  ledger restore path as everything else, not a separate bucket lifecycle.
- **Security:** Positive — documents inherit the ledger's tenant isolation, access control and
  tamper-evident audit chain (hard rule #2); there is no separate bucket ACL surface to misconfigure, and
  no public-object exposure risk.
- **Cost:** Lower at pilot volume — no object-storage service. The trade appears at scale: large binary
  blobs in a relational ledger are heavier than in purpose-built object storage.
- **Portability (P-06):** High — a document exports with the ledger; there is no proprietary bucket
  layout. The injected renderer keeps the byte format a separate, swappable concern.
- **Maintainability:** Good while documents are small/text. The known ceiling: many large binary
  documents would bloat the ledger and its backups, which is when an object store (with the ledger
  holding a content-hash reference) becomes the better shape.

## Consequences

- Frozen-content reproduction is structural: July's invoice still reads as July's after August's template
  change, because the bytes are the event, not a re-render (proved by test).
- No blob store to operate, secure or back up separately for the pilot.
- Large binary document volume is the trigger to revisit, not a reason to hold text documents in a bucket
  now.

## Reconsider-when

Documents become large binaries (scanned PDFs, images) at a volume that bloats the ledger/backups — then
move bytes to an object store and keep a content-hash reference in the event.
