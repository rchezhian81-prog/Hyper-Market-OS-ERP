// Durable sync outbox (P-01 / §31 / hard rule #6) — the persistent backing for the
// store-edge → cloud sync queue. A locally-committed event is enqueued; the sync
// agent drains pending rows and acknowledges each; an item that repeatedly fails to
// apply moves to a VISIBLE dead-letter state and is NEVER dropped. This mirrors the
// in-memory `SyncOutbox` (packages/sync) but async and multi-tenant. Depends only on
// the `SqlClient` port; testable without a live database.

import type { DomainEvent } from '../../contracts/src/event';
import type { SqlClient, SqlRow } from './sql-client';

export type OutboxState = 'pending' | 'acknowledged' | 'dead_letter';

const STATE = Object.freeze({
  pending: 'pending' as OutboxState,
  acknowledged: 'acknowledged' as OutboxState,
  deadLetter: 'dead_letter' as OutboxState,
});

export interface OutboxRecord {
  readonly tenantId: string;
  /** The event's idempotency key — the dedupe identity in the outbox. */
  readonly key: string;
  readonly event: DomainEvent;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly reason: string | null;
}

/** The durable, tenant-scoped sync outbox. */
export interface OutboxStore {
  /** Enqueue a locally-committed event; idempotent on its idempotency key. */
  enqueue(tenantId: string, event: DomainEvent): Promise<OutboxRecord>;
  /** Items awaiting sync for a tenant, in enqueue order. */
  pending(tenantId: string): Promise<readonly OutboxRecord[]>;
  /** Mark an item successfully synced (advance the watermark). Idempotent. */
  acknowledge(tenantId: string, key: string): Promise<void>;
  /** Record a failed sync attempt; auto-dead-letters after `maxAttempts`. */
  recordFailure(tenantId: string, key: string, reason: string, maxAttempts?: number): Promise<OutboxRecord | undefined>;
  /** Force a poison item to the dead-letter queue — never dropped (hard rule #6). */
  deadLetter(tenantId: string, key: string, reason: string): Promise<void>;
  /** The visible dead-letter queue for a tenant. */
  deadLetters(tenantId: string): Promise<readonly OutboxRecord[]>;
  find(tenantId: string, key: string): Promise<OutboxRecord | undefined>;
}

function composite(tenantId: string, key: string): string {
  return `${tenantId} ${key}`;
}

/** In-memory reference implementation — the behavioural contract, tenant-scoped. */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, OutboxRecord>();

  enqueue(tenantId: string, event: DomainEvent): Promise<OutboxRecord> {
    const id = composite(tenantId, event.idempotencyKey);
    const existing = this.items.get(id);
    if (existing) {
      return Promise.resolve(existing);
    }
    const record: OutboxRecord = Object.freeze({
      tenantId,
      key: event.idempotencyKey,
      event,
      state: STATE.pending,
      attempts: 0,
      reason: null,
    });
    this.items.set(id, record);
    return Promise.resolve(record);
  }

  pending(tenantId: string): Promise<readonly OutboxRecord[]> {
    return Promise.resolve(
      [...this.items.values()].filter((i) => i.tenantId === tenantId && i.state === STATE.pending),
    );
  }

  acknowledge(tenantId: string, key: string): Promise<void> {
    const id = composite(tenantId, key);
    const item = this.items.get(id);
    if (item && item.state === STATE.pending) {
      this.items.set(id, Object.freeze({ ...item, state: STATE.acknowledged }));
    }
    return Promise.resolve();
  }

  recordFailure(tenantId: string, key: string, reason: string, maxAttempts = 5): Promise<OutboxRecord | undefined> {
    const id = composite(tenantId, key);
    const item = this.items.get(id);
    if (!item || item.state !== STATE.pending) {
      return Promise.resolve(item);
    }
    const attempts = item.attempts + 1;
    const next: OutboxRecord = Object.freeze({
      ...item,
      attempts,
      reason,
      state: attempts >= maxAttempts ? STATE.deadLetter : STATE.pending,
    });
    this.items.set(id, next);
    return Promise.resolve(next);
  }

  deadLetter(tenantId: string, key: string, reason: string): Promise<void> {
    const id = composite(tenantId, key);
    const item = this.items.get(id);
    if (item) {
      this.items.set(id, Object.freeze({ ...item, state: STATE.deadLetter, reason }));
    }
    return Promise.resolve();
  }

  deadLetters(tenantId: string): Promise<readonly OutboxRecord[]> {
    return Promise.resolve(
      [...this.items.values()].filter((i) => i.tenantId === tenantId && i.state === STATE.deadLetter),
    );
  }

  find(tenantId: string, key: string): Promise<OutboxRecord | undefined> {
    return Promise.resolve(this.items.get(composite(tenantId, key)));
  }
}

const COLUMNS = 'tenant_id, idem_key, event, state, attempts, reason';

function rowToOutbox(row: SqlRow): OutboxRecord {
  const reason = row['reason'];
  return Object.freeze({
    tenantId: String(row['tenant_id']),
    key: String(row['idem_key']),
    event: row['event'] as DomainEvent,
    state: String(row['state']) as OutboxState,
    attempts: Number(row['attempts']),
    reason: reason === null || reason === undefined ? null : String(reason),
  });
}

/**
 * SQL-backed sync outbox over the `sync_outbox` table (migration 0002), via the
 * `SqlClient` port. Enqueue is an idempotent upsert; state advances (acknowledge /
 * failure / dead-letter) are updates that bind the target state as a parameter (never
 * a SQL literal). Poison items land in the visible dead-letter queue, never removed.
 */
export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly client: SqlClient) {}

  async enqueue(tenantId: string, event: DomainEvent): Promise<OutboxRecord> {
    const inserted = await this.client.query(
      `INSERT INTO sync_outbox (tenant_id, idem_key, event, state, attempts)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (tenant_id, idem_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [tenantId, event.idempotencyKey, JSON.stringify(event), STATE.pending],
    );
    if (inserted.length > 0) {
      return rowToOutbox(inserted[0]!);
    }
    const existing = await this.find(tenantId, event.idempotencyKey);
    if (existing === undefined) {
      throw new Error(`Enqueue for "${event.idempotencyKey}" conflicted but no row was found.`);
    }
    return existing;
  }

  async pending(tenantId: string): Promise<readonly OutboxRecord[]> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM sync_outbox WHERE tenant_id = $1 AND state = $2 ORDER BY created_at ASC`,
      [tenantId, STATE.pending],
    );
    return rows.map(rowToOutbox);
  }

  async acknowledge(tenantId: string, key: string): Promise<void> {
    await this.client.query(
      `UPDATE sync_outbox SET state = $1, updated_at = now()
       WHERE tenant_id = $2 AND idem_key = $3 AND state = $4`,
      [STATE.acknowledged, tenantId, key, STATE.pending],
    );
  }

  async recordFailure(
    tenantId: string,
    key: string,
    reason: string,
    maxAttempts = 5,
  ): Promise<OutboxRecord | undefined> {
    const rows = await this.client.query(
      `UPDATE sync_outbox
       SET attempts = attempts + 1,
           state = CASE WHEN attempts + 1 >= $1 THEN $2 ELSE state END,
           reason = $3,
           updated_at = now()
       WHERE tenant_id = $4 AND idem_key = $5 AND state = $6
       RETURNING ${COLUMNS}`,
      [maxAttempts, STATE.deadLetter, reason, tenantId, key, STATE.pending],
    );
    return rows.length > 0 ? rowToOutbox(rows[0]!) : this.find(tenantId, key);
  }

  async deadLetter(tenantId: string, key: string, reason: string): Promise<void> {
    await this.client.query(
      `UPDATE sync_outbox SET state = $1, reason = $2, updated_at = now()
       WHERE tenant_id = $3 AND idem_key = $4`,
      [STATE.deadLetter, reason, tenantId, key],
    );
  }

  async deadLetters(tenantId: string): Promise<readonly OutboxRecord[]> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM sync_outbox WHERE tenant_id = $1 AND state = $2`,
      [tenantId, STATE.deadLetter],
    );
    return rows.map(rowToOutbox);
  }

  async find(tenantId: string, key: string): Promise<OutboxRecord | undefined> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM sync_outbox WHERE tenant_id = $1 AND idem_key = $2`,
      [tenantId, key],
    );
    return rows.length > 0 ? rowToOutbox(rows[0]!) : undefined;
  }
}
