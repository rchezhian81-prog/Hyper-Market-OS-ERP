import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { confirmIt, sheetOpens, goBack } from './lib/confirm-sheet';
import { auditPage } from './lib/a11y-audit';

/**
 * **U6 (UI/UX gap audit §27 CRM rows · M21-FR-03 · M21-FR-04 · M16-FR-02 · crm-service.md · OB-698): the three CRM screens
 * on the real store computer over head office's real routes, in a real browser.**
 *
 *   • **Compensation.** The desk person reads the desk's limits as cards (₹500 alone · ₹5,000 ceiling · their own ₹500);
 *     chooses the case from the register; gives ₹200 after ONE confirm sheet (two interactions) — recorded in their name;
 *     types ₹800: the page says it is above their limit and the one button now reads "Ask for approval"; after the sheet
 *     the request waits on the Approvals path for a second person; the owner approves it in their own session; back on the
 *     page the request reads approved with "Give it now"; the sheet names the approver; the grant lands with approvedBy;
 *     ₹6,000 is refused BEFORE anything is sent (the greyed button says why). Every write is the expected one.
 *   • **Customer satisfaction.** The resolved case comes first and can be rated; the open one cannot (the greyed button
 *     says why); a score is one tap of five; the rating is recorded in the case's own customer's name; the report's CSAT
 *     reads 4.00 with its response rate beside it.
 *   • **Check consent.** Two interactions: three letters of the name list Kavitha Raman with WhatsApp "yes" and SMS "no"
 *     (her STOP after her yes), "Open the records" shows every record by purpose with the evidence; a cashier with no
 *     directory word is told so and checks by the number.
 *   • Each page in Tamil on the toggle; one primary action; the rendered WCAG audit clean; at 360px nothing reaches past
 *     the viewport. Synthetic data only. Without a browser binary it SKIPS.
 */

const OWNER = 'u-owner'; const DESK = 'u-desk'; const CASHIER = 'u-cash';
const DESK_WORDS = ['service.case.read', 'service.case.manage', 'customer.segment.read'];
const OWNER_WORDS = ['service.case.read', 'service.case.manage', 'service.compensation.approve', 'customer.consent.read', 'customer.consent.write', 'customer.segment.read'];
const CASHIER_WORDS = ['customer.consent.read', 'loyalty.member.enrol'];
let MEMBER = '';

/** What reaches past a 360px viewport (a register's own scroll box is contained). */
const widest = (page: Page): Promise<string[]> => page.evaluate(`(() => {
  const w = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > w + 1) return ['document scrollWidth=' + document.documentElement.scrollWidth];
  return Array.from(document.querySelectorAll('body *'))
    .filter((el) => !el.closest('.sre-scroll-x'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > w + 1 && r.width > 0)
    .filter(({ el }) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1))
    .slice(0, 8)
    .map(({ el, r }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right=' + Math.round(r.right));
})()`) as Promise<string[]>;

const primaries = (page: Page): Promise<number> => page.evaluate(`Array.from(document.querySelectorAll('.sre-btn-primary')).filter((b) => b.offsetParent !== null).length`) as Promise<number>;

describe.skipIf(!HAVE_BROWSER)('U6 · the CRM screens: compensation for a separate approver, satisfaction, consent by name', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'u6-crm',
      people: [{ userId: OWNER, permissions: OWNER_WORDS }, { userId: DESK, permissions: DESK_WORDS }, { userId: CASHIER, permissions: CASHIER_WORDS }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, DESK, 'store_manager', [store]);
        await ho.provisionRole(T, CASHIER, 'cashier', [store]);
        const call = async (method: 'POST', path: string, who: string, body: unknown) => {
          const r = await ho.request({ method, path, userId: who, tenantId: T, branchId: store, idempotencyKey: `seed-${path}-${JSON.stringify(body).length}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
          return r.body as Record<string, unknown>;
        };
        // a named member (OB-329), so the directory carries her name; her consent: WhatsApp yes; SMS yes, then STOP
        const joined = await call('POST', '/v1/loyalty/members', CASHIER, { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone', name: 'Kavitha Raman' });
        MEMBER = String(joined['memberRef']);
        await call('POST', `/v1/customers/${MEMBER}/consent`, OWNER, { purpose: 'marketing', channel: 'whatsapp', given: true, evidence: 'signed the enrolment form at the desk' });
        await call('POST', `/v1/customers/${MEMBER}/consent`, OWNER, { purpose: 'marketing', channel: 'sms', given: true, evidence: 'ticked yes on the app' });
        await call('POST', `/v1/customers/${MEMBER}/consent`, OWNER, { purpose: 'marketing', channel: 'sms', given: false, evidence: 'replied STOP' });
        // two cases on her: K-1 open (the compensation), K-2 resolved (the rating)
        await call('POST', '/v1/service/cases/K-1', DESK, { kind: 'complaint', customerRef: MEMBER, priority: 'normal', summary: 'The milk was sour', assignedTo: DESK });
        await call('POST', '/v1/service/cases/K-2', DESK, { kind: 'enquiry', customerRef: MEMBER, priority: 'low', summary: 'When does the bakery open', assignedTo: DESK });
        await call('POST', '/v1/service/cases/K-2/resolution', DESK, { resolution: 'Told her: 7am every day.' });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('Compensation: within the limit it is given after one confirm; above it a second person approves on the Approvals path; above the ceiling nothing is sent', async () => {
    const d = await shop.open(DESK, '/compensation/');
    await says(d.page, '#limits-cards', /₹500\.00/);
    await says(d.page, '#limits-cards', /₹5,000\.00/);
    expect(d.writes, 'nothing is written on open').toEqual([]);
    expect(await primaries(d.page), 'one primary action').toBeLessThanOrEqual(1);
    // the register of cases: choose K-1
    await d.page.waitForSelector('#cases-table tr[data-case="K-1"]');
    await d.page.click('#cases-table tr[data-case="K-1"] button[data-choose="K-1"]');
    await says(d.page, '#case-h', /^Case K-1$/);
    await says(d.page, '#given-table', /Nothing has been given on this case/);
    expect(await primaries(d.page), 'still one primary action').toBe(1);

    // ₹200 — within the agent's own ₹500: the route is said, the button reads Give, the sheet asks, the grant lands
    await d.page.selectOption('#g-kind', 'goodwill_credit');
    await d.page.fill('#g-rupees', '200'); await d.page.fill('#g-reason', 'sour milk, apology');
    await says(d.page, '#g-route', /^Within your limit/);
    await says(d.page, '#g-give-text', /^Give compensation$/);
    await d.page.click('#g-give');
    expect(await sheetOpens(d.page)).toMatch(/^Give this compensation\?$/);
    await goBack(d.page);
    expect(d.writes, 'going back writes nothing').toEqual([]);
    await d.page.click('#g-give');
    await confirmIt(d.page);
    await says(d.page, '#g-status', /^Given\. It is recorded against you\.$/);
    expect(d.writes).toEqual(['POST /v1/service/cases/K-1/compensation']);
    await says(d.page, '#given-table', /₹200\.00/);
    await says(d.page, '#given-table', /Goodwill credit/);

    // ₹800 — above ₹500: the page says so first and the one button becomes "Ask for approval"
    await d.page.fill('#g-rupees', '800'); await d.page.fill('#g-reason', 'she threw out the whole shopping');
    await says(d.page, '#g-route', /^Above your limit/);
    await says(d.page, '#g-give-text', /^Ask for approval$/);
    await d.page.click('#g-give');
    expect(await sheetOpens(d.page)).toMatch(/^Ask for approval\?$/);
    await confirmIt(d.page);
    await says(d.page, '#g-status', /^Asked\. It waits for a person who may approve compensation on the Approvals page/);
    expect(d.writes).toEqual(['POST /v1/service/cases/K-1/compensation', 'POST /v1/approvals/requests']);
    await d.page.waitForSelector('#asked-table tr[data-status="waiting"]');
    await says(d.page, '#asked-table', /₹800\.00/);
    expect(await d.page.locator('#asked-table button[data-give-approved]').count(), 'nothing to give until it is approved').toBe(0);

    // ₹6,000 — above the ₹5,000 ceiling: refused before anything is sent, the greyed button says why
    await d.page.fill('#g-rupees', '6000');
    await says(d.page, '#g-route', /^Above the desk ceiling/);
    expect(await d.page.isDisabled('#g-give')).toBe(true);
    await says(d.page, '#g-give-why', /^More than the desk ceiling/);
    expect(d.writes).toHaveLength(2);

    // the owner approves in THEIR session (the Approvals path), never the asker
    const inbox = (await shop.call('GET', '/v1/approvals/requests', OWNER)).body as { waitingForMe: { requestId: string; kind: string; valueMinor: number }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === 'service_compensation');
    expect(req).toMatchObject({ valueMinor: 80_000 });
    const decided = await shop.call('POST', `/v1/approvals/requests/${req!.requestId}/decide`, OWNER, { decision: 'approved', reason: 'the whole shopping was lost' });
    expect([200, 201], JSON.stringify(decided.body)).toContain(decided.status);

    // back on the desk: the request reads approved, "Give it now" opens the sheet naming the approver, the grant lands with approvedBy
    await d.page.click('#g-back'); // the register again
    await d.page.click('#cases-table tr[data-case="K-1"] button[data-choose="K-1"]');
    await d.page.waitForSelector('#asked-table tr[data-status="approved"]');
    await d.page.click('#asked-table button[data-give-approved]');
    expect(await sheetOpens(d.page)).toMatch(/^Give this compensation\?$/);
    await says(d.page, '#sre-confirm', /Approved by u-owner on the Approvals page/);
    await confirmIt(d.page);
    await says(d.page, '#g-status', /^Given\. It is recorded against you\.$/);
    expect(d.writes.at(-1)).toBe('POST /v1/service/cases/K-1/compensation');
    await says(d.page, '#given-table', /₹800\.00/);
    const held = (await shop.call('GET', '/v1/service/cases/K-1/compensations', OWNER)).body as { count: number; totalMinor: number; compensations: { amountMinor: number; grantedBy: string; approvedBy?: string }[] };
    expect(held).toMatchObject({ count: 2, totalMinor: 100_000 });
    expect(held.compensations.find((c) => c.amountMinor === 80_000)).toMatchObject({ grantedBy: DESK, approvedBy: OWNER });
    expect(held.compensations.find((c) => c.amountMinor === 20_000)?.approvedBy).toBeUndefined();
    // the same request cannot be spent twice: head office refuses by name, the page says so in three parts
    expect(await d.page.locator('#asked-table button[data-give-approved]').count()).toBe(0);

    // Tamil on the toggle; the audit clean at a desk
    await d.page.click('#lang');
    await says(d.page, '#page-h', /^இழப்பீடு$/);
    await says(d.page, '#limits-h', /^மேசையின் வரம்புகள்$/);
    await says(d.page, '#g-give-text', /^இழப்பீடு கொடு$|^ஒப்புதலுக்குக் கேள்$/);
    await d.page.click('#lang');
    const findings = await auditPage(d.page, { minTarget: 44 });
    expect(findings, JSON.stringify(findings)).toEqual([]);
    expect(d.errors).toEqual([]);
    await d.close();
  });

  it('Customer satisfaction: the resolved case first and rated in one tap of five; the open case cannot be, said why; the report counts it', async () => {
    const d = await shop.open(DESK, '/satisfaction/');
    await says(d.page, '#report-cards', /No customer has rated a case yet/);
    await d.page.waitForSelector('#cases-table tr[data-case="K-2"]');
    const order = await d.page.evaluate(`Array.from(document.querySelectorAll('#cases-table tbody tr[data-case]')).map((r) => r.dataset.case + ':' + r.dataset.ratable)`) as string[];
    expect(order).toEqual(['K-2:true', 'K-1:false']);
    expect(d.writes).toEqual([]);
    // the open case: chosen, but the record button is greyed and says why
    await d.page.click('#cases-table tr[data-case="K-1"] button[data-choose="K-1"]');
    await says(d.page, '#rate-facts', /K-1/);
    expect(await d.page.isDisabled('#r-record')).toBe(true);
    await says(d.page, '#r-record-why', /still open/);
    // the resolved case: one tap on 4, record — in the member's own name
    await d.page.click('#r-back');
    await d.page.click('#cases-table tr[data-case="K-2"] button[data-choose="K-2"]');
    await says(d.page, '#rate-facts', new RegExp(`In the name of: .*${MEMBER}`));
    expect(await d.page.isDisabled('#r-record'), 'no score yet').toBe(true);
    await d.page.click('#s-4');
    expect(await d.page.getAttribute('#s-4', 'aria-pressed')).toBe('true');
    expect(await d.page.isDisabled('#r-record')).toBe(false);
    await d.page.fill('#r-comment', 'quick and polite');
    await d.page.click('#r-record');
    await says(d.page, '#r-status', /^Recorded\./);
    expect(d.writes).toEqual(['POST /v1/service/cases/K-2/satisfaction']);
    await says(d.page, '#report-cards', /4\.00/);
    const report = (await shop.call('GET', '/v1/service/report', OWNER)).body as { csatHundredths: number };
    expect(report.csatHundredths).toBe(400);
    expect(await primaries(d.page)).toBe(1);
    await d.page.click('#lang');
    await says(d.page, '#page-h', /^வாடிக்கையாளர் திருப்தி$/);
    await says(d.page, '#s-4', /நன்று/);
    await d.page.click('#lang');
    const findings = await auditPage(d.page, { minTarget: 44 });
    expect(findings, JSON.stringify(findings)).toEqual([]);
    expect(d.errors).toEqual([]);
    await d.close();
  });

  it('Check consent: three letters of the name, then the records — two interactions; a cashier checks by the number', async () => {
    const o = await shop.open(OWNER, '/consent-check/');
    await o.page.waitForSelector('#f-text');
    await o.page.fill('#f-text', 'kav'); // interaction 1: the matches appear as the letters are typed
    await o.page.waitForSelector(`#matches-table tr[data-customer="${MEMBER}"]`);
    await says(o.page, `#matches-table tr[data-customer="${MEMBER}"]`, /Kavitha Raman/);
    await says(o.page, `#matches-table .sre-chips[data-customer="${MEMBER}"] [data-channel="whatsapp"]`, /yes/);
    await says(o.page, `#matches-table .sre-chips[data-customer="${MEMBER}"] [data-channel="sms"]`, /no/);
    await says(o.page, `#matches-table .sre-chips[data-customer="${MEMBER}"] [data-channel="email"]`, /not asked/);
    expect(o.writes, 'a read only').toEqual([]);
    await o.page.click(`#matches-table button[data-open="${MEMBER}"]`); // interaction 2: every record
    await says(o.page, '#records-facts', /Kavitha Raman/);
    await says(o.page, '#records-status', /^3 records$/);
    await says(o.page, '#purpose-marketing', /replied STOP/);
    await says(o.page, '#purpose-marketing', /signed the enrolment form at the desk/);
    await says(o.page, '#purpose-profiling', /not asked/);
    expect(await primaries(o.page)).toBe(1);
    await o.page.click('#lang');
    await says(o.page, '#page-h', /^ஒப்புதலைச் சரிபார்$/);
    await says(o.page, `#purpose-marketing`, /ஆம்/);
    await o.page.click('#lang');
    const findings = await auditPage(o.page, { minTarget: 44 });
    expect(findings, JSON.stringify(findings)).toEqual([]);
    // no match on a stranger's letters: said, never blank
    await o.page.click('#back');
    await o.page.fill('#f-text', 'zzq');
    await says(o.page, '#matches-table', /No customer matches those letters/);
    expect(o.errors).toEqual([]);
    await o.close();

    // the cashier holds the consent word but not the directory: told so, checks by the number
    const c = await shop.open(CASHIER, '/consent-check/');
    await says(c.page, '#f-note', /cannot read the customer directory/);
    await c.page.fill('#f-text', MEMBER);
    await c.page.click('#f-show');
    await says(c.page, `#matches-table .sre-chips[data-customer="${MEMBER}"] [data-channel="whatsapp"]`, /yes/);
    expect(c.writes).toEqual([]);
    expect(c.errors).toEqual([]);
    await c.close();
  });

  it('at 360px nothing on the three pages reaches past the viewport', async () => {
    for (const path of ['/compensation/', '/satisfaction/', '/consent-check/']) {
      const d = await shop.open(DESK === 'u-desk' && path === '/consent-check/' ? OWNER : DESK, path);
      await d.page.setViewportSize({ width: 360, height: 740 });
      await d.page.waitForSelector('#page-h');
      if (path !== '/consent-check/') await d.page.waitForSelector('#cases-table tr[data-case="K-1"]');
      expect(await widest(d.page), path).toEqual([]);
      expect(d.errors).toEqual([]);
      await d.close();
    }
  });
});
