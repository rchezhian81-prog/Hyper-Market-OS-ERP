import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { recordingPartner } from '../support/outbound-partner';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **W3 · D14-FR-06 (M32-FR-01/02 · §30.1 · OB-72 · P-08 · hard rules #4 and #6): the Partner webhooks page, on the store
 * computer, over head office's real outbound-webhook routes, with a recording partner (no partner is live).**
 *   • the IT administrator sets up a subscription; head office asks for a second person's approval; she asks for it on the
 *     page; a second administrator approves it in his own session; she sets it up again and it names him;
 *   • a sale happens; the partner refuses the message (400); it becomes a dead letter the page counts and lists;
 *   • she sends it again: it is back in the queue as series 2 — and the first attempt is still on the ledger (never deleted);
 *   • every message since a date is read; she switches the subscription off, and it is kept;
 *   • the connector queue of an outside system is read (nothing waiting); Tamil words;
 *   • a cashier whom the box lets open the page is refused by head office, in its words, and offered no form.
 * The signing secret is never typed on the page — only its vault name. Synthetic data only.
 */

const OWNER = 'u-owner'; const IT = 'u-it'; const IT2 = 'u-it-2'; const CASH = 'u-cash';
const SECRET = ['w3', 'webhook', 'page', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');
const WORDS = ['platform.health.read', 'platform.setup.write', 'approvals.request.read'];
const partner = recordingPartner();

describe.skipIf(!HAVE_BROWSER)('Partner webhooks (W3 · D14-FR-06)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'partner-webhooks',
      harness: { outboundTransport: partner, outboundSecrets: new Map([['w3-partner', SECRET]]) },
      people: [{ userId: IT, permissions: WORDS }, { userId: CASH, permissions: ['platform.health.read'] }],
      seed: async (ho, T) => {
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, IT, 'platform_admin');
        await ho.provisionRole(T, IT2, 'platform_admin');
        await ho.provisionRole(T, CASH, 'cashier');
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('subscribes with a second admin\'s approval, dead-letters a refused message, sends it again and keeps the first', async () => {
    const p = await shop.open(IT, '/partner-webhooks');
    await says(p.page, '#none', /No partner is subscribed yet/);
    await says(p.page, '#v-sender', /recording-partner/);
    await p.page.fill('#s-id', 'SUB-W3');
    await p.page.fill('#s-partner', 'sre-integrator');
    await p.page.fill('#s-url', 'https://integrator.example.test/hooks');
    await p.page.fill('#s-key', 'w3-partner');
    await p.page.fill('#s-tries', '2');
    await p.page.check('#s-events input[value="SaleCommitted"]');
    await p.page.click('#s-save');
    await says(p.page, '#new-status', /A second person must approve this subscription first/);
    await p.page.click('#s-ask');
    await says(p.page, '#new-status', /Write the reason first/);
    await p.page.fill('#s-why', 'our own integrator needs the sales feed');
    await p.page.click('#s-ask');
    await says(p.page, '#new-status', /^Asked\./);
    await p.page.click('#s-save');
    await says(p.page, '#new-status', /Still waiting for the second person/);
    // The second administrator approves exactly this subscription, in his own session.
    const asked = (await shop.call('GET', '/v1/approvals/requests', IT2)).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const request = asked.waitingForMe.find((r) => r.kind === 'partner_webhook_subscription' && r.subjectRef === 'SUB-W3');
    expect(request).toBeDefined();
    expect((await shop.call('POST', `/v1/approvals/requests/${request!.requestId}/decide`, IT2, { decision: 'approved', reason: 'checked the partner and its address' })).status).toBe(201);
    await p.page.click('#s-save');
    await says(p.page, '#new-status', new RegExp(`^Set up, approved by ${IT2}\\.$`));
    await says(p.page, '#rows', /SUB-W3.*sre-integrator.*SaleCommitted.*On/);

    // A sale; the partner refuses the message; it is a dead letter.
    const sale = { saleId: 'W3-E2E-1', receiptNumber: 'R-W3-E2E-1', laneId: 'lane-1', cashierId: CASH, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(), totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }] };
    expect((await shop.call('POST', '/v1/sales', OWNER, sale)).status).toBe(202);
    partner.answers.push(400);
    await p.page.click('#drain');
    await says(p.page, '#page-status', /Sent: 1 message\(s\) handled/);
    await says(p.page, '#v-dead', /^1$/);
    await p.page.click('#rows tr[data-id="SUB-W3"]');
    await says(p.page, '#dead-list', /SaleCommitted.*1 attempt\(s\): the partner refused it \(400\)/);
    expect(await p.page.isVisible('#facts >> text=w3-partner')).toBe(true);
    await p.page.click('#dead-list button');
    await says(p.page, '#record-status', /Put back in the queue \(series 2\)/);
    await says(p.page, '#v-dead', /^0$/);
    await says(p.page, '#dead-list', /No dead letters/);
    // The first series' dead-lettered attempt is still on head office's ledger: sending again deleted nothing.
    const facts = await shop.ho.store.readStream(shop.tenantId, streamName(STREAM.platform, 'outbound-webhooks'));
    expect(facts.filter((f) => (f.event.payload as { outcome?: string }).outcome === 'dead_lettered')).toHaveLength(1);
    expect(facts.some((f) => (f.event.payload as { change: string }).change === 'requeued')).toBe(true);
    // Every message since today.
    await p.page.click('#recon');
    await says(p.page, '#recon-totals', /1 message\(s\): 0 delivered, 1 waiting, 0 dead letter\(s\)/);
    // Switched off — kept.
    await p.page.click('#off');
    await says(p.page, '#record-status', /Switched off\. It is kept/);
    await says(p.page, '#rows', /SUB-W3.*Switched off/);
    // The connector queue of an outside system.
    await p.page.fill('#q-id', 'tally');
    await p.page.click('#q-read');
    await says(p.page, '#q-totals', /^0 waiting, 0 dead letter\(s\)\.$/);
    // No secret anywhere on the page.
    expect(await p.page.content()).not.toContain(SECRET);
    await p.page.click('#lang');
    await says(p.page, '#page-h', /^கூட்டாளர் வெப்ஹூக்குகள்$/);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/partner-webhooks');
    await says(c.page, '#page-status', /Head office refused:/);
    expect(await c.page.isVisible('#sub-form')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
