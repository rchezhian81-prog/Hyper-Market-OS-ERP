import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W4 · M31 connected run — M31-FR-01 versioned templates and retention · M31-FR-02 a document issued from a template and
 * reprinted identical · M31-FR-03 a send to a customer who never said yes is blocked · M31-FR-04 a do-not-contact customer
 * is never messaged — in a real browser, on the production API surface over real PostgreSQL when DATABASE_URL is set.**
 *   • documents: the owner drafts an order-notice layout and the store manager (a different person, §28) approves it; a
 *     notice is issued under v1; the owner then changes the layout (v2, approved the same way). A REPRINT of the notice is the
 *     very words issued under v1 — never re-rendered under v2 — marked as copy 1, and on record. On the Document retention
 *     page the notice is kept (inside its keeping time) and v1 must be kept, because a document was issued under it;
 *   • messages: SMS layouts approved by a second person, and the owner's budget. An offer to a customer with no yes to offers
 *     on record is refused (nothing queued). An order-ready message for a customer (who said yes) waits.
 *     Then the store manager records on the Do not contact page that this customer asked for no SMS: a new message is
 *     refused, and when the queue is worked the waiting one is WITHHELD, not sent — the stand-in transport sent nothing —
 *     and the Message queue page shows it held back with head office's reason.
 * Synthetic data only; the message transport is the recording stand-in (no live provider is called).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr';

describe.skipIf(!existsSync(CHROMIUM))('M31 on the production API (PostgreSQL when set), in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const transport = recordingTransport();
  const T = randomUUID();
  const call = (userId: string, path: string, body?: unknown) => shop.ho().request({
    method: body === undefined ? 'GET' : 'POST', path, userId, tenantId: T, ...(body === undefined ? {} : { idempotencyKey: `k-${randomUUID()}`, body }),
  });
  const ok = async (p: ReturnType<typeof call>, what: string): Promise<unknown> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL, harness: { notificationTransport: transport },
      pages: {
        '/document-retention': { html: 'document-retention.html', dataGlobal: 'documentRetentionData' },
        '/do-not-contact': { html: 'do-not-contact.html', dataGlobal: 'doNotContactData' },
        '/message-queue': { html: 'message-queue.html', dataGlobal: 'messageQueueData' },
      },
    });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('M31-FR-01/02: a layout approved by a second person issues a notice; a new layout never changes it; the reprint is identical; it is kept', async () => {
    await ok(call(OWNER, '/v1/documents/templates/order-notice/versions', { kind: 'notification', body: 'ORDER {{order}} IS READY — SRE Hyper Market', changeNote: 'first order notice' }), 'draft v1');
    await ok(call(MGR, '/v1/documents/templates/order-notice/versions/1/approve', {}), 'approve v1');
    await ok(call(OWNER, '/v1/documents/templates/order-notice/issue', { kind: 'notification', documentId: 'notice-ord-1', subjectRef: 'order:ORD-1', data: { order: 'ORD-1' }, retainUntil: '2099-12-31' }), 'issue');
    const issued = await ok(call(OWNER, '/v1/documents/issued/notice-ord-1'), 'read issued') as { content: string; templateVersion: number };
    expect(issued.templateVersion).toBe(1);
    expect(issued.content).toContain('ORDER ORD-1 IS READY');

    // The layout changes: a new version, approved by the other person — the issued notice keeps its layout.
    await ok(call(OWNER, '/v1/documents/templates/order-notice/versions', { kind: 'notification', body: 'Order {{order}}: please collect at the desk', changeNote: 'plainer words' }), 'draft v2');
    await ok(call(MGR, '/v1/documents/templates/order-notice/versions/2/approve', {}), 'approve v2');
    const reprint = await ok(call(OWNER, '/v1/documents/issued/notice-ord-1/reprint', { reason: 'the customer lost the first one' }), 'reprint') as { content: string; templateVersion: number; marking: string; copyNumber: number };
    expect(reprint.content, 'the reprint is the very words issued — never re-rendered under the new layout').toBe(issued.content);
    expect(reprint).toMatchObject({ templateVersion: 1, copyNumber: 1, marking: 'DUPLICATE — copy 1' });
    const after = await ok(call(OWNER, '/v1/documents/issued/notice-ord-1'), 'read again') as { content: string; reprints: { copyNumber: number; reprintedBy: string; reason: string }[] };
    expect(after.content).toBe(issued.content);
    expect(after.reprints).toEqual([expect.objectContaining({ copyNumber: 1, reprintedBy: OWNER, reason: 'the customer lost the first one' })]);

    await shop.restart();
    const s = await openAs(shop, browser, MGR, '/document-retention');
    try {
      await says(s.page, '#docs li[data-document="notice-ord-1"]', /notice-ord-1 · notification — keep/);
      expect(await s.page.locator('#docs li[data-document="notice-ord-1"] button').count(), 'nothing to dispose of while it is kept').toBe(0);
      await says(s.page, '#tpls li[data-template="order-notice@1"]', /order-notice v1 — must be kept/);
      await says(s.page, '#tpls', /order-notice v2/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('M31-FR-03/04: no yes on record is refused; a do-not-contact entry made on its page stops a new send and withholds the waiting one', async () => {
    await ok(call(OWNER, '/v1/notifications/templates/order-ready', { purpose: 'transactional', channel: 'sms', body: 'Your order {order} is ready to collect.' }), 'sms template');
    await ok(call(MGR, '/v1/notifications/templates/order-ready/approval', { version: 1 }), 'approve sms template');
    await ok(call(OWNER, '/v1/notifications/budget', { capMinor: 50_000, costMinorByChannel: { sms: 25 } }), 'budget');
    await ok(call(OWNER, '/v1/customers/demo-c-1/consent', { purpose: 'transactional', channel: 'sms', given: true, evidence: 'demo consent at the desk' }), 'consent');
    const intent = (customerId: string, order: string) => ({ customerId, purpose: 'transactional', channel: 'sms', templateId: 'order-ready', values: { order } });

    // FR-03: an offer to a customer who never said yes to offers is not sent — refused, nothing queued.
    await ok(call(OWNER, '/v1/notifications/templates/offer', { purpose: 'marketing', channel: 'sms', body: 'This week at SRE: {offer}. Reply STOP to opt out.' }), 'offer template');
    await ok(call(MGR, '/v1/notifications/templates/offer/approval', { version: 1 }), 'approve offer template');
    const noYes = await call(OWNER, '/v1/notifications/queue/n-no-yes', { customerId: 'demo-c-2', purpose: 'marketing', channel: 'sms', templateId: 'offer', values: { offer: 'rice 5kg ₹10 off' } });
    expect(noYes.status).toBe(422);
    expect((noYes.body as { error: { code: string } }).error.code).toBe('no_consent_on_record');
    await ok(call(OWNER, '/v1/notifications/queue/n-1', intent('demo-c-1', 'ORD-1')), 'enqueue for the customer who said yes');

    // FR-04: the store manager records, on the Do not contact page, that demo-c-1 asked for no SMS.
    const d = await openAs(shop, browser, MGR, '/do-not-contact');
    try {
      await says(d.page, '#rows', /Nobody is on the do-not-contact list\./);
      await d.page.fill('#a-customer', 'demo-c-1'); await d.page.selectOption('#a-channel', 'sms'); await d.page.selectOption('#a-source', 'customer_request');
      await d.page.fill('#a-reason', 'asked at the desk for no more SMS');
      await d.page.click('#a-add');
      await says(d.page, '#add-status', /^Added\./);
      await says(d.page, '#rows li[data-customer="demo-c-1"]', /demo-c-1 — not to be contacted: SMS/);
      expect(d.writes).toHaveLength(1);
      expect(d.errors).toEqual([]);
    } finally { await d.close(); }

    const blocked = await call(OWNER, '/v1/notifications/queue/n-2', intent('demo-c-1', 'ORD-3'));
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: { code: string } }).error.code).toBe('customer_suppressed');
    const drained = await ok(call(OWNER, '/v1/notifications/queue/drain', {}), 'work the queue') as { outcome?: { id: string; result: string }[] };
    expect(JSON.stringify(drained)).toContain('withheld');
    expect(transport.sent, 'the stand-in transport sent nothing to a do-not-contact customer').toEqual([]);

    await shop.restart();
    const q = await openAs(shop, browser, OWNER, '/message-queue');
    try {
      await says(q.page, '#withheld li[data-id="n-1"]', /n-1 · SMS/);
      await says(q.page, '#withheld li[data-id="n-1"]', /suppressed: demo-c-1 is on the do-not-contact register for sms/);
      await says(q.page, '#pending', /Nothing is waiting\./);
      expect(q.writes).toEqual([]);
      expect(q.errors).toEqual([]);
    } finally { await q.close(); }
  });
});
