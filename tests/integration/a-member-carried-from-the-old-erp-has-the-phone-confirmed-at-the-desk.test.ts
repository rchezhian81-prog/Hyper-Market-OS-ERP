import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId } from '../support/approval-request';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { MemoryIdempotencyStore, SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **OB-364 (owner, 24–25 Oct 2026, in writing): loyalty members carried from the old ERP are enrolled as members, and the
 * service desk confirms the phone number on the customer's next visit.**
 *
 * On the real API (in memory and, with DATABASE_URL, on real PostgreSQL with a cold restart):
 *   • a customer loaded by the approved import is a MEMBER at once (looked up by number), and the look-up says the phone
 *     is still to confirm — nobody has seen the number on their phone; one enrolled at the desk never says so;
 *   • the desk's confirm needs the number seen on the customer's own phone (else refused, nothing written); a cashier
 *     cannot confirm; a number that is not a member is refused by name;
 *   • confirmed: recorded as a NEW fact (who, when) — the look-up then reads it as checked, the earlier fact stays; a
 *     second confirm changes nothing; the number never travels in a URL; a cold restart keeps it all.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string => [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly stores: () => { store: EventStore; idempotency: IdempotencyStore } }
const backings: Backing[] = [{ name: 'the in-memory event store', stores: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', stores: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

describe.each(backings)('OB-364 — a member carried from the old ERP has the phone confirmed at the desk, on $name', ({ name, stores }) => {
  it('imported → a member, "confirm phone" → confirmed only with the number seen → recorded, once; kept across a cold restart', async () => {
    const backing = stores();
    let h: ApiHarness = apiHarness(backing);
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier', ['S1']);
    const paths: string[] = [];
    const post = (user: string, path: string, body: unknown) => { paths.push(path); return h.request({ method: 'POST', path, userId: user, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body }); };
    const look = async (mobile: string) => (await post(MGR, '/v1/loyalty/members/lookup', { mobile })).body as { member: boolean; mobileLast4?: string; phoneToConfirm?: boolean; phoneConfirmedBy?: string; phoneConfirmedAt?: string };

    // ── The approved import carries two customers from the old ERP (the manager loads, the owner approves).
    const text = csv(['mobile', 'loyaltyConsent', 'consentGivenOn', 'consentEvidence', 'name'], [['9876500011', 'yes', '2025-04-01', 'old ERP card', 'Meena K'], ['9876500012', 'yes', '2025-05-01', 'old ERP card', '']]);
    const v = await post(MGR, '/v1/import/validate', { templateId: 'customer-v1', text });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const approvalId = await approvedRequestId(h, T, MGR, OWNER, { kind: 'data_import_commit', subjectRef: 'J-OLD', details: { jobId: 'J-OLD', contentFingerprint: (v.body as { contentFingerprint: string }).contentFingerprint } });
    const loaded = await post(MGR, '/v1/import/commit', { jobId: 'J-OLD', templateId: 'customer-v1', text, approvalId });
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);

    // A member at once — and the phone still to confirm. One enrolled at the desk (seen on the phone) is not asked.
    expect(await look('9876500011')).toMatchObject({ member: true, mobileLast4: '0011', phoneToConfirm: true });
    expect((await post(MGR, '/v1/loyalty/members', { mobile: '9876500099', consent: true, verifiedHow: 'seen_on_phone' })).status).toBe(201);
    expect(await look('9876500099')).toMatchObject({ member: true, phoneToConfirm: false });
    // Enrolling the carried member again is no second member — the desk is told to confirm the number instead.
    expect((await post(MGR, '/v1/loyalty/members', { mobile: '9876500011', consent: true, verifiedHow: 'seen_on_phone' })).body).toMatchObject({ alreadyMember: true, phoneToConfirm: true });

    // ── Refusals: not seen on the phone; a cashier; a number that is no member. Nothing written by any.
    const notSeen = await post(MGR, '/v1/loyalty/members/confirm-phone', { mobile: '9876500011' });
    expect(notSeen.status).toBe(422);
    expect(codeOf(notSeen)).toBe('number_not_checked');
    expect((await post(CASH, '/v1/loyalty/members/confirm-phone', { mobile: '9876500011', verifiedHow: 'seen_on_phone' })).status).toBe(403);
    const nobody = await post(MGR, '/v1/loyalty/members/confirm-phone', { mobile: '9876500077', verifiedHow: 'seen_on_phone' });
    expect(nobody.status).toBe(404);
    expect(codeOf(nobody)).toBe('not_a_member');
    expect((await post(MGR, '/v1/loyalty/members/confirm-phone', { mobile: '12345', verifiedHow: 'seen_on_phone' })).status).toBe(400);
    expect((await look('9876500011')).phoneToConfirm).toBe(true);

    // ── Confirmed: who and when, a new fact; then it reads as checked; a second confirm changes nothing.
    const ok = await post(MGR, '/v1/loyalty/members/confirm-phone', { mobile: '98765 00011', verifiedHow: 'seen_on_phone' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ mobileLast4: '0011', confirmed: true, phoneConfirmedBy: MGR });
    expect(await look('9876500011')).toMatchObject({ member: true, phoneToConfirm: false, phoneConfirmedBy: MGR });
    expect((await post(MGR, '/v1/loyalty/members/confirm-phone', { mobile: '9876500011', verifiedHow: 'seen_on_phone' })).body).toMatchObject({ confirmed: true, alreadyConfirmed: true });
    // The other carried member is still to confirm — one confirmation is one member's.
    expect((await look('9876500012')).phoneToConfirm).toBe(true);
    // The number never went in a URL.
    expect(paths.every((p) => !/98765/.test(p))).toBe(true);
    // Append-only: the member's facts are the import's, then the desk's confirmation — the first one still there.
    const facts = (await backing.store.readStream(T, streamName(STREAM.loyalty, 'members'), { type: 'LoyaltyMember' })).map((e) => e.event.payload as { mobileLast4: string; verifiedHow: string; phoneConfirmedBy?: string; fullName?: string });
    const meena = facts.filter((f) => f.mobileLast4 === '0011');
    expect(meena.map((f) => f.verifiedHow)).toEqual(['carried_from_old_erp', 'seen_on_phone']);
    expect(meena[1]!.fullName, 'the name is not copied onto the confirmation').toBeUndefined();

    // ── Cold restart: a fresh API over the same records.
    h = apiHarness(name === 'real PostgreSQL' ? stores() : backing);
    expect(await look('9876500011')).toMatchObject({ phoneToConfirm: false, phoneConfirmedBy: MGR });
    expect((await look('9876500012')).phoneToConfirm).toBe(true);
  }, 60_000);
});
