// The further sweeps the ops-alert worker runs for each shop on every pass (its `alsoEachPass` hook, main.ts):
//   • Round 8 (M19-FR-04 · PA-08) — delivery exceptions past their time limit, put on the message queue;
//   • R3 · A19 — GST returns near or past the 3-year time bar, raised into every owner's alert inbox (`gstTimeBarSweep`).
//
// Both run on every pass. One failing never stops the other: the second still runs, and the failure is then thrown so
// the worker records the pass as failed for that shop and tries again next time (P-08 — never quietly).

export interface EachPassSweeps {
  /** Delivery-exception breaches: how many alerts it newly queued. */
  readonly breaches: (tenantId: string, at: string) => Promise<number>;
  /** A19: how many GST time-bar alerts it newly raised. */
  readonly gstTimeBar: (tenantId: string, at: string) => Promise<number>;
  readonly say: (line: string) => void;
}

/** The `alsoEachPass` hook: runs both sweeps; answers the breach alerts queued (what the worker reports as queued). */
export function alsoEachPassOf(sweeps: EachPassSweeps): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId, at) => {
    const errors: unknown[] = [];
    let queued = 0;
    try { queued = await sweeps.breaches(tenantId, at); } catch (e) { errors.push(e); }
    try {
      const raised = await sweeps.gstTimeBar(tenantId, at);
      if (raised > 0) sweeps.say(`alerts: ${raised} GST time-bar alert(s) raised to the owners of shop ${tenantId}`);
    } catch (e) { errors.push(e); }
    if (errors.length > 0) {
      const words = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
      throw new Error(`a per-shop sweep failed: ${words}`);
    }
    return queued;
  };
}
