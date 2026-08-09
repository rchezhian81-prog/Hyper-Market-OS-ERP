#!/usr/bin/env node
// Runnable audit-chain verifier (audit FND-02 / GAP-SEC-03, M34-FR-01).
//
// Reads every audit_log row from the PostgreSQL database named by DATABASE_URL and checks that each
// tenant's SHA-256 hash chain is intact — that no row was inserted, removed, reordered or edited
// behind the database. It reuses the SAME `verifyAuditChain` the kernel's sink seals with
// (services/kernel/src/audit-chain.ts), so the verifier cannot drift from the writer.
//
// Exit code is the point: 0 when every chain is intact, 1 when any is broken (so CI, a cron, or an
// auditor's terminal gets a machine-checkable answer, not just text). Rows written before the FND-02
// migration have no seal (hash IS NULL) and are reported as an unsealed prefix, not a failure.
//
// Usage:  set DATABASE_URL, then `pnpm verify:audit`. Reads only from the environment (hard rule #4).

import { verifyAuditChain, type ChainedAuditRow } from '../services/kernel/src/audit-chain.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — cannot verify the audit chain.');
    process.exit(1);
  }

  // Load node-postgres at runtime so the rest of the repo never depends on it.
  const pg = await import('pg');
  const { Pool } = (pg.default ?? pg) as typeof import('pg');
  const pool = new Pool({ connectionString: url });

  try {
    const { rows } = await pool.query(
      `SELECT seq, tenant_id, user_id, method, path, status, permission, trace_id,
              idempotency_key, recorded_at, prev_hash, hash
         FROM audit_log
        ORDER BY seq ASC`,
    );

    const sealed: ChainedAuditRow[] = [];
    let unsealed = 0;
    for (const r of rows) {
      if (r.hash === null || r.prev_hash === null) { unsealed += 1; continue; }
      sealed.push({
        sequence: Number(r.seq),
        tenantId: r.tenant_id,
        userId: r.user_id,
        method: r.method,
        path: r.path,
        status: Number(r.status),
        permission: r.permission,
        traceId: r.trace_id,
        idempotencyKey: r.idempotency_key ?? null,
        // recorded_at comes back as a Date; the seal was computed over its ISO form.
        recordedAt: new Date(r.recorded_at).toISOString(),
        prevHash: r.prev_hash,
        hash: r.hash,
      });
    }

    const result = verifyAuditChain(sealed);
    if (unsealed > 0) {
      console.log(`Note: ${unsealed} unsealed legacy row(s) (written before the FND-02 migration) were skipped.`);
    }

    if (result.intact) {
      console.log(`OK — audit chain intact: ${result.recordsChecked} record(s) across ${result.tenantsChecked} tenant(s).`);
      process.exit(0);
    }

    console.error(`TAMPER DETECTED — ${result.findings.length} break(s) across ${result.tenantsChecked} tenant(s):`);
    for (const f of result.findings) {
      console.error(`  tenant ${f.tenantId}, seq ${f.sequence}: ${f.reason} — ${f.detail}`);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
