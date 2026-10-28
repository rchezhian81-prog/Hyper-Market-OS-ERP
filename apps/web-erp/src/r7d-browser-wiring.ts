// Round 7 · R7-D browser wiring (kept in its own file so the shared bundle entry carries one import and one call):
//   • the self-service page's "clock in / clock out" queue through the store computer (OB-507 · M25-FR-01) —
//     `window.essAttendance`, read by ess.js;
//   • the production screen's food-handling certificate check for the person signed in (OB-502 · M25-FR-03) —
//     `window.productionFoodHandling`, read by the production page before it saves a run.
// Nothing is read or written here: every save is a person's click; a relay pass hands what was saved to the store computer.

import { createAttendanceQueue, attendanceWords } from './attendance-queue';
import { openBoxQueueRelay } from './lpw-box-queue';
import { openLpwOutbox } from './lpw-browser-wiring';

type Win = Record<string, unknown> & { laneWriteBase?: string };

const rec = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export function wireR7dPages(win: Win): void {
  const ess = rec(win['essData']);
  if (ess !== undefined && win.laneWriteBase !== undefined && str(ess['storeId']) !== undefined) {
    const storeId = str(ess['storeId'])!;
    const outbox = openLpwOutbox('ess-attendance', storeId, undefined, (why) => { win['essAttendanceStorageProblem'] = why; });
    const q = createAttendanceQueue({
      userId: str(ess['userId']) ?? null, storeId, permissions: Array.isArray(ess['permissions']) ? (ess['permissions'] as string[]) : [],
      now: () => new Date().toISOString(),
    }, outbox);
    const relay = openBoxQueueRelay(win.laneWriteBase, q.queue, outbox);
    win['essAttendance'] = { attendance: q, words: attendanceWords, ...(relay === undefined ? {} : { relay }) };
  }
  const production = rec(win['productionData']);
  const food = rec(production?.['foodHandling']);
  if (food !== undefined) win['productionFoodHandling'] = food;
}
