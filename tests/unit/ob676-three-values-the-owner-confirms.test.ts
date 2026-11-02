import { describe, it, expect } from 'vitest';
import { handoverToleranceStanding, HANDOVER_TOLERANCE_STARTING_SUGGESTION_MINOR, type HandoverToleranceConfirmation } from '../../services/fulfilment/src/handover-tolerance';
import { readStaffing, queueStaffingStanding, staffingFromRoleMap, queuesStaffedUnder, STAFFED_QUEUES, type QueueStaffing } from '../../services/orders/src/exception-queue-staffing';
import { exceptionOwnershipRoutes, exceptionIdFor, QUEUES_STAFFED_BY, type ExceptionOwnershipDeps } from '../../services/orders/src/exception-ownership';
import type { OrdersDeps, StoredSubstitution } from '../../services/orders/src/index';
import type { OwnedException } from '../../packages/orders/src/substitution-exception-ownership';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { StoreSettings } from '../../services/platform/src/store-packs';
import { toleranceNote, paiseOf, createDispatchSession } from '../../apps/web-erp/src/dispatch-session';
import { createStaffingSession, queueRows, roleWords } from '../../apps/web-erp/src/exception-queue-staffing-session';
import { createConcessionPortalSession, fetchConcessionPortal, type ConcessionPortalData } from '../../apps/concession-app/src/concession-portal-session';
import { OUTSIDE_PARTY_ROLES, OUTSIDE_PARTY_KINDS, outsidePartyGrantRefusal } from '../../services/identity/src/outside-party-logins';
import { OUTSIDE_KINDS, OUTSIDE_KIND_PERMISSION, OUTSIDE_KIND_SEGMENT } from '../../apps/web-erp/src/outside-logins-session';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

// OB-676 "A" (owner, 2 Nov 2026, in writing) — the pure rules and the screens' models behind the three values that were
// written in code: the driver cash hand-over limit (M19-FR-04), who staffs each delivery-exception queue (M19-FR-01 ·
// Item 2) and the concessionaire's own login (M27-FR-02). The connected proofs are tests/integration/
// ob676-three-values-the-owner-confirms.test.ts and the browser tests tests/e2e/ob676-*.e2e.ts.

const settings = (handoverToleranceMinor: number, version = 1): StoreSettings => ({
  storeId: 'BR1', warehouseId: null, tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 1, handoverToleranceMinor,
  cashVarianceToleranceMinor: 1, privacySlaDays: 15, version, setBy: 'u-setup', setAt: '2026-11-01T00:00:00.000Z',
});
const confirmation = (valueMinor: number, version: number): HandoverToleranceConfirmation => ({
  storeId: 'BR1', version, valueMinor, previousMinor: 10_000, kind: 'as_suggested', settingsVersion: 1, reason: null, by: 'u-owner', at: '2026-11-02T10:00:00.000Z',
});

describe('1 · the driver cash hand-over limit — suggested, not confirmed until the owner confirms the figure in force', () => {
  it('offers today\'s figure (else the code\'s old ₹100) and reads not confirmed until the latest confirmation is OF that figure', () => {
    expect(HANDOVER_TOLERANCE_STARTING_SUGGESTION_MINOR).toBe(10_000);
    expect(handoverToleranceStanding('BR1', undefined, [])).toMatchObject({ valueMinor: null, suggestedMinor: 10_000, state: 'not_confirmed', changedSinceConfirmed: false });
    expect(handoverToleranceStanding('BR1', settings(5_000), [])).toMatchObject({ valueMinor: 5_000, suggestedMinor: 5_000, state: 'not_confirmed', confirmed: null });
    expect(handoverToleranceStanding('BR1', settings(5_000), [confirmation(5_000, 1)])).toMatchObject({ state: 'confirmed', confirmed: { version: 1, valueMinor: 5_000, by: 'u-owner' } });
    // Someone else changed the figure after the owner confirmed: not confirmed again, said so.
    expect(handoverToleranceStanding('BR1', settings(20_000, 2), [confirmation(5_000, 1)])).toMatchObject({ state: 'not_confirmed', changedSinceConfirmed: true, confirmed: null });
  });

  it('the Dispatch board\'s words beside a cash difference: the limit and "not confirmed by the owner", nothing more once he has, and "did not say" when untold', () => {
    expect(toleranceNote('en', { valueMinor: 10_000, state: 'not_confirmed' })).toBe('Cash-difference limit for drivers: ₹100.00 — not confirmed by the owner');
    expect(toleranceNote('ta', { valueMinor: 10_000, state: 'not_confirmed' })).toMatch(/உரிமையாளர் உறுதிசெய்யவில்லை/);
    expect(toleranceNote('en', { valueMinor: 10_000, state: 'confirmed' })).toBe('');
    expect(toleranceNote('en', null)).toBe('Cash-difference limit for drivers: head office did not say.');
    expect([paiseOf('100'), paiseOf('₹100.5'), paiseOf('100.50'), paiseOf('abc'), paiseOf('')]).toEqual([10_000, 10_050, 10_050, undefined, undefined]);
  });

  it('the Dispatch session asks only on a click, refuses a non-owner and a figure of nothing before any call, and posts paise', async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch = (async (url: string, init?: { body?: string }) => { calls.push({ url, ...(init?.body === undefined ? {} : { body: init.body }) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const manager = createDispatchSession({ viewer: { userId: 'u-mgr', permissions: ['delivery.run.read'] }, fetch });
    expect(await manager.confirmTolerance('BR1', '100', '')).toEqual({ result: 'invalid', why: 'cannotSet' });
    const owner = createDispatchSession({ viewer: { userId: 'u-owner', permissions: ['delivery.run.read', 'delivery.controls.set'] }, fetch });
    expect(await owner.confirmTolerance('BR1', '0', '')).toEqual({ result: 'invalid', why: 'needRupees' });
    expect(calls).toEqual([]);
    await owner.tolerance('BR1');
    await owner.confirmTolerance('BR1', '75.50', ' as agreed ');
    expect(calls.map((c) => c.url)).toEqual(['/v1/delivery/handover-tolerance?storeId=BR1', '/v1/delivery/handover-tolerance/BR1']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ valueMinor: 7_550, reason: 'as agreed' });
  });
});

// ── 2 · who staffs each queue ───────────────────────────────────────────────────────────────────────────────────────

const MAY_WORK = ROLE_CATALOGUE.filter((r) => r.permissions.includes('order.exception.work')).map((r) => r.id);
const SUGGESTED = staffingFromRoleMap(QUEUES_STAFFED_BY, MAY_WORK);

describe('2 · who staffs each delivery-exception queue — the code\'s map is the suggestion; the owner sets it; an empty queue is unowned', () => {
  it('the suggestion is the old map, turned queue → roles, keeping only roles that may work exceptions at all', () => {
    expect(SUGGESTED).toEqual({
      fulfilment_supervisor: ['owner', 'store_manager'], customer_service_desk: ['cashier', 'owner', 'store_manager'],
      finance_recon_queue: ['accountant', 'owner', 'store_manager'], duty_manager: ['owner', 'store_manager'],
    });
    // The chartered accountant was in the old map but cannot work exceptions (no order.exception.work) — dropped, behaviour unchanged.
    expect(MAY_WORK).not.toContain('chartered_accountant');
    expect(MAY_WORK).not.toContain('concessionaire');
    expect(queueStaffingStanding(SUGGESTED, [])).toMatchObject({ state: 'not_confirmed', staffing: SUGGESTED, unowned: [], confirmed: null });
  });

  it('reads the owner\'s body: every queue named, roles that may work only, an empty list is UNOWNED on purpose', () => {
    const all = { fulfilment_supervisor: ['store_manager'], customer_service_desk: [], finance_recon_queue: ['accountant', 'accountant'], duty_manager: ['owner'] };
    const read = readStaffing({ staffing: all }, MAY_WORK);
    expect(read).toEqual({ staffing: { ...all, finance_recon_queue: ['accountant'] } });
    expect('problems' in readStaffing({ staffing: { ...all, duty_manager: ['supplier'] } }, MAY_WORK)).toBe(true);
    expect('problems' in readStaffing({ staffing: { ...all, somewhere: ['owner'] } }, MAY_WORK)).toBe(true);
    expect('problems' in readStaffing({ staffing: { fulfilment_supervisor: ['owner'] } }, MAY_WORK)).toBe(true);
    expect('problems' in readStaffing({}, MAY_WORK)).toBe(true);
    const standing = queueStaffingStanding(SUGGESTED, [{ version: 1, staffing: (read as { staffing: QueueStaffing }).staffing, asSuggested: false, reason: null, by: 'u-owner', at: 'x' }]);
    expect(standing).toMatchObject({ state: 'confirmed', unowned: ['customer_service_desk'] });
    expect(queuesStaffedUnder(standing.staffing, ['cashier'])).toEqual([]);
    expect(queuesStaffedUnder(standing.staffing, ['accountant'])).toEqual(['finance_recon_queue']);
  });

  it('the exception routes work under the staffing IN FORCE: a cashier staffs the service desk on the suggestion, and not once the owner has taken it away', async () => {
    const short: StoredSubstitution = { orderId: 'ord-c', lineId: 'l1', decision: 'confirmed', outcome: 'short_picked', pickProductId: null, pickQuantityMinor: 0, chargeMinor: 0, refundMinor: 0, eligibility: 'refused', at: '2026-11-02T09:00:00.000Z' } as StoredSubstitution;
    const build = (staffing: ReturnType<typeof queueStaffingStanding> | undefined) => {
      const kept: OwnedException[] = [];
      const deps = {
        now: () => '2026-11-02T09:10:00.000Z', allSubstitutions: () => [short],
        ownedExceptions: () => { const m = new Map<string, OwnedException>(); for (const o of kept) m.set(o.exceptionId, o); return [...m.values()]; },
        recordOwnedException: (_t: string, o: OwnedException) => { kept.push(o); },
        rolesOf: (_t: string, u: string) => (u === 'u-cash' ? ['cashier'] : ['store_manager']),
        ...(staffing === undefined ? {} : { queueStaffing: async () => staffing }),
      } as unknown as OrdersDeps & ExceptionOwnershipDeps;
      return exceptionOwnershipRoutes(deps);
    };
    const id = exceptionIdFor({ orderId: 'ord-c', lineId: 'l1', kind: 'policy_short_pick' });
    const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
    const ctx = (userId: string, params: Record<string, string> = {}): RequestContext => ({ tenantId: 't', userId, branchId: null, params, query: {}, body: undefined, traceId: 'x' } as RequestContext);
    // On the suggestion (no staffing port, as before): the cashier may claim the service-desk item; the worklist says not confirmed.
    const before = build(undefined);
    const list = await route(before, 'GET', '/v1/orders/substitution-exceptions').handler(ctx('u-mgr'));
    expect((list.body as { staffing: unknown }).staffing).toMatchObject({ state: 'not_confirmed', unowned: [] });
    expect((await route(before, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx('u-cash', { exceptionId: id }))).status).toBe(200);
    // The owner leaves the service desk unowned: the item stays on the list (P-08), the queue says unowned, and the cashier is refused.
    const owned = queueStaffingStanding(SUGGESTED, [{ version: 1, staffing: { ...SUGGESTED, customer_service_desk: [] }, asSuggested: false, reason: null, by: 'u-owner', at: 'x' }]);
    const after = build(owned);
    const list2 = await route(after, 'GET', '/v1/orders/substitution-exceptions').handler(ctx('u-mgr'));
    expect((list2.body as { exceptions: unknown[]; staffing: unknown }).exceptions).toHaveLength(1);
    expect((list2.body as { staffing: unknown }).staffing).toMatchObject({ state: 'confirmed', unowned: ['customer_service_desk'] });
    const queue = await route(after, 'GET', '/v1/orders/substitution-exceptions/queue/:owner').handler(ctx('u-mgr', { owner: 'customer_service_desk' }));
    expect(queue.body).toMatchObject({ count: 1, unowned: true, staffedBy: [] });
    await expect(route(after, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx('u-cash', { exceptionId: id }))).rejects.toMatchObject({ status: 422 });
    // The duty manager's queue is the terminal owner of them all: a manager may still work it.
    expect((await route(after, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx('u-mgr', { exceptionId: id }))).status).toBe(200);
  });

  it('the page\'s model: each queue in words, UNOWNED said; only the owner may set it; nothing is asked until a click', async () => {
    const read = { state: 'confirmed' as const, staffing: { ...SUGGESTED, customer_service_desk: [] }, suggested: SUGGESTED, confirmed: { version: 1, by: 'u-owner', at: 'x' }, unowned: ['customer_service_desk' as const], history: [], rolesThatMayWork: MAY_WORK };
    const rows = queueRows('en', read);
    expect(rows.map((r) => [r.queue, r.unowned, r.words])).toEqual([
      ['fulfilment_supervisor', false, 'Owner, Store manager'], ['customer_service_desk', true, 'UNOWNED — no role works this queue'],
      ['finance_recon_queue', false, 'Accountant, Owner, Store manager'], ['duty_manager', false, 'Owner, Store manager'],
    ]);
    expect(roleWords('en', 'purchase_user')).toBe('purchase user');
    expect(STAFFED_QUEUES).toHaveLength(4);
    const calls: string[] = [];
    const fetch = (async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const manager = createStaffingSession({ viewer: { userId: 'u-mgr', permissions: ['order.read'] }, fetch });
    expect(manager.may).toEqual({ named: true, read: true, set: false });
    expect(await manager.setStaffing(SUGGESTED, '')).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(calls).toEqual([]);
  });
});

// ── 3 · the concessionaire's own login ──────────────────────────────────────────────────────────────────────────────

describe('3 · the concessionaire\'s own login — a fourth outside party, its portal reads only its own counter', () => {
  it('is an outside-party login managed by those who manage concessions, given only through the two-person invite, holding no staff authority', () => {
    expect(OUTSIDE_PARTY_ROLES).toContain('concessionaire');
    expect(OUTSIDE_PARTY_KINDS.concessionaire).toEqual({ segment: 'concessionaires', permission: 'concession.contract.manage', party: 'concessionaire' });
    expect(outsidePartyGrantRefusal('concessionaire', undefined)).toMatch(/outside party's own login/);
    expect(outsidePartyGrantRefusal('cashier', 'concessionaire')).toMatch(/Nothing is added to an outside party's login/);
    const role = ROLE_CATALOGUE.find((r) => r.id === 'concessionaire')!;
    expect([...role.permissions].sort()).toEqual(['concession.portal.self', 'identity.self.read']);
    // The office page offers the kind to whoever manages concessions.
    expect(OUTSIDE_KINDS).toContain('concessionaire');
    expect([OUTSIDE_KIND_PERMISSION.concessionaire, OUTSIDE_KIND_SEGMENT.concessionaire]).toEqual(['concession.contract.manage', 'concessionaires']);
  });

  const DATA: ConcessionPortalData = {
    concessionaireId: 'JWL-1',
    counters: [{ contractId: 'C-JWL', name: 'Jewellery counter', branchId: 'BR1', basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 50_000, validUntil: '2027-08-01', mayTrade: false, blockers: ['insurance lapsed'] }],
    depositHeldMinor: 50_000,
    sales: [{ saleId: 'S-J1', contractId: 'C-JWL', at: '2026-11-02T05:00:00.000Z', grossMinor: 250_000, taxMinor: 7_500, tenderedTo: 'store_till' }],
    stock: [], invoices: null, refusals: { invoices: 'unavailable' }, asAt: '2026-11-02T06:00:00.000Z',
  };

  it('the portal\'s model: a counter that may not trade says why; an empty feed says "none yet"; an unread feed is never shown as none', () => {
    const v = createConcessionPortalSession({ userId: 'u-jewel', permissions: ['concession.portal.self'] }, DATA).view('en');
    expect(v.screen).toBe('shown');
    expect(v.counters[0]).toMatchObject({ headline: 'Jewellery counter (C-JWL) · Store BR1', status: { tone: 'error', label: 'May NOT trade today: insurance lapsed' } });
    expect(v.counters[0]!.facts).toEqual(['Terms: revenue share', 'Revenue share: 15.00%', 'Agreement until: 2027-08-01']);
    expect([v.deposit, v.salesTotal, v.stockTotal]).toEqual(['₹500.00', '₹2,500.00', null]);
    expect(v.notes.stock).toEqual({ words: 'The shop’s records show none of your stock on its shelves.', tone: 'muted' });
    expect(v.notes.invoices).toEqual({ words: 'This could not be read just now — it does not mean there is nothing. Try Refresh.', tone: 'warn' });
    expect(createConcessionPortalSession({ userId: 'u-cash', permissions: ['pos.sale.ring'] }, DATA).view('en').screen).toBe('not_permitted');
    expect(createConcessionPortalSession({ userId: null, permissions: [] }, DATA).view('ta').screenStatus.label).toMatch(/யாரும் உள்நுழையவில்லை/);
  });

  it('reads its four feeds with GETs only, carries "not bound" as such, and is null when nothing at all could be read', async () => {
    const seen: string[] = [];
    const notBound = (async (url: string, init?: { method?: string }) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ error: { code: 'login_not_bound_to_a_concessionaire' } }), { status: 403 });
    }) as unknown as typeof globalThis.fetch;
    const out = await fetchConcessionPortal(notBound);
    expect(seen.sort()).toEqual(['GET /v1/concession-portal/me/counters', 'GET /v1/concession-portal/me/invoices', 'GET /v1/concession-portal/me/sales', 'GET /v1/concession-portal/me/stock']);
    expect(out?.refusals).toEqual({ counters: 'not_bound', sales: 'not_bound', stock: 'not_bound', invoices: 'not_bound' });
    expect(createConcessionPortalSession({ userId: 'u-jewel', permissions: ['concession.portal.self'] }, out!).view('en').notes.counters?.words).toMatch(/not linked to a counter/);
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    expect(await fetchConcessionPortal(offline)).toBeNull();
  });
});
