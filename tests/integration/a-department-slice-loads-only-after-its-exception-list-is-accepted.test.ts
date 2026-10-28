import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { aStoreWithRules } from '../support/store-rules';
import { sealExtract, simpleHasher, type SealedExtract } from '../../packages/migration/src/index';
import { runSliceCommand, type SliceCommandInput } from '../../packages/migration/src/slice-command';
import { SLICE_TEMPLATES, type SliceFile } from '../../packages/migration/src/slice-import';

/**
 * **OB-241 — the first real-data load is ONE department, from four template files, row by row, and nothing is applied
 * until a named person accepts the exception list (MG-05 · MG-06 · §34.1 · §28 · hard rule #7).**
 *
 * Through the operator's command (`runSliceCommand`, what `pnpm run migration:slice` runs) against the real API, on the
 * in-memory store AND on real PostgreSQL, with a cold restart between staging and applying:
 *
 *   stage   good rows staged, bad rows quarantined with their reasons; the LOAD RECORD is kept under the signed-in
 *           operator — a body that names an operator is refused;
 *   apply   refused while nobody has accepted the list — the catalogue stays empty (no partial load, ever);
 *   accept  a named person in their own session; "ok" is refused; a different list cannot be accepted;
 *   apply   (after a cold restart) loads ONLY the staged rows, records what landed — and the operator, read from the
 *           record, then cannot sign the slice's control total; a different person can.
 * And it refuses a production box and the demo tenant before reading a row. Synthetic data only.
 */

const backings = r3OpsBackings();
const OPERATOR = 'u-loader';
const ACCEPTOR = 'u-owner';
const CASHIER = 'u-cash';
const STORE = 'S1';
const LOAD = 'slice-staples-1';
const FOOD = 'none,India,1 kg,Synthetic Packers Pvt Ltd Chennai,Care desk 1800-000-0000';

const FILES: Record<SliceFile, string> = {
  'tax-classes.csv': ['hsn_code,effective_from,rate_percent', '1006,2017-07-01,5', '0713,2017-07-01,0'].join('\n'),
  'products.csv': [
    SLICE_TEMPLATES['products.csv'].columns.join(','),
    `R-001,,Synthetic rice 1kg,each,staples,1006,,active,${FOOD},,,`,
    `R-002,,Synthetic dal 1kg,each,staples,0713,,active,${FOOD},,,`,
    `R-003,,Synthetic oil 1L,each,oils,1006,,active,${FOOD},,,`,
    `R-004,,Synthetic sugar 1kg,each,staples,1006,,active,,India,1 kg,Synthetic Packers,Care desk 1800-000-0000,,,`,
  ].join('\n'),
  'prices.csv': ['item_code,mrp,selling_price,cost_price,margin_floor_percent', 'R-001,60.00,55.00,48.00,', 'R-002,140.00,130.00,120.00,', 'R-003,200.00,190.00,170.00,'].join('\n'),
  'barcodes.csv': ['item_code,barcode,kind', 'R-001,8900000000012,', 'R-002,8900000000029,', 'R-003,8900000000036,'].join('\n'),
};
const rows = (text: string): number => text.split('\n').slice(1).filter((l) => l.trim() !== '').length;
const seal = (t: string, name: string, text: string): SealedExtract => {
  const r = sealExtract({ extractId: `x-${name}`, tenantId: t, sourceId: 'legacy-erp', material: text, rowCount: rows(text), extractedBy: OPERATOR, backupVerifiedAt: '2026-10-18T20:00:00.000Z', hasher: simpleHasher, now: '2026-10-18T21:00:00.000Z' });
  if (!r.ok || r.extract === undefined) throw new Error(r.detail);
  return r.extract;
};
const manifest = (t: string, files: Record<string, string> = FILES) => ({
  loadId: LOAD, tenantId: t, operator: OPERATOR, storeId: STORE,
  department: { categoryId: 'staples', name: 'Staples', regulated: ['food', 'packed'] },
  files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { seal: seal(t, name, text), declaredRows: rows(text) }])),
});
const command = (h: ApiHarness, t: string, over: Partial<SliceCommandInput> = {}): SliceCommandInput => ({
  mode: 'stage', manifest: manifest(t), files: FILES, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], client: h, ...over,
});

describe.each(backings)('a department slice loads only after its exception list is accepted — on $name (OB-241)', ({ harness, restart }) => {
  it('stage → refused apply → named acceptance → cold restart → apply loads the staged rows only; the operator cannot sign', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, ACCEPTOR);
    await aStoreWithRules(h, T, ACCEPTOR, STORE, 0);
    await h.provisionRole(T, OPERATOR, 'owner'); // the operator holds the catalogue, price and receiving authority a load needs
    await h.provisionRole(T, CASHIER, 'cashier');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    const { req, ok, code } = tenantClient(() => h, T);
    // The cleaning register exists (MG-04) and holds nothing blocking.
    await ok(req('POST', '/v1/migration/exceptions', { exceptions: [{ exceptionId: 'EX-1', kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name' }] }, OPERATOR), 'cleaning register');

    // ── stage ────────────────────────────────────────────────────────────────────────────────────────────
    const staged = await runSliceCommand(command(h, T));
    expect(staged.exitCode, staged.lines.join('\n')).toBe(0);
    const text = staged.lines.join('\n');
    expect(text).toMatch(/products.csv: 4 row\(s\) read, 2 staged, 2 quarantined/);
    expect(text).toMatch(/R-003\): category "oils" is not the pilot department/);
    expect(text).toMatch(/RECORDED — load slice-staples-1 is staged on the cloud by u-loader/);
    expect(staged.exceptionsCsv).toMatch(/prices.csv,4,R-003,item_code,depends_on_a_quarantined_row/);
    const view = (await ok(req('GET', `/v1/migration/loads/${LOAD}`, undefined, ACCEPTOR), 'read the load')).body as { record: { operator: string; sliceDigest: string; exceptions: unknown[] }; acceptance?: unknown };
    expect(view.record.operator).toBe(OPERATOR); // from the session, never the manifest's word
    expect(view.record.exceptions).toHaveLength(staged.staged!.exceptions.length);
    expect(view.acceptance).toBeUndefined();
    expect((await req('GET', `/v1/migration/loads/${LOAD}`, undefined, CASHIER)).status).toBe(403);

    // The load record refuses to be told who the operator is, refuses a second operator, and refuses a cashier.
    expect(code(await req('POST', '/v1/migration/loads/other', { operator: 'u-somebody', sliceDigest: 'd', department: { categoryId: 'staples', name: 'S' }, counts: {}, exceptions: [] }, OPERATOR))).toBe('load_operator_is_read_from_the_session');
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}`, { sliceDigest: 'another', department: { categoryId: 'staples', name: 'S' }, counts: {}, exceptions: [] }, ACCEPTOR))).toBe('load_has_another_operator');
    expect((await req('POST', '/v1/migration/loads/x', { sliceDigest: 'd', department: { categoryId: 'staples', name: 'S' }, counts: {}, exceptions: [] }, CASHIER)).status).toBe(403);

    // ── apply before acceptance: refused, nothing sent ───────────────────────────────────────────────────
    const early = await runSliceCommand(command(h, T, { mode: 'apply' }));
    expect(early.exitCode).toBe(1);
    expect(early.lines.join('\n')).toMatch(/REFUSED \(not_accepted\).*a partial load is never applied silently/);
    expect(((await ok(req('GET', '/v1/catalogue/products', undefined, OPERATOR), 'catalogue')).body as { products: unknown[] }).products).toEqual([]);
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}/applied`, { sliceDigest: view.record.sliceDigest, landed: {}, failedSteps: 0 }, OPERATOR))).toBe('exception_list_not_accepted');

    // ── accept: by name, in words, over THIS list ────────────────────────────────────────────────────────
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}/exception-list/acceptance`, { sliceDigest: view.record.sliceDigest, statement: 'ok' }, ACCEPTOR))).toBe('acceptance_explains_nothing');
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}/exception-list/acceptance`, { sliceDigest: 'not-this-one', statement: 'read every row of the exception list' }, ACCEPTOR))).toBe('exception_list_changed');
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}/exception-list/acceptance`, { sliceDigest: view.record.sliceDigest, statement: 'read every row of the exception list', acceptedBy: 'u-x' }, ACCEPTOR))).toBe('not_readable_as_an_acceptance');
    expect((await req('POST', `/v1/migration/loads/${LOAD}/exception-list/acceptance`, { sliceDigest: view.record.sliceDigest, statement: 'read every row of the exception list' }, CASHIER)).status).toBe(403);
    const accepted = await runSliceCommand(command(h, T, { mode: 'accept', acceptAs: ACCEPTOR, statement: 'read every quarantined row: the oil is another department and the sugar has no allergen declaration yet' }));
    expect(accepted.exitCode, accepted.lines.join('\n')).toBe(0);
    expect(accepted.lines.join('\n')).toMatch(/ACCEPTED — u-owner accepted 4 quarantined row\(s\)/);

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────

    // A file changed after staging: refused, even though the earlier list was accepted.
    const tampered = { ...FILES, 'prices.csv': FILES['prices.csv'].replace('55.00', '54.00') };
    const changed = await runSliceCommand(command(h, T, { mode: 'apply', files: tampered, manifest: manifest(T, tampered) }));
    expect(changed.exitCode).toBe(1);
    expect(changed.lines.join('\n')).toMatch(/they changed after staging/);

    // ── apply: the staged rows only ──────────────────────────────────────────────────────────────────────
    const applied = await runSliceCommand(command(h, T, { mode: 'apply' }));
    expect(applied.exitCode, applied.lines.join('\n')).toBe(0);
    expect(applied.lines.join('\n')).toMatch(/Operator from the load record: u-loader/);
    expect(applied.lines.join('\n')).toMatch(/APPLIED — every staged row landed; 4 quarantined row\(s\) stayed behind, accepted by u-owner/);
    const products = ((await ok(req('GET', '/v1/catalogue/products', undefined, OPERATOR), 'catalogue')).body as { products: { productId: string }[] }).products.map((p) => p.productId).sort();
    expect(products).toEqual(['R-001', 'R-002']);
    const after = (await ok(req('GET', `/v1/migration/loads/${LOAD}`, undefined, ACCEPTOR), 'read the load')).body as { applied?: { appliedBy: string; acceptedBy: string; landed: Record<string, number> } };
    expect(after.applied).toMatchObject({ appliedBy: OPERATOR, acceptedBy: ACCEPTOR, landed: { product: 2, barcode: 2, price: 2 } });
    // Only the operator may say it was applied.
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}/applied`, { sliceDigest: view.record.sliceDigest, landed: {}, failedSteps: 0 }, ACCEPTOR))).toBe('not_the_load_operator');
    // An applied load is not re-staged with other contents.
    expect(code(await req('POST', `/v1/migration/loads/${LOAD}`, { sliceDigest: 'new', department: { categoryId: 'staples', name: 'S' }, counts: {}, exceptions: [] }, OPERATOR))).toBe('load_already_applied');

    // ── MG-06: the operator, read from the stored record, cannot sign the slice's total; somebody else can ─────
    await ok(req('POST', '/v1/migration/control-totals', { totals: [{ totalId: 'CT-PRODUCTS', kind: 'stock', name: 'Staples products', unit: 'quantity', legacyValue: 2, loadedValue: 2, legacyDerivation: 'rows staged from the old export', loadedDerivation: 'products read back from the catalogue' }] }, OPERATOR), 'record total');
    expect(code(await req('POST', '/v1/migration/control-totals/CT-PRODUCTS/signature', { statement: 'two products, both read back by me' }, OPERATOR))).toBe('signer_ran_the_load');
    await ok(req('POST', '/v1/migration/control-totals/CT-PRODUCTS/signature', { statement: 'counted the two staples items against the old export' }, ACCEPTOR), 'a different person signs');
  });

  it('refuses a production box and the demo tenant before a row is read — in every mode', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    for (const mode of ['stage', 'accept', 'apply'] as const) {
      const prod = await runSliceCommand(command(h, T, { mode, targetKind: 'production', acceptAs: ACCEPTOR, statement: 'read every row of the list' }));
      expect(prod.exitCode).toBe(1);
      expect(prod.stage).toBe('target');
      expect(prod.lines.join('\n')).toMatch(/REFUSED \(production_target\)/);
      const demo = await runSliceCommand(command(h, T, { mode, manifest: { ...manifest(T), tenantId: 'pilot-demo' }, acceptAs: ACCEPTOR, statement: 'read every row of the list' }));
      expect(demo.exitCode).toBe(1);
      expect(demo.lines.join('\n')).toMatch(/REFUSED \(demo_tenant\)/);
      const unknown = await runSliceCommand(command(h, T, { mode, targetKind: 'prod' }));
      expect(unknown.lines.join('\n')).toMatch(/not one of rehearsal, staging, local, production/);
    }
    // And the API itself, on a production box, refuses every load route before anything else (hard rule #7).
    const prodApi = apiHarness({ migrationTargetKind: 'production' });
    await prodApi.seedOwner(T, ACCEPTOR);
    for (const [method, path, body] of [
      ['POST', `/v1/migration/loads/${LOAD}`, { sliceDigest: 'd', department: { categoryId: 'staples', name: 'S' }, counts: {}, exceptions: [] }],
      ['POST', `/v1/migration/loads/${LOAD}/exception-list/acceptance`, { sliceDigest: 'd', statement: 'read every row of the list' }],
      ['POST', `/v1/migration/loads/${LOAD}/applied`, { sliceDigest: 'd', landed: {}, failedSteps: 0 }],
      ['GET', `/v1/migration/loads/${LOAD}`, undefined],
    ] as const) {
      const r = await prodApi.request({ method, path, userId: ACCEPTOR, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `p-${path}`, body } : {}) });
      expect(r.status, path).toBe(403);
      expect((r.body as { error?: { code?: string } }).error?.code).toBe('target_is_production');
    }
  });
});
