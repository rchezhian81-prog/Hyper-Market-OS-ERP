import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APPROVALS_COPY, COPY_KEYS, createApprovalsSession, presentRequest, shopTime,
  type ApprovalsPorts, type ApprovalInboxView, type ApprovalRequestView, type DecideResult, type DecisionWord,
} from '../../apps/web-erp/src/approvals-session';
import { approvalsPortsFromData, bootApprovals } from '../../apps/web-erp/src/browser-entry';
import { bilingualGaps } from '../../packages/ui/src/index';

// The Approvals page — head office's maker-checker inbox (ADR-0024 · audit PA-03 · M02-FR-03 · §28). A CHECKER sees
// what other people asked for that they may decide (never their own) and approves or rejects it WITH A WRITTEN REASON
// in their own session; a MAKER sees where their own requests stand. The screen refuses the cheap things locally
// before any POST (no reason, nobody named, a request not waiting for them, their own request); head office is the
// gate on everything else, and its refusal words are shown as they are.

const row = (over: Partial<ApprovalRequestView> = {}): ApprovalRequestView => ({
  requestId: 'areq-1', kind: 'data_import_commit', label: 'Apply a bulk import', subjectRef: 'sept-prices', valueMinor: null,
  details: { jobId: 'sept-prices', contentFingerprint: 'f'.repeat(64) },
  summary: 'Load 120 rows (Products (SKU, name, price)) as "sept-prices"', reason: 'September price list',
  requestedBy: 'u-buyer', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting', ...over,
});
const INBOX: ApprovalInboxView = {
  waitingForMe: [
    row(),
    row({ requestId: 'areq-bank', kind: 'supplier_bank_change', label: 'Change where a supplier is paid', subjectRef: 'SUP-7', valueMinor: 1250000,
      details: { supplierId: 'SUP-7', newAccountLast4: '4321', verifiedByCall: true }, summary: 'Pay Sri Murugan Traders into the new account', requestedBy: 'u-acct', requestedAt: '2026-10-07T06:00:00.000Z' }),
  ],
  mine: [
    row({ requestId: 'areq-m1', requestedBy: 'u-owner', status: 'approved', decidedBy: 'u-mgr', decisionReason: 'checked', expiresAt: '2026-10-08T04:00:00.000Z', requestedAt: '2026-10-06T04:00:00.000Z' }),
    row({ requestId: 'areq-m2', requestedBy: 'u-owner', status: 'rejected', decidedBy: 'u-mgr', decisionReason: 'wrong file', requestedAt: '2026-10-07T01:00:00.000Z' }),
    row({ requestId: 'areq-m3', requestedBy: 'u-owner', status: 'expired', decidedBy: 'u-mgr', requestedAt: '2026-10-01T01:00:00.000Z' }),
    row({ requestId: 'areq-m4', requestedBy: 'u-owner', status: 'used', decidedBy: 'u-mgr', usedBy: 'import-x', requestedAt: '2026-09-30T01:00:00.000Z' }),
    row({ requestId: 'areq-m5', requestedBy: 'u-owner', status: 'waiting', requestedAt: '2026-10-07T07:00:00.000Z' }),
  ],
  asAt: '2026-10-07T08:00:00.000Z',
};

const ports = (over: Partial<ApprovalsPorts> = {}): ApprovalsPorts => ({
  inbox: () => INBOX,
  mayUse: () => true,
  decide: async (input) => ({ result: 'decided', decision: input.decision, decidedBy: 'u-owner' }),
  ...over,
});
const session = (over: Partial<ApprovalsPorts> = {}, userId: string | null = 'u-owner') => createApprovalsSession({ userId }, ports(over));

describe('the approvals copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(APPROVALS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...APPROVALS_COPY.en }, ta: { ...APPROVALS_COPY.ta, approveBtn: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('approveBtn');
  });
  it('the Tamil copy is Tamil, not English left in place', () => {
    for (const key of ['title', 'lead', 'approveBtn', 'rejectBtn', 'waitingHeading', 'mineHeading', 'reasonLabel'] as const) {
      expect(APPROVALS_COPY.ta[key], key).toMatch(/[஀-௿]/);
    }
  });
});

describe('"Waiting for you" — what others asked for, in plain words, with what will actually happen', () => {
  it('shows each request: the action, the summary, who asked, why, when (shop time), the amount, and the details as lines', () => {
    const view = session().view('en');
    expect(view.waitingCount).toBe(2);
    // Biggest amount first, then oldest.
    expect(view.waiting.map((r) => r.requestId)).toEqual(['areq-bank', 'areq-1']);
    const bank = view.waiting[0]!;
    expect(bank.label).toBe('Change where a supplier is paid');
    expect(bank.amount).toBe('₹12,500.00');
    expect(bank.requestedBy).toBe('u-acct');
    expect(bank.when).toBe('07-10-2026 11:30');
    expect(bank.details).toEqual([
      { key: 'supplierId', label: 'Supplier id', value: 'SUP-7' },
      { key: 'newAccountLast4', label: 'New account last4', value: '4321' },
      { key: 'verifiedByCall', label: 'Verified by call', value: 'yes' },
    ]);
    const imp = view.waiting[1]!;
    expect(imp.amount).toBeNull();
    expect(imp.reason).toBe('September price list');
    expect(imp.details).toEqual([
      { key: 'jobId', label: 'Load name', value: 'sept-prices' },
      { key: 'contentFingerprint', label: 'File check code', value: `${'f'.repeat(12)}…` },
    ]);
  });

  it('speaks Tamil for the kinds and details it knows, and spells out the rest — never a raw code', () => {
    const view = session().view('ta');
    expect(view.waiting[1]!.label).toBe(APPROVALS_COPY.ta.kindDataImport);
    expect(view.waiting[1]!.details[0]!.label).toBe(APPROVALS_COPY.ta.detailJobId);
    expect(view.waiting[0]!.details[2]!.value).toBe(APPROVALS_COPY.ta.yesWord);
    const unknown = presentRequest('en', row({ kind: 'price_below_cost', label: '' }));
    expect(unknown.label).toBe('Price below cost');
    const serverWorded = presentRequest('en', row({ kind: 'promo_at_loss', label: 'Launch a loss-making promotion' }));
    expect(serverWorded.label).toBe('Launch a loss-making promotion');
  });

  it('a pricing request reads as the shop says it — its kind in both languages, money in rupees, the floor as a percent', () => {
    const price = presentRequest('ta', row({
      kind: 'price_change', label: 'Set a price below cost or below the margin floor', subjectRef: 'P1', valueMinor: 6000,
      details: { productId: 'P1', priceMinor: 6000, mrpMinor: 10000, costMinor: 5000, currency: 'INR', marginFloorBps: 2000 },
    }));
    expect(price.label).toBe(APPROVALS_COPY.ta.kindPriceChange);
    const byKey = Object.fromEntries(price.details.map((d) => [d.key, d]));
    expect(byKey['priceMinor']).toMatchObject({ label: APPROVALS_COPY.ta.detailPriceMinor, value: '₹60.00' });
    expect(byKey['marginFloorBps']!.value).toBe('20.00%');
    const offer = presentRequest('en', row({
      kind: 'promotion_launch', label: '', subjectRef: 'diwali-dal',
      details: { promotionId: 'diwali-dal', promoPrice: { minor: 14500, currency: 'INR' }, unitCost: { minor: 15000, currency: 'INR' }, baselineUnits: 100 },
    }));
    expect(offer.label).toBe('Launch a promotion that loses margin');
    const offerKeys = Object.fromEntries(offer.details.map((d) => [d.key, d]));
    expect(offerKeys['promoPrice']).toMatchObject({ label: 'Offer price', value: '₹145.00' }); // never {"minor":14500,...}
    expect(offerKeys['unitCost']!.value).toBe('₹150.00');
    for (const k of ['quotation_below_floor', 'price_list_entry']) expect(presentRequest('ta', row({ kind: k })).label).not.toMatch(/[a-z]_[a-z]/);
  });

  it('every waiting row asks for attention with an icon and words — colour is never the only signal', () => {
    for (const r of session().view('en').waiting) {
      expect(r.status.label).toBe('Waiting for your decision');
      expect(r.status.icon.trim()).not.toBe('');
      expect(r.status.needsAttention).toBe(true);
    }
  });

  it('never offers the reader their own request to decide, even if one arrived in the inbox', () => {
    const own = row({ requestId: 'areq-own', requestedBy: 'u-owner' });
    const view = session({ inbox: () => ({ ...INBOX, waitingForMe: [own, ...INBOX.waitingForMe] }) }).view('en');
    expect(view.waiting.map((r) => r.requestId)).not.toContain('areq-own');
  });

  it('nothing waiting reads as a sentence, not a blank', () => {
    const view = session({ inbox: () => ({ waitingForMe: [], mine: [], asAt: null }) }).view('en');
    expect(view.waiting).toEqual([]);
    expect(view.screenState.label).toBe('Nothing is waiting for you to approve.');
    expect(view.screenState.icon.trim()).not.toBe('');
  });

  it('a person without identity.self.read sees nothing and is told why', () => {
    const view = session({ mayUse: () => false }).view('en');
    expect(view.mayUse).toBe(false);
    expect(view.waiting).toEqual([]);
    expect(view.mine).toEqual([]);
    expect(view.screenState.label).toBe('You do not have permission to use approvals.');
  });
});

describe('"What you asked for" — where each of my requests stands, in words', () => {
  it('newest first; waiting / approved until … / rejected by X: why / expired / used', () => {
    const mine = session().view('en').mine;
    expect(mine.map((r) => r.requestId)).toEqual(['areq-m5', 'areq-m2', 'areq-m1', 'areq-m3', 'areq-m4']);
    const by = (id: string) => mine.find((r) => r.requestId === id)!.status;
    expect(by('areq-m5').label).toBe('Waiting for a second person');
    expect(by('areq-m1').label).toBe('Approved by u-mgr — use it before 08-10-2026 09:30');
    expect(by('areq-m1').tone).toBe('ok');
    expect(by('areq-m2').label).toBe('Rejected by u-mgr: wrong file');
    expect(by('areq-m2').tone).toBe('error');
    expect(by('areq-m3').label).toMatch(/^Expired/);
    expect(by('areq-m4').label).toMatch(/^Used/);
    // Five states, five different icons — readable in greyscale and glare.
    expect(new Set(mine.map((r) => r.status.icon)).size).toBe(5);
  });
  it('the same chips in Tamil carry the person and the reason', () => {
    const mine = session().view('ta').mine;
    const rejected = mine.find((r) => r.requestId === 'areq-m2')!.status.label;
    expect(rejected).toContain('u-mgr');
    expect(rejected).toContain('wrong file');
    expect(rejected).toMatch(/[஀-௿]/);
  });
});

describe('deciding — only with a reason, only what is waiting for me, and the server\'s words when it refuses', () => {
  const spy = () => {
    const sent: { requestId: string; decision: DecisionWord; reason: string }[] = [];
    return { sent, decide: async (input: { requestId: string; decision: DecisionWord; reason: string }): Promise<DecideResult> => { sent.push(input); return { result: 'decided', decision: input.decision, decidedBy: 'u-owner' }; } };
  };

  it('refuses locally — no POST — with no reason, nobody named, no permission, a request not waiting, or my own', async () => {
    const s = spy();
    expect(await session({ decide: s.decide }).decide('areq-1', 'approved', '   ')).toEqual({ kind: 'needs_reason' });
    expect(await session({ decide: s.decide }, null).decide('areq-1', 'approved', 'fine')).toEqual({ kind: 'nobody_named' });
    expect(await session({ decide: s.decide, mayUse: () => false }).decide('areq-1', 'approved', 'fine')).toEqual({ kind: 'not_permitted' });
    expect(await session({ decide: s.decide }).decide('areq-unknown', 'approved', 'fine')).toEqual({ kind: 'not_waiting' });
    expect(await session({ decide: s.decide }).decide('areq-m5', 'approved', 'fine')).toEqual({ kind: 'not_waiting' }); // my own: never in my inbox
    const own = row({ requestId: 'areq-own', requestedBy: 'u-owner' });
    expect(await session({ decide: s.decide, inbox: () => ({ ...INBOX, waitingForMe: [own] }) }).decide('areq-own', 'approved', 'fine')).toEqual({ kind: 'own_request' });
    expect(s.sent).toEqual([]);
  });

  it('an approve or a reject reaches the port with the trimmed reason, and says what happens next', async () => {
    const s = spy();
    const sess = session({ decide: s.decide });
    const approved = await sess.decide('areq-1', 'approved', '  checked against the supplier letter ');
    expect(approved).toEqual({ kind: 'decided', decision: 'approved' });
    const rejected = await sess.decide('areq-bank', 'rejected', 'call the supplier first');
    expect(rejected).toEqual({ kind: 'decided', decision: 'rejected' });
    expect(s.sent).toEqual([
      { requestId: 'areq-1', decision: 'approved', reason: 'checked against the supplier letter' },
      { requestId: 'areq-bank', decision: 'rejected', reason: 'call the supplier first' },
    ]);
    expect(sess.presentDecideOutcome('en', approved).label).toBe('Approved. The person who asked can now go ahead — once.');
    expect(sess.presentDecideOutcome('en', approved).tone).toBe('ok');
    expect(sess.presentDecideOutcome('en', rejected).label).toBe('Rejected. The person who asked will see your reason.');
  });

  it('shows the server\'s own words on a refusal: 403, 409 already decided, 422 self-approval, lost link', async () => {
    const refusing = (code: string, whatHappened: string) => session({ decide: async () => ({ result: 'refused', code, whatHappened }) });
    const forbidden = await refusing('not_permitted_for_this_approval', 'u-owner may not approve "Change where a supplier is paid".').decide('areq-bank', 'approved', 'ok');
    expect(forbidden).toEqual({ kind: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-owner may not approve "Change where a supplier is paid".' });
    const s = session();
    expect(s.presentDecideOutcome('en', forbidden).label).toBe('Not recorded: u-owner may not approve "Change where a supplier is paid".');
    expect(s.presentDecideOutcome('en', forbidden).tone).toBe('error');

    const taken = await refusing('already_decided', 'This request was already approved by u-mgr.').decide('areq-1', 'rejected', 'no');
    expect(s.presentDecideOutcome('en', taken).label).toBe('Someone already decided this: This request was already approved by u-mgr.');
    expect(s.presentDecideOutcome('en', taken).tone).toBe('degraded');

    expect(await refusing('self_approval', 'u-owner asked for this and cannot also decide it (§28).').decide('areq-1', 'approved', 'ok')).toEqual({ kind: 'own_request' });
    expect(await session({ decide: async () => ({ result: 'lost_link' }) }).decide('areq-1', 'approved', 'ok')).toEqual({ kind: 'lost_link' });
    expect(s.presentDecideOutcome('ta', { kind: 'lost_link' }).label).toMatch(/[஀-௿]/);
    expect(s.presentDecideOutcome('en', { kind: 'refused', code: 'http_500', whatHappened: '' }).label).toBe('Not recorded — head office refused the decision.');
  });

  it('every outcome carries a tone, an icon and words', () => {
    const s = session();
    const outcomes = [
      { kind: 'decided', decision: 'approved' }, { kind: 'decided', decision: 'rejected' }, { kind: 'needs_reason' }, { kind: 'nobody_named' },
      { kind: 'not_permitted' }, { kind: 'not_waiting' }, { kind: 'own_request' }, { kind: 'lost_link' },
      { kind: 'refused', code: 'x', whatHappened: 'y' },
    ] as const;
    for (const lang of ['en', 'ta'] as const) {
      for (const o of outcomes) {
        const p = s.presentDecideOutcome(lang, o);
        expect(p.icon.trim(), `${lang} ${o.kind}`).not.toBe('');
        expect(p.label.trim(), `${lang} ${o.kind}`).not.toBe('');
      }
    }
  });
});

describe('the shop-time and the box wiring', () => {
  it('shopTime reads India time, the same in every test run', () => {
    expect(shopTime('2026-10-07T18:45:00.000Z')).toBe('08-10-2026 00:15');
    expect(shopTime(null)).toBe('');
    expect(shopTime('not a time')).toBe('not a time');
  });
  it('boots only with the box\'s payload, and gates on identity.self.read — default deny', () => {
    expect(bootApprovals(undefined)).toBeNull();
    expect(approvalsPortsFromData({ userId: 'u-1', permissions: ['identity.self.read'] }).mayUse()).toBe(true);
    expect(approvalsPortsFromData({ userId: 'u-1', permissions: [] }).mayUse()).toBe(false);
    expect(approvalsPortsFromData(undefined).mayUse()).toBe(false);
    expect(approvalsPortsFromData({ userId: 'u-1' }).inbox()).toEqual({ waitingForMe: [], mine: [], asAt: null });
    const live = approvalsPortsFromData({ userId: 'u-1', permissions: ['identity.self.read'] }, INBOX);
    expect(live.inbox()).toBe(INBOX);
    const booted = bootApprovals({ userId: 'u-owner', permissions: ['identity.self.read'], inbox: INBOX })!;
    expect(booted.view('en').waitingCount).toBe(2);
  });
});

describe('the view defers to the model, uses no browser dialogs, and only decides on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/approvals.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });
  it('renders from the bundled session rather than re-deciding what to show', () => {
    expect(VIEW).toMatch(/window\.approvalsSession/);
    expect(VIEW).toMatch(/session\.view\(/);
    expect(VIEW).toMatch(/session\.presentDecideOutcome\(/);
  });
  it('a decision runs ONLY inside a click handler, never at load; the page issues no write verb of its own', () => {
    const clickIdx = VIEW.indexOf("addEventListener('click'");
    expect(clickIdx, 'no click handler is registered').toBeGreaterThan(-1);
    const decideCall = VIEW.indexOf('session.decide(');
    expect(decideCall).toBeGreaterThan(-1);
    // The only caller of session.decide is the `decide` function, and the only callers of that are the two buttons.
    const callers = [...VIEW.matchAll(/\bdecide\(r\.requestId, '(approved|rejected)'/g)].map((m) => m[1]);
    expect(callers.sort()).toEqual(['approved', 'rejected']);
    for (const m of VIEW.matchAll(/void decide\(/g)) {
      const before = VIEW.slice(Math.max(0, m.index - 80), m.index);
      expect(before, 'decide() is called outside a click handler').toMatch(/addEventListener\('click', \(\) => \{ $/);
    }
    expect(VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).toEqual([]);
    expect(VIEW).toMatch(/window\.approvals\b/);
    expect(VIEW).toMatch(/api\.refresh\(/);
  });
  it('every status it draws carries a screen-reader announcement and an aria-hidden icon; every reason box has a label', () => {
    expect(VIEW).toMatch(/node\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
    expect(VIEW).toMatch(/label\.htmlFor = inputId/);
  });
  it('the shell loads the shared bundle, carries the data marker, and labels the toggle and both lists', () => {
    const HTML = readFileSync('apps/web-erp/web/approvals.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="waiting"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="mine"[^>]*aria-label=/);
  });
});

describe('the import screen no longer takes a typed approver anywhere', () => {
  it('the page has no approver box and the view sends no approver', () => {
    const HTML = readFileSync('apps/web-erp/web/data-io.html', 'utf8');
    const VIEW = readFileSync('apps/web-erp/web/data-io.js', 'utf8');
    expect(HTML).not.toMatch(/import-approver|approver-label/);
    expect(VIEW).not.toMatch(/import-approver|approver:/);
    expect(HTML).toMatch(/id="ask"/);
    expect(HTML).toMatch(/id="import-why"/);
    const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
    const commit = ENTRY.slice(ENTRY.indexOf('async function postCommit('), ENTRY.indexOf('export function dataIoPortsFromData('));
    expect(commit).toMatch(/approvalId: req\.approvalId/);
    expect(commit).not.toMatch(/decidedBy|uploadedBy|status: 'approved'/);
  });
});
