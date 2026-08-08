import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Connector mapping validation, end to end through the real API (M32-FR-02 mapping half, API-11). What
// makes integrations rot is that failures become INVISIBLE: a mapping that drops an unrecognised field
// looks like a clean run, right up until a tax code has not reached the accounts package for a quarter.
// So a mapping is VALIDATED before a live feed trusts it — an unmapped source field is an exception, not
// a silently dropped field; a lookup miss is refused rather than mapped to blank (an unknown ledger code
// mapped to nothing posts a wrong journal); and a destination-required field the mapping produced
// nothing for is named. Proves the wired validation surface against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const RULES = [
  { kind: 'copy', from: 'amount', to: 'Amount' },
  { kind: 'constant', to: 'Type', value: 'Journal' },
  { kind: 'lookup', from: 'taxCode', to: 'LedgerCode', table: { GST18: 'L-GST-18', GST5: 'L-GST-5' } },
];

const register = (h: ApiHarness, tenantId: string, userId: string, connectorId: string, version: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/integration/connectors/${connectorId}/mappings/${version}`, userId, tenantId, idempotencyKey: `cm-${connectorId}-${version}`, body });
const validate = (h: ApiHarness, tenantId: string, userId: string, connectorId: string, version: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/integration/connectors/${connectorId}/mappings/${version}/validate`, userId, tenantId, idempotencyKey: key ?? `cv-${connectorId}-${version}`, body });
const readMapping = (h: ApiHarness, tenantId: string, userId: string, connectorId: string, version: string) =>
  h.request({ method: 'GET', path: `/v1/integration/connectors/${connectorId}/mappings/${version}`, userId, tenantId });

interface Result { mapped: boolean; outcome: string; output: Record<string, unknown>; unmapped: string[]; detail: string }

describe('connector mapping validation: a dropped field is an exception, not a clean run (M32-FR-02)', () => {
  it('maps a clean record, and refuses an unmapped field unless it is ignored', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await register(h, A, 'u-owner', 'tally', 'v1', { rules: RULES, required: ['Amount', 'LedgerCode'] });

    const ok = (await validate(h, A, 'u-owner', 'tally', 'v1', { source: { amount: 1_000, taxCode: 'GST18' } }, 'cv-ok')).body as Result;
    expect(ok.mapped).toBe(true);
    expect(ok.outcome).toBe('mapped');
    expect(ok.output).toMatchObject({ Amount: 1_000, Type: 'Journal', LedgerCode: 'L-GST-18' });

    // A source field no rule accounts for is NAMED, not dropped — this is how a cess line vanishes.
    const extra = (await validate(h, A, 'u-owner', 'tally', 'v1', { source: { amount: 1_000, taxCode: 'GST18', cess: 50 } }, 'cv-extra')).body as Result;
    expect(extra.mapped).toBe(false);
    expect(extra.outcome).toBe('unmapped_fields');
    expect(extra.unmapped).toContain('cess');

    // Ignoring it is a NAMED decision — then it maps clean.
    const ignored = (await validate(h, A, 'u-owner', 'tally', 'v1', { source: { amount: 1_000, taxCode: 'GST18', cess: 50 }, ignore: ['cess'] }, 'cv-ign')).body as Result;
    expect(ignored.mapped).toBe(true);
  });

  it('refuses a lookup miss and a missing required field', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await register(h, A, 'u-owner', 'tally', 'v1', { rules: RULES, required: ['Amount', 'LedgerCode'] });

    // An unknown tax code has no ledger — refused rather than mapped to blank (a wrong journal that posts).
    const miss = (await validate(h, A, 'u-owner', 'tally', 'v1', { source: { amount: 1_000, taxCode: 'GST99' } }, 'cv-miss')).body as Result;
    expect(miss.outcome).toBe('lookup_miss');
    expect(miss.detail).toContain('GST99');

    // No amount → the destination-required Amount is produced by nothing, and is named.
    const missing = (await validate(h, A, 'u-owner', 'tally', 'v1', { source: { taxCode: 'GST18' } }, 'cv-req')).body as Result;
    expect(missing.outcome).toBe('missing_required');
    expect(missing.detail).toContain('Amount');
  });

  it('is authorized (owner configures, manager reads) and per-tenant, and refuses malformed/unknown', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // reads a mapping, does not configure one
    await h.provisionRole(A, 'u-cash', 'cashier');
    await register(h, A, 'u-owner', 'tally', 'v1', { rules: RULES, required: ['Amount'] });

    expect((await register(h, A, 'u-cash', 'x', 'v1', { rules: RULES, required: [] })).status).toBe(403);
    expect((await register(h, A, 'u-mgr', 'y', 'v1', { rules: RULES, required: [] })).status).toBe(403);
    expect((await readMapping(h, A, 'u-mgr', 'tally', 'v1')).status).toBe(200); // a manager may read
    // A rule that is not exactly copy/constant/lookup is refused.
    expect((await register(h, A, 'u-owner', 'bad', 'v1', { rules: [{ kind: 'transmute', from: 'a', to: 'b' }], required: [] })).status).toBe(400);
    // Validating against a mapping that was never registered.
    expect((await validate(h, A, 'u-owner', 'ghost', 'v9', { source: { a: 1 } })).status).toBe(404);
    // A validation with no source object.
    expect((await validate(h, A, 'u-owner', 'tally', 'v1', { source: 'not-an-object' }, 'cv-bad')).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect((await readMapping(h, B, 'u-owner-b', 'tally', 'v1')).status).toBe(404);
  });
});
