# `tests/migration/`

Schema migration safety — hard rules **#2, #6, #7**, and the standing rule on this project:
**additive, reversible, versioned migrations only. Never destructive.**

That rule was enforced by discipline, which means it was enforced until the first evening
somebody needed a column gone and the change looked obviously safe. **A destructive migration is
not like other bad code**: it runs once, it succeeds, and the data it removed is not in the diff.
You cannot review your way back to it, and the person who finds out is a customer asking about a
receipt from March.

- **The files are scanned** for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, column
  retypes, and dropped constraints or `NOT NULL`s — with a tripwire proving the scanner fires on
  each, and a counter-tripwire proving it does *not* fire on the additive statements a real
  migration uses. A scanner that flags legitimate work gets switched off within a fortnight.
- **Comments are stripped before scanning**, so a migration may explain what it deliberately does
  not do. Migration 0004's own header says *"a superuser can drop a trigger"*; a scanner that
  reads prose as SQL punishes documentation.
- **A migration may declare an exception**, with a reason, in its own header:

  ```sql
  -- MIGRATION-EXCEPTION: alter_column_type — uuid to text is lossless in this direction…
  ```

  The same shape as every other exception in this product (hard rule #6, MG-04): the dangerous
  thing is not permitted quietly and not forbidden absolutely — it is **kept, named and argued
  for**, where a reviewer sees it in the diff. Two rules keep it honest, and the second is the
  one that matters: a flagged statement with no declaration fails, **and a declaration with no
  flagged statement fails too**. Without that, the block rots into a blanket exemption somebody
  copies forward into a migration that genuinely does drop a column. The declared set is also
  asserted by name, so widening it is something a reviewer is made to notice.

  Migration 0005 is the real case: `uuid → text` is lossless, and the global `UNIQUE (id)` it
  drops is replaced in the same file by the wider, correct `UNIQUE (tenant_id, id)` that ADR-0003
  requires. Both are flagged, both are declared.

- **Against a real PostgreSQL**: the whole set is applied, then applied **again**, then a third
  time. A runner that is idempotent in theory and not in practice fails at exactly one moment —
  the deploy somebody interrupted halfway at eleven at night. The append-only guards are then
  verified **in the database** rather than trusted because migration 0004 says it installs them,
  and `UPDATE`/`DELETE` on the ledger are confirmed to fail by name.

> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
