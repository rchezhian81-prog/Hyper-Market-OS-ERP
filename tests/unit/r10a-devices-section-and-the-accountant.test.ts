import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  readVersionExceptions, presentVersionExceptions, fleetVersionExceptionsPort, VERSION_EXCEPTIONS_COPY, VERSION_EXCEPTIONS_PATH,
  type VersionExceptionsRead,
} from '../../apps/web-erp/src/fleet-version-exceptions';
import { issueQuotation, type QuotationLine, type Quotation } from '../../packages/suspended-sales/src/index';
import { APPROVAL_KINDS, fingerprintOf, actionDetails, type ApprovalPort, type ApprovalState } from '../../services/identity/src/approval-requests';
import { quotationsRoutes } from '../../services/pos/src/quotations';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { ACCOUNTANT_ROLE_ID } from '../../services/api/src/r10a-devices-accountant-adapters';
import { createQuotationsSession, quotationsOutcomeWords, QUOTATIONS_COPY } from '../../apps/web-erp/src/quotations-session';
import { APPROVALS_COPY } from '../../apps/web-erp/src/approvals-session';
import { ERP_NAVIGATION, navigationFor, canOpen } from '../../apps/web-erp/src/navigation';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { permissionsForScreen, permissionForScreen } from '../../edge/store-edge/src/screen-server';
import { goodsReceiptListPathFor, goodsReceiptPortsFromData, GOODS_RECEIPT_SCREEN_READ_PERMISSION } from '../../apps/web-erp/src/browser-entry';
import { goodsReceiptRoutes } from '../../services/inventory/src/goods-receipt';

/**
 * **Round 10 · R10-A (owner, 28 Oct 2026).**
 *   • OB-540 — the office Devices page lists handheld work done on a withdrawn or too-old app version, read from head office's
 *     `GET /v1/platform/handheld-work/version-exceptions`, in English and Tamil; read-only; honest "Not known" / "head office
 *     could not be reached" states (P-08).
 *   • OB-542 — a quotation on a product with no known floor that the OWNER himself makes is approved by the ACCOUNTANT;
 *     anyone else's still needs the owner (OB-532); the quoter never approves his own.
 *   • OB-543 — the accountant reads the goods-receipt screen through its own narrow word and may match the bill there; the
 *     person who received the goods is still refused.
 * The pure pieces. Synthetic data only.
 */

const respond = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;

const FINDING = {
  exceptionId: 'ex-1', kind: 'handheld_work_on_an_unsupported_app_version', severity: 'material', verdict: 'version_killed', client: 'picker',
  appVersion: '1.2.0', markedByStoreComputer: 'version_killed', route: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced',
  recordRef: 'waveId=W-7&lineId=L-3#abc123', store: 'store-1', relayedBy: 'u-box', at: '2030-06-01T04:30:00.000Z',
  detail: 'The record waveId=W-7&lineId=L-3 sent to /v1/fulfilment/waves/:waveId/lines/:lineId/synced was done on the picker on app 1.2.0, which head office has withdrawn (the store computer marked it too)',
  ownerAction: 'Update that handheld.',
};

describe('OB-540: the Devices page reads head office\'s register, and says every way the read can fail', () => {
  it('reads the findings, the informational count and when head office answered', async () => {
    const read = await readVersionExceptions(respond(200, { material: [FINDING], informational: 2, informationalExceptions: [], asAt: '2030-06-01T05:00:00.000Z' }));
    expect(read).toMatchObject({ state: 'read', informational: 2, unreadable: 0, asAt: '2030-06-01T05:00:00.000Z' });
    expect(read.state === 'read' ? read.material[0] : undefined).toMatchObject({ exceptionId: 'ex-1', client: 'picker', appVersion: '1.2.0', verdict: 'version_killed' });
  });

  it('goes through the store computer as the person: one same-origin GET to the register', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response('{"material":[],"informational":0}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    await readVersionExceptions(fetchFn);
    expect(seen).toEqual([{ url: VERSION_EXCEPTIONS_PATH, init: { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' } }]);
  });

  it('no connection, a dropped call or head office down is "could not be reached"; an unreadable answer is "not known"', async () => {
    const throws = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch;
    expect(await readVersionExceptions(throws)).toEqual({ state: 'unreachable' });
    expect(await readVersionExceptions(respond(503, {}))).toEqual({ state: 'unreachable' });
    expect(await readVersionExceptions(respond(502, {}))).toEqual({ state: 'unreachable' });
    expect(await readVersionExceptions(undefined as unknown as typeof globalThis.fetch)).toMatchObject({ state: expect.any(String) });
    expect(await readVersionExceptions(respond(200, { findings: [] }))).toEqual({ state: 'not_known' });
    expect(await readVersionExceptions((async () => new Response('not json', { status: 200 })) as unknown as typeof globalThis.fetch)).toEqual({ state: 'not_known' });
  });

  it('a missing head-office sign-in carries the store computer\'s own words; a refusal is said; head office\'s 403 is "not permitted"', async () => {
    expect(await readVersionExceptions(respond(401, { error: { code: 'head_office_sign_in_needed', whatHappened: 'Sign in first.', whatHappenedTa: 'முதலில் உள்நுழையுங்கள்.' } })))
      .toEqual({ state: 'sign_in_needed', en: 'Sign in first.', ta: 'முதலில் உள்நுழையுங்கள்.' });
    expect(await readVersionExceptions(respond(403, { error: { code: 'forbidden', whatHappened: 'This account does not hold "platform.health.read".' } }))).toEqual({ state: 'not_permitted' });
    expect(await readVersionExceptions(respond(403, { error: { code: 'not_at_this_store', whatHappened: 'You do not work at this store.' } })))
      .toEqual({ state: 'refused', status: 403, code: 'not_at_this_store', en: 'You do not work at this store.', ta: null });
    expect(await readVersionExceptions(respond(404, {}))).toEqual({ state: 'refused', status: 404, code: null, en: null, ta: null });
  });

  it('a reader without the Devices page\'s word is told so, and nothing is read', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return new Response('{}'); }) as unknown as typeof globalThis.fetch;
    const port = fleetVersionExceptionsPort(['identity.self.read'], fetchFn);
    expect(port.mayRead).toBe(false);
    expect(await port.read()).toEqual({ state: 'not_permitted' });
    expect(calls).toBe(0);
    expect(fleetVersionExceptionsPort(['platform.health.read'], fetchFn).mayRead).toBe(true);
  });
});

describe('OB-540: the section says which handheld, which version, what was done, when, and the finding — English and Tamil', () => {
  const read: VersionExceptionsRead = { state: 'read', material: [{ exceptionId: 'ex-1', client: 'picker', appVersion: '1.2.0', verdict: 'version_killed', markedByStoreComputer: 'version_killed', route: FINDING.route, recordRef: FINDING.recordRef, at: FINDING.at, detail: FINDING.detail }], informational: 2, unreadable: 0, asAt: '2030-06-01T05:00:00.000Z' };

  it('draws one row per finding with the shop\'s own clock', () => {
    const en = presentVersionExceptions('en', read);
    expect(en).toMatchObject({ tone: 'attention', status: '1 piece(s) of handheld work were done on a withdrawn or too-old version — update those handhelds.', asAt: 'Head office\'s list as at 2030-06-01 10:30' });
    expect(en.rows).toEqual([{
      exceptionId: 'ex-1', kind: 'Picker\'s handheld', version: '1.2.0', what: 'A pick on a wave line (record waveId=W-7&lineId=L-3)',
      when: '2030-06-01 10:00', finding: 'Version withdrawn by head office (the store computer marked it too)', detail: FINDING.detail,
    }]);
    expect(en.informational).toBe('2 record(s) came from a handheld too old to report its version — update those handhelds.');
    const ta = presentVersionExceptions('ta', read);
    expect(ta.rows[0]).toMatchObject({ kind: 'பொருள் எடுப்பவரின் கைக்கருவி', version: '1.2.0', finding: 'தலைமை அலுவலகம் திரும்பப் பெற்ற பதிப்பு (கடைக் கணினியும் குறித்தது)', detail: null });
    expect(ta.rows[0]!.what).toContain('அலை வரியில் ஒரு எடுப்பு');
    expect(ta.heading).not.toBe(en.heading);
  });

  it('an empty register says so in words (and is the only "all well"); a too-old version and unknown fields are said, never guessed', () => {
    const none = presentVersionExceptions('en', { state: 'read', material: [], informational: 0, unreadable: 0, asAt: null });
    expect(none).toMatchObject({ tone: 'ok', status: 'No handheld work was done on a withdrawn or too-old version.', rows: [], informational: null });
    const odd = presentVersionExceptions('en', { state: 'read', material: [{ exceptionId: 'ex-2', client: null, appVersion: null, verdict: 'upgrade_required', markedByStoreComputer: null, route: '/v1/somewhere/new', recordRef: null, at: null, detail: null }], informational: null, unreadable: 1, asAt: null });
    expect(odd.rows[0]).toMatchObject({ kind: 'Not known', version: 'not reported', what: 'Work sent to /v1/somewhere/new', when: 'Not known', finding: 'Below the minimum supported version' });
    expect(odd.status).toContain('1 entries could not be read');
    expect(odd.informational).toBe('How many records reported no version is not known.');
  });

  it('every failure is "Not known" in both languages — never an empty list that reads as nothing wrong (P-08)', () => {
    const states: VersionExceptionsRead[] = [
      { state: 'not_read_yet' }, { state: 'not_known' }, { state: 'unreachable' }, { state: 'not_permitted' },
      { state: 'sign_in_needed', en: 'Sign in first.', ta: 'முதலில் உள்நுழையுங்கள்.' }, { state: 'refused', status: 404, code: null, en: null, ta: null },
    ];
    for (const s of states) {
      const en = presentVersionExceptions('en', s); const ta = presentVersionExceptions('ta', s);
      expect(en.tone, s.state).toBe('unknown'); expect(en.rows).toEqual([]);
      expect(en.status).not.toBe(VERSION_EXCEPTIONS_COPY.en.none);
      expect(ta.status).not.toBe(en.status);
    }
    expect(presentVersionExceptions('en', { state: 'unreachable' }).status).toContain('head office could not be reached');
    expect(presentVersionExceptions('en', { state: 'not_read_yet' }).status).toMatch(/^Not known/);
    expect(presentVersionExceptions('ta', { state: 'sign_in_needed', en: 'Sign in first.', ta: 'முதலில் உள்நுழையுங்கள்.' }).status).toContain('முதலில் உள்நுழையுங்கள்.');
    expect(presentVersionExceptions('en', { state: 'refused', status: 404, code: null, en: null, ta: null }).status).toContain('404');
  });

  it('every word has its Tamil twin', () => {
    for (const [key, en] of Object.entries(VERSION_EXCEPTIONS_COPY.en)) {
      const ta = (VERSION_EXCEPTIONS_COPY.ta as Record<string, string>)[key];
      expect(ta, key).toBeTruthy();
      expect(ta, key).not.toBe(en);
    }
  });

  it('the Devices page draws the section from the bundled port and never calls the network itself', () => {
    const js = readFileSync('apps/web-erp/web/fleet.js', 'utf8');
    const html = readFileSync('apps/web-erp/web/fleet.html', 'utf8');
    expect(js).toMatch(/window\.fleetVersionExceptions/);
    expect(js).toMatch(/vxPort\.view\(lang, vxRead\)/);
    expect(/\bfetch\s*\(/.test(js)).toBe(false);
    for (const id of ['vx-h', 'vx-status', 'vx-rows', 'vx-info', 'vx-asat']) expect(html).toContain(`id="${id}"`);
  });
});

const line = (over: Partial<QuotationLine> = {}): QuotationLine => ({ lineId: 'l1', productId: 'p-new', description: 'New brand oil 1 L', unitPriceMinor: 180_00, quantityMinor: 10, uom: 'ea', taxBps: 500, ...over });
const base = { quotationId: 'Q9', tenantId: 't', storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', issuedBy: 'u-owner', issuedAt: '2030-06-01T06:00:00.000Z', validUntil: '2030-06-30' };
const accountantSays = { subjectRef: 'Q9', status: 'approved' as const, decidedBy: 'u-acct', reason: 'ok', byAccountant: true };
const ownerSays = { subjectRef: 'Q9', status: 'approved' as const, decidedBy: 'u-owner2', reason: 'ok', byOwner: true };

describe('OB-542: the OWNER\'s own quotation on a product with no known floor is approved by the ACCOUNTANT', () => {
  it('the owner quoting: refused without the accountant\'s approval — another owner\'s does not count', () => {
    const r = issueQuotation({ ...base, lines: [line()], floorNotKnown: ['p-new'], quoterIsOwner: true });
    expect(r).toMatchObject({ issued: false, outcome: 'floor_not_known_owner_quoted_unapproved' });
    expect(r.detail).toContain('only the accountant may approve');
    expect(issueQuotation({ ...base, lines: [line()], floorNotKnown: ['p-new'], quoterIsOwner: true, approval: ownerSays }).outcome).toBe('floor_not_known_owner_quoted_unapproved');
    expect(issueQuotation({ ...base, lines: [line()], floorNotKnown: ['p-new'], quoterIsOwner: true, approval: { ...accountantSays, subjectRef: 'Q-other' } }).outcome).toBe('floor_not_known_owner_quoted_unapproved');
  });

  it('the accountant\'s approval for exactly it lets it through, also for a below-floor line beside it; the quoter never approves his own', () => {
    const ok = issueQuotation({ ...base, lines: [line(), line({ lineId: 'l2', productId: 'p-rice', description: 'Rice', unitPriceMinor: 100_00 })], lineFloorsMinor: { 'p-rice': 120_00 }, floorNotKnown: ['p-new'], quoterIsOwner: true, approval: accountantSays });
    expect(ok).toMatchObject({ issued: true, quotation: { marginApprovedBy: 'u-acct', floorNotKnown: ['p-new'] } });
    expect(issueQuotation({ ...base, lines: [line()], floorNotKnown: ['p-new'], quoterIsOwner: true, approval: { ...accountantSays, decidedBy: 'u-owner' } })).toMatchObject({ issued: false, outcome: 'self_approved' });
  });

  it('anyone else quoting still needs the OWNER (OB-532): the accountant\'s approval does not count for them', () => {
    expect(issueQuotation({ ...base, issuedBy: 'u-mgr', lines: [line()], floorNotKnown: ['p-new'], approval: accountantSays }).outcome).toBe('floor_not_known_unapproved');
    expect(issueQuotation({ ...base, issuedBy: 'u-mgr', lines: [line()], floorNotKnown: ['p-new'], approval: ownerSays }).issued).toBe(true);
  });

  it('the engine knows the accountant\'s kind; only the accountant (and the owner, to grant it) hold its checker word', () => {
    expect(APPROVAL_KINDS['quotation_floor_not_known_owner_quoted']).toMatchObject({ makerPermission: 'pos.quotation.write', checkerPermission: 'pos.quotation.nofloor.ownerquote.approve' });
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('pos.quotation.nofloor.ownerquote.approve')).map((r) => r.id).sort()).toEqual([ACCOUNTANT_ROLE_ID, OWNER_ROLE_ID].sort());
    // The owner-only word for anyone else's quotation is unchanged.
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('pos.quotation.nofloor.approve')).map((r) => r.id)).toEqual([OWNER_ROLE_ID]);
    expect(APPROVALS_COPY.ta.kindQuotationFloorNotKnownOwnerQuoted).not.toBe(APPROVALS_COPY.en.kindQuotationFloorNotKnownOwnerQuoted);
  });
});

describe('OB-542 at head office\'s issue route: the quoter\'s owner role and the decider\'s accountant role are head office\'s own', () => {
  const body = { storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', validUntil: '2099-12-31', lines: [{ lineId: 'l1', productId: 'p-new', description: 'New brand oil 1 L', unitPriceMinor: 170_00, quantityMinor: 10, uom: 'ea', taxBps: 500 }] };
  const run = async (o: { quoter: string; decidedBy: string; kind: string; owners: readonly string[]; accountants: readonly string[] }) => {
    const recorded: Quotation[] = [];
    let spent = 0;
    const state: ApprovalState = {
      request: { requestId: 'areq-1', kind: o.kind, subjectRef: 'Q9', valueMinor: null, fingerprint: fingerprintOf(actionDetails(body, { quotationId: 'Q9' })), details: {}, summary: 's', reason: 'r', requestedBy: o.quoter, requestedAt: '2030-06-01T05:00:00.000Z' },
      decision: { requestId: 'areq-1', decision: 'approved', decidedBy: o.decidedBy, reason: 'ok', decidedAt: '2030-06-01T05:30:00.000Z', expiresAt: '2030-06-02T05:30:00.000Z' },
    };
    const approvals: ApprovalPort = {
      approvalState: () => state, approvalVersion: () => 1, spendApproval: () => { spent += 1; return true; },
      permissionsOfUser: () => ['pos.quotation.nofloor.approve', 'pos.quotation.nofloor.ownerquote.approve', 'price.change.approve'],
    };
    const route = quotationsRoutes({
      quotations: () => recorded, record: (_t, q) => { recorded.push(q); }, approvals, now: () => '2030-06-01T06:00:00.000Z',
      floorsAt: async () => ({ floors: {}, notKnown: ['p-new'] }), ownersAt: async () => o.owners, accountantsAt: async () => o.accountants,
    }).find((r) => r.method === 'POST' && r.path === '/v1/pos/quotations/:quotationId')!;
    try {
      const out = await route.handler({ tenantId: 't', userId: o.quoter, params: { quotationId: 'Q9' }, body: { ...body, approvalId: 'areq-1' }, query: {} } as unknown as Parameters<typeof route.handler>[0]);
      return { status: out.status, recorded: recorded.length, spent, by: recorded[0]?.marginApprovedBy };
    } catch (e) {
      return { status: (e as { status?: number }).status, code: (e as { body?: { code?: string } }).body?.code, next: (e as { body?: { nextSafeAction?: string } }).body?.nextSafeAction, recorded: recorded.length, spent };
    }
  };
  const OWNER_QUOTED = 'quotation_floor_not_known_owner_quoted';

  it('the owner quotes; this store\'s accountant approved it under the accountant\'s kind → made, the approval spent once', async () => {
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-acct', kind: OWNER_QUOTED, owners: ['u-owner'], accountants: ['u-acct'] })).toEqual({ status: 201, recorded: 1, spent: 1, by: 'u-acct' });
  });

  it('refused, nothing spent: an accountant of another store; another owner under the owner\'s kind; the owner\'s kind for his own', async () => {
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-acct-s2', kind: OWNER_QUOTED, owners: ['u-owner'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'quotation_floor_not_known_owner_quoted_unapproved', recorded: 0, spent: 0 });
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-owner2', kind: OWNER_QUOTED, owners: ['u-owner', 'u-owner2'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'quotation_floor_not_known_owner_quoted_unapproved', recorded: 0, spent: 0 });
    // The owner's own quotation asks under the accountant's kind — an approval under the owner's kind does not match it.
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-owner2', kind: 'quotation_floor_not_known', owners: ['u-owner', 'u-owner2'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'approval_does_not_match', recorded: 0, spent: 0 });
  });

  it('the refusal tells the owner to ask the ACCOUNTANT, by kind', async () => {
    const r = await run({ quoter: 'u-owner', decidedBy: 'u-acct-s2', kind: OWNER_QUOTED, owners: ['u-owner'], accountants: ['u-acct'] });
    expect(r).toMatchObject({ next: expect.stringContaining('kind quotation_floor_not_known_owner_quoted') });
  });

  it('a store manager quoting is unchanged (OB-532): the owner approves under the owner\'s kind; the accountant\'s kind does not match', async () => {
    expect(await run({ quoter: 'u-mgr', decidedBy: 'u-owner', kind: 'quotation_floor_not_known', owners: ['u-owner'], accountants: ['u-acct'] })).toEqual({ status: 201, recorded: 1, spent: 1, by: 'u-owner' });
    expect(await run({ quoter: 'u-mgr', decidedBy: 'u-acct', kind: OWNER_QUOTED, owners: ['u-owner'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'approval_does_not_match', recorded: 0, spent: 0 });
  });
});

describe('OB-542 on the Quotations page: the owner\'s own no-floor quotation offers to ask the ACCOUNTANT', () => {
  it('keeps the number and lines, asks with the accountant\'s kind, and says so in English and Tamil', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
      calls.push({ url, method, body });
      const reply = url === '/v1/approvals/requests'
        ? { status: 201, body: { requestId: 'areq-7', kind: 'quotation_floor_not_known_owner_quoted', status: 'waiting' } }
        : { status: 422, body: { error: { code: 'quotation_floor_not_known_owner_quoted_unapproved', whatHappened: 'only the accountant may approve', wasItSaved: 'not_saved', nextSafeAction: 'ask' } } };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const s = createQuotationsSession({ viewer: { userId: 'u-owner', permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch, newNumber: () => '31415926', now: () => '2030-06-01T06:00:00.000Z' });
    const lines = [{ productId: 'p-new', description: 'New brand oil 1 L', quantity: 10, unitPriceMinor: 180_00, uom: 'ea', taxBps: 500 }];
    expect((await s.make({ storeId: 'store-1', customerRef: 'Murugan Stores', validUntil: '2030-06-30', approvalId: '', lines })).result).toBe('refused');
    expect(s.belowFloor()).toBe('31415926');
    expect(s.needsAccountant()).toBe(true);
    expect(s.needsOwner()).toBe(false);
    const asked = await s.askApproval();
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/v1/approvals/requests', body: { kind: 'quotation_floor_not_known_owner_quoted', subjectRef: '31415926', valueMinor: null } });
    expect((calls[1]!.body as { details: Record<string, unknown> }).details).toEqual({ ...(calls[0]!.body as Record<string, unknown>), quotationId: '31415926' });
    expect(quotationsOutcomeWords('en', asked)).toBe(`${QUOTATIONS_COPY.en.askedAccountant} areq-7`);
    expect(quotationsOutcomeWords('ta', asked)).toBe(`${QUOTATIONS_COPY.ta.askedAccountant} areq-7`);
    expect(QUOTATIONS_COPY.ta.askAccountant).not.toBe(QUOTATIONS_COPY.en.askAccountant);
    expect(readFileSync('apps/web-erp/web/quotations.js', 'utf8')).toMatch(/needsAccountant\(\) \? 'askAccountant'/);
  });
});

describe('OB-543: the accountant reads the goods-receipt screen through its own narrow word, and matches the bill there', () => {
  const role = (id: string) => ROLE_CATALOGUE.find((r) => r.id === id)!;

  it('the accountant holds the narrow read and the bill-match word — not the broad stock read; the word is dotted', () => {
    const accountant = role(ACCOUNTANT_ROLE_ID);
    expect(accountant.permissions).toContain('inventory.goodsreceipt.read');
    expect(accountant.permissions).toContain('purchase.invoice.match');
    expect(accountant.permissions).not.toContain('inventory.availability.read');
    expect(GOODS_RECEIPT_SCREEN_READ_PERMISSION).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('inventory.goodsreceipt.read')).map((r) => r.id).sort()).toEqual([ACCOUNTANT_ROLE_ID, OWNER_ROLE_ID].sort());
  });

  it('the narrow word opens exactly ONE route — the screen\'s receipt list — and that route nothing else', () => {
    const routes = goodsReceiptRoutes({} as Parameters<typeof goodsReceiptRoutes>[0]);
    expect(routes.filter((r) => r.permission === 'inventory.goodsreceipt.read').map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/inventory/goods-receipt-review']);
    // The broad list is unchanged.
    expect(routes.find((r) => r.method === 'GET' && r.path === '/v1/inventory/goods-receipt')?.permission).toBe('inventory.availability.read');
  });

  it('the menu offers the goods-receipt screen to the accountant (and only that item from the narrow word); the box opens it', () => {
    const access = new AccessControl(ROLE_CATALOGUE, [{ userId: 'u-acct', roleId: ACCOUNTANT_ROLE_ID, branchScope: ['store-1'] }, { userId: 'u-cash', roleId: 'cashier', branchScope: ['store-1'] }]);
    const items = navigationFor(access, { userId: 'u-acct', branchId: 'store-1' }).flatMap((g) => g.items.map((i) => i.id));
    expect(items).toContain('goods-receipt');
    expect(canOpen(access, { userId: 'u-acct', branchId: 'store-1' }, '/goods-receipt')).toBe(true);
    expect(canOpen(access, { userId: 'u-cash', branchId: 'store-1' }, '/goods-receipt')).toBe(false);
    expect(ERP_NAVIGATION.filter((i) => (i.alsoOpenedWith ?? []).includes('inventory.goodsreceipt.read')).map((i) => i.id)).toEqual(['goods-receipt']);
    expect(permissionsForScreen('goods-receipt')).toEqual(['inventory.availability.read', 'inventory.goodsreceipt.read']);
    expect(permissionForScreen('goods-receipt')).toBe('inventory.availability.read');
    expect(permissionsForScreen('manager')).toEqual(['till.dayclose.read']);
  });

  it('the screen reads the narrow list for a narrow reader, the broad one otherwise; it may read and match', () => {
    expect(goodsReceiptListPathFor(['inventory.goodsreceipt.read', 'purchase.invoice.match'])).toBe('/v1/inventory/goods-receipt-review');
    expect(goodsReceiptListPathFor(['inventory.availability.read', 'inventory.goodsreceipt.read'])).toBe('/v1/inventory/goods-receipt');
    expect(goodsReceiptListPathFor(undefined)).toBe('/v1/inventory/goods-receipt');
    const ports = goodsReceiptPortsFromData({ userId: 'u-acct', permissions: role(ACCOUNTANT_ROLE_ID).permissions });
    expect(ports.mayRead()).toBe(true);
    expect(ports.mayMatchBill?.()).toBe(true);
    expect(ports.mayRecordReturn?.()).toBe(false);
    expect(goodsReceiptPortsFromData({ userId: 'u-cash', permissions: role('cashier').permissions }).mayRead()).toBe(false);
  });
});
