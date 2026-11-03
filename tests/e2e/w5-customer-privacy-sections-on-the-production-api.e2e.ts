import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 · route audit bundle 8 — the customer and privacy sections on eight office pages, in a real browser, on the
 * production API surface (over real PostgreSQL when DATABASE_URL is set).** Synthetic data only.
 *   • Customers (M16-FR-04 · P-04): who looked at a customer's record — the manager's look is listed;
 *   • Customer data requests (M20-FR-04 · hard rule #6): the sealed record of a finished erasure — who approved, who carried
 *     it out, what was erased and what the law kept; (M01-FR-02) the processor-contract register: a company is added and
 *     head office's check is read;
 *   • Incidents (C2 · DPDP s.8(6)): a leak of customer data — the Board at once, the 72-hour report and the people affected,
 *     each with what is still missing; it sends nothing;
 *   • Loyalty (M16-FR-02): a member leaves at the desk — head office holds them as left;
 *   • Message queue (PA-08 r6): an approved message is stopped with a reason — head office holds it as withdrawn;
 *   • Campaigns (M21-FR-01 · P-08): the decision log names the plan, its reach and who was left out;
 *   • Trial switches and shop account (OB-324): the consent-manager exceptions are read (none brought in yet);
 *   • Store credit and vouchers (M17-FR-04): one family's two cards as one pooled balance.
 * Nothing is written on open; a cashier is offered none of the sections; the sections read in Tamil.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2'; const MGR = 'u-mgr'; const CASH = 'u-cash';

describe.skipIf(!existsSync(CHROMIUM))('W5 customer and privacy sections on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = (who: string, method: 'GET' | 'POST', path: string, body?: unknown) => shop.ho().request({ method, path, userId: who, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `seed-${randomUUID()}`, body: body ?? {} } : {}) });
  const must = async (p: ReturnType<typeof as>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body as Record<string, unknown>; };
  let memberRef = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    const page = (html: string, dataGlobal: string) => ({ html, dataGlobal });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL, pages: {
        '/customers': page('customers.html', 'customersData'), '/data-requests': page('data-requests.html', 'dataRequestsData'),
        '/incidents': page('incidents.html', 'incidentsData'), '/loyalty': page('loyalty.html', 'loyaltyDeskData'),
        '/message-queue': page('message-queue.html', 'messageQueueData'), '/campaigns': page('campaigns.html', 'campaignsData'),
        '/rollout': page('rollout.html', 'rolloutData'), '/stored-value': page('stored-value.html', 'storedValueData'),
      },
    });
    const h = shop.ho();
    await h.seedOwner(T, OWNER);
    await h.provisionOwner(T, OWNER2);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier');
    // The manager opens a customer's record (every look is written down).
    await as(MGR, 'GET', '/v1/customers/cust-w5-look/profile');
    // A demo customer's erasure, carried through by two people (OB-49: demo records only).
    await must(as(OWNER, 'POST', '/v1/privacy/pii/demo-w5-erase/contact', { recordCount: 1 }), 'pii contact');
    await must(as(OWNER, 'POST', '/v1/privacy/pii/demo-w5-erase/tax-invoices', { recordCount: 2, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31' }), 'pii invoices');
    await must(as(OWNER, 'POST', '/v1/privacy/data-requests/dsr-w5-1', { customerRef: 'demo-w5-erase', kind: 'erasure' }), 'raise');
    await must(as(OWNER, 'POST', '/v1/privacy/data-requests/dsr-w5-1/verification', { verifiedBy: 'came to the desk with the phone the account is on' }), 'verify');
    await must(as(OWNER, 'POST', '/v1/privacy/data-requests/dsr-w5-1/erasure-approval', {}), 'approve');
    await must(as(MGR, 'POST', '/v1/privacy/data-requests/dsr-w5-1/erasure-execution', {}), 'execute');
    // A loyalty member enrolled at the desk.
    memberRef = String((await must(as(MGR, 'POST', '/v1/loyalty/members', { mobile: '9000000522', consent: true, verifiedHow: 'seen_on_phone' }), 'enrol'))['memberRef']);
    // An approved marketing message (drafted by one owner, approved by the other), and a campaign planned with it.
    await must(as(OWNER, 'POST', '/v1/notifications/templates/tpl-w5', { purpose: 'marketing', channel: 'sms', body: 'Fresh offers this week at SRE (synthetic).' }), 'draft');
    await must(as(OWNER2, 'POST', '/v1/notifications/templates/tpl-w5/approval', { version: 1 }), 'approve template');
    await must(as(OWNER, 'POST', '/v1/service/campaigns/camp-w5/plan', { purpose: 'marketing', channel: 'sms', templateId: 'tpl-w5', templateApproved: true, containsPromotion: true, audience: ['cust-a', 'cust-b'] }), 'plan');
    // One family's two cards.
    await must(as(OWNER, 'POST', '/v1/stored-value/instruments', { instrumentId: 'GC-W5-1', kind: 'gift_card', ownerRef: 'fam-w5', faceValueMinor: 50_000 }), 'card 1');
    await must(as(OWNER, 'POST', '/v1/stored-value/instruments', { instrumentId: 'SC-W5-2', kind: 'store_credit', ownerRef: 'fam-w5', faceValueMinor: 12_550 }), 'card 2');
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('Customers: who looked at a record (M16-FR-04)', async () => {
    const o = await openAs(shop, browser, OWNER, '/customers');
    try {
      await says(o.page, '#desk-views-h', /^Who looked at a customer's record$/);
      expect(o.writes, 'nothing is written on open').toEqual([]);
      await o.page.fill('#cd-views-customer', 'cust-w5-look');
      await o.page.click('#cd-views-form-go');
      await says(o.page, '#cd-views-list', /^u-mgr — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      await o.page.click('#lang');
      await says(o.page, '#desk-views-h', /^வாடிக்கையாளர் பதிவைப் பார்த்தவர்கள்$/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
  });

  it('Customer data requests: the sealed record of a finished erasure, and the processor-contract register (M20-FR-04 · M01-FR-02)', async () => {
    const o = await openAs(shop, browser, OWNER, '/data-requests');
    try {
      await says(o.page, '#desk-sealed-h', /^Sealed records of erasures$/);
      await o.page.click('#cd-sealed-go');
      await says(o.page, '#cd-sealed-list', /demo-w5-erase · dsr-w5-1/);
      await o.page.click('#cd-sealed-list li[data-request="dsr-w5-1"] button.show-sealed');
      await says(o.page, '#cd-sealed-list li[data-request="dsr-w5-1"] .sealed', /approved by u-owner · carried out by u-mgr/);
      await says(o.page, '#cd-sealed-list li[data-request="dsr-w5-1"] .kept', /^Kept by law: tax-invoices \(tax_invoice, 2034-03-31\)$/);

      await o.page.click('#cd-proc-go');
      await says(o.page, '#cd-proc-list', /^Nothing on record\.$/);
      await o.page.fill('#cd-proc-vendorId', 'sms-co');
      await o.page.fill('#cd-proc-vendorName', 'Synthetic SMS Co');
      await o.page.fill('#cd-proc-categories', 'phone, name');
      await o.page.fill('#cd-proc-purpose', 'order messages');
      await o.page.fill('#cd-proc-contractRef', 'DPA-2026-07');
      await o.page.fill('#cd-proc-contractFrom', '2026-01-01');
      await o.page.click('#cd-proc-form-go');
      await says(o.page, '#cd-proc-record-status', /^Added to the list\.$/);
      await says(o.page, '#cd-proc-list li[data-vendor="sms-co"]', /^Synthetic SMS Co \(sms-co\) — name, phone · order messages · DPA-2026-07 · 2026-01-01 → no end date$/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    const reg = (await as(OWNER, 'GET', '/v1/privacy/processor-contracts')).body as { register: { vendorId: string; recordedBy: string }[] };
    expect(reg.register).toEqual([expect.objectContaining({ vendorId: 'sms-co', recordedBy: OWNER })]);
  });

  it('Incidents: a customer-data leak — what is due, to whom, by when, and what is still missing (C2)', async () => {
    const o = await openAs(shop, browser, OWNER, '/incidents');
    try {
      await says(o.page, '#desk-breach-h', /^Customer data leak/);
      await o.page.fill('#cd-breach-breachId', 'LEAK-W5-1');
      await o.page.fill('#cd-breach-discovered', '2026-11-02T09:15');
      await o.page.fill('#cd-breach-categories', 'phone, address');
      await o.page.fill('#cd-breach-count', '14');
      await o.page.fill('#cd-breach-description', 'A printed delivery list was left on the counter (synthetic).');
      await o.page.click('#cd-breach-form-go');
      await says(o.page, '#cd-breach-deadline', /^Full report due by: 2026-11-05 09:15$/);
      await says(o.page, '#cd-breach-obligations li[data-obligation="board_immediate_intimation"]', /^Tell the Data Protection Board at once — /);
      await says(o.page, '#cd-breach-obligations li[data-obligation="affected_principal_notices"]', /still missing: .*contactPoint/);
      expect(o.writes).toEqual(['POST /v1/privacy/breach/assess']);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
  });

  it('Loyalty, Message queue, Campaigns, Trial switches, Store credit: leave, stop a message, the log, consent exceptions, a family\'s balance', async () => {
    const l = await openAs(shop, browser, MGR, '/loyalty');
    try {
      await l.page.fill('#cd-leave-member', memberRef);
      await l.page.fill('#cd-leave-reason', 'asked to stop at the desk');
      await l.page.click('#cd-leave-form-go');
      await says(l.page, '#cd-leave-status', /^Recorded\. The member has left/);
      expect(l.errors).toEqual([]);
    } finally { await l.close(); }
    const standing = (await as(MGR, 'GET', `/v1/loyalty/members/${memberRef}/standing`)).body as Record<string, unknown>;
    expect(JSON.stringify(standing)).toMatch(/"left"/);

    const q = await openAs(shop, browser, OWNER, '/message-queue');
    try {
      await q.page.click('#cd-withdraw-go');
      await says(q.page, '#cd-withdraw-list li[data-template="tpl-w5"]', /tpl-w5 · version 1 · marketing\/sms/);
      await q.page.fill('#cd-withdraw-tpl-w5-1-reason', 'offer recalled (synthetic)');
      await q.page.click('#cd-withdraw-tpl-w5-1-go');
      await says(q.page, '#cd-withdraw-list', /^No approved message\.$/);
      expect(q.errors).toEqual([]);
    } finally { await q.close(); }
    const tpls = (await as(OWNER, 'GET', '/v1/notifications/templates')).body as { templates: { templateId: string; state: string; withdrawnBy?: string; withdrawalReason?: string }[] };
    expect(tpls.templates.filter((x) => x.templateId === 'tpl-w5').at(-1)).toMatchObject({ state: 'withdrawn', withdrawnBy: OWNER, withdrawalReason: 'offer recalled (synthetic)' });

    const c = await openAs(shop, browser, OWNER, '/campaigns');
    try {
      await c.page.click('#cd-log-go');
      await says(c.page, '#cd-log-list li[data-campaign="camp-w5"]', /^camp-w5 · marketing\/sms — would reach 0, left out 2 .* · by u-owner · /);
      expect(c.errors).toEqual([]);
    } finally { await c.close(); }

    const r = await openAs(shop, browser, OWNER, '/rollout');
    try {
      await r.page.click('#cd-cx-go');
      await says(r.page, '#cd-cx-list', /^Every record brought in was applied\.$/);
      expect(r.errors).toEqual([]);
    } finally { await r.close(); }

    const s = await openAs(shop, browser, OWNER, '/stored-value');
    try {
      expect(s.writes).toEqual([]);
      await s.page.fill('#cd-house-customer', 'fam-w5');
      await s.page.click('#cd-house-form-go');
      await says(s.page, '#cd-house-balance', /^Left on all cards together: ₹625\.50 · 2 card\(s\)$/);
      await s.page.click('#lang');
      await says(s.page, '#cd-house-balance', /^எல்லா அட்டைகளிலும் சேர்த்து மீதம்: ₹625\.50 · 2 அட்டை\(கள்\)$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('a cashier is offered none of these sections', async () => {
    for (const path of ['/customers', '/data-requests', '/message-queue', '/campaigns']) {
      const o = await openAs(shop, browser, CASH, path);
      try {
        expect(await o.page.locator('section[data-desk]:not([hidden])').count(), path).toBe(0);
        expect(o.writes).toEqual([]);
      } finally { await o.close(); }
    }
  });
});
