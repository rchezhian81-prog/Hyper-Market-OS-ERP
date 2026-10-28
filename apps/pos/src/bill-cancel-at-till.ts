// CANCEL THE WHOLE BILL AT THE TILL, before it is paid (OB-523 · M15-FR-01 · M12-FR-02 · hard rules #1, #2, #6 and P-08).
//
// The customer walks away, or the wrong quotation was keyed. The cashier picks a reason (the same preset list a line's void
// uses); the till sends the bill's lines, the reason and the quotations this bill rang up to ITS store computer
// (`POST /lane/till-activity`, kind `bill_void`). The box keeps every line as a void and every quotation as a release on its
// own disk BEFORE it answers — then queues them for head office, which frees the quotation again (only from this bill) so a
// later bill may ring it up. Offline (no head office) the box keeps them and sends them once when the line is back; the
// cancel itself never waits on head office.
//
// The till clears nothing until the box says it has the record: each line is then MARKED voided with the reason (kept on the
// bill as evidence, never erased) and a fresh bill starts. A paid bill is never cancelled here — that is a refund.
// Kept in its own file so the till's model (session.ts) and screen (app.js) carry only a few lines for it.

/** One line still on the bill, as the box keeps it. */
export interface BillLineForCancel {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly valueMinor: number;
}

/** What the till's cancel answered, for the screen. */
export interface BillCancelAnswer {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly laneMessageTa?: string;
  readonly linesVoided?: number;
  readonly quotationsFreed?: readonly string[];
}

/** The few till operations this needs (the view and the session, as browser-entry holds them). */
export interface BillCancelOps {
  readonly signedIn: () => boolean;
  readonly committed: () => boolean;
  /** A payment whose save is not yet confirmed (a lost answer) — the bill may be paid, so it is never cancelled meanwhile. */
  readonly awaitingSave: () => boolean;
  readonly billRef: () => string;
  /** The lines still counting on the bill (a line already voided is not voided twice). */
  readonly liveLines: () => readonly BillLineForCancel[];
  /** The quotations rung up on THIS bill (OB-506), which the cancel frees (OB-523). */
  readonly quotationsOnBill: () => readonly string[];
  /** Mark a line voided with the reason on the till's own bill (kept, struck through). */
  readonly voidLine: (lineId: string, reason: string) => void;
  /** Start a fresh bill. */
  readonly newSale: () => void;
  /** A fresh activity id for this cancel (one per press; a retry of the same press re-sends the same id). */
  readonly newActivityId: () => string;
}

/** The till's words for this step — English and Tamil, so the screen needs no new word table. */
export const BILL_CANCEL_WORDS = {
  en: { option: 'Cancel the whole bill', reason: 'Why is the whole bill cancelled?', confirm: 'Cancel this bill? Every line is voided with the reason and kept on record.', yes: 'Yes, cancel the bill', no: 'No, keep the bill' },
  ta: { option: 'முழு பில்லையும் ரத்து செய்', reason: 'முழு பில் ஏன் ரத்து செய்யப்படுகிறது?', confirm: 'இந்த பில்லை ரத்து செய்யவா? ஒவ்வொரு வரியும் காரணத்துடன் நீக்கப்பட்டு பதிவில் வைக்கப்படும்.', yes: 'ஆம், பில்லை ரத்து செய்', no: 'வேண்டாம், பில்லை வைத்திரு' },
} as const;

/** Cancel the bill on the till now (OB-523). Never throws: every answer is in the cashier's words. */
export function billCancelAtTill(input: {
  readonly ops: BillCancelOps;
  /** The till-activity post to this till's own store computer (browser-entry's `sendTillActivity`); throws when unreachable. */
  readonly post: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): (reason: string) => Promise<BillCancelAnswer> {
  const { ops, post } = input;
  return async (rawReason) => {
    const reason = rawReason.trim();
    if (!ops.signedIn()) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: 'Sign in at the till first, then cancel the bill.', laneMessageTa: 'முதலில் பில்லிங்கில் உள்நுழையவும், பிறகு பில்லை ரத்து செய்யவும்.' };
    if (ops.committed()) return { ok: false, refusedBecause: 'bill_already_paid', laneMessage: 'This bill is paid, so it is not cancelled here — take a refund instead.', laneMessageTa: 'இந்த பில் செலுத்தப்பட்டுவிட்டது, எனவே இங்கே ரத்து செய்ய முடியாது — பணத்தைத் திருப்பித் தரும் முறையைப் பயன்படுத்தவும்.' };
    if (ops.awaitingSave()) return { ok: false, refusedBecause: 'bill_save_unconfirmed', laneMessage: 'This bill\'s payment is still being confirmed, so it cannot be cancelled now. Check the payment first.', laneMessageTa: 'இந்த பில்லின் கட்டணம் இன்னும் உறுதிசெய்யப்படுகிறது, எனவே இப்போது ரத்து செய்ய முடியாது. முதலில் கட்டணத்தைச் சரிபார்க்கவும்.' };
    if (reason === '') return { ok: false, refusedBecause: 'reason_required', laneMessage: 'Cancelling a bill needs a reason.', laneMessageTa: 'பில்லை ரத்து செய்ய ஒரு காரணம் தேவை.' };
    const lines = ops.liveLines();
    const quotationIds = [...new Set(ops.quotationsOnBill())];
    if (lines.length === 0 && quotationIds.length === 0) return { ok: false, refusedBecause: 'nothing_to_cancel', laneMessage: 'There is nothing on this bill to cancel.', laneMessageTa: 'இந்த பில்லில் ரத்து செய்ய எதுவும் இல்லை.' };
    const body = { activityId: ops.newActivityId(), kind: 'bill_void', billRef: ops.billRef(), reason, lines, ...(quotationIds.length === 0 ? {} : { quotationIds }) };
    let r: Record<string, unknown> | undefined;
    // One retry with the SAME body (the box keys every part on its id): a lost reply never records the cancel twice.
    for (let attempt = 0; attempt < 2 && r === undefined; attempt += 1) {
      try { r = await post(body); } catch { r = undefined; }
    }
    if (r === undefined) {
      return { ok: false, refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so the bill was not cancelled. The bill stays as it is.', laneMessageTa: 'இந்த பில்லிங் கடைக் கணினியை அடைய முடியவில்லை, எனவே பில் ரத்து செய்யப்படவில்லை. பில் அப்படியே உள்ளது.' };
    }
    if (r['recorded'] !== true) {
      return {
        ok: false, ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}),
        laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'The bill was not cancelled. The bill stays as it is.',
        ...(typeof r['laneMessageTa'] === 'string' ? { laneMessageTa: r['laneMessageTa'] } : {}),
      };
    }
    // The box has it: now the till marks each line voided (kept as evidence) and starts a fresh bill.
    for (const l of lines) { try { ops.voidLine(l.lineId, reason); } catch { /* the box holds the void; the bill is cleared next */ } }
    ops.newSale();
    const freed = Array.isArray(r['quotationsFreed']) ? (r['quotationsFreed'] as unknown[]).filter((q): q is string => typeof q === 'string') : quotationIds;
    return {
      ok: true, linesVoided: lines.length, quotationsFreed: freed,
      laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'Bill cancelled.',
      ...(typeof r['laneMessageTa'] === 'string' ? { laneMessageTa: r['laneMessageTa'] } : {}),
    };
  };
}
