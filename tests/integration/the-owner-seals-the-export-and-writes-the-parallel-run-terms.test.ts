import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { CommandClient } from '../../packages/migration/src/load-command';
import { sealSlice, writeParallelPolicy } from '../../packages/migration/src/owner-steps-command';
import { runSliceCommand } from '../../packages/migration/src/slice-command';
import { sliceTemplateCsv } from '../../packages/migration/src/slice-import';

/**
 * Audit row 8 (lane B MG2 · MG10b) — the two owner steps that had no command, on the REAL API, in memory and on PostgreSQL,
 * with a cold restart: `seal` seals each exported slice file through the existing MG-02 seal route as the signed-in
 * person, and the slice command then verifies those seals at stage time; `parallel-policy` writes the MG-10 terms through
 * the existing route, and the run then accepts a day. Refusals: no verified backup restore of the old ERP (the route's own
 * MG-02 rule), a cashier writing the terms (403), a seal never replaced, the demo tenant and production refused before any
 * call. Synthetic data only.
 */

const backings = r3OpsBackings();
const OWNER = 'u-owner';
const RECON = 'u-recon';
const CASHIER = 'u-cash';
const fp = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

function clientOf(get: () => ApiHarness): CommandClient {
  return { request: async (r) => get().request({ method: r.method, path: r.path, userId: r.userId, tenantId: r.tenantId, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }), ...(r.query === undefined ? {} : { query: r.query }) }) };
}

describe.each(backings)('the owner seals the export and writes the parallel-run terms — on $name (audit row 8)', ({ harness, restart }) => {
  it('seal: every file sealed by the route, as the person; a seal never replaced; the slice then verifies them; no verified backup is refused', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    const manifest = { loadId: 'dept-1', tenantId: T, operator: OWNER, storeId: 'S1', department: { categoryId: 'cat-ambient', name: 'Ambient grocery' }, files: {} };
    const header = sliceTemplateCsv('tax-classes.csv').split(/\r?\n/)[0]!;
    const files = { 'tax-classes.csv': `${header}\nGST5,5\nGST12,12\n` };
    const base = { files, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], fingerprint: fp, today: '2026-10-20', client: clientOf(() => h) };

    // MG-02's own rule, from the route: no verified restore of the old ERP's backup, no seal.
    const refused = await sealSlice({ ...base, manifest, sealAs: OWNER, backupRestoredOn: 'not-a-date' });
    expect(refused.exitCode).toBe(2);
    const sealed = await sealSlice({ ...base, manifest, sealAs: OWNER, backupRestoredOn: '2026-10-19' });
    expect(sealed.lines.join('\n')).toMatch(/^SEALED — tax-classes\.csv: 2 row\(s\), digest [0-9a-f]+, by u-owner at /m);
    expect(sealed.exitCode).toBe(0);
    const withSeals = sealed.manifest!;
    expect(withSeals.files['tax-classes.csv']!.seal).toMatchObject({ extractId: 'dept-1-tax-classes', tenantId: T, sourceId: 'old-erp', rowCount: 2, extractedBy: OWNER, backupVerifiedAt: '2026-10-19', sealed: true });

    h = restart(h); // ── COLD RESTART ───────────────────────────────────────────────────────────────────────────

    // A second run keeps the seal (never replaced), and the slice command verifies it against the file.
    const again = await sealSlice({ ...base, manifest: withSeals, sealAs: OWNER, backupRestoredOn: '2026-10-19' });
    expect(again.lines.join('\n')).toMatch(/^kept — tax-classes\.csv is already sealed/m);
    expect(again.manifest).toBeUndefined();
    const staged = await runSliceCommand({ mode: 'stage', manifest: withSeals, files, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], hasher: sha });
    expect(staged.lines.join('\n')).toMatch(/Seal verified — tax-classes\.csv: 2 row\(s\)\./);
    // A file changed after sealing is caught at stage time.
    const changed = await runSliceCommand({ mode: 'stage', manifest: withSeals, files: { 'tax-classes.csv': `${files['tax-classes.csv']}GST18,18\n` }, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], hasher: sha });
    expect(changed.lines.join('\n')).toMatch(/SEAL BROKEN — tax-classes\.csv/);
  });

  it('parallel-policy: the owner writes the terms through the route; a cashier is refused (403); nothing is defaulted; a day then records', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, RECON, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const client = clientOf(() => h);
    const terms = { tenantId: T, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], cutoverId: 'CUT-1', reconcilerUserId: RECON, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-21', client };
    const missing = await writeParallelPolicy({ tenantId: T, targetKind: 'rehearsal', demoTenantIds: [], as: OWNER, client });
    expect(missing.exitCode).toBe(2);
    expect(missing.lines.join('\n')).toMatch(/Nothing is filled in for you: these are your decisions \(R-05\)\./);
    const cashier = await writeParallelPolicy({ ...terms, as: CASHIER });
    expect(cashier.exitCode).toBe(1);
    expect(cashier.lines.join('\n')).toMatch(/REFUSED — the policy was not recorded/);
    const written = await writeParallelPolicy({ ...terms, as: OWNER });
    expect(written.exitCode).toBe(0);
    expect(written.lines[0]).toBe(`POLICY RECORDED — from 2026-10-21, ${RECON} reconciles every day; 3 clean day(s) in a row needed, at most 14 day(s). Set by ${OWNER} at ${written.lines[0]!.split(' at ').at(-1)}`);

    h = restart(h); // ── COLD RESTART ───────────────────────────────────────────────────────────────────────────

    // The run has its terms now: the named reconciler can record a day (it could not before the policy).
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/migration/parallel-run/days/2026-10-21', { comparisons: [{ area: 'sales_value', legacyValue: 100, newValue: 100, toleranceMinor: 0 }] }, RECON), 'record the first day');
  });

  it('the demo tenant and a production box are refused before any call is made', async () => {
    const calls: unknown[] = [];
    const client: CommandClient = { request: async (r) => { calls.push(r); return { status: 500, body: undefined }; } };
    const m = { loadId: 'd', tenantId: 'pilot-demo', operator: OWNER, storeId: 'S1', department: { categoryId: 'c', name: 'n' }, files: {} };
    const demo = await sealSlice({ manifest: m, files: { 'tax-classes.csv': 'h\n1\n' }, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], sealAs: OWNER, backupRestoredOn: '2026-10-19', client, fingerprint: fp, today: '2026-10-20' });
    expect(demo.lines.join('\n')).toMatch(/REFUSED \(demo_tenant\)/);
    const prod = await writeParallelPolicy({ tenantId: randomUUID(), targetKind: 'production', demoTenantIds: [], as: OWNER, cutoverId: 'C', reconcilerUserId: RECON, requiredCleanDays: 1, maxParallelDays: 1, startedOn: '2026-10-21', client });
    expect(prod.lines.join('\n')).toMatch(/REFUSED \(production_target\)/);
    expect(calls).toEqual([]);
  });
});
