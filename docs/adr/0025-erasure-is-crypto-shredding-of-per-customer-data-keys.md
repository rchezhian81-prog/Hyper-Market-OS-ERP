# ADR 0025 — Erasure is crypto-shredding: a customer's personal text is sealed under their own data key, and erasure destroys the key

- **Status:** Proposed (development-approved by the programme lead for FUL-12; the owner's authorisation and a lawyer's
  confirmation of the retention policy are still needed before any real customer's data is erased — matrix residual)
- **Date:** 11 October 2026
- **Context:** M16-FR-03 / M20-FR-04 require that a verified erasure removes a customer's personal data, except what the
  law keeps. The independent verifier (round 6, FUL-12) found that erasure and minimisation only *appended* redaction
  events: reading `event_ledger` directly on PostgreSQL, the original events still held the complaint text. That is the
  ledger working as designed — hard rule #2 (append-only, `db/migrations/0004_append_only_guards.sql`) and hard rule #6
  (audit evidence is never deleted) forbid editing or deleting those rows. So the personal text must never be readable in
  the ledger in the first place, while the business record (amounts, dates, ids, states) stays whole.

## Decision

**Crypto-shredding.** The personal-data fields of customer-linked events are written to the ledger *encrypted*, under a
data key that belongs to one **(tenant, subject, category)**. An erasure **destroys that key**. The event stays, byte for
byte; its personal text becomes ciphertext nobody can open.

- **Where it happens.** One `EventStore` layer, `PersonalDataSealingStore`
  (`packages/persistence/src/personal-data.ts`), wraps the cloud's `SqlEventStore` in `startApi`
  (`services/api/src/main.ts`). It seals the policy's fields on append and opens them on read, so every domain adapter
  keeps reading plaintext while the key exists and reads `[erased]` after. Events of other types pass through untouched.
- **What is in scope** — `PERSONAL_DATA_POLICY` (`services/api/src/adapters.ts`), category by category, the same
  categories the erasure locates (`privacyDomainHoldingsAdapter`):

  | Category | Event · fields | Disposition on erasure |
  |---|---|---|
  | `service_cases` | `ServiceCaseRecorded` · `summary`, `resolution` | minimised: the redacted latest state is recorded **and** the key is destroyed, so earlier states' words are unreadable |
  | `notification_intents` | `NotificationQueue` (enqueued) · `intent.text` | erased: key destroyed; the send record (when, channel, cost) stays; a pending message is withheld, never sent as a placeholder |
  | `loyalty_member` | `LoyaltyMember` · `mobileLast4` (subject = the member code) | erased: key destroyed; points movements are not personal and stay |
  | `delivery_records` | `DeliveryAttempted` / `DeliveryAttemptIndexed` · `notes`; `DispatchPlanned` · each stop's `area` (subject = the order's customer) | erased: key destroyed; the cash taken at the door and the run's reconciliation stay |
  | `consent_history` | `ConsentRecorded` · `evidence` | **retained** (audit evidence): the key is kept |
  | `lp_records` | `LpCaseOpened` · `summary`, evidence `description`; `LpEvidenceAdded` · `item.description`; `LpCaseClosed` · `outcomeNote` | **retained** (fraud investigation): the key is kept |

  Not sealed, deliberately: ids, amounts, dates, states, and `customerRef` itself (a pseudonymous id the reads filter on;
  the marketing profile is unlinked from it by the existing anonymisation fact). Storefront orders hold no address
  (checked: a delivery location is used to judge the radius and is not persisted), so they need no sealing and are
  retained as tax invoices.
- **The key store.** `subject_data_keys` (db/migrations/0015) in the same PostgreSQL database, row-level-security scoped
  per tenant. Each data key is 32 random bytes, **wrapped** (AES-256-GCM, bound to tenant/subject/category) under a
  key-encryption key (KEK) the API holds from configuration — `PII_KEY_ENCRYPTION_KEY`, or, when unset, derived from
  `PACK_SIGNING_KEY` under its own label (the API says which at boot). The KEK is never in the database, the code or the
  logs. A field is sealed with AES-256-GCM under its data key with tenant/subject/category as associated data, so a
  sealed value copied to another subject does not open.
- **Destroying a key** overwrites the wrapped key with `NULL` and stamps `destroyed_at`. The row is never deleted and a
  destroyed key is never re-set — the database refuses both (trigger `sre_subject_key_destroy_only`). The destruction is
  an **audited, append-only fact** twice over: a row on the **shredded-key list** `subject_key_shreds` (append-only,
  `sre_refuse_mutation`) and a `SubjectDataKeyShredded` event on the privacy stream — neither holds key material.
- **Prevent-restore.** New personal text for a (subject, category) whose key is destroyed is not kept: it is written as
  `[erased]`.

### Backups — the shredded-key list wins

A backup taken *before* an erasure holds the live key. Three things keep a restore from resurrecting it:

1. every backup manifest carries the full shredded-key list as at its snapshot (`scripts/lib/backup-snapshot.mjs`), so
   the newest backup always carries every older shred;
2. `scripts/restore.mjs` re-applies, after the restore reconciles, the union of this backup's list and every
   `--shred-list-from` source (the live database's URL, and/or a newer backup's manifest): each entry goes back on the
   list and its restored key is overwritten. With no newer source it says so loudly;
3. at run time a key whose (tenant, subject, category) is on the list is treated as destroyed **and destroyed again on
   sight** (`SqlSubjectKeyStore.keysForRead`) — so even a list re-applied by hand, without touching the key rows, wins.

The operator runbook step is therefore: restore with `--shred-list-from` pointing at the live database if it is
reachable, otherwise at the newest backup manifest held off-site.

## Limits (honest)

- **Events written before this change** (synthetic data in development and the demo) hold their personal text in plain;
  they are not re-written (that would be an edit of the ledger). No real customer's data exists yet (hard rule #7); a
  shop's first real data will be written sealed from the start. If real data ever predates this layer, a re-sealing
  migration would need its own decision.
- **The store computer** is out of scope: its local log is not sealed, and it has not been reviewed field by field for
  customer personal text. The domains in scope above are head office's (service desk, app, delivery, notifications,
  loyalty enrolment, loss prevention); the store computer's copy needs its own review before real data.
- **PostgreSQL leftovers:** an overwritten key row's old version lives in dead tuples until `VACUUM`, and in WAL / point
  in time archives until they age out. Both are encrypted by the KEK, which is not in the database. Backups follow the
  list rule above.
- **Losing the KEK** makes every sealed field unreadable (`[personal data unavailable: its key is missing]`, said, never
  guessed). The KEK must be backed up with the other deployment secrets, separately from the database backups.
- Consent proof and loss-prevention cases are retained in full until their own retention ends; erasing them then is a
  retention-expiry act (destroy their category key), not yet automated.

## §19-substitution impact

Not a substitution of a §19 baseline technology (PostgreSQL and the event ledger stay); recorded on the six axes because
it changes how personal data is stored.

- **Offline:** none on the till. Sealing runs only in the cloud API; a sale never waits on it (hard rule #1).
- **Support:** one more secret (`PII_KEY_ENCRYPTION_KEY`) to keep and back up; one more restore flag
  (`--shred-list-from`). A wrong or lost KEK shows a visible placeholder, not wrong data.
- **Security:** personal text is unreadable in the database, its dumps and its backups without the KEK; an erased
  person's text is unreadable even with it. Least privilege: the application role may only destroy a key, never delete it
  or re-set it.
- **Cost:** negligible — node's built-in AES-GCM; one key read per ledger read that touches a sealed event.
- **Portability:** the sealed form is plain JSON (`{ "$pd": "v1", s, c, d }`) with documented AES-256-GCM; an export
  through the API is opened, so a shop's export (P-06) is readable while the keys exist.
- **Maintainability:** one policy table names every sealed field; a new personal field is one line there plus its
  category in the erasure's locate step.

## Consequences

- An erasure leaves the ledger byte-for-byte intact and the person's words unrecoverable; reports and totals do not move.
- Every new customer-linked free-text field must be added to `PERSONAL_DATA_POLICY` — a reviewer's checklist item.

## Reconsider-when

A second region or a managed KMS is adopted (move the KEK into it); real customer data predates this layer; or the till
starts capturing customer free text.
