import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, askForApproval, decide } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { SupplierRecord } from '../../services/purchase/src/supplier-master';

/**
 * **WF-02 — supplier onboarding, application → documents → bank → approval, in ONE run on the real API (M06-FR-01 · §28 ·
 * ADR-0024 · hard rules #2 #4), in memory and — with DATABASE_URL — on real PostgreSQL.**
 *
 *   1. APPLICATION: a purchase user proposes the supplier (name, GSTIN, terms); it is `proposed`, awaiting approval;
 *   2. DOCUMENTS: the GST registration and the FSSAI licence are added, each verified by the person who sends it, under
 *      their own sign-in (a verifier typed for somebody else is refused); the earlier version stays on the record;
 *   3. BANK: the account is changed only through head office's maker-checker — the owner asks, a different person with the
 *      authority approves in their own session; the supplier's own creator cannot approve its bank; a change sent with
 *      no approval is refused; the account is then on the record as verified by the approver;
 *   4. APPROVAL: the creator cannot approve their own supplier; a different person with the authority does, with a reason;
 *      approving again is a no-op;
 *   and a second head-office instance over the same store (a restart) reads the same supplier, documents, bank and state.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Factory = (sameStoreAs?: ApiHarness) => ApiHarness;
const backings: { name: string; harness: Factory }[] = [{ name: 'the in-memory event store', harness: (same) => apiHarness(same === undefined ? {} : { store: same.store }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const GST = { documentId: 'doc-gst', kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' };
const FSSAI = { documentId: 'doc-fssai', kind: 'fssai_licence', reference: '12426999000123', validFrom: '2026-04-01', validUntil: '2028-03-31' };

interface OneSupplier { supplier: SupplierRecord | null; bank: { accountRef: string; requestedBy: string; verifiedBy: string } | null; attention: string[] }

describe.each(backings)('WF-02 — supplier onboarding: application → documents → bank → approval — on $name', ({ harness }) => {
  it('one run: proposed with its documents verified by the sender, the bank changed by maker-checker, approved by a different person; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');   // proposes suppliers and adds their documents
    await h.provisionRole(T, 'u-acct', 'accountant');        // approves suppliers and bank changes
    await h.provisionRole(T, 'u-cash', 'cashier');
    const post = (path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
    const one = async (hh: ApiHarness = h): Promise<OneSupplier> => (await hh.request({ method: 'GET', path: '/v1/purchase/suppliers/sup-kav', userId: 'u-buyer', tenantId: T })).body as OneSupplier;

    // 1. APPLICATION — proposed, awaiting approval. A cashier cannot propose one.
    expect((await post('/v1/purchase/suppliers/sup-kav', 'u-cash', { name: 'Kaveri Foods' }, 'cash-propose')).status).toBe(403);
    const applied = await post('/v1/purchase/suppliers/sup-kav', 'u-buyer', { name: 'Kaveri Foods', gstin: '33kaver1234f1z5', phone: '+91-90000-00001', paymentTermsDays: 30 }, 'apply');
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ created: true, supplier: { status: 'proposed', createdBy: 'u-buyer', gstin: '33KAVER1234F1Z5', version: 1, documents: [] } });

    // 2. DOCUMENTS — a verifier typed for somebody else is refused; verified by the sender, it is theirs, on the server clock.
    expect(codeOf(await post('/v1/purchase/suppliers/sup-kav', 'u-buyer', { name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', paymentTermsDays: 30, documents: [{ ...GST, verifiedBy: 'u-acct' }] }, 'docs-typed'))).toBe('actor_is_the_caller');
    const docs = await post('/v1/purchase/suppliers/sup-kav', 'u-buyer', { name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', paymentTermsDays: 30, documents: [{ ...GST, verifiedBy: 'u-buyer' }, { ...FSSAI, verifiedBy: 'u-buyer' }] }, 'docs');
    expect(docs.status).toBe(200);
    expect(docs.body).toMatchObject({ created: false, supplier: { status: 'proposed', version: 2, documents: [
      expect.objectContaining({ documentId: 'doc-gst', kind: 'gst_registration', verifiedBy: 'u-buyer' }),
      expect.objectContaining({ documentId: 'doc-fssai', kind: 'fssai_licence', verifiedBy: 'u-buyer' }),
    ] } });

    // 3. BANK — never without a second person's approval; never approved by the supplier's own creator.
    const change = { newAccount: 'tok-kaveri-acct', requestedVia: 'letter', calledBackOn: '+91-90000-00001', numberWeAlreadyHeld: '+91-90000-00001', requestedAt: '2026-10-12T05:00:00.000Z' };
    expect(codeOf(await post('/v1/purchase/suppliers/sup-kav/bank-details', 'u-owner', change, 'bank-unapproved'))).toBe('not_approved');
    // The creator holds no authority to decide a bank change (and could not be its approver): refused, still no bank.
    const asked = await askForApproval(h, T, 'u-owner', { kind: 'supplier_bank_change', subjectRef: 'sup-kav', details: { ...change, supplierId: 'sup-kav' } });
    expect(asked.status).toBe(201);
    expect((await decide(h, T, 'u-buyer', (asked.body as { requestId: string }).requestId)).status).toBeGreaterThanOrEqual(400);
    expect((await one()).bank).toBeNull();
    const approvalId = await approvedRequestId(h, T, 'u-owner', 'u-acct', { kind: 'supplier_bank_change', subjectRef: 'sup-kav', details: { ...change, supplierId: 'sup-kav' } });
    const banked = await post('/v1/purchase/suppliers/sup-kav/bank-details', 'u-owner', { ...change, approvalId }, 'bank');
    expect(banked.status).toBe(200);
    expect((await one()).bank).toMatchObject({ accountRef: 'tok-kaveri-acct', requestedBy: 'u-owner', verifiedBy: 'u-acct' });
    // The same approval cannot be spent twice.
    expect((await post('/v1/purchase/suppliers/sup-kav/bank-details', 'u-owner', { ...change, newAccount: 'tok-other', approvalId }, 'bank-again')).status).toBeGreaterThanOrEqual(400);

    // 4. APPROVAL — not by its creator (no authority), not without a reason; by a different person, once.
    expect((await post('/v1/purchase/suppliers/sup-kav/approval', 'u-buyer', { reason: 'mine' }, 'appr-self')).status).toBe(403);
    expect(codeOf(await post('/v1/purchase/suppliers/sup-kav/approval', 'u-acct', {}, 'appr-noreason'))).toBe('approval_needs_a_reason');
    const approved = await post('/v1/purchase/suppliers/sup-kav/approval', 'u-acct', { reason: 'GST and FSSAI seen; bank called back on the number we held' }, 'appr');
    expect(approved.body).toMatchObject({ alreadyApproved: false, supplier: { status: 'active', approvedBy: 'u-acct', createdBy: 'u-buyer', version: 3 } });
    expect((await post('/v1/purchase/suppliers/sup-kav/approval', 'u-acct', { reason: 'again' }, 'appr-again')).body).toMatchObject({ alreadyApproved: true });

    // A second head-office instance over the same store (a restart): the same supplier, documents, bank and state.
    const after = await one(harness(h));
    expect(after.supplier).toMatchObject({ supplierId: 'sup-kav', status: 'active', createdBy: 'u-buyer', approvedBy: 'u-acct', version: 3 });
    expect(after.supplier!.documents.map((d) => [d.documentId, d.verifiedBy])).toEqual([['doc-gst', 'u-buyer'], ['doc-fssai', 'u-buyer']]);
    expect(after.bank).toMatchObject({ accountRef: 'tok-kaveri-acct', verifiedBy: 'u-acct' });
    expect(after.attention).toEqual([]);
  });
});
