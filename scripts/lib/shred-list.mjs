// The shredded-key list across a backup and a restore (audit FUL-12 · ADR-0025 "Backups").
//
// An erasure destroys a customer's data key (crypto-shredding). A backup taken BEFORE that erasure still holds the key —
// restoring it naively would bring the person's personal text back. So the shredded-key list must WIN over any restored
// key:
//   • every backup's manifest carries the full list as it stood at that backup's moment (`shredListOf`), so the newest
//     backup always carries every shred before it;
//   • a restore re-applies the NEWEST list it can find — the live database if it is still reachable, and/or the manifest
//     of a newer backup — on top of what it restored (`reapplyShredList`): each entry goes back on the list, and its key,
//     if the restored backup held one, is overwritten;
//   • and at run time the API destroys on sight any key whose entry is on the list (packages/persistence/src/personal-data.ts).
// The list holds no key material and no personal data — a subject's pseudonymous id, a category, the request, when.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const PLATFORM_OPTIONS = '-c app.tenant_id=*';

/** The shredded-key list as `client` sees it (inside whatever transaction it holds); empty when the table is not there yet. */
export async function shredListOf(client) {
  const exists = (await client.query("SELECT to_regclass('public.subject_key_shreds') IS NOT NULL AS ok")).rows[0].ok;
  if (!exists) return [];
  const rows = (await client.query(
    'SELECT tenant_id::text AS "tenantId", subject_ref AS "subjectRef", category, request_id AS "requestId", shredded_by AS "shreddedBy", shredded_at AS "shreddedAt" FROM subject_key_shreds ORDER BY shredded_at, tenant_id, subject_ref, category',
  )).rows;
  return rows.map((r) => ({ ...r, shreddedAt: new Date(r.shreddedAt).toISOString() }));
}

/** Read a shredded-key list from a source: a PostgreSQL URL (the live database) or a backup manifest's path. */
export async function readShredList(source) {
  if (/^postgres(ql)?:\/\//.test(source)) {
    const client = new pg.Client({ connectionString: source, options: PLATFORM_OPTIONS });
    await client.connect();
    try { return await shredListOf(client); } finally { await client.end(); }
  }
  const manifest = JSON.parse(readFileSync(source, 'utf8'));
  return Array.isArray(manifest.shredList) ? manifest.shredList : [];
}

/** The union of several lists, one entry per (tenant, subject, category) — the earliest shred kept. */
export function unionOf(...lists) {
  const by = new Map();
  for (const list of lists) {
    for (const e of list) {
      const k = `${e.tenantId}\u0000${e.subjectRef}\u0000${e.category}`;
      const held = by.get(k);
      if (held === undefined || e.shreddedAt < held.shreddedAt) by.set(k, e);
    }
  }
  return [...by.values()];
}

/**
 * Put every entry back on `targetUrl`'s list and overwrite any key the restore brought back for it. Append-only on the
 * list (an entry already there is left as it is); the key overwrite is the one change `subject_data_keys` allows.
 * Returns how many entries were added and how many restored keys were destroyed again.
 */
export async function reapplyShredList({ targetUrl, entries }) {
  const client = new pg.Client({ connectionString: targetUrl, options: PLATFORM_OPTIONS });
  await client.connect();
  let added = 0;
  let destroyed = 0;
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const ins = await client.query(
        `INSERT INTO subject_key_shreds (tenant_id, subject_ref, category, request_id, shredded_by, shredded_at)
         SELECT $1::uuid, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM tenants WHERE tenant_id = $1::uuid)
         ON CONFLICT (tenant_id, subject_ref, category) DO NOTHING`,
        [e.tenantId, e.subjectRef, e.category, e.requestId, e.shreddedBy, e.shreddedAt],
      );
      added += ins.rowCount ?? 0;
      const upd = await client.query(
        'UPDATE subject_data_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1::uuid AND subject_ref = $2 AND category = $3 AND wrapped_key IS NOT NULL',
        [e.tenantId, e.subjectRef, e.category],
      );
      destroyed += upd.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return { added, destroyed };
}
