// The self-checkout lane and its attendant (R8-3 · D04-FR-06 · D14-FR-02 · M12 · M15 · OB-302 · OB-316 · P-01 · P-07 ·
// hard rules #1, #3 and #4).
//
// A self-checkout lane is a TILL LANE the customer operates. So it is built on the till's own tested engine — the same
// session, the same signed pack, the same store computer, the same sale path to the disk (hard rule #1: no network in the
// path of a customer paying) — with three things added on top and nothing taken away:
//
//   1. THE LANE IS OFF UNTIL THE OWNER SWITCHES IT ON FOR THIS LANE (OB-316): the `self_checkout` rollout switch, read from
//      the signed store pack with no network. A lane not told, or switched off, says so and takes nothing.
//   2. A COLLEAGUE OPENS IT, AND IS THE ONE ACCOUNTABLE FOR IT. The attendant signs the lane open with their own staff
//      code and PIN (hard rule #4: no shared login); every sale on it names them, as a till names its cashier.
//   3. ANYTHING THE CUSTOMER MUST NOT DECIDE GOES TO THE ATTENDANT, who settles it with their OWN PIN each time — never a
//      standing "attendant mode" the customer could press:
//        • an age-restricted item — always a person, never the machine (the engine's rule; OB-03's 18);
//        • a perishable whose barcode carried no date — a person looks at the pack (OB-298);
//        • a WEIGHED item without a scale label — never a keyed weight (OB-302): the attendant sends it to a verified
//          scale for its own label, or it is not sold here;
//        • an item the till refuses (recall, the law's gates) or cannot find — handed back, the reason told to the attendant;
//        • the payment — the customer pays on the shop's own card / UPI machine and the attendant confirms what the machine
//          said, typing its approval number in real trading (OB-271) — never a card number (hard rule #3). An integrated
//          terminal that answers by itself is EXTERNAL and not built.
//      The customer only ever reads neutral words ("a colleague will be with you"); the attendant reads the specific one.
//
// The engine's WATCH (random audits, produce and void patterns, the basket risk figure) runs only once the owner has set
// its numbers — until then they are "not set" and nothing is invented (P-08). No security scale is fitted (EXTERNAL), so
// the weight checks are not run, and the attendant's view says so.
//
// Pure model over ports: no DOM, no fetch. The browser entry hands it the till engine the box served.

import { assessSelfCheckout, type ScannedLine, type SelfCheckoutPolicy, type InterventionKind } from '../../../packages/self-checkout/src/self-checkout';
import {
  DECISIONS_FOR, type LaneInterventionKind, type LaneInterventionOutcome, type SettledIntervention, type SelfCheckoutBasketEvidence,
} from '../../../packages/self-checkout/src/basket-evidence';

/** The rollout switch this lane sits behind (OB-316). */
export const SELF_CHECKOUT_SWITCH = 'self_checkout';

export interface Words { readonly en: string; readonly ta: string }

/** The owner's watch numbers, when set (store pack). Absent = not set: no random audit, no pattern, no risk figure. */
export interface SelfCheckoutWatch {
  readonly auditRateBps: number;
  readonly auditAboveMinor: number;
  readonly looseProducePatternCount: number;
  readonly voidPatternCount: number;
}

type SignIn = { readonly signedIn: true; readonly userId: string; readonly displayName?: string } | { readonly signedIn: false; readonly refusedBecause?: string; readonly laneMessage: string };
type CardAnswer = { readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string; readonly attemptId?: string; readonly state?: string; readonly amountMinor?: number };
interface TillLine { readonly lineId: string; readonly productId: string; readonly description: string; readonly qtyText: string; readonly amountMinor: number; readonly uom: string; readonly voided: boolean }

/** The till engine the box served (the till's `window.posSession`) — only what this lane uses of it. */
export interface TillEngine {
  scanBarcode(code: string): { readonly lineId: string; readonly description: string; readonly amountMinor: number };
  basket(): readonly TillLine[];
  payableMinor(): number;
  voidAtTill(lineId: string, reason: string): Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string }>;
  confirmAge(minimumAge: number, atIsoUtc: string, productId?: string): unknown;
  refuseAge(minimumAge: number, atIsoUtc: string, productId?: string): unknown;
  confirmPackDate(productId: string, atIsoUtc: string): unknown;
  refusePackDate(productId: string, atIsoUtc: string): unknown;
  signInAtTill(input: { readonly staffId?: string; readonly pin?: string }): Promise<SignIn>;
  signOutAtTill(): Promise<void>;
  operator(): string | undefined;
  nextReceipt(): Promise<string>;
  startCardPayment(kind: 'card' | 'upi', amountMinor?: number): Promise<CardAnswer>;
  answerCardPayment(attemptId: string, outcome: 'approved' | 'declined' | 'no_answer', approvalId?: string, machineRef?: string): Promise<CardAnswer>;
  tenderCardOrUpi(input: { readonly saleId: string; readonly receiptNumber: string; readonly atIsoUtc: string; readonly kind: 'card' | 'upi'; readonly outcome: 'approved' | 'declined' | 'no_answer'; readonly ref?: string; readonly machineRef?: string }): Promise<string>;
  newSale(): void;
  currentBillRef(): string;
}

/** What the pack says about a code before the till is asked — enough to tell a weighed item from an each-item. */
export interface CodeLookup {
  scan(code: string): { readonly product: { readonly productId: string; readonly name: string; readonly baseUom: string }; readonly barcodeKind: string };
}

export interface SelfCheckoutLaneConfig {
  /** OB-316: is `self_checkout` on for this lane, from the signed pack — and why not when it is not. */
  readonly switchOn: boolean;
  readonly switchWhy: string | null;
  /** OB-256: the mirror pilot's only tender is "paid on old system" — a self-checkout lane cannot take that. */
  readonly mirrorPilot: boolean;
  /** OB-271: real trading — an approved machine payment carries the machine's approval number. */
  readonly realTrading: boolean;
  readonly watch?: SelfCheckoutWatch;
  readonly lookup?: CodeLookup;
  readonly now: () => string;
  /** Hand the basket's evidence to the store computer once the sale is saved (loss prevention, M15). */
  readonly recordBasket: (body: Record<string, unknown>) => Promise<{ readonly recorded: boolean; readonly laneMessage: string }>;
}

export interface LaneIntervention {
  readonly id: string;
  readonly kind: LaneInterventionKind;
  readonly blocking: boolean;
  /** Neutral words for the customer, in both languages. */
  readonly customerMessage: Words;
  /** The specific words for the attendant. */
  readonly attendantDetail: string;
  readonly decisions: readonly LaneInterventionOutcome[];
  readonly productId?: string;
  readonly lineId?: string;
}

export interface Answer { readonly ok: boolean; readonly words: Words; readonly refusedBecause?: string; readonly detail?: string }

export interface LaneView {
  readonly open: boolean;
  /** Why customers cannot use the lane now, when they cannot. */
  readonly closed: Words | null;
  readonly attendant: string | null;
  readonly lines: readonly { readonly lineId: string; readonly description: string; readonly qtyText: string; readonly amountMinor: number }[];
  readonly totalMinor: number;
  /** One neutral line for the customer: what to do now. */
  readonly customerNow: Words;
  readonly waitingForColleague: boolean;
  readonly interventions: readonly LaneIntervention[];
  readonly payment: { readonly attemptId: string; readonly kind: 'card' | 'upi'; readonly amountMinor: number } | null;
  readonly receipt: { readonly number: string; readonly basketRecorded: boolean } | null;
  /** Said to the attendant, never to the customer. */
  readonly attendantNotes: readonly string[];
}

const W = (en: string, ta: string): Words => ({ en, ta });
export const WORDS = Object.freeze({
  switchedOff: W('Self-checkout is switched off on this lane. Please use a staffed till.', 'இந்த வரிசையில் சுய-கட்டணம் நிறுத்தப்பட்டுள்ளது. ஊழியர் உள்ள கட்டண மையத்தைப் பயன்படுத்தவும்.'),
  mirrorPilot: W('This lane cannot take payment during the pilot. Please use a staffed till.', 'சோதனைக் காலத்தில் இந்த வரிசையில் கட்டணம் பெற முடியாது. ஊழியர் உள்ள கட்டண மையத்தைப் பயன்படுத்தவும்.'),
  notOpened: W('This lane is closed. A colleague will open it. Please use a staffed till.', 'இந்த வரிசை மூடப்பட்டுள்ளது. எங்கள் ஊழியர் திறப்பார். ஊழியர் உள்ள கட்டண மையத்தைப் பயன்படுத்தவும்.'),
  scanItems: W('Scan your items one by one.', 'உங்கள் பொருட்களை ஒவ்வொன்றாக ஸ்கேன் செய்யவும்.'),
  readyToPay: W('When you have scanned everything, choose how to pay. Card or UPI only.', 'அனைத்தையும் ஸ்கேன் செய்ததும், செலுத்தும் முறையைத் தேர்ந்தெடுக்கவும். கார்டு அல்லது UPI மட்டும்.'),
  colleague: W('Please wait — a colleague will be with you.', 'சற்று காத்திருங்கள் — எங்கள் ஊழியர் உங்களிடம் வருவார்.'),
  colleagueOneItem: W('A colleague will be with you to check one item.', 'ஒரு பொருளைச் சரிபார்க்க எங்கள் ஊழியர் உங்களிடம் வருவார்.'),
  colleagueWeigh: W('A colleague will help you weigh this item.', 'இந்தப் பொருளை எடைபோட எங்கள் ஊழியர் உதவுவார்.'),
  colleagueItem: W('A colleague will help you with this item.', 'இந்தப் பொருளுக்கு எங்கள் ஊழியர் உதவுவார்.'),
  notFound: W('This item did not scan. A colleague will help.', 'இந்தப் பொருள் ஸ்கேன் ஆகவில்லை. எங்கள் ஊழியர் உதவுவார்.'),
  quickCheck: W('A colleague will do a quick check — it will only take a moment.', 'எங்கள் ஊழியர் ஒரு சிறிய சரிபார்ப்பு செய்வார் — ஒரு நிமிடம் மட்டுமே.'),
  shortly: W('A colleague will be with you shortly.', 'எங்கள் ஊழியர் விரைவில் உங்களிடம் வருவார்.'),
  payOnMachine: W('Pay on the machine now. A colleague will confirm your payment.', 'இப்போது இயந்திரத்தில் செலுத்தவும். எங்கள் ஊழியர் உங்கள் கட்டணத்தை உறுதிசெய்வார்.'),
  nothingToPay: W('Scan an item first.', 'முதலில் ஒரு பொருளை ஸ்கேன் செய்யவும்.'),
  paidThanks: W('Thank you! Your bill is saved.', 'நன்றி! உங்கள் பில் சேமிக்கப்பட்டது.'),
  declined: W('The payment did not go through. You can try again, or a colleague will help.', 'கட்டணம் நடைபெறவில்லை. மீண்டும் முயற்சிக்கலாம், அல்லது எங்கள் ஊழியர் உதவுவார்.'),
  noAnswer: W('The machine has not answered. Please wait — do not pay again. A colleague will help.', 'இயந்திரம் பதில் தரவில்லை. காத்திருங்கள் — மீண்டும் செலுத்த வேண்டாம். எங்கள் ஊழியர் உதவுவார்.'),
  removed: W('Removed.', 'நீக்கப்பட்டது.'),
  notRemoved: W('That item could not be taken off. A colleague will help.', 'அந்தப் பொருளை நீக்க முடியவில்லை. எங்கள் ஊழியர் உதவுவார்.'),
  attendantRefused: W('Not accepted — check the staff code and PIN.', 'ஏற்கப்படவில்லை — ஊழியர் குறியீடு மற்றும் PIN-ஐச் சரிபார்க்கவும்.'),
  settled: W('Done. Thank you.', 'முடிந்தது. நன்றி.'),
  laneOpened: W('Lane open.', 'வரிசை திறக்கப்பட்டது.'),
  saleNotSaved: W('The bill could not be saved. Do not hand over the goods — a colleague will help.', 'பில் சேமிக்க முடியவில்லை. பொருட்களை ஒப்படைக்க வேண்டாம் — எங்கள் ஊழியர் உதவுவார்.'),
});

const ENGINE_WORDS: Partial<Record<InterventionKind, Words>> = {
  random_audit: WORDS.quickCheck, high_value_produce_pattern: WORDS.shortly, void_pattern: WORDS.shortly,
};
const WEIGHED_UOMS = new Set(['kg', 'g', 'L', 'ml']);
const LABELLED = new Set(['weight_embedded', 'price_embedded']);

/** A deterministic draw (0–9,999) from the bill: the same basket always draws the same way, so nobody can re-roll it. */
export function auditDraw(billRef: string): number {
  let h = 2166136261;
  for (let i = 0; i < billRef.length; i += 1) { h ^= billRef.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10_000;
}

export interface SelfCheckoutLane {
  view(): LaneView;
  /** The attendant signs the lane open with their own code and PIN; they are accountable for its sales. */
  openLane(staffId: string, pin: string): Promise<Answer>;
  closeLane(): Promise<Answer>;
  scan(code: string): Answer;
  removeLine(lineId: string): Promise<Answer>;
  /** The attendant settles one intervention with their OWN PIN (every time). */
  settle(interventionId: string, staffId: string, pin: string, decision: LaneInterventionOutcome): Promise<Answer>;
  /** The customer chooses card or UPI: the attempt is written on the store computer before the machine is used. */
  pay(kind: 'card' | 'upi'): Promise<Answer>;
  /** The attendant confirms what the machine said, with their own PIN — and its approval number in real trading. */
  confirmPayment(staffId: string, pin: string, outcome: 'approved' | 'declined' | 'no_answer', machineRef?: string): Promise<Answer>;
  /** The next customer: an empty basket, the lane still open under the same attendant. */
  nextCustomer(): void;
}

export function createSelfCheckoutLane(till: TillEngine, config: SelfCheckoutLaneConfig): SelfCheckoutLane {
  let seq = 0;
  /** What is waiting for a colleague now (from the scans, and the payment). */
  let pending: (LaneIntervention & { readonly code?: string; readonly minimumAge?: number })[] = [];
  /** What colleagues settled in this basket — the evidence. */
  let settled: SettledIntervention[] = [];
  /** Engine interventions a colleague has already settled, by kind (+ line). */
  let engineSettled = new Set<string>();
  let voided: string[] = [];
  let payment: { attemptId: string; kind: 'card' | 'upi'; amountMinor: number } | null = null;
  let receipt: { number: string; basketRecorded: boolean } | null = null;
  let notice: Words | null = null;
  let attendant: string | null = null;

  const closedWhy = (): Words | null => {
    if (!config.switchOn) return WORDS.switchedOff;
    if (config.mirrorPilot) return WORDS.mirrorPilot;
    if (attendant === null || till.operator() === undefined) return WORDS.notOpened;
    return null;
  };
  const activeLines = () => till.basket().filter((l) => !l.voided);

  /** The engine's interventions for this basket, when the owner's watch numbers are set; none otherwise (P-08). */
  const engineInterventions = (): LaneIntervention[] => {
    if (config.watch === undefined) return [];
    const lines: ScannedLine[] = activeLines().map((l) => ({
      lineId: l.lineId, productId: l.productId, name: l.description, qty: 1, unitPriceMinor: l.amountMinor, scannedAt: config.now(),
      looseProduce: WEIGHED_UOMS.has(l.uom),
    }));
    const policy: SelfCheckoutPolicy = {
      looseProducePatternCount: config.watch.looseProducePatternCount, voidPatternCount: config.watch.voidPatternCount,
      auditAboveMinor: config.watch.auditAboveMinor, auditRateBps: config.watch.auditRateBps,
    };
    const a = assessSelfCheckout({
      basketId: till.currentBillRef(), laneId: 'self-checkout', mode: 'self_checkout', lines, voidedLineIds: voided,
      selectedForAudit: auditDraw(till.currentBillRef()) < config.watch.auditRateBps, policy, at: config.now(),
    });
    return a.interventions
      .filter((i) => i.kind === 'random_audit' || i.kind === 'high_value_produce_pattern' || i.kind === 'void_pattern')
      .filter((i) => !engineSettled.has(i.kind))
      .map((i) => ({
        id: `E-${i.kind}`, kind: i.kind as LaneInterventionKind, blocking: i.blocking, customerMessage: ENGINE_WORDS[i.kind] ?? WORDS.shortly,
        attendantDetail: i.attendantDetail, decisions: DECISIONS_FOR[i.kind as LaneInterventionKind],
      }));
  };
  const all = (): LaneIntervention[] => [...pending, ...engineInterventions()];
  const blocking = (): LaneIntervention[] => all().filter((i) => i.blocking);

  const add = (i: Omit<LaneIntervention, 'id' | 'decisions'> & { code?: string; minimumAge?: number }): void => {
    seq += 1;
    pending = [...pending, { ...i, id: `I${seq}`, decisions: DECISIONS_FOR[i.kind] }];
  };

  /** Prove the person at the lane is a colleague, with their own code and PIN — every time, never remembered. */
  const colleague = async (staffId: string, pin: string): Promise<{ ok: true; userId: string } | { ok: false; answer: Answer }> => {
    if (staffId.trim() === '' || pin.trim() === '') return { ok: false, answer: { ok: false, words: WORDS.attendantRefused, refusedBecause: 'colleague_not_named' } };
    const r = await till.signInAtTill({ staffId: staffId.trim(), pin });
    if (!r.signedIn) return { ok: false, answer: { ok: false, words: WORDS.attendantRefused, refusedBecause: r.refusedBecause ?? 'not_signed_in', detail: r.laneMessage } };
    attendant = r.userId;
    return { ok: true, userId: r.userId };
  };

  const evidence = (): SelfCheckoutBasketEvidence => {
    const draw = config.watch === undefined ? null : auditDraw(till.currentBillRef()) < config.watch.auditRateBps;
    let riskBps: number | null = null;
    if (config.watch !== undefined) {
      riskBps = assessSelfCheckout({
        basketId: till.currentBillRef(), laneId: 'self-checkout', mode: 'self_checkout',
        lines: activeLines().map((l) => ({ lineId: l.lineId, productId: l.productId, name: l.description, qty: 1, unitPriceMinor: l.amountMinor, scannedAt: config.now(), looseProduce: WEIGHED_UOMS.has(l.uom) })),
        voidedLineIds: voided, selectedForAudit: draw === true,
        policy: { looseProducePatternCount: config.watch.looseProducePatternCount, voidPatternCount: config.watch.voidPatternCount, auditAboveMinor: config.watch.auditAboveMinor, auditRateBps: config.watch.auditRateBps },
        at: config.now(),
      }).riskBps;
    }
    return { format: 'sre-sco-basket/1', lines: activeLines().length, voids: voided.length, interventions: settled, riskBps, auditSelected: draw };
  };

  const reset = (): void => {
    pending = []; settled = []; engineSettled = new Set(); voided = []; payment = null; receipt = null; notice = null;
    till.newSale();
  };

  return {
    view(): LaneView {
      const closed = closedWhy();
      const list = all();
      const waiting = list.some((i) => i.blocking) || payment !== null;
      const customerNow = receipt !== null ? WORDS.paidThanks
        : payment !== null ? WORDS.payOnMachine
          : notice !== null ? notice
            : list.find((i) => i.blocking)?.customerMessage ?? (activeLines().length > 0 ? WORDS.readyToPay : WORDS.scanItems);
      return {
        open: closed === null, closed, attendant,
        lines: activeLines().map((l) => ({ lineId: l.lineId, description: l.description, qtyText: l.qtyText, amountMinor: l.amountMinor })),
        totalMinor: till.payableMinor(),
        customerNow: closed ?? customerNow,
        waitingForColleague: waiting,
        interventions: list,
        payment, receipt,
        attendantNotes: [
          'No security scale is fitted to this lane, so weight checks are not run (the scale is an outside supplier\'s hardware).',
          config.watch === undefined
            ? 'The owner has not set the self-checkout watch numbers (random audit rate, produce and void patterns), so none is run and no risk figure is kept — not set.'
            : `Watch: random audit ${config.watch.auditRateBps / 100}% of baskets over ₹${(config.watch.auditAboveMinor / 100).toFixed(2)}; ${config.watch.looseProducePatternCount} loose-produce lines or ${config.watch.voidPatternCount} removals are a pattern.`,
        ],
      };
    },

    async openLane(staffId, pin) {
      if (!config.switchOn) return { ok: false, words: WORDS.switchedOff, refusedBecause: 'self_checkout_switched_off', detail: config.switchWhy ?? 'switched off' };
      if (config.mirrorPilot) return { ok: false, words: WORDS.mirrorPilot, refusedBecause: 'mirror_pilot' };
      const who = await colleague(staffId, pin);
      if (!who.ok) return who.answer;
      return { ok: true, words: WORDS.laneOpened, detail: `opened by ${who.userId}` };
    },

    async closeLane() {
      await till.signOutAtTill();
      attendant = null;
      return { ok: true, words: WORDS.notOpened };
    },

    scan(code) {
      const closed = closedWhy();
      if (closed !== null) return { ok: false, words: closed, refusedBecause: 'lane_closed' };
      if (payment !== null || receipt !== null) return { ok: false, words: payment !== null ? WORDS.payOnMachine : WORDS.paidThanks, refusedBecause: 'not_now' };
      notice = null;
      // OB-302: a weighed product scanned by its plain code is never priced by a keyed weight — it goes to the attendant.
      try {
        const hit = config.lookup?.scan(code);
        if (hit !== undefined && WEIGHED_UOMS.has(hit.product.baseUom) && !LABELLED.has(hit.barcodeKind)) {
          add({ kind: 'weighed_item', blocking: true, customerMessage: WORDS.colleagueWeigh, productId: hit.product.productId, code,
            attendantDetail: `${hit.product.name} is sold by ${hit.product.baseUom}. Never key a weight (OB-302): take it to a verified scale for its own label, then the customer scans the label — or it is not sold here.` });
          return { ok: false, words: WORDS.colleagueWeigh, refusedBecause: 'weighed_item' };
        }
      } catch { /* the till below gives the real reason for a code the pack does not know */ }
      try {
        till.scanBarcode(code);
        return { ok: true, words: WORDS.readyToPay };
      } catch (e) {
        const err = e as { name?: string; laneMessage?: string; message?: string; productId?: string; description?: string; minimumAge?: number };
        const said = err.laneMessage ?? err.message ?? String(e);
        if (err.name === 'AgeCheckRequiredError') {
          add({ kind: 'age_check', blocking: true, customerMessage: WORDS.colleagueOneItem, productId: err.productId, code, minimumAge: err.minimumAge,
            attendantDetail: `${err.description ?? 'This item'} is age-restricted (${err.minimumAge}+). See the customer and their identification. The lane never clears this itself.` });
          return { ok: false, words: WORDS.colleagueOneItem, refusedBecause: 'age_check' };
        }
        if (err.name === 'PackDateCheckRequiredError') {
          add({ kind: 'pack_date_check', blocking: true, customerMessage: WORDS.colleagueOneItem, productId: err.productId, code,
            attendantDetail: `${err.description ?? 'This item'} is perishable and its barcode carries no date: look at the date printed on the pack.` });
          return { ok: false, words: WORDS.colleagueOneItem, refusedBecause: 'pack_date_check' };
        }
        if (err.name === 'UnknownBarcodeError') {
          add({ kind: 'not_found', blocking: false, customerMessage: WORDS.notFound, code, attendantDetail: `Code ${code} is not in this shop's price list: ${said}` });
          notice = WORDS.notFound;
          return { ok: false, words: WORDS.notFound, refusedBecause: 'not_found' };
        }
        // A recall, an expired batch, the law's gates, an unknown unit — the till's own words, for the attendant.
        add({ kind: 'item_refused', blocking: false, customerMessage: WORDS.colleagueItem, code, attendantDetail: `The till will not sell it: ${said}` });
        notice = WORDS.colleagueItem;
        return { ok: false, words: WORDS.colleagueItem, refusedBecause: 'item_refused', detail: said };
      }
    },

    async removeLine(lineId) {
      if (payment !== null || receipt !== null) return { ok: false, words: WORDS.notRemoved, refusedBecause: 'not_now' };
      const r = await till.voidAtTill(lineId, 'removed by the customer at self-checkout');
      if (!r.ok) return { ok: false, words: WORDS.notRemoved, ...(r.refusedBecause === undefined ? {} : { refusedBecause: r.refusedBecause }), detail: r.laneMessage };
      voided = [...voided, lineId];
      return { ok: true, words: WORDS.removed };
    },

    async settle(interventionId, staffId, pin, decision) {
      const target = all().find((i) => i.id === interventionId);
      if (target === undefined) return { ok: false, words: WORDS.settled, refusedBecause: 'nothing_to_settle' };
      if (!target.decisions.includes(decision)) return { ok: false, words: WORDS.attendantRefused, refusedBecause: 'not_a_decision_for_this', detail: `${target.kind} is settled by ${target.decisions.join(' or ')}` };
      const who = await colleague(staffId, pin);
      if (!who.ok) return who.answer;
      const at = config.now();
      const p = pending.find((i) => i.id === interventionId);
      // Each decision through the till's own engine, in the colleague's name (they are signed in now).
      if (p !== undefined && p.kind === 'age_check' && p.minimumAge !== undefined) {
        if (decision === 'old_enough') till.confirmAge(p.minimumAge, at, p.productId);
        else till.refuseAge(p.minimumAge, at, p.productId);
      }
      if (p !== undefined && p.kind === 'pack_date_check' && p.productId !== undefined) {
        if (decision === 'date_good') till.confirmPackDate(p.productId, at);
        else till.refusePackDate(p.productId, at);
      }
      pending = pending.filter((i) => i.id !== interventionId);
      if (p === undefined) engineSettled = new Set([...engineSettled, target.kind]);
      settled = [...settled, { kind: target.kind, blocking: target.blocking, outcome: decision, settledBy: who.userId, at, ...(target.productId === undefined ? {} : { productId: target.productId }) }];
      if (notice !== null && !pending.some((i) => i.kind === 'not_found' || i.kind === 'item_refused')) notice = null;
      // A yes puts the held item on the bill now, through the same scan the customer made.
      if (p?.code !== undefined && (decision === 'old_enough' || decision === 'date_good')) {
        try { till.scanBarcode(p.code); } catch (e) {
          const err = e as { laneMessage?: string; message?: string };
          return { ok: false, words: WORDS.colleagueItem, refusedBecause: 'item_refused', detail: err.laneMessage ?? err.message ?? String(e) };
        }
      }
      return { ok: true, words: WORDS.settled };
    },

    async pay(kind) {
      const closed = closedWhy();
      if (closed !== null) return { ok: false, words: closed, refusedBecause: 'lane_closed' };
      if (activeLines().length === 0) return { ok: false, words: WORDS.nothingToPay, refusedBecause: 'nothing_to_pay' };
      if (blocking().length > 0) return { ok: false, words: blocking()[0]!.customerMessage, refusedBecause: 'colleague_needed' };
      if (payment !== null) return { ok: true, words: WORDS.payOnMachine };
      const r = await till.startCardPayment(kind);
      if (!r.ok || r.attemptId === undefined) return { ok: false, words: WORDS.colleague, refusedBecause: r.refusedBecause ?? 'payment_not_started', detail: r.laneMessage };
      payment = { attemptId: r.attemptId, kind, amountMinor: r.amountMinor ?? till.payableMinor() };
      return { ok: true, words: WORDS.payOnMachine };
    },

    async confirmPayment(staffId, pin, outcome, machineRef) {
      if (payment === null) return { ok: false, words: WORDS.readyToPay, refusedBecause: 'no_payment_started' };
      if (outcome === 'approved' && config.realTrading && (machineRef ?? '').trim() === '') {
        return { ok: false, words: WORDS.attendantRefused, refusedBecause: 'machine_ref_required', detail: 'In real trading the machine\'s approval / reference number from the slip is typed with an approval (OB-271).' };
      }
      const who = await colleague(staffId, pin);
      if (!who.ok) return who.answer;
      const at = config.now();
      const answered = await till.answerCardPayment(payment.attemptId, outcome, undefined, outcome === 'approved' ? machineRef?.trim() : undefined);
      if (!answered.ok) return { ok: false, words: WORDS.colleague, refusedBecause: answered.refusedBecause ?? 'answer_not_recorded', detail: answered.laneMessage };
      settled = [...settled, { kind: 'payment', blocking: true, outcome, settledBy: who.userId, at }];
      if (outcome === 'declined') { payment = null; return { ok: false, words: WORDS.declined, refusedBecause: 'declined' }; }
      if (outcome === 'no_answer') return { ok: false, words: WORDS.noAnswer, refusedBecause: 'no_answer', detail: answered.laneMessage };
      // Approved: the bill number from the store computer, then the sale onto its disk — the till's own path (hard rule #1).
      let number: string;
      try { number = await till.nextReceipt(); } catch (e) {
        const err = e as { laneMessage?: string; message?: string };
        return { ok: false, words: WORDS.saleNotSaved, refusedBecause: 'receipt_number_not_issued', detail: err.laneMessage ?? err.message ?? String(e) };
      }
      const saleId = `S-${number}`;
      try {
        await till.tenderCardOrUpi({ saleId, receiptNumber: number, atIsoUtc: at, kind: payment.kind, outcome: 'approved', ref: payment.attemptId, ...(machineRef === undefined || machineRef.trim() === '' ? {} : { machineRef: machineRef.trim() }) });
      } catch (e) {
        const err = e as { laneMessage?: string; message?: string; name?: string };
        return { ok: false, words: WORDS.saleNotSaved, refusedBecause: err.name ?? 'sale_not_saved', detail: err.laneMessage ?? err.message ?? String(e) };
      }
      // The basket's evidence for loss prevention — after the sale is safe; a failure here is said, never fatal.
      const ev = evidence();
      const total = payment.amountMinor;
      payment = null;
      receipt = { number, basketRecorded: false };
      try {
        const r = await config.recordBasket({ activityId: `SCO-${saleId}`, kind: 'self_checkout_basket', billRef: saleId, valueMinor: total, reason: 'self-checkout basket', selfCheckout: ev });
        receipt = { number, basketRecorded: r.recorded };
      } catch { receipt = { number, basketRecorded: false }; }
      return { ok: true, words: WORDS.paidThanks, detail: number };
    },

    nextCustomer() { reset(); },
  };
}
