import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Supplier statement, end to end through the real API (M24-FR-04, API-03). The closing balance is built
// from NAMED BUCKETS (invoices and debit notes owed, credit notes and payments off) and cross-checked a
// second way, so a line kind that was never categorised makes `reconciles` go false rather than
// vanishing quietly from a supplier's balance. A DISPUTED line is shown separately — neither owed nor
// written off, because folding it in is how a dispute quietly becomes a payment. And a login without the
// `view_statement` grant gets a PERMISSION answer (`accessible: false`), never a balance of zero, because
// "you owe nothing" and "you may not see this" are not the same sentence. Proves the wired statement.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const config = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, grants: string[], key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}`, userId, tenantId, idempotencyKey: key ?? `cfg-${partnerId}`, body: { grants } });
const setOpening = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, openingMinor: number) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/statement/opening`, userId, tenantId, idempotencyKey: `op-${partnerId}`, body: { openingMinor } });
const line = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, ref: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/statement/lines/${ref}`, userId, tenantId, idempotencyKey: key ?? `ln-${ref}`, body });
const statement = (h: ApiHarness, tenantId: string, userId: string, partnerId: string) =>
  h.request({ method: 'GET', path: `/v1/supplier-portal/partners/${partnerId}/statement`, userId, tenantId });

interface Stmt { accessible: boolean; openingMinor: number; invoicedMinor: number; debitedMinor: number; creditedMinor: number; paidMinor: number; closingMinor: number; disputedMinor: number; reconciles: boolean; lines: unknown[]; detail: string }

const WITH_STMT = ['submit_invoice', 'view_statement'];

describe('supplier statement: named buckets that reconcile, disputes apart, permission not zero (M24-FR-04)', () => {
  it('builds a closing balance from buckets that reconciles, with a disputed line shown separately', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, A, 'u-owner', 'SUP1', WITH_STMT);
    await setOpening(h, A, 'u-owner', 'SUP1', 100_000);
    await line(h, A, 'u-owner', 'SUP1', 'INV1', { kind: 'invoice', date: '2026-07-01', amountMinor: 500_000 });
    await line(h, A, 'u-owner', 'SUP1', 'INV2', { kind: 'invoice', date: '2026-07-05', amountMinor: 300_000 });
    await line(h, A, 'u-owner', 'SUP1', 'DN1', { kind: 'debit_note', date: '2026-07-06', amountMinor: 20_000 });
    await line(h, A, 'u-owner', 'SUP1', 'CN1', { kind: 'credit_note', date: '2026-07-07', amountMinor: -50_000 });
    await line(h, A, 'u-owner', 'SUP1', 'PAY1', { kind: 'payment', date: '2026-07-10', amountMinor: -200_000 });
    await line(h, A, 'u-owner', 'SUP1', 'INVD', { kind: 'invoice', date: '2026-07-11', amountMinor: 150_000, status: 'disputed' });

    const s = (await statement(h, A, 'u-owner', 'SUP1')).body as Stmt;
    expect(s.accessible).toBe(true);
    expect(s.invoicedMinor).toBe(800_000); // the disputed invoice is NOT counted here
    expect(s.debitedMinor).toBe(20_000);
    expect(s.creditedMinor).toBe(50_000);
    expect(s.paidMinor).toBe(200_000);
    // opening 100,000 + invoiced 800,000 + debited 20,000 - credited 50,000 - paid 200,000 = 670,000
    expect(s.closingMinor).toBe(670_000);
    expect(s.disputedMinor).toBe(150_000); // shown apart, never folded into the balance
    expect(s.reconciles).toBe(true);
    expect(s.lines).toHaveLength(6);
  });

  it('moves a line out of the balance and into disputed when its status changes', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, A, 'u-owner', 'SUP1', WITH_STMT);
    await line(h, A, 'u-owner', 'SUP1', 'INV1', { kind: 'invoice', date: '2026-07-01', amountMinor: 500_000 });
    expect(((await statement(h, A, 'u-owner', 'SUP1')).body as Stmt).closingMinor).toBe(500_000);

    // Same document ref, now disputed → it leaves the balance and appears as disputed (superseded).
    await line(h, A, 'u-owner', 'SUP1', 'INV1', { kind: 'invoice', date: '2026-07-01', amountMinor: 500_000, status: 'disputed' }, 'ln-INV1-disp');
    const s = (await statement(h, A, 'u-owner', 'SUP1')).body as Stmt;
    expect(s.closingMinor).toBe(0);
    expect(s.disputedMinor).toBe(500_000);
    expect(s.lines).toHaveLength(1); // the ref deduped, not doubled
  });

  it('answers a login without the statement grant with a permission answer, not a balance of zero', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, A, 'u-owner', 'SUP2', ['submit_invoice']); // no view_statement
    await setOpening(h, A, 'u-owner', 'SUP2', 100_000);
    await line(h, A, 'u-owner', 'SUP2', 'INV1', { kind: 'invoice', date: '2026-07-01', amountMinor: 500_000 });

    const s = (await statement(h, A, 'u-owner', 'SUP2')).body as Stmt;
    expect(s.accessible).toBe(false);
    expect(s.lines).toHaveLength(0);
    expect(s.detail).toContain('permission answer');
  });

  it('is authorized and per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not run supplier statements
    await config(h, A, 'u-owner', 'SUP1', WITH_STMT);

    expect((await statement(h, A, 'u-cash', 'SUP1')).status).toBe(403);
    expect((await line(h, A, 'u-cash', 'SUP1', 'X', { kind: 'invoice', date: '2026-07-01', amountMinor: 1 })).status).toBe(403);
    expect((await statement(h, A, 'u-owner', 'GHOST')).status).toBe(404);
    expect((await setOpening(h, A, 'u-owner', 'SUP1', 1.5)).status).toBe(400);
    expect((await line(h, A, 'u-owner', 'SUP1', 'BAD', { kind: 'nonsense', date: '2026-07-01', amountMinor: 1 })).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect((await statement(h, B, 'u-owner-b', 'SUP1')).status).toBe(404);
  });
});
