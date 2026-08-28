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

/** What the lane asks the edge for, and all it may ask for. */
export interface EdgeNode {
  /** Price a scan from the pack this edge holds. Never a network call (hard rule #1). */
  readonly pack: () => SignedPack | undefined;
  /** Commit a sale to the local disk before the receipt prints. */
  readonly commit: (saleId: string, record: string) => Promise<CommitOutcome>;
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
}): EdgeNode {
  let held = input.initialPack;

  return {
    pack: () => held,

    commit: async (saleId, record) => {
      const outcome = await commitLocally({
        saleId, record, log: input.log,
        ...(input.reserveBytes === undefined ? {} : { reserveBytes: input.reserveBytes }),
      });

      // **After the durable write, never before.** Queueing first would send a sale the lane went
      // on to refuse — the cloud would hold a sale that never happened, and the customer would
      // have walked away without paying for it. Same reasoning as printing the receipt second.
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
      return outcome;
    },

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
