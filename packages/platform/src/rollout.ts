// Per-feature controlled rollout — a switch per branch and per till lane (R8-9 · R8 exit "per-feature controlled rollout"
// · Stage 18 "per-wave controlled GO" · OB-316 · M01-FR-03 · P-01 · P-08 · hard rules #2 and #10).
//
// OB-316 (owner, 23 Oct 2026, in writing): a feature can be switched on per branch AND per till lane. Each change carries
// a reason, is a numbered version, and can be rolled back in one step to an earlier version (the identity lane's governed
// switch pattern, services/platform/src/governed-config.ts); a high-impact switch needs the owner's approval; and the till
// reads its own lane's switch OFFLINE, from the signed store pack.
//
// The rules that have to be right live here, pure:
//   • A SWITCH NOBODY SET IS OFF. A trial feature runs only where somebody switched it on, for a stated reason. There is
//     no "probably on" path, and no tenant-wide default that turns a trial on in every shop at once.
//   • THE MOST SPECIFIC SETTING DECIDES. A lane's own setting beats its branch's; a branch's beats nothing. So "self
//     checkout on lane 7 only" is a lane switch with the branch never set, and "on in this branch except lane 2" is the
//     branch on and lane 2 off. Each answer names where it came from, so nobody has to guess why a lane is on.
//   • NOTHING IS OVERWRITTEN. Every change is a new version on an append-only history (hard rule #2); a rollback restores
//     an older version's state AS a new version, and shows in the history as its own event.
//   • THE TILL NEVER ASKS THE NETWORK. Its lane's switches ride in the signed store pack (`rolloutSection`), and a till
//     whose pack carries no rollout section says so ("not told") and treats every trial feature as off (P-08: never a
//     silent "on").
//
// Pure and deterministic: no clock, no I/O.

/** One change to one switch at one place, as recorded. `laneId` absent = the branch-wide setting. */
export interface RolloutChange {
  readonly key: string;
  readonly branchId: string;
  readonly laneId?: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly changedBy: string;
  readonly changedAt: string;
  /** 1 for the first change at this place, +1 each change. Numbered by position when read (`rolloutHistory`). */
  readonly version?: number;
  /** The owner who approved a high-impact change, and the approval spent on it. */
  readonly approvedBy?: string;
  readonly approvalId?: string;
  /** Set on a rollback: the version whose state this change restored. */
  readonly rolledBackFrom?: number;
}

export interface RolloutPlace {
  readonly branchId: string;
  readonly laneId?: string;
}

/** A switch name: lower-case words joined by dots (the same rule as the shop's other switches). */
export const ROLLOUT_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
/** A branch or lane id as the org register and the device register write them. */
export const ROLLOUT_PLACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const samePlace = (c: RolloutChange, key: string, place: RolloutPlace): boolean =>
  c.key === key && c.branchId === place.branchId && (c.laneId ?? null) === (place.laneId ?? null);

/** One place's history of one switch, oldest first, each change numbered by its position. */
export function rolloutHistory(changes: readonly RolloutChange[], key: string, place: RolloutPlace): readonly (RolloutChange & { readonly version: number })[] {
  return changes.filter((c) => samePlace(c, key, place)).map((c, i) => ({ ...c, version: i + 1 }));
}

export type RolloutSource = 'lane' | 'branch' | 'never_set';

export interface RolloutDecision {
  readonly key: string;
  readonly branchId: string;
  readonly laneId: string | null;
  readonly on: boolean;
  /** Where the answer came from — the lane's own setting, its branch's, or nobody ever set it (off). */
  readonly source: RolloutSource;
  /** The version of the setting that decided, or null when nobody set it. */
  readonly version: number | null;
  readonly detail: string;
}

/** Is this feature on here? The most specific setting decides; nothing set is off. */
export function decideRollout(changes: readonly RolloutChange[], key: string, place: RolloutPlace): RolloutDecision {
  const base = { key, branchId: place.branchId, laneId: place.laneId ?? null };
  if (place.laneId !== undefined) {
    const lane = rolloutHistory(changes, key, place).at(-1);
    if (lane !== undefined) {
      return { ...base, on: lane.enabled, source: 'lane', version: lane.version, detail: `${key} is ${lane.enabled ? 'ON' : 'OFF'} on lane ${place.laneId} by its own setting (version ${lane.version}: ${lane.reason})` };
    }
  }
  const branch = rolloutHistory(changes, key, { branchId: place.branchId }).at(-1);
  if (branch !== undefined) {
    return { ...base, on: branch.enabled, source: 'branch', version: branch.version, detail: `${key} is ${branch.enabled ? 'ON' : 'OFF'} ${place.laneId === undefined ? 'in' : `on lane ${place.laneId} because of`} branch ${place.branchId}'s setting (version ${branch.version}: ${branch.reason})` };
  }
  return { ...base, on: false, source: 'never_set', version: null, detail: `nobody has switched ${key} on ${place.laneId === undefined ? `in branch ${place.branchId}` : `for lane ${place.laneId}`} — a switch nobody set is off` };
}

/** The current setting of every switch at every place it was ever set — the board a person reads. */
export interface RolloutBoardRow {
  readonly key: string;
  readonly branchId: string;
  readonly laneId: string | null;
  readonly enabled: boolean;
  readonly version: number;
  readonly reason: string;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly approvedBy: string | null;
}

export function rolloutBoard(changes: readonly RolloutChange[]): readonly RolloutBoardRow[] {
  const places = new Map<string, { key: string; place: RolloutPlace }>();
  for (const c of changes) places.set(`${c.key}\u0000${c.branchId}\u0000${c.laneId ?? ''}`, { key: c.key, place: { branchId: c.branchId, ...(c.laneId === undefined ? {} : { laneId: c.laneId }) } });
  return [...places.values()].map(({ key, place }) => {
    const last = rolloutHistory(changes, key, place).at(-1)!;
    return {
      key, branchId: place.branchId, laneId: place.laneId ?? null, enabled: last.enabled, version: last.version,
      reason: last.reason, changedBy: last.changedBy, changedAt: last.changedAt, approvedBy: last.approvedBy ?? null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key) || a.branchId.localeCompare(b.branchId) || (a.laneId ?? '').localeCompare(b.laneId ?? ''));
}

/** The store pack's rollout section for ONE store: its branch settings and each lane's own, with their versions. */
export interface RolloutSection {
  readonly format: 'sre-rollout/1';
  readonly branchId: string;
  readonly switches: readonly {
    readonly key: string;
    /** The branch-wide setting, or null when the branch never set one. */
    readonly branch: { readonly enabled: boolean; readonly version: number } | null;
    readonly lanes: readonly { readonly laneId: string; readonly enabled: boolean; readonly version: number }[];
  }[];
}

export function rolloutSection(changes: readonly RolloutChange[], branchId: string): RolloutSection {
  const here = rolloutBoard(changes).filter((r) => r.branchId === branchId);
  const keys = [...new Set(here.map((r) => r.key))].sort();
  return {
    format: 'sre-rollout/1',
    branchId,
    switches: keys.map((key) => {
      const branch = here.find((r) => r.key === key && r.laneId === null);
      return {
        key,
        branch: branch === undefined ? null : { enabled: branch.enabled, version: branch.version },
        lanes: here.filter((r) => r.key === key && r.laneId !== null).map((r) => ({ laneId: r.laneId!, enabled: r.enabled, version: r.version })),
      };
    }),
  };
}

/** What a till is told about its own lane: every switch the pack names, resolved for this lane. */
export type LaneRollout =
  | { readonly known: false; readonly why: string }
  | { readonly known: true; readonly laneId: string; readonly switches: Readonly<Record<string, { readonly on: boolean; readonly source: Exclude<RolloutSource, 'never_set'>; readonly version: number }>> };

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isVersioned = (v: unknown): v is { enabled: boolean; version: number } => isRec(v) && typeof v['enabled'] === 'boolean' && Number.isInteger(v['version']);

/**
 * Resolve a pack's rollout section for one lane — on the store computer, from the signed pack, with no network. A pack
 * without the section (or a box that does not know its lane) is "not told", never "everything on"; a malformed entry is
 * left out rather than guessed.
 */
export function laneRollout(section: unknown, laneId: string | undefined): LaneRollout {
  if (laneId === undefined || laneId.trim() === '') return { known: false, why: 'this store computer was not told which lane it is' };
  if (!isRec(section) || section['format'] !== 'sre-rollout/1' || !Array.isArray(section['switches'])) {
    return { known: false, why: 'the store pack carries no rollout switches — every trial feature is off on this lane' };
  }
  const switches: Record<string, { on: boolean; source: 'lane' | 'branch'; version: number }> = {};
  for (const s of section['switches'] as unknown[]) {
    if (!isRec(s) || typeof s['key'] !== 'string' || !ROLLOUT_KEY.test(s['key'])) continue;
    const lane = Array.isArray(s['lanes']) ? (s['lanes'] as unknown[]).find((l) => isRec(l) && l['laneId'] === laneId) : undefined;
    if (isVersioned(lane)) { switches[s['key']] = { on: lane.enabled, source: 'lane', version: lane.version }; continue; }
    if (isVersioned(s['branch'])) switches[s['key']] = { on: s['branch'].enabled, source: 'branch', version: s['branch'].version };
  }
  return { known: true, laneId, switches };
}

/** The till's one question: is this trial feature on for my lane? Not told, or never set, is OFF. */
export function laneSwitchOn(rollout: LaneRollout | undefined, key: string): boolean {
  return rollout !== undefined && rollout.known && rollout.switches[key]?.on === true;
}
