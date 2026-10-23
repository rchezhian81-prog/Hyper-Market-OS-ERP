// The further sweeps the ops-alert worker runs for each shop on every pass (its `alsoEachPass` hook, main.ts):
//   • Round 8 (M19-FR-04 · PA-08) — delivery exceptions past their time limit, put on the message queue;
//   • R3 · A19 — GST returns near or past the 3-year time bar, raised into every owner's alert inbox (`gstTimeBarSweep`);
//   • R4 · C15 — payslips not issued by (or issued after) their pay date, raised into every owner's alert inbox
//     (`payslipLateSweep`, r4-pay-epr-adapters.ts).
//   • OB-288 lane 2 · M10-FR-01 — a batch past its date moves to the "expired" state, once (`lane2ExpirySweep`).
//
// All run on every pass. One failing never stops the others: the rest still run, and the failure is then thrown so
// the worker records the pass as failed for that shop and tries again next time (P-08 — never quietly).

export interface EachPassSweeps {
  /** Delivery-exception breaches: how many alerts it newly queued. */
  readonly breaches: (tenantId: string, at: string) => Promise<number>;
  /** A19: how many GST time-bar alerts it newly raised. */
  readonly gstTimeBar: (tenantId: string, at: string) => Promise<number>;
  /** C15: how many late-payslip alerts it newly raised (absent → not run). */
  readonly payslipLate?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 lane 2 · M10-FR-01: how many batches moved to the expired state on this pass (absent → not run). */
  readonly expiryMove?: (tenantId: string, at: string) => Promise<number>;
  /** OB-292 (OB-288 lane 1 · P1): how many aged approvals it newly escalated to the owner (absent → not run). */
  readonly approvalAge?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 P5 (OB-293): the daily Tally file outbox's pass — files made ready or dead-lettered (absent → not run). */
  readonly financeBridge?: (tenantId: string, at: string) => Promise<number>;
  readonly say: (line: string) => void;
}

/** The `alsoEachPass` hook: runs every sweep; answers the breach alerts queued (what the worker reports as queued). */
export function alsoEachPassOf(sweeps: EachPassSweeps): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId, at) => {
    const errors: unknown[] = [];
    let queued = 0;
    try { queued = await sweeps.breaches(tenantId, at); } catch (e) { errors.push(e); }
    try {
      const raised = await sweeps.gstTimeBar(tenantId, at);
      if (raised > 0) sweeps.say(`alerts: ${raised} GST time-bar alert(s) raised to the owners of shop ${tenantId}`);
    } catch (e) { errors.push(e); }
    if (sweeps.payslipLate !== undefined) {
      try {
        const raised = await sweeps.payslipLate(tenantId, at);
        if (raised > 0) sweeps.say(`alerts: ${raised} late-payslip alert(s) raised to the owners of shop ${tenantId}`);
      } catch (e) { errors.push(e); }
    }
    if (sweeps.expiryMove !== undefined) {
      try {
        const moved = await sweeps.expiryMove(tenantId, at);
        if (moved > 0) sweeps.say(`expiry: ${moved} batch(es) past their date moved to the expired state for shop ${tenantId}`);
      } catch (e) { errors.push(e); }
    }
    if (sweeps.approvalAge !== undefined) { try { const n = await sweeps.approvalAge(tenantId, at); if (n > 0) sweeps.say(`alerts: ${n} aged approval(s) escalated to the owners of shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.financeBridge !== undefined) { try { const n = await sweeps.financeBridge(tenantId, at); if (n > 0) sweeps.say(`tally: ${n} daily file(s) made ready or dead-lettered for shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (errors.length > 0) {
      const words = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
      throw new Error(`a per-shop sweep failed: ${words}`);
    }
    return queued;
  };
}
