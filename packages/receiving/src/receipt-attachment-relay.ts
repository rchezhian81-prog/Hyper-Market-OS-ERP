// Batch 20e · R6 (M07-FR-04 · P-01 · P-08) — the attachment queue's leg of the shared device → store-computer path. The SAME
// `/lane/outbox` door every piece of device work uses, from the attachment queue's OWN outbox, ONE file per hand-over (a
// file is up to 150 KB as base64; one per batch keeps every hand-over inside the store computer's 256 KB batch). Link down:
// every file is kept on the device and tried again; refused: kept, with the reason, for a person (hard rules #6, #10).

import type { SyncOutbox } from '../../sync/src/outbox';
import { drainToBox, boxStatus, type FetchLike } from '../../sync/src/device-drain';
import type { ReceiptAttachmentQueue } from './receipt-attachments';

export interface AttachmentRelay {
  syncNow(): Promise<{ readonly handed: number; readonly refused: number; readonly failed: number; readonly offline: boolean }>;
}

/** Files handed over per pass at most (one per hand-over); the next pass carries the rest. */
export const FILES_PER_PASS = 5;

export function openAttachmentRelay(input: {
  readonly boxBase: string | undefined;
  readonly outbox: SyncOutbox;
  readonly queue: ReceiptAttachmentQueue;
  readonly source: 'manager' | 'warehouse';
  readonly fetch?: FetchLike;
}): AttachmentRelay | undefined {
  const fetchFn = input.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch);
  if (input.boxBase === undefined || fetchFn === undefined) return undefined;
  const boxBase = input.boxBase;
  return {
    syncNow: async () => {
      let handed = 0; let refused = 0; let failed = 0; let offline = false;
      for (let pass = 0; pass < FILES_PER_PASS && input.outbox.pending().length > 0; pass += 1) {
        const r = await drainToBox({ outbox: input.outbox, boxBase, source: input.source, fetch: fetchFn, limit: 1 });
        handed += r.handed; refused += r.refused; failed += r.failed;
        if (r.offline || r.attempted === 0 || r.failed > 0) { offline = r.offline; break; }
      }
      const statuses = await boxStatus({ boxBase, keys: input.queue.handedKeys(), fetch: fetchFn });
      if (statuses !== undefined) input.queue.noteBoxStatus(statuses);
      return { handed, refused, failed, offline };
    },
  };
}
