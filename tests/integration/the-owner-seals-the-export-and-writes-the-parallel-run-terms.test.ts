import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { CommandClient } from '../../packages/migration/src/load-command';
import { sealSlice, writeParallelPolicy, type OwnerPin, type PinVerdict } from '../../packages/migration/src/owner-steps-command';
import { runSliceCommand } from '../../packages/migration/src/slice-command';
import { sliceTemplateCsv } from '../../packages/migration/src/slice-import';

/**
 * Audit row 8 (lane B MG2 · MG10b) — the two owner steps that had no command, on the REAL API, in memory and on PostgreSQL,
 * with a cold restart: `seal` seals each exported slice file through the existing MG-02 seal route as the signed-in
 * person, and the slice command then verifies those seals at stage time; `parallel-policy` writes the MG-10 terms through
 * the existing route, and the run then accepts a day. Refusals: no verified backup restore of the old ERP (the route's own
 * MG-02 rule), a cashier writing the terms (403), a seal never replaced, the demo tenant and production refused before any
 * call. Both ask for the acting person's OWN till PIN, checked on this PC, before any call (OB-257): no PIN, a wrong one,
 * none issued, or a PC that cannot check, and no call is made — so no token of theirs is minted. Synthetic data only.
 */

const backings = r3OpsBackings();
const OWNER = 'u-owner';
const RECON = 'u-recon';
const CASHIER = 'u-cash';
const fp = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

/** The person's own PIN, typed and matching (the shell asks at the keyboard and checks the till's verifiers). */
const PIN_OK: OwnerPin = { askPin: async () => '246810', verifyPin: () => 'ok' };
const now = (): string => new Date().toISOString();

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
    const base = { files, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], fingerprint: fp, today: '2026-10-20', client: clientOf(() => h), pin: PIN_OK, now };

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
    const terms = { tenantId: T, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], cutoverId: 'CUT-1', reconcilerUserId: RECON, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-21', client, pin: PIN_OK, now };
    const missing = await writeParallelPolicy({ tenantId: T, targetKind: 'rehearsal', demoTenantIds: [], as: OWNER, client, pin: PIN_OK, now });
    expect(missing.exitCode).toBe(2);
    expect(missing.lines.join('\n')).toMatch(/Nothing is filled in for you: these are your decisions \(R-05\)\./);
    const cashier = await writeParallelPolicy({ ...terms, as: CASHIER });
    expect(cashier.exitCode).toBe(1);
    expect(cashier.lines.join('\n')).toMatch(/REFUSED — the policy was not recorded/);
    const written = await writeParallelPolicy({ ...terms, as: OWNER });
    expect(written.exitCode).toBe(0);
    expect(written.lines.slice(0, 2)).toEqual([`${OWNER}: type YOUR OWN till PIN now (six digits; nothing shows while you type). Only ${OWNER} types it.`, `  ${OWNER}'s PIN matches.`]);
    expect(written.lines[2]).toBe(`POLICY RECORDED — from 2026-10-21, ${RECON} reconciles every day; 3 clean day(s) in a row needed, at most 14 day(s). Set by ${OWNER} at ${written.lines[2]!.split(' at ').at(-1)}`);

    h = restart(h); // ── COLD RESTART ───────────────────────────────────────────────────────────────────────────

    // The run has its terms now: the named reconciler can record a day (it could not before the policy).
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/migration/parallel-run/days/2026-10-21', { comparisons: [{ area: 'sales_value', legacyValue: 100, newValue: 100, toleranceMinor: 0 }] }, RECON), 'record the first day');
  });

  it('the demo tenant and a production box are refused before any call is made', async () => {
    const calls: unknown[] = [];
    const client: CommandClient = { request: async (r) => { calls.push(r); return { status: 500, body: undefined }; } };
    const m = { loadId: 'd', tenantId: 'pilot-demo', operator: OWNER, storeId: 'S1', department: { categoryId: 'c', name: 'n' }, files: {} };
    const demo = await sealSlice({ manifest: m, files: { 'tax-classes.csv': 'h\n1\n' }, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], sealAs: OWNER, backupRestoredOn: '2026-10-19', client, fingerprint: fp, today: '2026-10-20', pin: PIN_OK, now });
    expect(demo.lines.join('\n')).toMatch(/REFUSED \(demo_tenant\)/);
    const prod = await writeParallelPolicy({ tenantId: randomUUID(), targetKind: 'production', demoTenantIds: [], as: OWNER, cutoverId: 'C', reconcilerUserId: RECON, requiredCleanDays: 1, maxParallelDays: 1, startedOn: '2026-10-21', client, pin: PIN_OK, now });
    expect(prod.lines.join('\n')).toMatch(/REFUSED \(production_target\)/);
    expect(calls).toEqual([]);
  });

  it('OB-257: no PIN, a wrong PIN, no PIN issued, or a PC that cannot check — refused in words, and no call is ever made', async () => {
    const calls: unknown[] = [];
    const client: CommandClient = { request: async (r) => { calls.push(r); return { status: 200, body: {} }; } };
    const asked: string[] = [];
    const pinSaying = (typed: string | undefined, verdict: PinVerdict): OwnerPin => ({ askPin: async (who) => { asked.push(who); return typed; }, verifyPin: () => verdict });
    const m = { loadId: 'd', tenantId: randomUUID(), operator: OWNER, storeId: 'S1', department: { categoryId: 'c', name: 'n' }, files: {} };
    const seal = (pin: OwnerPin) => sealSlice({ manifest: m, files: { 'tax-classes.csv': 'h\n1\n' }, targetKind: 'rehearsal', demoTenantIds: [], sealAs: OWNER, backupRestoredOn: '2026-10-19', client, fingerprint: fp, today: '2026-10-20', pin, now });
    const policy = (pin: OwnerPin) => writeParallelPolicy({ tenantId: randomUUID(), targetKind: 'rehearsal', demoTenantIds: [], as: OWNER, cutoverId: 'C', reconcilerUserId: RECON, requiredCleanDays: 1, maxParallelDays: 1, startedOn: '2026-10-21', client, pin, now });
    for (const run of [seal, policy]) {
      const none = await run(pinSaying(undefined, 'ok'));
      expect([none.exitCode, none.lines.at(-1)]).toEqual([1, `NOT DONE — no PIN was typed for ${OWNER}. Nothing was done.`]);
      const wrong = await run(pinSaying('111111', 'wrong'));
      expect([wrong.exitCode, wrong.lines.at(-1)]).toEqual([1, `REFUSED — that is not ${OWNER}'s till PIN. Nothing was done.`]);
      const notIssued = await run(pinSaying('111111', 'no_pin_issued'));
      expect(notIssued.exitCode).toBe(1);
      expect(notIssued.lines.at(-1)).toMatch(/has no till PIN on this computer\. Make one first, with u-owner there: pnpm run till:pin -- --user u-owner/);
      const cannot = await run(pinSaying('111111', 'cannot_check'));
      expect(cannot.exitCode).toBe(2);
      expect(cannot.lines.at(-1)).toMatch(/this PC cannot check till PINs yet/);
    }
    // The PIN was asked of the acting person every time, and nothing reached the API: no token was ever needed.
    expect(asked).toEqual(Array(8).fill(OWNER));
    expect(calls).toEqual([]);
    // With the PIN, each call carries WHEN it matched — the token's step-up time the shell stamps.
    await seal(PIN_OK);
    expect(calls).toHaveLength(1);
    expect(typeof (calls[0] as { signedInAt?: unknown }).signedInAt).toBe('string');
  });
});
