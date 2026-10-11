// Crypto-shredding of personal data in the append-only ledger (audit FUL-12 · M16-FR-03 · M20-FR-04 · ADR-0025).
//
// The ledger never forgets (hard rule #2) and audit evidence is never deleted (hard rule #6) — so an erasure cannot take a
// customer's words out of the events that hold them. What it CAN do is make them unreadable: every personal-data field of
// a customer-linked event is written ENCRYPTED under a data key that belongs to one (tenant, subject, category), and an
// erasure DESTROYS that key. The event stays — its amounts, dates, ids and its place in the chain — but its personal
// text is ciphertext nobody holds the key to.
//
// Three pieces, all here:
//   • `SubjectKeyStore` — where the data keys live, OUTSIDE the ledger (a key must be destroyable; a ledger row is not).
//     The in-memory reference, and the SQL one over `subject_data_keys` + `subject_key_shreds` (db/migrations/0015).
//     The data keys are WRAPPED under a key-encryption key the process holds from configuration — never stored beside them.
//   • The SHREDDED-KEY LIST wins: a key whose (tenant, subject, category) is on the list is destroyed, whatever a restored
//     backup brought back — and is destroyed again on sight (`keysForRead`). `scripts/restore.mjs` re-applies the newest
//     list after a restore (ADR-0025 "Backups").
//   • `PersonalDataSealingStore` — an `EventStore` that seals the policy's fields on the way in and opens them on the way
//     out. Every adapter above it reads plaintext while the key exists; after the key is destroyed it reads a placeholder.
//     The raw `event_ledger` row only ever holds the sealed form.
//
// AES-256-GCM throughout (node's crypto). A sealed value carries its subject and category in the clear — both are already
// pseudonymous ids elsewhere in the same payload — and the ciphertext is bound to them (and the tenant) as associated
// data, so a sealed value moved to another subject does not open.

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import type { DomainEvent } from '../../contracts/src/event';
import type { EventStore, AppendResult, BatchEntry, AppendOptions, PersistedEvent, ReadOptions } from './event-store';
import type { SqlClient } from './sql-client';
import { scopedTo } from './sql-client';

// ── keys ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whose personal data, and which kind of it — the unit a key covers and an erasure destroys. */
export interface SubjectKeyRef {
  readonly subjectRef: string;
  readonly category: string;
}

/** One entry of the shredded-key list. No key material — only that it was destroyed, by which request, when. */
export interface KeyShred extends SubjectKeyRef {
  readonly tenantId: string;
  readonly requestId: string;
  readonly shreddedBy: string;
  readonly shreddedAt: string;
}

/** A key as a read finds it: usable, destroyed (on the shredded list), or simply not there (never created / lost). */
export type ReadKey = Buffer | 'shredded' | 'missing';

export interface SubjectKeyStore {
  /** The key to seal NEW personal data with — created on first use; `undefined` once the key is destroyed (prevent-restore). */
  keyForWrite(tenantId: string, ref: SubjectKeyRef): Promise<Buffer | undefined>;
  /** The keys to open sealed values with, by `refKey(ref)`. A key on the shredded list reads 'shredded' — and is destroyed again. */
  keysForRead(tenantId: string, refs: readonly SubjectKeyRef[]): Promise<ReadonlyMap<string, ReadKey>>;
  /** Destroy a key: put it on the shredded list and overwrite it. Idempotent — a second shred is a no-op that says so. */
  shred(tenantId: string, ref: SubjectKeyRef, by: { readonly requestId: string; readonly shreddedBy: string; readonly at: string }): Promise<{ readonly alreadyShredded: boolean }>;
  isShredded(tenantId: string, ref: SubjectKeyRef): Promise<boolean>;
  /** The tenant's shredded-key list, oldest first. */
  shreds(tenantId: string): Promise<readonly KeyShred[]>;
}

export const refKey = (ref: SubjectKeyRef): string => `${ref.subjectRef}\u0000${ref.category}`;

const KEK_LABEL = 'sre/personal-data-kek/v1';

/**
 * The key-encryption key: `PII_KEY_ENCRYPTION_KEY` when the deployment sets one (recommended — ADR-0025), otherwise derived
 * from the pack signing key under its own label (the same pattern as the loyalty member key), so an existing deployment
 * keeps working. Never stored in the database.
 */
export function personalDataKek(input: { readonly configured?: string; readonly packSigningKey: string }): Buffer {
  const source = input.configured ?? input.packSigningKey;
  if (source.length < 32) throw new RangeError('the personal-data key-encryption key needs at least 32 characters of secret');
  return createHmac('sha256', source).update(KEK_LABEL, 'utf8').digest();
}

const aadFor = (tenantId: string, ref: SubjectKeyRef): Buffer => Buffer.from(`${tenantId}|${ref.subjectRef}|${ref.category}`, 'utf8');

function gcmSeal(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

/** The in-memory reference key store (tests, and the shape every key store must have). */
export class InMemorySubjectKeyStore implements SubjectKeyStore {
  private readonly keys = new Map<string, Buffer | null>();
  private readonly list = new Map<string, KeyShred>();
  private k(tenantId: string, ref: SubjectKeyRef): string { return `${tenantId}\u0000${refKey(ref)}`; }

  keyForWrite(tenantId: string, ref: SubjectKeyRef): Promise<Buffer | undefined> {
    const k = this.k(tenantId, ref);
    if (this.list.has(k)) return Promise.resolve(undefined);
    const held = this.keys.get(k);
    if (held === null) return Promise.resolve(undefined);
    if (held !== undefined) return Promise.resolve(held);
    const fresh = randomBytes(32);
    this.keys.set(k, fresh);
    return Promise.resolve(fresh);
  }

  keysForRead(tenantId: string, refs: readonly SubjectKeyRef[]): Promise<ReadonlyMap<string, ReadKey>> {
    const out = new Map<string, ReadKey>();
    for (const ref of refs) {
      const k = this.k(tenantId, ref);
      const held = this.keys.get(k);
      if (this.list.has(k)) { if (held != null) this.keys.set(k, null); out.set(refKey(ref), 'shredded'); continue; }
      out.set(refKey(ref), held === null ? 'shredded' : held === undefined ? 'missing' : held);
    }
    return Promise.resolve(out);
  }

  shred(tenantId: string, ref: SubjectKeyRef, by: { readonly requestId: string; readonly shreddedBy: string; readonly at: string }): Promise<{ readonly alreadyShredded: boolean }> {
    const k = this.k(tenantId, ref);
    const already = this.list.has(k);
    if (!already) this.list.set(k, { tenantId, ...ref, requestId: by.requestId, shreddedBy: by.shreddedBy, shreddedAt: by.at });
    this.keys.set(k, null);
    return Promise.resolve({ alreadyShredded: already });
  }

  isShredded(tenantId: string, ref: SubjectKeyRef): Promise<boolean> { return Promise.resolve(this.list.has(this.k(tenantId, ref))); }

  shreds(tenantId: string): Promise<readonly KeyShred[]> {
    return Promise.resolve([...this.list.values()].filter((s) => s.tenantId === tenantId));
  }
}

/**
 * The SQL key store over `subject_data_keys` and `subject_key_shreds` (db/migrations/0015). Every statement runs on the
 * tenant's row-level-security scope. The data keys are wrapped under `kek`, bound to (tenant, subject, category).
 */
export class SqlSubjectKeyStore implements SubjectKeyStore {
  constructor(private readonly client: SqlClient, private readonly kek: Buffer) {
    if (kek.length !== 32) throw new RangeError('the key-encryption key must be 32 bytes');
  }

  async keyForWrite(tenantId: string, ref: SubjectKeyRef): Promise<Buffer | undefined> {
    const db = scopedTo(this.client, tenantId);
    if (await this.isShredded(tenantId, ref)) return undefined;
    const read = async (): Promise<{ wrapped: Buffer | null } | undefined> => {
      const rows = await db.query<{ wrapped_key: Buffer | null }>(
        'SELECT wrapped_key FROM subject_data_keys WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3',
        [tenantId, ref.subjectRef, ref.category],
      );
      return rows.length === 0 ? undefined : { wrapped: rows[0]!.wrapped_key };
    };
    let row = await read();
    if (row === undefined) {
      const fresh = randomBytes(32);
      await db.query(
        'INSERT INTO subject_data_keys (tenant_id, subject_ref, category, wrapped_key) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, subject_ref, category) DO NOTHING',
        [tenantId, ref.subjectRef, ref.category, gcmSeal(this.kek, fresh, aadFor(tenantId, ref))],
      );
      row = await read(); // a concurrent writer's key wins; both then seal under the same one
    }
    if (row === undefined || row.wrapped === null) return undefined;
    return gcmOpen(this.kek, Buffer.from(row.wrapped), aadFor(tenantId, ref));
  }

  async keysForRead(tenantId: string, refs: readonly SubjectKeyRef[]): Promise<ReadonlyMap<string, ReadKey>> {
    const out = new Map<string, ReadKey>();
    if (refs.length === 0) return out;
    const db = scopedTo(this.client, tenantId);
    const subjects = [...new Set(refs.map((r) => r.subjectRef))];
    const keyRows = await db.query<{ subject_ref: string; category: string; wrapped_key: Buffer | null }>(
      'SELECT subject_ref, category, wrapped_key FROM subject_data_keys WHERE tenant_id = $1 AND subject_ref = ANY($2::text[])',
      [tenantId, subjects],
    );
    const shredRows = await db.query<{ subject_ref: string; category: string }>(
      'SELECT subject_ref, category FROM subject_key_shreds WHERE tenant_id = $1 AND subject_ref = ANY($2::text[])',
      [tenantId, subjects],
    );
    const shredded = new Set(shredRows.map((r) => refKey({ subjectRef: r.subject_ref, category: r.category })));
    const held = new Map(keyRows.map((r) => [refKey({ subjectRef: r.subject_ref, category: r.category }), r.wrapped_key] as const));
    for (const ref of refs) {
      const k = refKey(ref);
      if (out.has(k)) continue;
      const wrapped = held.get(k);
      if (shredded.has(k)) {
        // The shredded-key list wins: a key a restored backup brought back is destroyed again, on sight.
        if (wrapped !== undefined && wrapped !== null) await this.destroy(tenantId, ref);
        out.set(k, 'shredded');
        continue;
      }
      out.set(k, wrapped === undefined ? 'missing' : wrapped === null ? 'shredded' : gcmOpen(this.kek, Buffer.from(wrapped), aadFor(tenantId, ref)));
    }
    return out;
  }

  private async destroy(tenantId: string, ref: SubjectKeyRef): Promise<void> {
    await scopedTo(this.client, tenantId).query(
      'UPDATE subject_data_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3 AND wrapped_key IS NOT NULL',
      [tenantId, ref.subjectRef, ref.category],
    );
  }

  async shred(tenantId: string, ref: SubjectKeyRef, by: { readonly requestId: string; readonly shreddedBy: string; readonly at: string }): Promise<{ readonly alreadyShredded: boolean }> {
    const db = scopedTo(this.client, tenantId);
    const run = async (tx: SqlClient): Promise<{ alreadyShredded: boolean }> => {
      const listed = await tx.query(
        `INSERT INTO subject_key_shreds (tenant_id, subject_ref, category, request_id, shredded_by, shredded_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, subject_ref, category) DO NOTHING RETURNING subject_ref`,
        [tenantId, ref.subjectRef, ref.category, by.requestId, by.shreddedBy, by.at],
      );
      await tx.query(
        'UPDATE subject_data_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3 AND wrapped_key IS NOT NULL',
        [tenantId, ref.subjectRef, ref.category],
      );
      return { alreadyShredded: listed.length === 0 };
    };
    // The list entry and the overwrite land together or not at all.
    return db.transaction ? db.transaction(run) : run(db);
  }

  async isShredded(tenantId: string, ref: SubjectKeyRef): Promise<boolean> {
    const rows = await scopedTo(this.client, tenantId).query(
      'SELECT 1 FROM subject_key_shreds WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3',
      [tenantId, ref.subjectRef, ref.category],
    );
    return rows.length > 0;
  }

  async shreds(tenantId: string): Promise<readonly KeyShred[]> {
    const rows = await scopedTo(this.client, tenantId).query<{ subject_ref: string; category: string; request_id: string; shredded_by: string; shredded_at: Date | string }>(
      'SELECT subject_ref, category, request_id, shredded_by, shredded_at FROM subject_key_shreds WHERE tenant_id = $1 ORDER BY shredded_at, subject_ref, category',
      [tenantId],
    );
    return rows.map((r) => ({
      tenantId, subjectRef: r.subject_ref, category: r.category, requestId: r.request_id, shreddedBy: r.shredded_by,
      shreddedAt: r.shredded_at instanceof Date ? r.shredded_at.toISOString() : new Date(r.shredded_at).toISOString(),
    }));
  }
}

// ── the policy and the sealing store ──────────────────────────────────────────────────────────────────────────────

/** What a reader sees where a destroyed key's value was. */
export const ERASED_TEXT = '[erased]';
/** What a reader sees where a key that should exist is not there (P-08: said, never guessed). */
export const KEY_MISSING_TEXT = '[personal data unavailable: its key is missing]';

/** A redaction marker carries no personal data and is never sealed (so a minimised record reads as minimised). */
const REDACTION_MARKER = /^\[removed under privacy request [^\]]*\]$/;

export interface SealedValue {
  readonly $pd: 'v1';
  /** Subject and category — pseudonymous ids, bound into the ciphertext as associated data. */
  readonly s: string;
  readonly c: string;
  /** base64 of IV ‖ tag ‖ ciphertext of the JSON value. */
  readonly d: string;
}

export const isSealed = (v: unknown): v is SealedValue =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['$pd'] === 'v1'
  && typeof (v as Record<string, unknown>)['s'] === 'string' && typeof (v as Record<string, unknown>)['c'] === 'string';

export interface PersonalFieldContext {
  readonly tenantId: string;
  /** The store UNDER the sealing layer — for a subject that has to be looked up (an order's customer). */
  readonly store: EventStore;
}

/** One rule: in events of a type, which fields are whose personal data, of which category. */
export interface PersonalFieldRule {
  readonly category: string;
  /** Path from the payload to the object(s) holding the fields; `'*'` walks every element of an array. Default: the payload. */
  readonly at?: readonly string[];
  readonly fields: readonly string[];
  /** Whose data — from the holding object (and the whole payload). Undefined → not linked to a person; left as written. */
  readonly subject: (holder: Readonly<Record<string, unknown>>, payload: Readonly<Record<string, unknown>>, ctx: PersonalFieldContext) => string | undefined | Promise<string | undefined>;
}

/** Event type → its personal-data rules. */
export type PersonalDataPolicy = Readonly<Record<string, readonly PersonalFieldRule[]>>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every object a rule's path reaches, with a setter so a copy can be rebuilt. */
function holdersOf(root: unknown, path: readonly string[]): Record<string, unknown>[] {
  let level: unknown[] = [root];
  for (const step of path) {
    const next: unknown[] = [];
    for (const node of level) {
      if (step === '*') { if (Array.isArray(node)) next.push(...node); } else if (isObj(node)) next.push(node[step]);
    }
    level = next;
  }
  return level.filter(isObj);
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/**
 * An `EventStore` that writes the policy's personal fields SEALED and reads them OPENED. Append-only and idempotent exactly
 * as the store beneath it; the guard, the order and the atomicity of a batch are the inner store's. Events of a type the
 * policy does not name pass straight through, untouched both ways.
 */
export class PersonalDataSealingStore implements EventStore {
  private readonly types: ReadonlySet<string>;

  constructor(readonly inner: EventStore, readonly keys: SubjectKeyStore, private readonly policy: PersonalDataPolicy) {
    this.types = new Set(Object.keys(policy));
  }

  private async sealPayload(tenantId: string, type: string, payload: unknown): Promise<unknown> {
    const rules = this.policy[type];
    if (rules === undefined || !isObj(payload)) return payload;
    const copy = clone(payload) as Record<string, unknown>;
    for (const rule of rules) {
      for (const holder of holdersOf(copy, rule.at ?? [])) {
        const subjectRef = await rule.subject(holder, copy, { tenantId, store: this.inner });
        if (subjectRef === undefined || subjectRef === '') continue;
        for (const field of rule.fields) {
          const value = holder[field];
          if (value === undefined || value === null || isSealed(value)) continue;
          if (typeof value === 'string' && (REDACTION_MARKER.test(value) || value === ERASED_TEXT)) continue;
          const ref = { subjectRef, category: rule.category };
          const key = await this.keys.keyForWrite(tenantId, ref);
          if (key === undefined) {
            // The key was destroyed: this person was erased. Their new personal text is not kept (prevent-restore).
            holder[field] = typeof value === 'string' ? ERASED_TEXT : null;
            continue;
          }
          const sealed: SealedValue = { $pd: 'v1', s: subjectRef, c: rule.category, d: gcmSeal(key, Buffer.from(JSON.stringify(value), 'utf8'), aadFor(tenantId, ref)).toString('base64') };
          holder[field] = sealed;
        }
      }
    }
    return copy;
  }

  private async open(records: readonly PersistedEvent[]): Promise<PersistedEvent[]> {
    const touched = records.filter((r) => this.types.has(r.event.type));
    if (touched.length === 0) return [...records];
    // One key read per tenant per call — every sealed value in the batch opens from it.
    const refsByTenant = new Map<string, SubjectKeyRef[]>();
    const collect = (tenantId: string, v: unknown): void => {
      if (isSealed(v)) { const l = refsByTenant.get(tenantId) ?? []; l.push({ subjectRef: v.s, category: v.c }); refsByTenant.set(tenantId, l); return; }
      if (Array.isArray(v)) { for (const x of v) collect(tenantId, x); return; }
      if (isObj(v)) for (const x of Object.values(v)) collect(tenantId, x);
    };
    for (const r of touched) collect(r.tenantId, r.event.payload);
    if (refsByTenant.size === 0) return [...records];
    const keysByTenant = new Map<string, ReadonlyMap<string, ReadKey>>();
    for (const [tenantId, refs] of refsByTenant) keysByTenant.set(tenantId, await this.keys.keysForRead(tenantId, refs));
    const openValue = (tenantId: string, v: unknown): unknown => {
      if (isSealed(v)) {
        const key = keysByTenant.get(tenantId)?.get(refKey({ subjectRef: v.s, category: v.c }));
        if (key === undefined || key === 'missing') return KEY_MISSING_TEXT;
        if (key === 'shredded') return ERASED_TEXT;
        try {
          return JSON.parse(gcmOpen(key, Buffer.from(v.d, 'base64'), aadFor(tenantId, { subjectRef: v.s, category: v.c })).toString('utf8')) as unknown;
        } catch { return KEY_MISSING_TEXT; }
      }
      if (Array.isArray(v)) return v.map((x) => openValue(tenantId, x));
      if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, openValue(tenantId, x)]));
      return v;
    };
    return records.map((r) => (this.types.has(r.event.type)
      ? Object.freeze({ ...r, event: { ...r.event, payload: openValue(r.tenantId, r.event.payload) } as DomainEvent })
      : r));
  }

  async append(tenantId: string, stream: string, event: DomainEvent): Promise<AppendResult> {
    return (await this.appendBatch(tenantId, [{ stream, event }]))[0]!;
  }

  async appendBatch(tenantId: string, entries: readonly BatchEntry[], options?: AppendOptions): Promise<readonly AppendResult[]> {
    const sealed: BatchEntry[] = [];
    for (const e of entries) {
      sealed.push(this.types.has(e.event.type)
        ? { stream: e.stream, event: { ...e.event, payload: await this.sealPayload(tenantId, e.event.type, e.event.payload) } as DomainEvent }
        : e);
    }
    const results = await this.inner.appendBatch(tenantId, sealed, options);
    const opened = await this.open(results.map((r) => r.record));
    return results.map((r, i) => ({ record: opened[i]!, deduped: r.deduped }));
  }

  guardVersion(tenantId: string, key: string): Promise<number> { return this.inner.guardVersion(tenantId, key); }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PersistedEvent | undefined> {
    const r = await this.inner.findByIdempotencyKey(tenantId, idempotencyKey);
    return r === undefined ? undefined : (await this.open([r]))[0];
  }

  async readStream(tenantId: string, stream: string, opts?: ReadOptions): Promise<readonly PersistedEvent[]> {
    return this.open(await this.inner.readStream(tenantId, stream, opts));
  }

  async latestOfType(tenantId: string, stream: string, type: string): Promise<PersistedEvent | undefined> {
    const r = await this.inner.latestOfType(tenantId, stream, type);
    return r === undefined ? undefined : (await this.open([r]))[0];
  }

  async exportTenant(tenantId: string): Promise<readonly PersistedEvent[]> {
    return this.open(await this.inner.exportTenant(tenantId));
  }

  registerTenant(tenantId: string, registeredBy: string): Promise<void> { return this.inner.registerTenant(tenantId, registeredBy); }
}
