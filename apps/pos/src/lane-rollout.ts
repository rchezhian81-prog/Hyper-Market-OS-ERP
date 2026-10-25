// The till's rollout switches (R8-9 · OB-316 · P-01 · P-08). The store computer resolves this lane's switches from the
// SIGNED store pack and hands them to the till with the lane (`posLane.rollout`, edge screen-data `posLanePayload`), so
// the till answers "is this trial feature on for my lane?" with no network at all — and a till that was not told
// (no pack section, or a box that does not know its lane) treats every trial feature as OFF, and can say why.
//
// Attached as `window.posRollout`; nothing in the sale path waits on it (hard rule #1).

import { laneSwitchOn, type LaneRollout } from '../../../packages/platform/src/rollout';

export interface PosRollout {
  /** True when the box told this till its lane's switches (from the signed pack). */
  readonly known: boolean;
  /** Why the till was not told — shown to staff instead of a silent "off". */
  readonly why: string | null;
  /** The switches on for this lane, by name (a switch nobody set is not listed, and is off). */
  readonly on: readonly string[];
  /** Is this trial feature on for my lane? Not told, or never set, is OFF. */
  isOn(key: string): boolean;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read what the box sent; anything unreadable is "not told", never "on". */
export function posRolloutOf(raw: unknown): PosRollout {
  let rollout: LaneRollout | undefined;
  if (isRec(raw) && raw['known'] === true && typeof raw['laneId'] === 'string' && isRec(raw['switches'])) {
    const switches: Record<string, { on: boolean; source: 'lane' | 'branch'; version: number }> = {};
    for (const [k, v] of Object.entries(raw['switches'])) {
      if (isRec(v) && typeof v['on'] === 'boolean' && (v['source'] === 'lane' || v['source'] === 'branch') && Number.isInteger(v['version'])) switches[k] = { on: v['on'], source: v['source'], version: v['version'] as number };
    }
    rollout = { known: true, laneId: raw['laneId'], switches };
  }
  const why = rollout !== undefined ? null : isRec(raw) && typeof raw['why'] === 'string' ? raw['why'] : 'the store computer did not send this lane\'s rollout switches — every trial feature is off';
  return {
    known: rollout !== undefined,
    why,
    on: rollout !== undefined && rollout.known ? Object.entries(rollout.switches).filter(([, v]) => v.on).map(([k]) => k).sort() : [],
    isOn: (key) => laneSwitchOn(rollout, key),
  };
}
