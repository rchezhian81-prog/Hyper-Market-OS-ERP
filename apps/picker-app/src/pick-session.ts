// Picker/packer handheld session (M19 / M18 / D09) — the model behind the picker
// screens (`docs/design/screens/picker-packer.md`). It runs on a low-spec Android
// handheld in the aisles, so it is **synchronous and local by construction**: the
// assigned wave is cached, every scan is recorded locally, and nothing here awaits
// the network (§31 picking row). PII is minimised — a pick line carries the order
// reference, never customer details.
//
// The rules the spec insists on, enforced here rather than trusted to the picker:
//   • EVERY PICK IS A SCAN, in order — scan the bin, then scan the item, then
//     confirm. Confirming without those scans is refused, and scanning the wrong
//     item for the bin is refused;
//   • A SUBSTITUTION IS NEVER THE PICKER'S SILENT CHOICE — it commits only with the
//     customer's confirmation (A04), delegated to `packages/fulfilment`;
//   • A WEIGHED ITEM CAPTURES ITS FINAL PRICE AT PICK (D09), so the bill matches
//     what was actually put in the crate;
//   • THE MANIFEST MATCHES WHAT WAS PACKED — it is derived from the picked lines,
//     never typed, and packing is blocked while any line is unresolved.
//
// ── The outbox, and why it is a required constructor argument ────────────────
//
// The paragraph above used to end "the scans queue for sync afterwards" and **nothing queued**.
// The session held every resolved line in a JavaScript object and no other part of the system ever
// heard about them: a wave picked correctly, offline, exactly as designed, existed only until the
// handheld was closed. The docstring was the only place the queue had ever been.
//
// So the outbox is a constructor argument and it is **required**. An optional one is a port a
// deployment can forget, and forgetting it is invisible — which is precisely how this got here.
// Every line that reaches a resolved state queues an event, and so does the pack.

import { makeEvent } from '../../../packages/contracts/src/event';
import { money, multiplyByInteger, scaleMoney, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';
import { precisionOf, minorPerUnitOf, normaliseUom, quantityLabel, toDecimalString, typedQuantityMinor, type Uom } from '../../../packages/contracts/src/quantity';
import { confirmSubstitution } from '../../../packages/fulfilment/src/delivery';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { NewWorkRefusedError } from '../../../packages/platform-admin/src/client-version'; // OB-521 (R8-A)
import { deviceItemReason, deviceItemState, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';

/**
 * `awaiting_customer` (OB-687 · FUL-14): the picker PROPOSED a swap on a line whose customer asked to be asked first, and
 * the customer's yes or no has not come back yet. Not resolved — the crate cannot be packed while a line waits.
 */
export type LineState = 'pending' | 'awaiting_customer' | 'picked' | 'short' | 'substituted' | 'quality_failed';

/**
 * The customer's substitution rule for a line, as head office carried it with the wave (FUL-14 · OB-687) — never the
 * customer themself (PII stays off the handheld): `ask_first` — a swap needs the customer's yes, so the picker PROPOSES it;
 * `never` — no swap; `best_match` — the shop may choose. Absent: head office holds no rule for the order.
 */
export const LINE_SUBSTITUTION_RULES = Object.freeze(['ask_first', 'never', 'best_match'] as const);
export type LineSubstitutionRule = (typeof LINE_SUBSTITUTION_RULES)[number];

/** Why the picker is offering a swap — chosen, never typed; the customer is told it in their own language. */
export const PROPOSAL_REASONS = Object.freeze(['out_of_stock', 'not_found'] as const);
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

/**
 * Head office's word on one proposal, as the store computer read it back (OB-687): still waiting, the customer said yes or no
 * (in the app, or to staff by phone — the same), the shop's own rules refuse the swap, or it is too late / closed.
 */
export const ANSWER_STATES = Object.freeze(['waiting', 'yes', 'no', 'refused', 'too_late', 'closed'] as const);
export type AnswerState = (typeof ANSWER_STATES)[number];
export interface SubstitutionAnswer {
  readonly proposalId: string;
  readonly lineId: string;
  readonly state: AnswerState;
  readonly substituteProductId?: string;
  readonly substituteName?: string;
  /** The substitute's published price per unit, as head office read it — what a yes is packed at. */
  readonly substituteUnitPriceMinor?: number | null;
  /** How the yes or no was given: in the app, or told to staff (by phone, WhatsApp, SMS or in person). */
  readonly via?: 'app' | 'staff';
  /** For a staff-recorded answer: the call or message reference a person can look up. */
  readonly reference?: string;
  /** For `refused`: head office's reason in its words. */
  readonly reason?: string;
}

/** How a waiting line was settled when the answers were read back — the screen words each one. */
export type AnswerOutcome = 'swapped' | 'customer_said_no' | 'refused_by_rule' | 'no_answer_in_time';

/** One line of assigned work. `bin` is where the picker must scan first. */
export interface PickLineInput {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly bin: string;
  /**
   * Where this sits in the shop, as the aisle sign reads it (M04-FR-02).
   *
   * Absent means the shop has **no shelf address for this item**, which is not a cosmetic gap: the
   * line is placed at the end of the walk and the picker is told, because the alternative is a
   * silent trip back across the shop that looks like the route being wrong.
   */
  readonly shelf?: string;
  /** True when this line has no shelf address. Shown, never hidden. */
  readonly unmapped?: boolean;
  /** Required quantity in the UOM's smallest unit. */
  readonly requiredQty: number;
  readonly uom: Uom;
  /** Price per UOM unit — used to capture a weighed line's final price (D09). */
  readonly unitPrice: Money;
  /** The product master's handling class, when the catalogue pack carries one (HA-2) — shown so the picker keeps a cold
   *  item cold. Absent means nobody has said; the handheld shows nothing rather than a guess. */
  readonly handling?: string;
  /** The customer's substitution rule (OB-687 · FUL-14), as head office carried it. Absent: no rule on record. */
  readonly substitution?: LineSubstitutionRule;
}

/** A swap the picker proposed and the customer has not answered yet (OB-687). */
export interface LineProposal {
  readonly proposalId: string;
  readonly substituteProductId: string;
  /** Absent only on a proposal resumed from head office's word after this handheld's own queue no longer held it. */
  readonly why?: ProposalReason;
  readonly proposedAt: string;
  /** The owner's wait, counted from when the picker asked: no answer by then and the line goes short. */
  readonly answerBy: string;
  readonly waitMinutes: number;
}

export interface PickLine extends PickLineInput {
  readonly state: LineState;
  /** What was actually picked (may be less than required on a short pick). */
  readonly pickedQty: number;
  /** Final line price captured at pick — exact for weighed goods (D09). */
  readonly finalPrice: Money;
  readonly substituteProductId?: string;
  readonly note?: string;
  /** Present while the line waits for the customer's answer, and kept after so the outcome can say what was asked. */
  readonly proposal?: LineProposal;
}

export interface WaveProgress {
  readonly total: number;
  readonly resolved: number;
  readonly pending: number;
  readonly complete: boolean;
}

/** Cold-chain / tamper evidence recorded at packing (M19-FR-02). */
export interface PackEvidence {
  readonly temperatureC?: number;
  readonly tamperSealRef?: string;
  readonly packedBy: string;
  readonly at: string;
}

export interface ManifestLine {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly qty: number;
  readonly uom: Uom;
  readonly finalPrice: Money;
  readonly substituted: boolean;
}

export interface DispatchManifest {
  readonly waveId: string;
  readonly packedBy: string;
  readonly at: string;
  readonly lines: readonly ManifestLine[];
  readonly totalValue: Money;
  readonly evidence: PackEvidence;
}

/** The two event types this handheld queues — named once, for the session, the box's allow-list and the cloud routes. */
export const PICK_LINE_RESOLVED = 'PickLineResolved';
export const WAVE_PACKED = 'WavePacked';
/** OB-687: a swap proposed to the customer — relayed by the store computer to head office, where the customer answers it. */
export const SUBSTITUTION_PROPOSED = 'SubstitutionProposed';

/** The kinds of work this handheld sends: a line's outcome, the wave's pack, a swap put to the customer. A guardrail binds the shell's words to this. */
export const SENT_WORK_KINDS = Object.freeze(['line', 'pack', 'proposal'] as const);
export type SentWorkKind = (typeof SENT_WORK_KINDS)[number];

/**
 * One piece of work this handheld queued, and where it has got to (SP-3c-i · the five shared device states). Read from
 * the DURABLE device queue plus the store computer's own word — so the list is the same after the app is closed.
 */
export interface SentWork {
  readonly kind: SentWorkKind;
  /** The line id for a line outcome; the wave id for the pack. */
  readonly id: string;
  /** What it was: the product (or substitute) and the order reference; the wave for a pack. */
  readonly what: string;
  /** The outcome in the model's own words: the state and quantity for a line; lines and value for a pack. */
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

export class NoSuchLineError extends Error {
  constructor(lineId: string) {
    super(`No pick line "${lineId}" in this wave.`);
    this.name = 'NoSuchLineError';
  }
}

export class BinNotScannedError extends Error {
  constructor(bin: string) {
    super(`Scan bin ${bin} before picking from it.`);
    this.name = 'BinNotScannedError';
  }
}

export class WrongItemError extends Error {
  constructor(expected: string, scanned: string) {
    super(`Wrong item: expected ${expected}, scanned ${scanned}.`);
    this.name = 'WrongItemError';
  }
}

export class LineAlreadyResolvedError extends Error {
  constructor(lineId: string, state: LineState) {
    super(`Line "${lineId}" is already ${state}.`);
    this.name = 'LineAlreadyResolvedError';
  }
}

export class WaveNotCompleteError extends Error {
  constructor(pending: number) {
    super(`Cannot pack: ${pending} line(s) still unresolved.`);
    this.name = 'WaveNotCompleteError';
  }
}

export class ReasonRequiredError extends Error {
  constructor(what: string) {
    super(`A ${what} needs a reason — it is recorded against the order.`);
    this.name = 'ReasonRequiredError';
  }
}

export class SubstitutionEvidenceRequiredError extends Error {
  constructor(lineId: string) {
    super(
      `Line "${lineId}": a substitution needs the customer's own confirmation, as a reference ` +
      'that can be looked up afterwards. A tick box is not evidence.',
    );
    this.name = 'SubstitutionEvidenceRequiredError';
  }
}

export class NotAskFirstLineError extends Error {
  constructor(lineId: string) {
    super(`Line "${lineId}": the customer did not ask to be asked first, so a swap here is not put to them — record it with their reference, or mark the item unavailable.`);
    this.name = 'NotAskFirstLineError';
  }
}

/** The words a line goes short with when the owner has set no wait (OB-687): the picker does not wait. */
export const NO_WAIT_SET_REASON = 'no wait set by the owner — the picker does not wait for the customer, so the line goes short';

/**
 * A picker's assigned wave. Everything is local and synchronous — the handheld
 * works with no signal and the scans queue for sync afterwards.
 */
export class PickSession {
  private readonly lines: PickLine[];
  private scannedBin: string | null = null;
  private packed: DispatchManifest | null = null;

  private readonly currency: CurrencyCode;
  private readonly at: () => string;
  /** Who is picking, as the wave named them — travels on every outcome so head office can re-verify the picker (§28). */
  private readonly pickerId: string | null;
  /** The store computer's word on each item it took, keyed by queue key — filled by `noteBoxStatus` (SP-3c-i). */
  private readonly boxWord = new Map<string, BoxItemStatus>();
  /** OB-521: set while this build may not START a new wave (withdrawn or too old) — the words to refuse it with. */
  private newWorkBar: { readonly en: string; readonly ta: string } | null = null;

  constructor(
    readonly waveId: string,
    assigned: readonly PickLineInput[],
    /** Where every resolved line and the pack are queued for sync. Required — see above. */
    private readonly outbox: SyncOutbox,
    options: {
      readonly currency?: CurrencyCode;
      /** Injected so a test is deterministic; the handheld passes its own clock. */
      readonly now?: () => string;
      /** The picker the wave was assigned to. Absent on a wave that named nobody — recorded as such, never invented. */
      readonly pickerId?: string;
    } = {},
  ) {
    this.currency = options.currency ?? 'INR';
    this.at = options.now ?? (() => new Date().toISOString());
    this.pickerId = options.pickerId ?? null;
    this.lines = assigned.map((l) => ({
      ...l,
      // W4 (M19-FR-02): head office's wave lines carry the product master's unit as spelled ("each", "KG"); the quantity and
      // price helpers are keyed on the stored code, so it is read through the one shared spelling map (OB-31 rule 4). An
      // unknown spelling stays as given (the helpers then refuse it rather than guess).
      uom: normaliseUom(l.uom) ?? l.uom,
      state: 'pending' as LineState,
      pickedQty: 0,
      finalPrice: money(0, this.currency),
    }));
  }

  /**
   * OB-521: bar (or, with `null`, lift the bar on) STARTING a new wave on this build. A wave this handheld has already
   * started — a line resolved here, or anything of it in the device queue — is always finished.
   */
  barNewWork(words: { readonly en: string; readonly ta: string } | null): void {
    this.newWorkBar = words;
  }

  /** OB-521: has this handheld already started this wave? (A resolved line, or anything of it already queued here.) */
  started(): boolean {
    return this.lines.some((l) => l.state !== 'pending') || this.packed !== null
      || this.outbox.all().some((item) => item.event.source === this.waveId);
  }

  /** The assigned work, as the handheld lists it. */
  work(): readonly PickLine[] {
    return this.lines.slice();
  }

  /**
   * OB-31 rule 1 (Round B follow-up) — a quantity of this line as the picker reads it, in the line's OWN unit: 1500 of a kg
   * line is "1.500 kg", 750 of a litre line "0.750 L" (it showed "750", raw millilitres), 2 items "2". Words only.
   */
  quantityText(lineId: string, quantityMinor: number): string {
    return quantityLabel(quantityMinor, this.lineOrThrow(lineId).uom);
  }

  /** The same quantity as the number the picker types back in the line's unit ("1.500", "0.750", "2") — the pre-fill. */
  typedText(lineId: string, quantityMinor: number): string {
    return toDecimalString({ minor: quantityMinor, uom: this.lineOrThrow(lineId).uom });
  }

  /** Whether the picker types a decimal for this line (kg / L — to the gram or millilitre), so the keypad offers ".". */
  takesDecimal(lineId: string): boolean {
    return minorPerUnitOf(this.lineOrThrow(lineId).uom) > 1;
  }

  /**
   * OB-31 rule 1 — what the picker TYPED, in the line's own unit ("0.75" L, "1.5" kg, "2" items), as the integer count of
   * the unit's smallest step that `pick` takes (750 ml, 1500 g, 2), through the ONE shared reading (`typedQuantityMinor`).
   * `undefined` for anything the unit does not hold exactly (half an item, a fourth decimal of a kg, nought, a word).
   */
  quantityFromTyped(lineId: string, typed: string): number | undefined {
    return typedQuantityMinor(typed, this.lineOrThrow(lineId).uom);
  }

  progress(): WaveProgress {
    // A line waiting for the customer's answer is not resolved (OB-687): the crate cannot be packed while it waits.
    const pending = this.lines.filter((l) => l.state === 'pending' || l.state === 'awaiting_customer').length;
    return {
      total: this.lines.length,
      resolved: this.lines.length - pending,
      pending,
      complete: pending === 0,
    };
  }

  /** Step 1 of every pick: scan the bin the picker is standing at. */
  scanBin(bin: string): void {
    this.scannedBin = bin.trim();
  }

  private lineOrThrow(lineId: string): PickLine {
    const line = this.lines.find((l) => l.lineId === lineId);
    if (line === undefined) throw new NoSuchLineError(lineId);
    return line;
  }

  /**
   * Record a line's new state — and queue it.
   *
   * Every path that resolves a line goes through here (pick, substitute, quality fail, mark
   * unavailable), so the queueing cannot be forgotten by a path added later. That is the point of
   * doing it in one place rather than four.
   *
   * Idempotent on line id **and state**: re-recording the same outcome collapses to one item, while
   * a genuine change of outcome queues its own event, because "picked 4" followed by "quality
   * failed" is two things that happened and the cloud needs both.
   */
  private replace(next: PickLine): void {
    // OB-521: the first outcome of a wave STARTS it — refused on a barred build, before anything changes.
    if (this.newWorkBar !== null && !this.started()) throw new NewWorkRefusedError(this.newWorkBar.en, this.newWorkBar.ta);
    const index = this.lines.findIndex((l) => l.lineId === next.lineId);
    this.lines[index] = next;
    this.outbox.enqueue(
      makeEvent({
        id: `${this.waveId}:${next.lineId}:${next.state}`,
        type: PICK_LINE_RESOLVED,
        occurredAt: this.at(),
        idempotencyKey: `pick:${this.waveId}:${next.lineId}:${next.state}`,
        source: this.waveId,
        payload: {
          waveId: this.waveId,
          lineId: next.lineId,
          // The order reference travels; the customer does not. PII stays off the handheld (§31).
          orderRef: next.orderRef,
          productId: next.substituteProductId ?? next.productId,
          // M19-FR-02 fold: head office builds the ORDER's pack from this — the name as the shop wrote it and the quantity
          // the order asked for, so a short line is charged for what goes and says by how much it is short.
          description: next.description,
          requiredQty: next.requiredQty,
          state: next.state,
          pickedQty: next.pickedQty,
          uom: next.uom,
          finalPriceMinor: next.finalPrice.minor,
          currency: next.finalPrice.currency,
          substituted: next.state === 'substituted',
          note: next.note ?? null,
          // Who did it (SP-3c-i): head office re-verifies this person from THEIR grants, never the relay's.
          pickedBy: this.pickerId,
        },
      }),
    );
  }

  private assertPickable(line: PickLine): void {
    if (line.state !== 'pending') {
      throw new LineAlreadyResolvedError(line.lineId, line.state);
    }
    // Step 1 must have happened, at the right bin.
    if (this.scannedBin !== line.bin) {
      throw new BinNotScannedError(line.bin);
    }
  }

  /** The exact line price for a quantity — weighed goods price to the paisa (D09). */
  private priceFor(line: PickLine, qty: number): Money {
    const denominator = 10 ** precisionOf(line.uom);
    return denominator === 1
      ? multiplyByInteger(line.unitPrice, qty)
      : scaleMoney(line.unitPrice, qty, denominator, 'half_up');
  }

  /**
   * Steps 2 and 3: scan the item, then confirm the quantity. Refuses a wrong item
   * and refuses picking before the bin was scanned. Captures the final price —
   * exact for a weighed line (D09). Picking less than required is a SHORT pick, so
   * the order is updated honestly (M19-FR-01) rather than silently completed.
   */
  pick(lineId: string, scannedProductId: string, qty: number): PickLine {
    const line = this.lineOrThrow(lineId);
    this.assertPickable(line);
    if (scannedProductId.trim() !== line.productId) {
      throw new WrongItemError(line.productId, scannedProductId.trim());
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new RangeError(`Picked quantity must be a positive integer, got ${qty}.`);
    }
    if (qty > line.requiredQty) {
      throw new RangeError(`Cannot pick more than the ${line.requiredQty} required.`);
    }

    const next: PickLine = {
      ...line,
      state: qty < line.requiredQty ? 'short' : 'picked',
      pickedQty: qty,
      finalPrice: this.priceFor(line, qty),
    };
    this.replace(next);
    return next;
  }

  /**
   * Record a substitution for a short line. It commits ONLY with the customer's
   * confirmation (A04) — delegated to `packages/fulfilment`, which refuses an
   * unconfirmed swap. Never the picker's silent choice.
   *
   * ── Why the confirmation needs a REFERENCE and not a tick ──────────────────
   *
   * The rule engine takes a boolean, and a boolean on a handheld is a checkbox labelled *customer
   * confirmed* that a picker with eleven lines left taps in half a second. It is true in the type
   * system and unverifiable in the aisle, and afterwards nobody can tell an agreed swap from a
   * guessed one.
   *
   * So this layer requires the **evidence**: whatever the tenant's A04 rule produces — the id of
   * the customer's reply, a call log reference, a chat message id. It is not validated here
   * (only the tenant knows what shape theirs takes) but it must exist and it travels with the
   * substitution, so a swap the customer disputes can be looked up rather than argued about.
   */
  substitute(
    lineId: string,
    substituteProductId: string,
    /** The customer's own confirmation, as a reference that can be looked up. Never a tick box. */
    approvalRef: string,
    qty: number,
    substituteUnitPrice: Money,
  ): PickLine {
    const line = this.lineOrThrow(lineId);
    if (line.state === 'picked' || line.state === 'substituted') {
      throw new LineAlreadyResolvedError(lineId, line.state);
    }
    if (approvalRef.trim() === '') {
      throw new SubstitutionEvidenceRequiredError(lineId);
    }
    // Throws SubstitutionNotConfirmedError when the customer has not agreed.
    confirmSubstitution({
      orderLineId: lineId,
      originalProductId: line.productId,
      substituteProductId,
      customerConfirmed: true,
    });

    const priced: PickLine = { ...line, unitPrice: substituteUnitPrice };
    const next: PickLine = {
      ...priced,
      state: 'substituted',
      pickedQty: qty,
      finalPrice: this.priceFor(priced, qty),
      substituteProductId,
      // Kept on the line so it reaches the manifest and the queue with the swap it belongs to.
      note: `customer approval: ${approvalRef.trim()}`,
    };
    this.replace(next);
    return next;
  }

  /**
   * OB-687 · FUL-14 · M19-FR-02: PROPOSE a swap on a line whose customer asked to be asked first. Nothing is decided here:
   * the proposal is queued for the store computer (it reaches head office once, keyed on the line and the substitute), the
   * customer answers it in the app (or tells staff, who record it), and the answer is read back with `applyAnswers`.
   *
   * The owner's wait (`waitMinutes`) is HIS number. With none set the picker does not wait: the line goes short now, with the
   * reason said, and nothing is put to the customer. Local and synchronous, like every other act on this handheld.
   */
  proposeSubstitute(
    lineId: string, substituteProductId: string, why: ProposalReason, waitMinutes: number | null | undefined,
  ): { readonly outcome: 'asked'; readonly line: PickLine; readonly answerBy: string } | { readonly outcome: 'short_no_wait'; readonly line: PickLine } {
    const line = this.lineOrThrow(lineId);
    if (line.state !== 'pending') throw new LineAlreadyResolvedError(lineId, line.state);
    if (line.substitution !== 'ask_first') throw new NotAskFirstLineError(lineId);
    const sub = substituteProductId.trim();
    if (sub === '' || sub === line.productId) throw new RangeError('A swap is a different product from the one ordered — scan the item you are offering instead.');
    if (!(PROPOSAL_REASONS as readonly string[]).includes(why)) throw new ReasonRequiredError('proposed swap');
    if (waitMinutes === null || waitMinutes === undefined) {
      return { outcome: 'short_no_wait', line: this.markUnavailable(lineId, NO_WAIT_SET_REASON) };
    }
    if (!Number.isSafeInteger(waitMinutes) || waitMinutes <= 0) throw new RangeError(`The wait must be whole minutes above nought, got ${waitMinutes}.`);
    // OB-521: the first outcome of a wave STARTS it — refused on a barred build, before anything changes.
    if (this.newWorkBar !== null && !this.started()) throw new NewWorkRefusedError(this.newWorkBar.en, this.newWorkBar.ta);
    const proposedAt = this.at();
    const answerBy = new Date(Date.parse(proposedAt) + waitMinutes * 60_000).toISOString();
    const proposalId = `${this.waveId}:${lineId}:${sub}`;
    const proposal: LineProposal = { proposalId, substituteProductId: sub, why, proposedAt, answerBy, waitMinutes };
    const next: PickLine = { ...line, state: 'awaiting_customer', proposal };
    const index = this.lines.findIndex((l) => l.lineId === lineId);
    this.lines[index] = next;
    this.outbox.enqueue(
      makeEvent({
        id: `${this.waveId}:${lineId}:proposal`,
        type: SUBSTITUTION_PROPOSED,
        occurredAt: proposedAt,
        idempotencyKey: `subprop:${proposalId}`,
        source: this.waveId,
        payload: {
          proposalId, waveId: this.waveId, lineId,
          // The order reference travels; the customer does not (§31).
          orderRef: line.orderRef, orderedProductId: line.productId, description: line.description,
          substituteProductId: sub, quantity: line.requiredQty, uom: line.uom, why, waitMinutes, proposedAt, answerBy,
          // Who asked: head office re-verifies this person from THEIR grants, never the relay's.
          proposedBy: this.pickerId,
        },
      }),
    );
    return { outcome: 'asked', line: next, answerBy };
  }

  /**
   * OB-687: after the handheld was closed and opened again, a line it had put to the customer still WAITS — from its own
   * durable queue (the proposal it sent, with no outcome after it), else from head office's word (an answer on the wave). It is
   * never asked twice: head office refuses a second swap on one line.
   */
  resumeProposals(answers: readonly SubstitutionAnswer[] = []): number {
    let resumed = 0;
    const queued = this.outbox.all().map((i) => i.event).filter((e) => e.source === this.waveId);
    for (const line of this.lines) {
      if (line.state !== 'pending') continue;
      if (queued.some((e) => e.type === PICK_LINE_RESOLVED && (e.payload as { lineId?: unknown }).lineId === line.lineId)) continue;
      const sent = queued.find((e) => e.type === SUBSTITUTION_PROPOSED && (e.payload as { lineId?: unknown }).lineId === line.lineId);
      let proposal: LineProposal | undefined;
      if (sent !== undefined) {
        const p = sent.payload as { proposalId: string; substituteProductId: string; why: ProposalReason; proposedAt: string; answerBy: string; waitMinutes: number };
        proposal = { proposalId: p.proposalId, substituteProductId: p.substituteProductId, why: p.why, proposedAt: p.proposedAt, answerBy: p.answerBy, waitMinutes: p.waitMinutes };
      } else {
        const a = answers.find((x) => x.lineId === line.lineId && x.substituteProductId !== undefined && typeof (x as { answerBy?: unknown }).answerBy === 'string');
        const answerBy = (a as { answerBy?: string } | undefined)?.answerBy;
        if (a !== undefined && answerBy !== undefined) proposal = { proposalId: a.proposalId, substituteProductId: a.substituteProductId!, proposedAt: answerBy, answerBy, waitMinutes: 0 };
      }
      if (proposal === undefined) continue;
      this.lines[this.lines.indexOf(line)] = { ...line, state: 'awaiting_customer', proposal };
      resumed += 1;
    }
    return resumed;
  }

  /** The lines waiting for the customer's answer — the ones worth asking the store computer about. */
  waitingForCustomer(): readonly PickLine[] {
    return this.lines.filter((l) => l.state === 'awaiting_customer');
  }

  /**
   * OB-687: fold in head office's word on the proposals (read back through the store computer) and settle each waiting line:
   * a YES packs the swap at the substitute's published price, with the answer as the customer's own reference; a NO, a swap
   * the shop's rules refuse, or no answer by the owner's time leaves the line SHORT, the reason said. A line whose time has
   * passed goes short even with no word from head office (`answers` empty — the handheld may be offline), because the owner
   * said how long the picker waits. Every settlement is an ordinary line outcome, queued like any other.
   */
  applyAnswers(answers: readonly SubstitutionAnswer[], now: string = this.at()): readonly { readonly lineId: string; readonly outcome: AnswerOutcome; readonly line: PickLine }[] {
    const settled: { lineId: string; outcome: AnswerOutcome; line: PickLine }[] = [];
    for (const line of this.waitingForCustomer()) {
      const p = line.proposal!;
      const a = answers.find((x) => x.proposalId === p.proposalId && x.lineId === line.lineId);
      const price = a?.substituteUnitPriceMinor;
      if (a?.state === 'yes' && typeof price === 'number' && Number.isSafeInteger(price) && price >= 0) {
        const ref = `customer said yes ${a.via === 'staff' ? `to staff (${a.reference ?? 'no reference'})` : 'in the app'} · proposal ${p.proposalId}`;
        settled.push({ lineId: line.lineId, outcome: 'swapped', line: this.substitute(line.lineId, p.substituteProductId, ref, line.requiredQty, money(price, line.unitPrice.currency)) });
      } else if (a?.state === 'no') {
        settled.push({ lineId: line.lineId, outcome: 'customer_said_no', line: this.markUnavailable(line.lineId, `the customer said no to ${p.substituteProductId}`) });
      } else if (a?.state === 'refused') {
        settled.push({ lineId: line.lineId, outcome: 'refused_by_rule', line: this.markUnavailable(line.lineId, `the shop's rules refuse ${p.substituteProductId}: ${a.reason ?? 'no reason given'}`) });
      } else if (a?.state === 'too_late' || a?.state === 'closed' || Date.parse(now) > Date.parse(p.answerBy)) {
        settled.push({ lineId: line.lineId, outcome: 'no_answer_in_time', line: this.markUnavailable(line.lineId, p.waitMinutes > 0 ? `no answer from the customer within ${p.waitMinutes} minute(s)` : `no answer from the customer by ${p.answerBy}`) });
      }
    }
    return settled;
  }

  /** Flag a quality failure — the line is excluded from the pack, with a reason. */
  failQuality(lineId: string, reason: string): PickLine {
    const line = this.lineOrThrow(lineId);
    if (reason.trim() === '') throw new ReasonRequiredError('quality failure');
    const next: PickLine = {
      ...line,
      state: 'quality_failed',
      pickedQty: 0,
      finalPrice: money(0, this.currency),
      note: reason,
    };
    this.replace(next);
    return next;
  }

  /** Mark a line short with nothing picked (item unavailable, no substitute accepted). */
  markUnavailable(lineId: string, reason: string): PickLine {
    const line = this.lineOrThrow(lineId);
    if (reason.trim() === '') throw new ReasonRequiredError('short pick');
    const next: PickLine = { ...line, state: 'short', pickedQty: 0, finalPrice: money(0, this.currency), note: reason };
    this.replace(next);
    return next;
  }

  /**
   * Pack the wave and produce the dispatch manifest. Blocked while any line is
   * unresolved. The manifest is DERIVED from what was actually picked — quality
   * failures and zero-pick shorts are excluded — so it matches the crate exactly
   * (M19-FR-02 acceptance).
   */
  pack(evidence: PackEvidence): DispatchManifest {
    const progress = this.progress();
    if (!progress.complete) {
      throw new WaveNotCompleteError(progress.pending);
    }

    const packedLines = this.lines.filter((l) => l.pickedQty > 0 && l.state !== 'quality_failed');
    let totalValue = money(0, this.currency);
    const lines: ManifestLine[] = packedLines.map((l) => {
      totalValue = money(totalValue.minor + l.finalPrice.minor, this.currency);
      return {
        lineId: l.lineId,
        orderRef: l.orderRef,
        productId: l.substituteProductId ?? l.productId,
        description: l.description,
        qty: l.pickedQty,
        uom: l.uom,
        finalPrice: l.finalPrice,
        substituted: l.state === 'substituted',
      };
    });

    this.packed = {
      waveId: this.waveId,
      packedBy: evidence.packedBy,
      at: evidence.at,
      lines,
      totalValue,
      evidence,
    };
    // The manifest the driver will be handed, queued as one event. Cold-chain and tamper evidence
    // travel with it — a crate that arrives warm is an argument nobody can settle afterwards
    // without the temperature that was recorded when it was sealed (M19-FR-02).
    this.outbox.enqueue(
      makeEvent({
        id: `${this.waveId}:packed`,
        type: WAVE_PACKED,
        occurredAt: evidence.at,
        idempotencyKey: `pack:${this.waveId}`,
        source: this.waveId,
        payload: {
          waveId: this.waveId,
          packedBy: evidence.packedBy,
          lineCount: lines.length,
          totalValueMinor: totalValue.minor,
          currency: totalValue.currency,
          temperatureC: evidence.temperatureC ?? null,
          tamperSealRef: evidence.tamperSealRef ?? null,
        },
      }),
    );
    return this.packed;
  }

  /** The manifest once packed, or null before. */
  manifest(): DispatchManifest | null {
    return this.packed;
  }

  // ── Where each piece of work has got to (SP-3c-i · the shared device → box → head office leg) ──────────

  /** Fold in the store computer's word on the items it holds (asked over `/lane/outbox/status`). */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void {
    for (const s of statuses) this.boxWord.set(s.key, s);
  }

  /** The keys the box has taken — the ones worth asking it about. */
  handedKeys(): readonly string[] {
    return this.outbox.all().filter((item) => item.state === 'acknowledged').map((item) => item.key);
  }

  /**
   * Every outcome and pack this handheld queued, newest first, each with one of the five shared state words. The
   * device's own "acknowledged" means the BOX has it — only the box's word says head office does (P-08). A refusal
   * carries its reason, because a person has to act on it.
   */
  sentWork(): readonly SentWork[] {
    return this.outbox.all()
      .flatMap((item): SentWork[] => {
        const box = this.boxWord.get(item.key);
        const common = { at: item.event.occurredAt, state: deviceItemState(item, box), attempts: item.attempts } as const;
        const reason = deviceItemReason(item, box);
        const withReason = reason === undefined ? {} : { reason };
        if (item.event.type === PICK_LINE_RESOLVED) {
          const p = item.event.payload as { lineId: string; orderRef: string; productId: string; state: LineState; pickedQty: number; uom: string; finalPriceMinor: number };
          return [{ kind: 'line', id: p.lineId, what: `${p.productId} · ${p.orderRef}`, detail: `${p.state} · ${minorPerUnitOf(p.uom) > 1 ? quantityLabel(p.pickedQty, p.uom) : `${p.pickedQty} ${p.uom}`}`, ...common, ...withReason }];
        }
        if (item.event.type === SUBSTITUTION_PROPOSED) {
          const p = item.event.payload as { lineId: string; orderRef: string; substituteProductId: string; answerBy: string };
          return [{ kind: 'proposal', id: p.lineId, what: `${p.substituteProductId} · ${p.orderRef}`, detail: `asked the customer · answer by ${p.answerBy}`, ...common, ...withReason }];
        }
        if (item.event.type === WAVE_PACKED) {
          const p = item.event.payload as { waveId: string; lineCount: number; totalValueMinor: number; currency: string };
          return [{ kind: 'pack', id: p.waveId, what: p.waveId, detail: `${p.lineCount} ${p.lineCount === 1 ? 'line' : 'lines'} · ${p.totalValueMinor} ${p.currency}`, ...common, ...withReason }];
        }
        return [];
      })
      .reverse();
  }
}
