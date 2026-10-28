// The further sweeps the ops-alert worker runs for each shop on every pass (its `alsoEachPass` hook, main.ts):
//   • Round 8 (M19-FR-04 · PA-08) — delivery exceptions past their time limit, put on the message queue;
//   • R3 · A19 — GST returns near or past the 3-year time bar, raised into every owner's alert inbox (`gstTimeBarSweep`);
//   • R4 · C15 — payslips not issued by (or issued after) their pay date, raised into every owner's alert inbox
//     (`payslipLateSweep`, r4-pay-epr-adapters.ts).
//   • OB-288 lane 2 · M10-FR-01 — a batch past its date moves to the "expired" state, once (`lane2ExpirySweep`).
//   • OB-288 lane 4 · P2 · M29-FR-03/04 — the owner's five exception alerts raised into his inbox, and every scheduled
//     report and export that is due prepared (`ownerReportingSweep`, owner-reporting-adapters.ts).
//   • FG-4 · M04-FR-04 / M06-FR-03 — an expired (or, once the owner sets his window, expiring) display or supplier
//     contract raised to every owner, cleared on renewal (`contractExpirySweep`, fg4-buying-adapters.ts).
//   • Round 6 · B7 — a weighing scale whose Legal Metrology stamp is due within the register's notice period (or has
//     lapsed) raised to every owner, cleared on re-stamping (`scaleStampExpirySweep`, r6b-quality-scale-adapters.ts).
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
  /** OB-288 P2 · D02-FR-02: how many season plans ended into clearance on this pass (absent → not run). */
  readonly seasonEnd?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 wave 3: the customer package's timed work — points expiry, repeat orders, order notices, journeys (absent → not run). */
  readonly customerCommerce?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 commercial desks: concession expiry alerts and B2B contracts ending, raised to the owners (absent → not run). */
  readonly commercialDesks?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 lane 4 · P2 (M29-FR-03/04): the owner's exception alerts raised, and the scheduled reports prepared (absent → not run). */
  readonly ownerReporting?: (tenantId: string, at: string) => Promise<number>;
  /** OB-288 P4: the hourly usage record (OB-321) and the customer-data volume watch (C9) — records made and alerts raised/cleared (absent → not run). */
  readonly saasRollout?: (tenantId: string, at: string) => Promise<number>;
  /** FG-4 (M04-FR-04 · M06-FR-03): how many expired / expiring display or supplier contract alerts it raised (absent → not run). */
  readonly contractExpiry?: (tenantId: string, at: string) => Promise<number>;
  /** Round 6 · B7: how many weighing-scale stamp alerts (due soon or lapsed) it raised (absent → not run). */
  readonly scaleStamp?: (tenantId: string, at: string) => Promise<number>;
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
    if (sweeps.seasonEnd !== undefined) { try { const n = await sweeps.seasonEnd(tenantId, at); if (n > 0) sweeps.say(`range: ${n} season plan(s) ended into clearance for shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.customerCommerce !== undefined) { try { const n = await sweeps.customerCommerce(tenantId, at); if (n > 0) sweeps.say(`customers: ${n} timed step(s) done for shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.commercialDesks !== undefined) { try { const n = await sweeps.commercialDesks(tenantId, at); if (n > 0) sweeps.say(`alerts: ${n} concession / B2B contract expiry alert(s) raised to the owners of shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.ownerReporting !== undefined) { try { const n = await sweeps.ownerReporting(tenantId, at); if (n > 0) sweeps.say(`owner: ${n} exception alert(s) raised or scheduled report(s) prepared for shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.saasRollout !== undefined) { try { const n = await sweeps.saasRollout(tenantId, at); if (n > 0) sweeps.say(`saas: ${n} usage record(s) or data-volume alert change(s) for shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.contractExpiry !== undefined) { try { const n = await sweeps.contractExpiry(tenantId, at); if (n > 0) sweeps.say(`alerts: ${n} display / supplier contract expiry alert(s) raised to the owners of shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (sweeps.scaleStamp !== undefined) { try { const n = await sweeps.scaleStamp(tenantId, at); if (n > 0) sweeps.say(`alerts: ${n} weighing-scale stamp alert(s) raised to the owners of shop ${tenantId}`); } catch (e) { errors.push(e); } }
    if (errors.length > 0) {
      const words = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
      throw new Error(`a per-shop sweep failed: ${words}`);
    }
    return queued;
  };
}
