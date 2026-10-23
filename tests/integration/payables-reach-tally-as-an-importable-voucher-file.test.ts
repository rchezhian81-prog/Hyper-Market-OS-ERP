import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { validateTallyImport } from '../../packages/tally-export/src/index';

// WF-05 "… approval → AP/Tally" · M23-FR-04 (OB-288 P3): the payables journals the posting run put on our ledger come out as
// ONE Tally import file — a voucher per journal keyed by our entry id, in the accountant's own ledger names — checked by a
// stand-in for Tally's import before it is offered. A journal touching an account the accountant has not named is kept out
// and listed by name. Synthetic data; the real proof is the accountant's own Tally import (AVR-09). In memory and — with
// DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const MAP = DEFAULT_RETAIL_POSTING_MAP; // includes the payables rules

interface Export { empty: boolean; complete: boolean; xml: string; vouchers: { entryId: string }[]; exceptions: { entryId: string; reason: string; accountCodes?: string[] }[]; controlTotals: { voucherCount: number; debitMinor: number; creditMinor: number }; check: { ok: boolean; problems: string[] } }

describe.each(backings)('payables to Tally (WF-05 · M23-FR-04) — on $name', ({ harness }) => {
  it('posted payables → the accountant names the Tally ledgers → one importable voucher file that the stand-in accepts; a restart gives the same file', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const [id, qty] of [['a', 10], ['b', 4]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines);
    }
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map', body: MAP })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/finance/payables/post', P3.MATCHER, {})).status).toBe(201);
    const payables = (await call('GET', '/v1/finance/payables', P3.MATCHER)).body as { journals: { entryId: string; period: string; lines: { accountCode: string }[] }[] };
    expect(payables.journals.length).toBe(2);
    const period = payables.journals[0]!.period;
    const codes = [...new Set(payables.journals.flatMap((j) => j.lines.map((l) => l.accountCode)))].sort();

    const ap = (q: Record<string, string> = { period }) => h.request({ method: 'GET', path: '/v1/finance/tally/ap-vouchers', userId: P3.MATCHER, tenantId: T, query: q });
    expect(codeOf(await ap())).toBe('tally_ledgers_not_named');
    expect(codeOf(await ap({}))).toBe('period_required');
    expect((await h.request({ method: 'GET', path: '/v1/finance/tally/ap-vouchers', userId: P3.CASHIER, tenantId: T, query: { period } })).status).toBe(403);
    expect((await call('POST', '/v1/finance/tally/ledger-names', P3.BUYER, { companyName: 'SRE', names: { x: 'y' } })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/finance/tally/ledger-names', P3.MATCHER, { companyName: 'SRE', names: {} }))).toBe('not_readable_as_tally_ledger_names');

    // Half-mapped: the vouchers are kept OUT and named, and the export says it is incomplete.
    await call('POST', '/v1/finance/tally/ledger-names', P3.MATCHER, { companyName: 'SRE Hyper Market (synthetic)', names: { [codes[0]!]: 'First ledger' } });
    const half = (await ap()).body as Export;
    expect(half.complete).toBe(false);
    expect(half.vouchers).toEqual([]);
    expect(half.exceptions.map((e) => e.reason)).toEqual(['ledger_not_mapped', 'ledger_not_mapped']);

    // Fully mapped: one voucher per journal, balanced, accepted by the stand-in, totals as claimed.
    await call('POST', '/v1/finance/tally/ledger-names', P3.MATCHER, { companyName: 'SRE Hyper Market (synthetic)', names: Object.fromEntries(codes.map((c) => [c, `Tally ${c}`])) });
    const full = (await ap()).body as Export;
    expect(full.complete).toBe(true);
    expect(full.vouchers.map((v) => v.entryId).sort()).toEqual(payables.journals.map((j) => j.entryId).sort());
    expect(full.check).toEqual({ ok: true, problems: [], totals: full.controlTotals });
    expect(full.controlTotals.debitMinor).toBe(full.controlTotals.creditMinor);
    expect(full.controlTotals.debitMinor).toBe(70_000);
    expect(validateTallyImport(full.xml, full.controlTotals).ok).toBe(true);

    // Another month has nothing: said as such, never an empty "file of the month".
    expect((await ap({ period: '2020-01' })).body).toMatchObject({ empty: true });
    // A cold restart gives the very same file (the same vouchers, the same REMOTEIDs — a re-import is the same vouchers).
    const again = (await harness(h).request({ method: 'GET', path: '/v1/finance/tally/ap-vouchers', userId: P3.MATCHER, tenantId: T, query: { period } })).body as Export;
    expect(again.xml).toBe(full.xml);
  }, 120_000);
});
