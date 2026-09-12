// The store edge — the box in the shop that keeps the lanes trading (P-01, §31).
//
// **The edge is the shop's system of record while it is offline.** Not a cache. That distinction
// decides every conflict: when the edge and the cloud disagree about a sale the edge took, the
// edge is right, because it was there and the cloud was not. Designs that treat the edge as a
// cache resolve the other way, and a sale disappears when the line comes back.
//
// The pieces: a durable local commit (`durability.ts`), a signed catalogue pack the lanes price
// from, and the sync agent that carries work to the cloud afterwards without ever touching the
// sale path.

export {
  commitLocally, planShed, edgeHealth, SHED_ORDER,
  type DurableLog, type CommitRefusal, type CommitOutcome, type EdgeDataKind,
  type Usage, type ShedPlan, type EdgeHealth,
} from './durability';

import { acceptPack, type SignedPack, type PackSigner } from '../../../services/catalogue/src/pack';
import { commitLocally, type CommitOutcome, type DurableLog } from './durability';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { toCloudSale } from './cloud-sale';
import { toCloudReturn } from './cloud-return';
import { canonicalHash, type IdempotencyGuard } from './idempotency';
import type { ReturnEntitlement, EntitlementLine } from './entitlement';
import type { SaleLookupResult } from './receipt-lookup';

/** What the lane asks the edge for, and all it may ask for. */
export interface EdgeNode {
  /** Price a scan from the pack this edge holds. Never a network call (hard rule #1). */
  readonly pack: () => SignedPack | undefined;
  /** Commit a sale to the local disk before the receipt prints. */
  readonly commit: (saleId: string, record: string) => Promise<CommitOutcome>;
  /**
   * Commit an offline RETURN to the local disk, then queue it for the cloud (M13-FR-01, §31).
   *
   * The mirror of `commit`, and deliberately a SEPARATE seam: a refund is money leaving the drawer,
   * so it is durable before it is called done, exactly as a sale is durable before the receipt
   * prints. It writes to its OWN durable log and its OWN outbox — never the sale log — so a return
   * can never be re-queued as a sale on restart, and the sale path is untouched by its existence.
   */
  readonly commitReturn: (returnId: string, record: string) => Promise<CommitOutcome>;
  /**
   * Look up a bill THIS lane rang, by its receipt number or sale id, for the refund screen
   * (M13-FR-01, §31). Returns the original sale plus the return/refund history against it — read
   * from this lane's own durable logs, so it works offline for a locally-known bill. Resolves
   * `undefined` for a bill this lane did not ring (or when no lookup is configured — a standalone
   * shell). Never a network call, and read-only: it can commit nothing.
   */
  readonly lookupSale: (receiptOrId: string) => Promise<SaleLookupResult | undefined>;
  /** Take a new catalogue pack, or keep the one we trust. */
  readonly takePack: (incoming: SignedPack) => { readonly accepted: boolean; readonly staffMessage: string };
}

export function createEdgeNode(input: {
  readonly tenantId: string;
  readonly log: DurableLog;
  readonly signer: PackSigner;
  readonly initialPack?: SignedPack;
  readonly reserveBytes?: number;
  /**
   * Where a committed sale is queued for the cloud.
   *
   * **This was missing, and it was the seam the whole product runs through.** `commit` wrote the
   * sale to the disk and stopped: durable, correct, and never queued — so no sale a lane took ever
   * reached the cloud. Every piece on either side of this line was built and tested; nothing
   * joined them, and nothing failed, which is what made it invisible.
   */
  readonly outbox?: SyncOutbox;
  /**
   * The RETURN's own durable log — separate from the sale log on purpose (M13-FR-01).
   *
   * A return record must never land in the sale log: the restart re-queue reads every sale-log
   * record as a `SaleCommitted`, so a return there would be re-sent to `/v1/sales` as a broken sale.
   * Its own log keeps the two pipelines independent, so nothing here can disturb the sale path.
   * `commitReturn` refuses (durably, before the refund is called done) when it is not configured.
   */
  readonly returnsLog?: DurableLog;
  /** Where a committed RETURN is queued for the cloud — the return pipeline's own outbox. */
  readonly returnsOutbox?: SyncOutbox;
  /**
   * Operation-identity guard for refunds (RR-F03). Rebuilt from the durable returns log at boot and
   * consulted before every refund write: an identical retry returns the original outcome with no new
   * effect, and a reused id with different money is refused as an explicit conflict. Optional so a
   * standalone/demo edge (and the direct-construction unit tests) still run; a real edge supplies it.
   */
  readonly returnsIdempotency?: IdempotencyGuard;
  /**
   * Refund entitlement from trusted local data (RR-F04). Rebuilt at boot from this edge's sale log
   * (how much each sale sold) and returns log (how much has come back), it refuses a refund that
   * would take back more of a line than was sold — using what the box knows, never the numbers the
   * request supplies. A sale this edge did not ring is `saleKnown === false`; such a refund cannot be
   * entitlement-checked here and is allowed under the existing approval/cap controls, its global
   * at-most-once left to cloud reconciliation (it is never claimed locally). Optional so a
   * standalone/demo edge and the direct-construction unit tests still run.
   */
  readonly returnsEntitlement?: ReturnEntitlement;
  /**
   * Operation-identity guard for SALES (GAP-SALE-IDEMPOTENCY-01) — the sale-path mirror of
   * `returnsIdempotency`. Rebuilt from the durable sale log at boot and consulted before every sale
   * write: an identical retry returns the original outcome with no second append, and a reused sale
   * id with a different payload is refused as an explicit conflict rather than double-recorded.
   * Optional so a standalone/demo edge (and the direct-construction unit tests) still run.
   */
  readonly salesIdempotency?: IdempotencyGuard;
  /**
   * Receipt lookup for the refund screen (M13-FR-01) — resolves a bill this lane rang from its own
   * durable logs. Injected (not built here) because it reads the log files live, which is I/O the
   * node itself stays free of; `main.ts` wires it to `buildReceiptLookup` over the real logs so it
   * always reflects everything committed, including sales rung earlier in this same session. Absent
   * on a standalone/demo edge, where `lookupSale` then resolves `undefined`.
   */
  readonly lookupSale?: (receiptOrId: string) => Promise<SaleLookupResult | undefined>;
}): EdgeNode {
  let held = input.initialPack;
  // Work committing right now, keyed by its id, so a concurrent second call with the same id awaits
  // the first rather than racing it to a double write (RR-F03 "prove across concurrency"). One map
  // per pipeline — a sale and a refund never share an id space.
  const returnsInFlight = new Map<string, Promise<CommitOutcome>>();
  const salesInFlight = new Map<string, Promise<CommitOutcome>>();

  return {
    pack: () => held,

    commit: async (saleId, record) => {
      // The durable write, then the queue — after the write, never before. Queueing first would send
      // a sale the lane went on to refuse; the customer would have walked away without paying for it.
      const commitAndQueue = async (): Promise<CommitOutcome> => {
        const outcome = await commitLocally({
          saleId, record, log: input.log,
          ...(input.reserveBytes === undefined ? {} : { reserveBytes: input.reserveBytes }),
        });
        if (outcome.committed && input.outbox !== undefined) {
          input.outbox.enqueue(makeEvent({
            id: `edge-sale-${saleId}`,
            type: 'SaleCommitted',
            occurredAt: new Date().toISOString(),
            // The sale's own id, minted here at the lane. Every retry from here to the cloud carries
            // this same key, so a resend collapses to one sale (§31.1).
            idempotencyKey: `edge-${input.tenantId}-${saleId}`,
            source: 'edge/lane',
            // Translated to the cloud's sale contract before it leaves — the disk record speaks
            // `id`/`total`, `/v1/sales` speaks `saleId`/`totalMinor`/`packVersion`. The pack this edge
            // holds is the one the lane priced this sale from, so it stamps the version (see cloud-sale.ts).
            payload: toCloudSale(JSON.parse(record) as unknown, held?.snapshot.version ?? 0),
          }));
        }
        // Teach the refund-entitlement guard what this sale sold, so a refund taken later in the SAME
        // session is checked against it and not only against sales already on disk at boot (RR-F04).
        // Off the money-critical path, and wrapped so it can never affect the sale.
        if (outcome.committed && input.returnsEntitlement !== undefined) {
          try {
            const parsed = JSON.parse(record) as { lines?: { productId?: unknown; quantityMinor?: unknown }[] };
            const lines: EntitlementLine[] = Array.isArray(parsed.lines)
              ? parsed.lines.flatMap((l) => (typeof l.productId === 'string' && typeof l.quantityMinor === 'number'
                ? [{ productId: l.productId, quantityMinor: l.quantityMinor }] : []))
              : [];
            input.returnsEntitlement.recordSale(saleId, lines);
          } catch { /* the sale is committed regardless; entitlement just won't know this line */ }
        }
        return outcome;
      };

      const guard = input.salesIdempotency;
      if (guard === undefined) {
        // Standalone/demo edge (and the direct-construction unit tests) — original behaviour.
        return commitAndQueue();
      }

      // Operation identity + canonical payload identity for the sale (GAP-SALE-IDEMPOTENCY-01),
      // decided before anything is written: an identical retry returns the original outcome and
      // writes nothing again; a reused sale id with a different payload is an explicit conflict.
      const hash = canonicalHash(record);
      const decideReused = (): CommitOutcome | undefined => {
        const verdict = guard.verdict(saleId, hash);
        if (verdict.kind === 'duplicate') {
          return {
            committed: true, durable: true,
            detail: `sale ${saleId} was already recorded with these details — returning the original outcome; nothing was written again`,
            laneMessage: 'This sale was already recorded.',
          };
        }
        if (verdict.kind === 'conflict') {
          return {
            committed: false, refusedBecause: 'idempotency_conflict',
            detail: `sale id ${saleId} was already used for a different sale; this request was refused and nothing was written`,
            laneMessage: 'This sale ID was already used for a different sale. Do not take payment — tell the manager.',
          };
        }
        return undefined; // fresh
      };

      const reused = decideReused();
      if (reused !== undefined) return reused;

      const pending = salesInFlight.get(saleId);
      if (pending !== undefined) {
        await pending;
        const afterRace = decideReused();
        if (afterRace !== undefined) return afterRace;
      }

      const work = (async (): Promise<CommitOutcome> => {
        const outcome = await commitAndQueue();
        if (outcome.committed) guard.remember(saleId, hash);
        return outcome;
      })();
      salesInFlight.set(saleId, work);
      try {
        return await work;
      } finally {
        salesInFlight.delete(saleId);
      }
    },

    commitReturn: async (returnId, record) => {
      // Configured on every real edge; guarded so a mis-wired deployment refuses the refund BEFORE
      // it is called done (a bad minute) rather than losing it silently after (money already gone).
      if (input.returnsLog === undefined) {
        return {
          committed: false,
          refusedBecause: 'could_not_write_durably',
          detail: 'this edge has no returns log configured, so a refund cannot be saved durably',
          laneMessage: 'This lane cannot record a refund right now. Do not hand over cash — use another lane and tell the manager.',
        };
      }

      const returnsLog = input.returnsLog;

      // The durable write, then the queue — after the write, never before, the same ordering as the
      // sale and for the same reason: queueing first would send a refund the lane went on to refuse.
      const commitAndQueue = async (): Promise<CommitOutcome> => {
        const outcome = await commitLocally({
          saleId: returnId, record, log: returnsLog,
          ...(input.reserveBytes === undefined ? {} : { reserveBytes: input.reserveBytes }),
        });
        if (outcome.committed && input.returnsOutbox !== undefined) {
          input.returnsOutbox.enqueue(makeEvent({
            id: `edge-return-${returnId}`,
            type: 'ReturnAccepted',
            occurredAt: new Date().toISOString(),
            // The return's own id, minted at the lane. Every retry carries this same key, so a resend
            // collapses to one refund at the cloud (§31.1).
            idempotencyKey: `edge-return-${input.tenantId}-${returnId}`,
            source: 'edge/lane',
            // Translated to the cloud's synced-return contract before it leaves. `returnAcceptedRoute`
            // reads `originalSaleId` to address the bill; the cloud re-verifies the §28 approver.
            payload: toCloudReturn(JSON.parse(record) as unknown),
          }));
        }
        return outcome;
      };

      // Refund entitlement from trusted local data (RR-F04). Wraps the durable write: for a refund
      // against a sale THIS edge rang, it refuses one that would take back more of a line than was
      // sold, using the box's own sold + already-returned totals, and reserves the returned quantity
      // synchronously BEFORE the write so two refunds of the last unit cannot both pass. A sale this
      // edge did not ring (cross-lane, no receipt) has no trusted local record: it is allowed under
      // the existing approval/cap controls and its global at-most-once is left to cloud reconciliation
      // — deliberately not claimed here (see the note on `returnsEntitlement`).
      const entitlement = input.returnsEntitlement;
      let cloud: ReturnType<typeof toCloudReturn> | undefined;
      try { cloud = toCloudReturn(JSON.parse(record) as unknown); } catch { cloud = undefined; }
      const entSaleId = cloud !== undefined && typeof cloud.originalSaleId === 'string' && cloud.originalSaleId !== ''
        ? cloud.originalSaleId : undefined;
      const entLines: EntitlementLine[] = (cloud?.lines ?? []).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));

      const withEntitlement = async (commit: () => Promise<CommitOutcome>): Promise<CommitOutcome> => {
        if (entitlement === undefined || entSaleId === undefined || !entitlement.saleKnown(entSaleId)) {
          return commit(); // nothing trusted to check against — safe policy handled by the caller/cloud
        }
        const verdict = entitlement.check(entSaleId, entLines);
        if (!verdict.ok) {
          return {
            committed: false, refusedBecause: 'over_return',
            detail: `refund would return ${verdict.requestedMinor} of ${verdict.productId} against sale ${entSaleId}, but only ${Math.max(0, verdict.soldMinor - verdict.returnedMinor)} of ${verdict.soldMinor} sold remain unreturned`,
            laneMessage: 'This item has already been refunded against that receipt. Do not hand back cash — tell the manager.',
          };
        }
        entitlement.reserve(entSaleId, entLines); // synchronous, before the durable write (atomic)
        try {
          const outcome = await commit();
          if (!outcome.committed) entitlement.release(entSaleId, entLines);
          return outcome;
        } catch (e) {
          entitlement.release(entSaleId, entLines);
          throw e;
        }
      };

      const guard = input.returnsIdempotency;
      if (guard === undefined) {
        // Standalone/demo edge with no durable identity guard — original behaviour, still entitled.
        return withEntitlement(commitAndQueue);
      }

      // Operation identity + canonical payload identity (RR-F03). A reused id decides the outcome
      // before anything is written: an identical payload returns the original outcome and writes
      // nothing again; a different payload under the same id is an explicit conflict.
      const hash = canonicalHash(record);
      const decideReused = (): CommitOutcome | undefined => {
        const verdict = guard.verdict(returnId, hash);
        if (verdict.kind === 'duplicate') {
          return {
            committed: true, durable: true,
            detail: `refund ${returnId} was already recorded with these details — returning the original outcome; nothing was written again`,
            laneMessage: 'This refund was already recorded. Do not hand back cash a second time.',
          };
        }
        if (verdict.kind === 'conflict') {
          return {
            committed: false, refusedBecause: 'idempotency_conflict',
            detail: `refund id ${returnId} was already used for a different refund; this request was refused and nothing was written`,
            laneMessage: 'This refund ID was already used for a different amount. Do not hand back cash — tell the manager.',
          };
        }
        return undefined; // fresh
      };

      const reused = decideReused();
      if (reused !== undefined) return reused;

      // Fresh — but a concurrent call with the same id may be committing right now. Await it, then
      // re-decide against what it actually committed, so two racing calls cannot both write.
      const pending = returnsInFlight.get(returnId);
      if (pending !== undefined) {
        await pending;
        const afterRace = decideReused();
        if (afterRace !== undefined) return afterRace;
        // else the concurrent one failed and remembered nothing — fall through and commit ours.
      }

      const work = (async (): Promise<CommitOutcome> => {
        const outcome = await withEntitlement(commitAndQueue);
        if (outcome.committed) guard.remember(returnId, hash);
        return outcome;
      })();
      returnsInFlight.set(returnId, work);
      try {
        return await work;
      } finally {
        returnsInFlight.delete(returnId);
      }
    },

    // Read-only, off the money path: resolve a bill this lane rang for the refund screen. Delegates
    // to the injected lookup (which reads the durable logs live); a standalone edge without one
    // resolves `undefined`, which the screen shows as "receipt not found on this lane".
    lookupSale: async (receiptOrId) => input.lookupSale?.(receiptOrId),

    takePack: (incoming) => {
      // The same function the service and the tests use, so a lane cannot end up applying a
      // different rule from the one that was proved.
      const result = acceptPack({
        incoming,
        ...(held === undefined ? {} : { held }),
        signer: input.signer,
        tenantId: input.tenantId,
      });
      if (result.accepted) held = incoming;
      return { accepted: result.accepted, staffMessage: result.staffMessage };
    },
  };
}

// The real durable log — the disk the receipt waits for.
export * from './file-log';

// The socket between the till's screen and the till's disk (ADR-0004).
export * from './lane-server';
