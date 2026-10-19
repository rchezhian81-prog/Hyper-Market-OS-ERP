import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runSliceCommand } from '../../packages/migration/src/slice-command';
import { sliceApplyGate, stageSlice } from '../../packages/migration/src/slice-import';
import { compareParallelDay, ownDifference, type ComparisonArea, type DayComparison } from '../../packages/migration/src/cutover';
import { signParallelDay } from '../../packages/migration/src/parallel-day-sign';
import { loadOperatorFor } from '../../services/migration/src/load-records';
import type { MigrationDeps } from '../../services/migration/src/index';

/**
 * Guardrails for the cutover-readiness tools (OB-239 · OB-242: the written Option 2 GO comes only after these hold).
 *
 *   1. The slice loader refuses a production box and the demo tenant — in every mode, before a row is read.
 *   2. No partial load is applied without an ACCEPTED exception list: the gate is shut for every acceptance that is not
 *      a named person's over exactly this list, and the command reaches the loader only through that gate.
 *   3. The operator and the signer differ: "who ran the load" is read from the stored, signed-in load record — no route
 *      takes it from a request body, and the signature routes ask the load record, not a typed name.
 *   4. A parallel-run day with an unexplained material difference cannot be signed — for every area, every sign of
 *      difference, and every way of "explaining" that explains nothing.
 * Synthetic data only.
 */

const read = (p: string): string => readFileSync(p, 'utf8');

describe('1 · the slice loader refuses a demo or production target', () => {
  it('production, an unreadable kind and the demo tenant are refused in stage, accept and apply — with nothing read or sent', async () => {
    const calls: string[] = [];
    const client = { request: async (r: { path: string }) => { calls.push(r.path); return { status: 200, body: {} }; } };
    const manifest = (tenantId: string) => ({ loadId: 'g-1', tenantId, operator: 'u-op', storeId: 'S1', department: { categoryId: 'staples', name: 'Staples' }, files: {} });
    for (const mode of ['stage', 'accept', 'apply'] as const) {
      for (const [targetKind, tenant, refusal] of [
        ['production', 'ab000000-0000-4000-8000-000000000001', /production_target/],
        ['PRODUCTION ', 'ab000000-0000-4000-8000-000000000001', /not one of/],
        ['rehearsal', 'pilot-demo', /demo_tenant/],
        ['rehearsal', 'ab000000-0000-4000-8000-0000000000de', /demo_tenant/],
      ] as const) {
        const out = await runSliceCommand({ mode, manifest: manifest(tenant), files: { 'products.csv': 'x' }, targetKind, demoTenantIds: ['pilot-demo', 'ab000000-0000-4000-8000-0000000000de'], client, acceptAs: 'u-x', statement: 'read every line of the list' });
        expect(out.exitCode, `${mode} ${targetKind} ${tenant}`).toBe(1);
        expect(out.lines.join('\n')).toMatch(refusal);
        expect(out.staged).toBeUndefined();
      }
    }
    expect(calls).toEqual([]);
  });

  it('the command script reads MIGRATION_TARGET_KIND and the demo tenants from the box, never a default of its own', () => {
    const script = read('scripts/migration-slice.ts');
    expect(script).toMatch(/targetKind: env\['MIGRATION_TARGET_KIND'\]/);
    expect(script).toMatch(/demoTenantIds: demoTenantIds\(env, flags\['demo-tenant'\]\)/);
  });
});

describe('2 · no partial load is applied without an accepted exception list', () => {
  const tax = 'hsn_code,effective_from,rate_percent\n1006,2017-07-01,5';
  const products = 'item_code,description,uom,category,hsn_code\nR-1,Synthetic rice,each,staples,1006\nR-2,Synthetic oil,each,oils,1006';
  const prices = 'item_code,mrp,selling_price,cost_price\nR-1,60.00,55.00,48.00';
  const s = stageSlice({ department: { categoryId: 'staples', name: 'Staples' }, files: { 'tax-classes.csv': tax, 'products.csv': products, 'prices.csv': prices } });

  it('the gate is shut for every acceptance that is not a named person over exactly this list', () => {
    expect(s.exceptions.length).toBeGreaterThan(0); // a partial slice
    const good = { sliceDigest: s.digest, acceptedBy: 'u-owner', acceptedAt: '2026-10-19T10:00:00.000Z', statement: 'read every row', quarantined: s.exceptions.length };
    for (const bad of [undefined, { ...good, acceptedBy: '' }, { ...good, acceptedBy: '   ' }, { ...good, sliceDigest: '' }, { ...good, sliceDigest: `${s.digest}x` }]) {
      expect(sliceApplyGate(s, bad).open).toBe(false);
    }
    expect(sliceApplyGate(s, good).open).toBe(true);
  });

  it('in the command, the loader is reached only after the gate opened; the acceptance is read from the cloud, never from a file', () => {
    const src = read('packages/migration/src/slice-command.ts');
    const gate = src.indexOf('sliceApplyGate(staged, view.acceptance)');
    const refuse = src.indexOf('if (!gate.open)');
    const load = src.indexOf('executeLoad(client, plan)');
    expect(gate).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(gate);
    expect(load).toBeGreaterThan(refuse);
    expect(src.match(/executeLoad\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/readFileSync|acceptance\.json/);
  });

  it('on the cloud, "applied" is refused over an unaccepted or changed list', () => {
    const src = read('services/migration/src/load-records.ts');
    expect(src).toMatch(/view\.record\.sliceDigest !== b\['sliceDigest'\] \|\| view\.acceptance === undefined/);
  });
});

describe('3 · the operator and the signer differ — the operator is read from the stored load record', () => {
  it('no load route takes the operator, and no acceptance or signature takes its person, from the body', () => {
    const records = read('services/migration/src/load-records.ts');
    expect(records).toMatch(/b\['operator'\] !== undefined \|\| b\['operatorId'\] !== undefined \|\| b\['recordedBy'\] !== undefined/);
    expect(records).toMatch(/operator: ctx\.userId/);
    expect(records).toMatch(/acceptedBy: ctx\.userId/);
    expect(records).toMatch(/b\['acceptedBy'\] !== undefined/);
    const days = read('services/migration/src/parallel-day-routes.ts');
    expect(days).toMatch(/b\['signedBy'\] !== undefined/);
  });

  it('both control-total signature routes ask the load record; neither compares the signer with a typed extraction operator', () => {
    const decisions = read('services/migration/src/decisions.ts');
    expect(decisions.match(/loadOperatorFor\(deps, ctx\.tenantId, /g)).toHaveLength(2);
    expect(decisions).not.toMatch(/const loadOperator = await deps\.extractionOperator/);
    const legacy = read('services/migration/src/index.ts');
    expect(legacy).toMatch(/deps\.loadRecords\(ctx\.tenantId\)\)\.map\(\(r\) => r\.operator\)/);
  });

  it('when load records are kept, they are the ONLY answer: a typed extraction operator never stands in', async () => {
    const deps = {
      loadRecords: () => [],
      extractionOperator: () => 'u-typed-by-somebody',
    } as unknown as MigrationDeps;
    expect(await loadOperatorFor(deps, 't', 'u-signer')).toBeUndefined();
    const withRecord = { ...deps, loadRecords: () => [{ loadId: 'l', operator: 'u-loader', recordedAt: '2026-10-19T10:00:00.000Z' }] } as unknown as MigrationDeps;
    expect(await loadOperatorFor(withRecord, 't', 'u-signer')).toBe('u-loader');
    expect(await loadOperatorFor(withRecord, 't', 'u-loader')).toBe('u-loader'); // the signer IS the loader → the engine refuses
  });

  it('the full-extract loader keeps the same load record before it sends anything', () => {
    const src = read('packages/migration/src/load-command.ts');
    const record = src.indexOf('`/v1/migration/loads/${encodeURIComponent(manifest.loadId)}`');
    expect(record).toBeGreaterThan(0);
    expect(src.indexOf('executeLoad(input.client!, plan)')).toBeGreaterThan(record);
  });

  it('the composition root wires the load records, so the fallback is never live', () => {
    expect(read('services/api/src/adapters.ts')).toMatch(/loadRecords: \(tenantId\) => allOf<LoadRecord>/);
  });
});

describe('4 · a parallel-run day with an unexplained material difference cannot be signed', () => {
  const AREAS: readonly ComparisonArea[] = ['sales_value', 'sales_count', 'stock_movement', 'tax', 'payments', 'loyalty'];
  const nonReasons = [undefined, '', '   ', 'ok', 'fine', 'noted', 'checked', 'the new system is probably right', 'took the newer figure'];

  it('every area, both signs, every tolerance it exceeds, every non-reason — refused, and the refusal names the difference', () => {
    for (const area of AREAS) {
      for (const delta of [1, -1, 999_999]) {
        for (const tolerance of [0, Math.abs(delta) - 1].filter((t) => t >= 0)) {
          const comparisons: DayComparison[] = [{ area, legacyValue: 1_000_000, newValue: 1_000_000 + delta, toleranceMinor: tolerance }];
          const raised = compareParallelDay({ tenantId: 't', businessDate: '2026-10-10', comparisons }).differences;
          expect(raised).toHaveLength(1);
          for (const why of nonReasons) {
            const owned = ownDifference({ differences: raised, differenceId: raised[0]!.differenceId, ownerUserId: 'u-recon', ...(why === undefined ? {} : { explanation: why }) });
            const differences = owned.ok ? owned.differences : raised;
            const r = signParallelDay({ businessDate: '2026-10-10', comparisons, differences, signedBy: 'u-recon', statement: 'compared both day-end reports area by area', now: '2026-10-11T08:00:00.000Z', reconcilerUserId: 'u-recon', ownerUserId: 'u-owner' });
            expect(r.ok, `${area} ${delta} ${tolerance} "${why}"`).toBe(false);
            if (!r.ok) {
              expect(r.refusedBecause).toBe('unexplained_material_difference');
              expect(r.detail).toContain(raised[0]!.differenceId);
            }
          }
        }
      }
    }
  });

  it('the screen, the desk and the relayed route all sign through the same engine', () => {
    expect(read('apps/web-erp/src/migration-session.ts')).toMatch(/signParallelDay\(/);
    expect(read('services/migration/src/parallel-day-routes.ts').match(/signParallelDay\(/g)).toHaveLength(1); // one judge, shared by both routes
    expect(read('services/migration/src/parallel-day-routes.ts').match(/judgeSignature\(/g)).toHaveLength(2); // the desk route and the relayed route
  });
});
