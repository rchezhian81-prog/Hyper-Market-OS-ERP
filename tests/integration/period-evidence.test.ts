import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Period-close evidence pack & control-total validation, end to end (M23-FR-04 / QG-07, API-09). A period is
// signed on TWO figures agreeing that were reached two DIFFERENT ways — the book of record vs an independent
// second source (the bank statement, the filed return, the counted shelf), which the caller supplies. The
// tested engine compares them exactly, and the evidence pack is the thing the CA SIGNS: it states both sides
// of every figure so the signature is on something re-derivable. A pack that does not reconcile is still
// produced but marked NOT signable, with the reason on the page. Pure reads, gated finance.period.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const CUTOFF = '2026-06-01T00:00:00Z';

const reconcilingTotals = [
  { name: 'Sales', ledgerMinor: 100000, postedMinor: 100000, method: 'sales ledger vs bank credits' },
  { name: 'GST output', ledgerMinor: 18000, postedMinor: 18000, method: 'GST ledger vs filed GSTR-1' },
];
const mismatchedTotals = [
  reconcilingTotals[0]!,
  { name: 'GST output', ledgerMinor: 18000, postedMinor: 17000, method: 'GST ledger vs filed GSTR-1' }, // 1000 short
];

const controlTotals = (h: ApiHarness, u: string, totals: unknown, key = 'ct-1') =>
  h.request({ method: 'POST', path: '/v1/finance/periods/2026-06/control-totals', userId: u, tenantId: A, idempotencyKey: key, body: { totals } });
const evidencePack = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'ep-1') =>
  h.request({ method: 'POST', path: '/v1/finance/periods/2026-06/evidence-pack', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                   // finance.period.read
  await h.provisionRole(A, 'u-book', 'accountant');  // finance.period.read
  await h.provisionRole(A, 'u-cash', 'cashier');     // no finance.period.read
  return h;
}

describe('period-close evidence pack & control totals: the CA signs something re-derivable (M23-FR-04)', () => {
  it('reconciles each control total two-sidedly and flags the one that does not', async () => {
    const h = await cast();
    const res = await controlTotals(h, 'u-book', mismatchedTotals);
    expect(res.status).toBe(200);
    const body = res.body as { results: { name: string; differenceMinor: number; reconciles: boolean }[]; allReconcile: boolean };
    expect(body.allReconcile).toBe(false);
    expect(body.results.find((r) => r.name === 'Sales')).toMatchObject({ reconciles: true, differenceMinor: 0 });
    expect(body.results.find((r) => r.name === 'GST output')).toMatchObject({ reconciles: false, differenceMinor: -1000 });
  });

  it('produces a SIGNABLE pack when every total reconciles and nothing is dead-lettered', async () => {
    const h = await cast();
    const res = await evidencePack(h, 'u-owner', { totals: reconcilingTotals, tradingDayCutoff: CUTOFF });
    expect(res.status).toBe(200);
    const pack = res.body as { signable: boolean; reconciles: boolean; verdict: string; preparedBy: string; tradingDayCutoff: string };
    expect(pack).toMatchObject({ signable: true, reconciles: true, preparedBy: 'u-owner', tradingDayCutoff: CUTOFF });
    expect(pack.verdict).toContain('signable');
  });

  it('still produces a pack that does NOT reconcile, but marks it not signable with the reason', async () => {
    const h = await cast();
    const res = await evidencePack(h, 'u-owner', { totals: mismatchedTotals, tradingDayCutoff: CUTOFF }, 'ep-2');
    const pack = res.body as { signable: boolean; verdict: string; statement: string[] };
    expect(pack.signable).toBe(false);
    expect(pack.verdict).toContain('NOT signable');
    expect(pack.statement.some((line) => line.includes('Do not sign'))).toBe(true);

    // A reconciling set with a dead-lettered posting is also not signable — the posting is named, never dropped.
    const withDead = await evidencePack(h, 'u-owner', { totals: reconcilingTotals, tradingDayCutoff: CUTOFF, deadLetteredCount: 2 }, 'ep-3');
    const dp = withDead.body as { signable: boolean; statement: string[] };
    expect(dp.signable).toBe(false);
    expect(dp.statement.some((line) => line.includes('dead-letter'))).toBe(true);
  });

  it('rejects malformed totals / a missing cut-off (400) and gates on finance.period.read', async () => {
    const h = await cast();
    expect(codeOf(await controlTotals(h, 'u-owner', 'nope', 'ct-bad'))).toBe('not_readable_as_control_totals');

    const noCutoff = await evidencePack(h, 'u-owner', { totals: reconcilingTotals }, 'ep-nocut');
    expect(noCutoff.status).toBe(400);
    expect(codeOf(noCutoff)).toBe('evidence_pack_needs_a_cutoff');

    // A cashier has no finance.period.read → refused on both.
    expect((await controlTotals(h, 'u-cash', reconcilingTotals, 'ct-cash')).status).toBe(403);
    expect((await evidencePack(h, 'u-cash', { totals: reconcilingTotals, tradingDayCutoff: CUTOFF }, 'ep-cash')).status).toBe(403);
  });
});
