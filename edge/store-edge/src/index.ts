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
}): EdgeNode {
  let held = input.initialPack;

  return {
    pack: () => held,

    commit: (saleId, record) => commitLocally({
      saleId, record, log: input.log,
      ...(input.reserveBytes === undefined ? {} : { reserveBytes: input.reserveBytes }),
    }),

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
