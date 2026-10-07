import { describe, it, expect } from 'vitest';
import {
  createWriteOffCaptureSession, draftOfDetails, formatRupees, presentWriteOffAsk, presentWriteOffRecord,
  writeOffBodyOf, writeOffDetails, writeOffOutcomeOfRefusal, writeOffRequestBody,
  COPY_KEYS, LOSS_TYPES, WRITE_OFF_APPROVAL_KIND, WRITE_OFF_CAPTURE_COPY, WRITE_OFF_REFUSAL_CODES,
  type WriteOffAskOutcome, type WriteOffCapturePort, type WriteOffCapturePorts, type WriteOffDraft, type WriteOffPostResult,
  type WriteOffRecordOutcome,
} from '../../apps/web-erp/src/write-off-capture-session';
import type { ApprovalAsk, ApprovalRequestView, AskResult, InboxRead } from '../../apps/web-erp/src/approvals-session';
import { APPROVAL_REFUSAL_CODES } from '../../apps/web-erp/src/catalogue-session';
import { bootWriteOffCapture, writeOffCapturePortsFromData, HEAD_OFFICE_APPROVALS } from '../../apps/web-erp/src/browser-entry';
import { actionDetails, fingerprintOf, takeApproval, APPROVAL_KINDS, type ApprovalState } from '../../services/identity/src/approval-requests';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **A big loss is recorded by two people — the raiser and a second person who handles stock (M28-FR-01 · ADR-0024 ·
 * §28 · audit PA-03).**
 *
 * The write-off capture screen used to send a material loss with the approver's name TYPED into a box (`approvedBy`).
 * A name in a box is not anybody's approval. Now:
 *
 *   1. a loss BELOW the store limit is recorded on the raiser's own, exactly as before;
 *   2. a BIG loss: the raiser fills it (with its photo or witness), writes why and presses **Ask for approval** — head
 *      office's engine records a `stock_write_off` request for EXACTLY the body the record will send plus the
 *      write-off's id, for exactly the loss's value;
 *   3. a second person who handles stock approves it on their own Approvals page;
 *   4. **Record the loss** finds the raiser's OWN APPROVED request for this write-off whose details are exactly the form
 *      and sends the loss naming it (`approvalId`, never `approvedBy`) — and when it is not asked, waiting, rejected,
 *      expired, used or changed since asking, says so in plain words (English and Tamil) and sends nothing. Head
 *      office's own refusals read in plain words too; anything else in head office's own words.
 *
 * With no head office behind the page, a big loss is not recorded at all — and nobody's name is accepted anywhere.
 */

const THRESHOLD = 500_00; // ₹500 — the tenant's material-loss line (injected policy)
const NOW = '2026-10-07T05:00:00.000Z';
const ID = 'WO-1';

const draft = (over: Partial<WriteOffDraft> = {}): WriteOffDraft => ({
  writeOffId: ID, productId: 'Toor dal 1kg', locationId: 'aisle-3', qty: 12, uom: 'ea',
  lossType: 'damage', valueMinor: 100_00, ...over,
});
/** A big loss, with its photo — ready to ask about. */
const big = (over: Partial<WriteOffDraft> = {}): WriteOffDraft => draft({ valueMinor: 1_140_00, evidenceRef: 'photo-17', ...over });
const WHY = 'rats got into the sacks overnight';

/** A request as head office's inbox hands it back (JSON round-tripped, like the wire). */
const row = (over: Omit<Partial<ApprovalRequestView>, 'details'> & Pick<ApprovalRequestView, 'requestId'> & { readonly details?: object }): ApprovalRequestView => ({
  kind: WRITE_OFF_APPROVAL_KIND, label: 'Write off stock (a material loss)', subjectRef: ID, valueMinor: 1_140_00,
  summary: 'Write off 12 × Toor dal 1kg — damage, ₹1,140.00', reason: WHY,
  requestedBy: 'u-owner', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting',
  ...over,
  details: JSON.parse(JSON.stringify(over.details ?? writeOffDetails(ID, writeOffBodyOf(big())))) as Record<string, unknown>,
});

/** A stub head office: the approval engine (ask + inbox) and the write-off route, recording what each was sent. */
function office(opts: { mine?: ApprovalRequestView[]; inbox?: InboxRead; ask?: AskResult; post?: WriteOffPostResult; mayCapture?: boolean; connected?: boolean; userId?: string | null; threshold?: number } = {}) {
  const asks: ApprovalAsk[] = [];
  const posted: { writeOffId: string; body: Record<string, unknown> }[] = [];
  let inboxReads = 0;
  const port: WriteOffCapturePort = {
    async post(input) {
      // What the browser port sends, exactly: the request body built by the one function.
      posted.push({ writeOffId: input.writeOffId, body: writeOffRequestBody(input.body, input.approvalId) });
      return opts.post ?? { result: 'recorded' };
    },
  };
  const ports: WriteOffCapturePorts = {
    mayCapture: () => opts.mayCapture ?? true,
    capturePort: () => port,
    ...(opts.connected === false ? {} : {
      askApproval: async (ask: ApprovalAsk): Promise<AskResult> => {
        asks.push(ask);
        return opts.ask ?? { result: 'asked', request: row({ requestId: 'areq-new', details: ask.details, summary: ask.summary, reason: ask.reason }) };
      },
      approvalInbox: async (): Promise<InboxRead> => { inboxReads += 1; return opts.inbox ?? { result: 'read', inbox: { waitingForMe: [], mine: opts.mine ?? [], asAt: null } }; },
    }),
  };
  const s = createWriteOffCaptureSession(
    { userId: opts.userId === undefined ? 'u-owner' : opts.userId, materialThresholdMinor: opts.threshold ?? THRESHOLD },
    ports,
  );
  return { s, asks, posted, inboxReads: () => inboxReads };
}

describe('write-off capture: bilingual + the view', () => {
  it('has no bilingual gaps — every key in English and Tamil', () => {
    const gaps = bilingualGaps(WRITE_OFF_CAPTURE_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });

  it('the Tamil copy is Tamil, not English left in place', () => {
    for (const key of COPY_KEYS.filter((k) => k !== 'langName' && k !== 'refused')) {
      expect(WRITE_OFF_CAPTURE_COPY.ta[key], key).toMatch(/[஀-௿]/);
    }
  });

  it('offers the five loss types as chosen chips (never free text), in the engine order', () => {
    const { s } = office();
    const v = s.view('en');
    expect(v.mayCapture).toBe(true);
    expect(v.lossTypes.map((c) => c.lossType)).toEqual([...LOSS_TYPES]);
    expect(v.lossTypes.find((c) => c.lossType === 'damage')?.label).toBe('Damage');
    expect(s.view('ta').lossTypes.find((c) => c.lossType === 'damage')?.label).toBe('சேதம்');
  });

  it('shows the material-loss threshold, and surfaces when nobody is named', () => {
    const { s } = office({ userId: null });
    const v = s.view('en');
    expect(v.thresholdMinor).toBe(500_00);
    expect(v.thresholdText).toBe('₹500.00');
    expect(v.nobodyNamed).toBe(true);
  });

  it('shows a not-permitted state to a user who cannot record a loss', () => {
    const { s } = office({ mayCapture: false });
    const v = s.view('en');
    expect(v.mayCapture).toBe(false);
    expect(v.lossTypes).toEqual([]);
    expect(v.screenState.label).toBe(WRITE_OFF_CAPTURE_COPY.en.stateNotPermitted);
  });

  it('formatRupees renders paise as ₹', () => {
    expect(formatRupees(500_00)).toBe('₹500.00');
    expect(formatRupees(0)).toBe('₹0.00');
    expect(formatRupees(1_140_00)).toBe('₹1,140.00');
  });

  it('says whether it is wired to head office’s approval engine', () => {
    expect(office().s.connected).toBe(true);
    expect(office({ connected: false }).s.connected).toBe(false);
  });
});

describe('write-off capture: materiality', () => {
  it('is material at or above the threshold, immaterial below — and a big loss needs approval', () => {
    const { s } = office();
    expect(s.isMaterial(499_99)).toBe(false);
    expect(s.isMaterial(500_00)).toBe(true); // boundary is material
    expect(s.needsApproval({ writeOffId: ID, valueMinor: 499_99 })).toBe(false);
    expect(s.needsApproval({ writeOffId: ID, valueMinor: 500_00 })).toBe(true);
  });
});

describe('what a stock_write_off approval is FOR — the same rule as head office’s engine', () => {
  it('the details are exactly the body the record sends, plus the write-off id — equal to the engine’s actionDetails', () => {
    const body = writeOffBodyOf(big());
    const details = writeOffDetails(ID, body);
    expect(details).toEqual({
      productId: 'Toor dal 1kg', locationId: 'aisle-3', qty: 12, uom: 'ea', lossType: 'damage', reasonCode: 'damage',
      valueMinor: 1_140_00, evidenceRef: 'photo-17', writeOffId: ID,
    });
    // The body as the route receives it — WITH the approval — reduces to exactly the same details on the server.
    const sent = writeOffRequestBody(body, 'areq-1');
    expect(sent).toEqual({ ...details, writeOffId: undefined, approvalId: 'areq-1' } as unknown as Record<string, unknown>);
    expect(actionDetails(sent, { writeOffId: ID })).toEqual(details);
    expect(fingerprintOf(actionDetails(sent, { writeOffId: ID }))).toBe(fingerprintOf(details));
    // Never a typed approver in the body, ever.
    expect(sent).not.toHaveProperty('approvedBy');
    expect(sent).not.toHaveProperty('writeOffId');
  });

  it('a small loss carries no evidence key at all; a finer reason code overrides the loss type', () => {
    expect(writeOffRequestBody(writeOffBodyOf(draft()))).not.toHaveProperty('evidenceRef');
    expect(writeOffBodyOf(draft({ lossType: 'expiry' })).reasonCode).toBe('expiry');
    expect(writeOffBodyOf(draft({ reasonCode: '  past use-by  ' })).reasonCode).toBe('past use-by');
    expect(writeOffBodyOf(draft({ productId: '  P1 ', evidenceRef: '  ' }))).toEqual({
      productId: 'P1', locationId: 'aisle-3', qty: 12, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 100_00,
    });
  });

  it('the engine accepts exactly what the screen asked for — and refuses it once a figure changed', async () => {
    const { s, asks } = office();
    const asked = await s.askApproval('en', big(), WHY);
    expect(asked.kind).toBe('asked');
    const ask = asks[0]!;
    const state: ApprovalState = {
      request: {
        requestId: 'areq-1', kind: ask.kind, subjectRef: ask.subjectRef, valueMinor: ask.valueMinor, fingerprint: fingerprintOf(ask.details),
        details: ask.details, summary: ask.summary, reason: ask.reason, requestedBy: 'u-owner', requestedAt: NOW,
      },
      decision: { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-manager', reason: 'seen the sacks', decidedAt: NOW, expiresAt: '2026-10-08T05:00:00.000Z' },
    };
    const take = (body: Record<string, unknown>, valueMinor: number) => takeApproval({
      state, kind: 'stock_write_off', subjectRef: ID, details: actionDetails(body, { writeOffId: ID }), valueMinor,
      maker: 'u-owner', usedBy: `write-off:${ID}`, now: NOW, checkerHolds: () => true,
    });
    await expect(take(writeOffRequestBody(writeOffBodyOf(big()), 'areq-1'), 1_140_00)).resolves.toMatchObject({ decidedBy: 'u-manager' });
    await expect(take(writeOffRequestBody(writeOffBodyOf(big({ qty: 13 })), 'areq-1'), 1_140_00)).rejects.toMatchObject({ body: { code: 'approval_does_not_match' } });
  });
});

describe('Ask for approval — the raiser’s own request, for exactly this loss; nothing is recorded', () => {
  it('asks with kind stock_write_off, the write-off id, exactly the record’s details, the loss’s value, a plain summary and why', async () => {
    const { s, asks, posted } = office();
    const o = await s.askApproval('en', big(), `  ${WHY}  `);
    expect(o.kind).toBe('asked');
    expect(asks).toEqual([{
      kind: 'stock_write_off', subjectRef: ID,
      details: writeOffDetails(ID, writeOffBodyOf(big())), valueMinor: 1_140_00,
      summary: 'Write off 12 × Toor dal 1kg — damage, ₹1,140.00', reason: WHY,
    }]);
    expect(posted, 'asking records nothing').toEqual([]);
    expect(s.presentAskOutcome('en', o)).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(s.presentAskOutcome('en', o).label).toBe(`${WRITE_OFF_CAPTURE_COPY.en.asked} Write off 12 × Toor dal 1kg — damage, ₹1,140.00`);
  });

  it('the summary is in the asker’s language, and names the unit when it is not each', async () => {
    const { s, asks } = office();
    await s.askApproval('ta', big({ qty: 3, uom: 'kg', lossType: 'expiry' }), WHY);
    expect(asks[0]!.summary).toBe('3 kg × Toor dal 1kg இழப்பாகக் கழித்தல் — காலாவதி, ₹1,140.00');
    await s.askApproval('en', big({ lossType: 'expiry' }), WHY);
    expect(asks[1]!.summary).toBe('Write off 12 × Toor dal 1kg — expired, ₹1,140.00');
  });

  it('refuses locally — nothing asked — without permission, incomplete, below the limit, no evidence, no reason, or not connected', async () => {
    const cases: [ReturnType<typeof office>, WriteOffDraft, string, WriteOffAskOutcome['kind']][] = [
      [office({ mayCapture: false }), big(), WHY, 'not_permitted'],
      [office(), big({ productId: ' ' }), WHY, 'incomplete'],
      [office(), big({ qty: 1.5 }), WHY, 'incomplete'],
      [office(), big({ valueMinor: Number.NaN }), WHY, 'incomplete'],
      [office(), draft({ valueMinor: 499_99, evidenceRef: 'photo' }), WHY, 'not_material'],
      [office(), big({ evidenceRef: '  ' }), WHY, 'needs_evidence'],
      [office(), big(), 'because', 'needs_why'],
      [office({ connected: false }), big(), WHY, 'not_connected'],
    ];
    for (const [o, d, why, kind] of cases) {
      expect((await o.s.askApproval('en', d, why)).kind, kind).toBe(kind);
      expect(o.asks, kind).toEqual([]);
      expect(o.posted, kind).toEqual([]);
    }
  });

  it('head office’s refusal of the ask, and a lost link, are said — nothing recorded', async () => {
    const refused = office({ ask: { result: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-owner may not write off stock (a material loss), so cannot ask for it to be approved.' } });
    const o = await refused.s.askApproval('en', big(), WHY);
    expect(o).toEqual({ kind: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-owner may not write off stock (a material loss), so cannot ask for it to be approved.' });
    expect(presentWriteOffAsk('en', o).label).toBe('Not asked: u-owner may not write off stock (a material loss), so cannot ask for it to be approved.');
    expect(presentWriteOffAsk('ta', { kind: 'refused', code: 'x', whatHappened: '' }).label).toBe(WRITE_OFF_CAPTURE_COPY.ta.askRefusedNoWords);
    const lost = office({ ask: { result: 'lost_link' } });
    expect(await lost.s.askApproval('en', big(), WHY)).toEqual({ kind: 'lost_link' });
    expect(lost.posted).toEqual([]);
  });
});

describe('Record the loss — a small loss as before; a big one only with the raiser’s own approved request', () => {
  it('records an IMMATERIAL loss on the raiser’s own — no approval looked up, none sent, no evidence invented', async () => {
    const o = office();
    const r = await o.s.record(draft({ valueMinor: 100_00 }));
    expect(r).toEqual({ kind: 'recorded', approvedBy: null });
    expect(o.inboxReads()).toBe(0);
    expect(o.posted).toEqual([{ writeOffId: ID, body: { productId: 'Toor dal 1kg', locationId: 'aisle-3', qty: 12, uom: 'ea', lossType: 'damage', reasonCode: 'damage', valueMinor: 100_00 } }]);
    expect(o.s.presentRecordOutcome('en', r)).toMatchObject({ tone: 'ok', needsAttention: false, label: WRITE_OFF_CAPTURE_COPY.en.recorded });
  });

  it('records a BIG loss naming the raiser’s own APPROVED request for exactly this loss — approvalId, never approvedBy', async () => {
    const o = office({ mine: [row({ requestId: 'areq-ok', status: 'approved', decidedBy: 'u-manager', decisionReason: 'seen it', expiresAt: '2026-10-08T04:00:00.000Z' })] });
    const r = await o.s.record(big());
    expect(r).toEqual({ kind: 'recorded', approvedBy: 'u-manager' });
    expect(o.posted).toHaveLength(1);
    expect(o.posted[0]).toEqual({ writeOffId: ID, body: { ...writeOffRequestBody(writeOffBodyOf(big())), approvalId: 'areq-ok' } });
    expect(o.posted[0]!.body).not.toHaveProperty('approvedBy');
    expect(o.s.presentRecordOutcome('en', r).label).toBe('Loss recorded. u-manager approved it, and that approval has now been used. The shelf figure has come down.');
    expect(o.s.presentRecordOutcome('ta', r).label).toBe('இழப்பு பதிவு செய்யப்பட்டது. u-manager அனுமதித்தார்; அந்த அனுமதி இப்போது பயன்படுத்தப்பட்டுவிட்டது. அலமாரி எண்ணிக்கை குறைந்தது.');
  });

  it('picks the newest approved request for exactly this loss, ignoring other write-offs and other kinds', async () => {
    const o = office({ mine: [
      row({ requestId: 'areq-old', status: 'approved', decidedBy: 'u-manager', requestedAt: '2026-10-07T03:00:00.000Z' }),
      row({ requestId: 'areq-new', status: 'approved', decidedBy: 'u-owner2', requestedAt: '2026-10-07T04:30:00.000Z' }),
      row({ requestId: 'areq-other', subjectRef: 'WO-2', status: 'approved', decidedBy: 'u-x', requestedAt: '2026-10-07T05:00:00.000Z' }),
      row({ requestId: 'areq-kind', kind: 'stock_adjustment_up', status: 'approved', decidedBy: 'u-x', requestedAt: '2026-10-07T05:00:00.000Z' }),
    ] });
    await o.s.record(big());
    expect(o.posted[0]!.body['approvalId']).toBe('areq-new');
  });

  it('a big loss is refused in plain words — nothing sent — when not asked, waiting, rejected, expired, used, or changed since asking', async () => {
    const cases: [ApprovalRequestView[], WriteOffDraft, WriteOffRecordOutcome, string][] = [
      [[], big(), { kind: 'not_asked' },
        'Not recorded — nobody has been asked to approve this loss yet. Write why and press “Ask for approval” first.'],
      [[row({ requestId: 'r1' })], big(), { kind: 'waiting' },
        'Not recorded — still waiting for a second person who handles stock (not you) to approve it on their Approvals page.'],
      [[row({ requestId: 'r1', status: 'rejected', decidedBy: 'u-manager', decisionReason: 'count the sacks again' })], big(),
        { kind: 'rejected', decidedBy: 'u-manager', reason: 'count the sacks again' },
        'Not recorded — u-manager rejected it: “count the sacks again”. Change what they said and ask again.'],
      [[row({ requestId: 'r1', status: 'expired', decidedBy: 'u-manager' })], big(), { kind: 'expired' },
        'Not recorded — the approval ran out of time before it was used. Ask again.'],
      [[row({ requestId: 'r1', status: 'used', decidedBy: 'u-manager', usedBy: 'write-off:WO-1' })], big(), { kind: 'used' },
        'Not recorded — that approval was already used once. One approval allows one loss; ask again.'],
      [[row({ requestId: 'r1', status: 'approved', decidedBy: 'u-manager' })], big({ qty: 13 }), { kind: 'changed' },
        'Not recorded — this is not exactly the loss that was approved (something changed after you asked). Ask for approval again for exactly this.'],
      [[row({ requestId: 'r1', status: 'approved', decidedBy: 'u-manager' })], big({ evidenceRef: 'photo-18' }), { kind: 'changed' },
        'Not recorded — this is not exactly the loss that was approved (something changed after you asked). Ask for approval again for exactly this.'],
    ];
    for (const [mine, d, outcome, words] of cases) {
      const o = office({ mine });
      const r = await o.s.record(d);
      expect(r, outcome.kind).toEqual(outcome);
      expect(o.posted, `${outcome.kind}: nothing may be sent`).toEqual([]);
      expect(o.s.presentRecordOutcome('en', r).label, outcome.kind).toBe(words);
      expect(o.s.presentRecordOutcome('ta', r).label, `${outcome.kind} in Tamil`).toMatch(/^பதிவு செய்யப்படவில்லை/);
    }
  });

  it('a value changed after asking is not what was approved — the amount is part of it', async () => {
    const o = office({ mine: [row({ requestId: 'r1', status: 'approved', decidedBy: 'u-manager' })] });
    expect(await o.s.record(big({ valueMinor: 1_200_00 }))).toEqual({ kind: 'changed' });
    expect(o.posted).toEqual([]);
  });

  it('a rejection says who and why in Tamil too', () => {
    expect(presentWriteOffRecord('ta', { kind: 'rejected', decidedBy: 'u-manager', reason: 'count the sacks again' }).label)
      .toBe('பதிவு செய்யப்படவில்லை — u-manager மறுத்தார்: “count the sacks again”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
    expect(presentWriteOffRecord('en', { kind: 'rejected', decidedBy: null, reason: 'That request was rejected by u-manager: no.' }).label)
      .toBe('Not recorded — it was rejected: That request was rejected by u-manager: no. Change what they said and ask again.');
  });

  it('a big loss is refused locally — nothing sent — without permission, incomplete, without evidence, or not connected', async () => {
    const cases: [ReturnType<typeof office>, WriteOffDraft, WriteOffRecordOutcome['kind'], string][] = [
      [office({ mayCapture: false }), big(), 'not_permitted', 'Not recorded — you do not have permission to record a loss.'],
      [office(), big({ uom: '' }), 'incomplete', 'Not recorded — fill in the item, where it is, how many (a whole number), what it is worth and the kind of loss.'],
      [office(), big({ lossType: 'theft' as unknown as WriteOffDraft['lossType'] }), 'incomplete', 'Not recorded — fill in the item, where it is, how many (a whole number), what it is worth and the kind of loss.'],
      [office(), big({ valueMinor: -1 }), 'incomplete', 'Not recorded — fill in the item, where it is, how many (a whole number), what it is worth and the kind of loss.'],
      [office(), big({ evidenceRef: undefined }), 'needs_evidence', 'Not recorded — this is a big loss: add a photo or witness first.'],
    ];
    for (const [o, d, kind, words] of cases) {
      const r = await o.s.record(d);
      expect(r.kind, kind).toBe(kind);
      expect(o.posted, kind).toEqual([]);
      expect(o.inboxReads(), `${kind}: the inbox is not even read`).toBe(0);
      expect(presentWriteOffRecord('en', r).label, kind).toBe(words);
    }
  });

  it('LOCAL-ONLY: with no head office behind the page, a big loss is not recorded on a typed name — and it says so', async () => {
    const o = office({ connected: false });
    const r = await o.s.record(big());
    expect(r).toEqual({ kind: 'not_connected' });
    expect(o.posted).toEqual([]);
    const en = presentWriteOffRecord('en', r);
    expect(en).toMatchObject({ tone: 'error', needsAttention: true });
    expect(en.label).toBe('Not recorded — a big loss needs a second person’s approval at head office, and this screen is not connected to head office. A name typed on a page is not an approval, so nothing was recorded.');
    expect(presentWriteOffRecord('ta', r).label).toBe(WRITE_OFF_CAPTURE_COPY.ta.notConnected.replace('{not}', WRITE_OFF_CAPTURE_COPY.ta.notRecorded));
    // A small loss still records on the raiser's own — that never needed head office's approval engine.
    expect(await o.s.record(draft())).toEqual({ kind: 'recorded', approvedBy: null });
  });

  it('a lost inbox read or a refused one is said, and nothing is sent', async () => {
    const lost = office({ inbox: { result: 'lost_link' } });
    expect(await lost.s.record(big())).toEqual({ kind: 'lost_link' });
    expect(lost.posted).toEqual([]);
    const refused = office({ inbox: { result: 'refused', code: 'unauthenticated', whatHappened: 'Sign in again.' } });
    expect(await refused.s.record(big())).toEqual({ kind: 'refused', code: 'unauthenticated', whatHappened: 'Sign in again.' });
    expect(refused.posted).toEqual([]);
  });
});

describe('head office’s refusals of the record — every one in plain words, English and Tamil', () => {
  const approved = () => [row({ requestId: 'r1', status: 'approved', decidedBy: 'u-manager' })];

  it('each write-off refusal and each approval refusal has its own plain words', async () => {
    const expected: Record<string, string> = {
      write_off_needs_approval: 'Not recorded — head office counts this as a big loss, so a second person who handles stock must approve it. Write why and press “Ask for approval”.',
      write_off_needs_evidence: 'Not recorded — head office counts this as a big loss: it needs a photo or witness, and a second person who handles stock must approve it. Add the photo or witness, write why and press “Ask for approval”.',
      invalid_write_off: 'Not recorded — head office could not accept this loss as written. Check how many (a whole number above zero) and the kind of loss.',
      stock_not_owned_by_the_store: 'Not recorded — some of this item at that place belongs to someone else (a concession or consignment supplier, or a customer). Store staff cannot write off stock the store does not own; its owner records that loss.',
      write_off_already_recorded: 'This loss was already recorded. Nothing was recorded again.',
      approval_unknown: 'Not recorded — nobody has been asked to approve this loss yet. Write why and press “Ask for approval” first.',
      approval_does_not_match: 'Not recorded — this is not exactly the loss that was approved (something changed after you asked). Ask for approval again for exactly this.',
      approval_still_waiting: 'Not recorded — still waiting for a second person who handles stock (not you) to approve it on their Approvals page.',
      approval_rejected: 'Not recorded — it was rejected: That request was rejected by u-manager: no. Change what they said and ask again.',
      approval_expired: 'Not recorded — the approval ran out of time before it was used. Ask again.',
      approval_already_used: 'Not recorded — that approval was already used once. One approval allows one loss; ask again.',
      checker_may_not_approve: 'Not recorded — the person who approved it no longer handles stock, so their approval does not count. Ask again.',
      approver_named_without_approval: 'Not recorded — naming a person is not their approval. Ask for approval, and wait for a second person to approve it on their Approvals page.',
    };
    expect(Object.keys(expected).sort()).toEqual([...WRITE_OFF_REFUSAL_CODES, ...APPROVAL_REFUSAL_CODES].sort());
    for (const [code, words] of Object.entries(expected)) {
      const whatHappened = code === 'approval_rejected' ? 'That request was rejected by u-manager: no.' : 'head office words';
      const o = office({ mine: approved(), post: { result: 'refused', code, whatHappened } });
      const r = await o.s.record(big());
      expect(o.posted, code).toHaveLength(1); // it was sent; head office refused it
      expect(r).toEqual(writeOffOutcomeOfRefusal(code, whatHappened));
      const en = o.s.presentRecordOutcome('en', r);
      expect(en.label, code).toBe(words);
      expect(en.icon.trim().length, code).toBeGreaterThan(0);
      const ta = o.s.presentRecordOutcome('ta', r);
      expect(ta.label, `${code} in Tamil`).toMatch(/[஀-௿]/);
      expect(ta.label, `${code} in Tamil`).not.toContain('head office words');
    }
  });

  it('already recorded is not a failure; a stock-ownership or unreadable loss is an error; needs-approval asks for attention', () => {
    expect(presentWriteOffRecord('en', writeOffOutcomeOfRefusal('write_off_already_recorded', ''))).toMatchObject({ tone: 'degraded', needsAttention: false });
    expect(presentWriteOffRecord('en', writeOffOutcomeOfRefusal('stock_not_owned_by_the_store', ''))).toMatchObject({ tone: 'error', needsAttention: true });
    expect(presentWriteOffRecord('en', writeOffOutcomeOfRefusal('invalid_write_off', ''))).toMatchObject({ tone: 'error', needsAttention: true });
    expect(presentWriteOffRecord('en', writeOffOutcomeOfRefusal('write_off_needs_approval', ''))).toMatchObject({ tone: 'degraded', needsAttention: true });
  });

  it('any other code is head office’s own words — never read as success', async () => {
    const o = office({ post: { result: 'refused', code: 'forbidden', whatHappened: 'u-cashier does not hold inventory.movement.append.' } });
    const r = await o.s.record(draft());
    expect(r).toEqual({ kind: 'refused', code: 'forbidden', whatHappened: 'u-cashier does not hold inventory.movement.append.' });
    expect(presentWriteOffRecord('en', r).label).toBe('Not recorded: u-cashier does not hold inventory.movement.append.');
    expect(presentWriteOffRecord('ta', r).label).toBe('பதிவு செய்யப்படவில்லை: u-cashier does not hold inventory.movement.append.');
    expect(presentWriteOffRecord('en', { kind: 'refused', code: 'x', whatHappened: '  ' }).label).toBe('Not recorded — head office refused it.');
    const lost = office({ post: { result: 'lost_link' } });
    const l = await lost.s.record(draft());
    expect(l).toEqual({ kind: 'lost_link' });
    expect(presentWriteOffRecord('en', l)).toMatchObject({ tone: 'degraded', needsAttention: true, label: 'Not recorded — no connection to head office. Nothing was saved. Try again.' });
  });

  it('when head office calls a loss big that this page did not, the page asks for approval for THAT write-off from then on', async () => {
    const o = office({ post: { result: 'refused', code: 'write_off_needs_approval', whatHappened: 'needs approval' } });
    const small = draft({ valueMinor: 400_00, evidenceRef: 'photo-1' });
    expect(o.s.needsApproval(small)).toBe(false);
    expect(await o.s.askApproval('en', small, WHY)).toEqual({ kind: 'not_material' });
    expect((await o.s.record(small)).kind).toBe('head_office_refused');
    expect(o.s.needsApproval(small)).toBe(true);
    expect(o.s.needsApproval({ ...small, writeOffId: 'WO-other' }), 'only that write-off').toBe(false);
    expect((await o.s.askApproval('en', small, WHY)).kind).toBe('asked');
    // From now on recording it looks for the approval instead of sending it bare.
    expect(await o.s.record(small)).toEqual({ kind: 'not_asked' });
    expect(o.posted).toHaveLength(1);
  });
});

describe('“Losses you asked approval for” — carry a loss on, exactly as it was asked', () => {
  it('lists the raiser’s own write-off requests in play, newest first, one per write-off, with words and the loss to carry on', async () => {
    const o = office({ mine: [
      row({ requestId: 'r-old', status: 'rejected', decidedBy: 'u-manager', decisionReason: 'no', requestedAt: '2026-10-07T02:00:00.000Z' }),
      row({ requestId: 'r-new', status: 'approved', decidedBy: 'u-manager', expiresAt: '2026-10-08T04:30:00.000Z', requestedAt: '2026-10-07T04:30:00.000Z' }),
      row({ requestId: 'r-2', subjectRef: 'WO-2', status: 'waiting', requestedAt: '2026-10-07T05:00:00.000Z',
        details: writeOffDetails('WO-2', writeOffBodyOf(big({ writeOffId: 'WO-2', reasonCode: 'mouldy' }))) }),
      row({ requestId: 'r-3', subjectRef: 'WO-3', status: 'used', decidedBy: 'u-manager', requestedAt: '2026-10-07T05:30:00.000Z' }),
      row({ requestId: 'r-4', subjectRef: 'WO-4', status: 'waiting', requestedAt: '2026-10-07T01:00:00.000Z', details: { productId: 'x' } }),
      row({ requestId: 'r-k', kind: 'period_close', subjectRef: '2026-09', requestedAt: '2026-10-07T06:00:00.000Z' }),
    ] });
    const v = await o.s.yourLosses('en');
    expect(v.state).toBe('read');
    expect(v.rows.map((r) => r.requestId)).toEqual(['r-2', 'r-new', 'r-4']);
    const approvedRow = v.rows[1]!;
    expect(approvedRow.status).toMatchObject({ tone: 'ok', label: 'Approved by u-manager — use it before 08-10-2026 10:00' });
    expect(approvedRow.askedAt).toBe('07-10-2026 10:00');
    expect(approvedRow.why).toBe(WHY);
    expect(approvedRow.draft).toEqual({ ...big(), reasonCode: 'damage' });
    expect(v.rows[0]!.draft).toMatchObject({ writeOffId: 'WO-2', reasonCode: 'mouldy' });
    expect(v.rows[2]!.draft, 'details that are not a loss are listed but cannot be carried on').toBeNull();
    // Carrying it on and recording finds that very approval.
    const r = await o.s.record(approvedRow.draft!);
    expect(r).toEqual({ kind: 'recorded', approvedBy: 'u-manager' });
    expect(o.posted[0]!.body['approvalId']).toBe('r-new');
    expect((await o.s.yourLosses('ta')).rows[1]!.status.label).toBe('u-manager அனுமதித்தார் — 08-10-2026 10:00-க்குள் பயன்படுத்தவும்');
  });

  it('reads nothing without permission or head office, and says when the read failed', async () => {
    expect(await office({ mayCapture: false }).s.yourLosses('en')).toEqual({ state: 'not_permitted', rows: [] });
    expect(await office({ connected: false }).s.yourLosses('en')).toEqual({ state: 'not_connected', rows: [] });
    expect(await office({ inbox: { result: 'lost_link' } }).s.yourLosses('en')).toEqual({ state: 'lost_link', rows: [] });
  });

  it('draftOfDetails reads back exactly the loss, and refuses what is not one', () => {
    const d = writeOffDetails(ID, writeOffBodyOf(big()));
    expect(draftOfDetails(ID, d)).toEqual({ ...big(), reasonCode: 'damage' });
    expect(draftOfDetails(ID, { ...d, qty: 0 })).toBeNull();
    expect(draftOfDetails(ID, { ...d, lossType: 'theft' })).toBeNull();
    expect(draftOfDetails('', d)).toBeNull();
    const noPhoto = { ...d };
    delete noPhoto['evidenceRef'];
    expect(draftOfDetails(ID, noPhoto)).not.toHaveProperty('evidenceRef');
  });
});

describe('the box wiring', () => {
  it('boots only with the box’s payload; gates on inventory.movement.append (default deny); wires head office when given', async () => {
    expect(bootWriteOffCapture(undefined)).toBeNull();
    const offline = bootWriteOffCapture({ userId: 'u-owner', permissions: ['inventory.movement.append'] });
    expect(offline?.connected).toBe(false);
    expect(offline?.view('en').thresholdText).toBe('₹500.00'); // the engine default, the same line head office uses
    expect(bootWriteOffCapture({ userId: 'u-owner', permissions: ['inventory.movement.append'] }, undefined, HEAD_OFFICE_APPROVALS)?.connected).toBe(true);
    expect(writeOffCapturePortsFromData({ userId: 'u-cashier', permissions: ['pos.sale.create'] }).mayCapture()).toBe(false);
    expect(writeOffCapturePortsFromData(undefined).mayCapture()).toBe(false);
    // With no port wired a small loss is a lost link, never a pretend success.
    expect(await offline!.record(draft())).toEqual({ kind: 'lost_link' });
  });

  it('the engine knows the kind this screen asks under, checked by another person who handles stock', () => {
    const spec = APPROVAL_KINDS[WRITE_OFF_APPROVAL_KIND];
    expect(spec?.label).toBe('Write off stock (a material loss)');
    expect(spec?.makerPermission).toBe('inventory.movement.append');
    expect(spec?.checkerPermission).toBe('inventory.movement.append');
  });
});
