// D-6 (roadmap v2.1 addendum, ratified R2) — digital food-safety / HACCP checklists.
//
// Acceptance, in the addendum's words: "Scheduled temperature/equipment checks and cleaning/receiving checklists with
// corrective-action capture and a tamper-evident trail; a missed check surfaces".
//
// The pieces existed under other IDs — continuous probe monitoring (M26 `monitoring.ts`: a quiet probe is a fault),
// cleaning / pest / fire schedules (M26 `schedules.ts`: a missed compliance task escalates by itself), cold-chain verdicts
// (M10) and the receiving temperature at the dock (M07). What was missing was the CHECK a person does on a clock and
// signs: the 7 a.m. chiller reading, the slicer's daily guard check, the close-of-day deli clean, the checklist at the
// dock — each with what was found, what was DONE about a failure, and a missed one that shows itself. This module is that
// check, in four kinds, on one rule set:
//
//   • **A check is due on its schedule** (every N minutes from a start). Its slots are DERIVED, never stored, so a slot
//     nobody recorded is missed by arithmetic, not by a job that may itself not have run. Past its grace it is MISSED and
//     says who it escalates to. A receiving checklist has no clock (it is done per delivery), so it is never "missed".
//   • **A failed check needs its corrective action written down** — a temperature outside its limits, a checklist item
//     failed, equipment that failed. A failure with no corrective action is REFUSED, not stored as a "fail" nobody acted
//     on: a fail on file with nothing done is the record an inspector reads as negligence.
//   • **A late check is kept as late.** It is accepted (the reading is real) but the slot reads "done late", so the miss
//     stays visible (P-08) — never quietly turned green.
//
// Pure and deterministic: the clock is injected; no I/O. The tamper-evident trail is the route's: every definition and
// every record is sealed into the hash-chained audit trail (M34-FR-01), whose verify names any break.

export type FoodSafetyCheckKind = 'temperature' | 'equipment' | 'cleaning' | 'receiving';
export const FOOD_SAFETY_CHECK_KINDS: readonly FoodSafetyCheckKind[] = Object.freeze(['temperature', 'equipment', 'cleaning', 'receiving']);

export interface ChecklistItem {
  readonly itemId: string;
  readonly label: string;
}

/** A scheduled food-safety check (or, for `receiving`, a per-delivery checklist). */
export interface FoodSafetyCheck {
  readonly checkId: string;
  readonly branchId: string;
  readonly title: string;
  readonly kind: FoodSafetyCheckKind;
  /** The schedule: a slot every `everyMinutes` from `startsAt`. Absent only on a receiving checklist (per delivery). */
  readonly everyMinutes?: number;
  readonly startsAt?: string;
  /** Minutes after a slot is due before it is MISSED. */
  readonly graceMinutes: number;
  /** A temperature check's limits, tenths of °C (inclusive). Required for `temperature`. */
  readonly minTenthsC?: number;
  readonly maxTenthsC?: number;
  /** The items a person ticks pass/fail. Required (at least one) for `cleaning`, `receiving` and `equipment`. */
  readonly items: readonly ChecklistItem[];
  /** The fridge / slicer / oven this is about (the facilities equipment id), when there is one. */
  readonly equipmentId?: string;
  readonly assignedRole: string;
  /** Who hears about a missed check. */
  readonly escalatesTo: string;
  readonly active: boolean;
  /**
   * NEW-8: when this VERSION of the check came into force (the moment it was defined or redefined). A redefinition — a later
   * start, a new interval, set inactive — governs only from its own `effectiveFrom` forward; every slot that fell due under
   * the earlier version stays that version's, so a check that was missed stays missed. The FIRST version of a check governs
   * from its own schedule's start. Absent on a definition read without its history (then it is the only version).
   */
  readonly effectiveFrom?: string;
}

export type ItemResult = 'pass' | 'fail';

/** One check as a person did it. `performedBy` is always the signed-in person (the route sets it). */
export interface FoodSafetyCheckRecord {
  readonly recordId: string;
  readonly checkId: string;
  /** The scheduled slot this record answers (absent on a receiving checklist, which names its delivery instead). */
  readonly slotDueAt?: string;
  /** The delivery (goods receipt) a receiving checklist is about. */
  readonly subjectRef?: string;
  readonly performedBy: string;
  readonly performedAt: string;
  readonly readingTenthsC?: number;
  readonly itemResults?: Readonly<Record<string, ItemResult>>;
  readonly correctiveAction?: string;
  readonly evidenceRefs?: readonly string[];
  /** Set by the engine: what the check found. */
  readonly outcome: 'pass' | 'fail';
  readonly failures: readonly string[];
  /** Set by the engine: recorded after its slot's grace ran out. */
  readonly late: boolean;
}

const MINUTE_MS = 60_000;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** Why a definition cannot be a check — or `null` when it can. */
export function definitionProblem(c: Omit<FoodSafetyCheck, 'checkId'>): string | null {
  if (!isStr(c.branchId) || !isStr(c.title) || !FOOD_SAFETY_CHECK_KINDS.includes(c.kind) || !isStr(c.assignedRole) || !isStr(c.escalatesTo)) {
    return 'a check needs a branch, a title, a kind (temperature / equipment / cleaning / receiving), the role that does it and who a miss escalates to';
  }
  if (!isInt(c.graceMinutes) || c.graceMinutes < 0) return 'graceMinutes must be a whole number of minutes, 0 or more';
  const scheduled = c.kind !== 'receiving';
  if (scheduled && (!isInt(c.everyMinutes) || c.everyMinutes <= 0 || !isTime(c.startsAt))) {
    return `a ${c.kind} check is scheduled: it needs everyMinutes (a whole number above 0) and startsAt (a time)`;
  }
  if (!scheduled && (c.everyMinutes !== undefined || c.startsAt !== undefined)) {
    return 'a receiving checklist is done per delivery, not on a clock — it takes no everyMinutes or startsAt';
  }
  if (c.kind === 'temperature' && (!isInt(c.minTenthsC) || !isInt(c.maxTenthsC) || c.minTenthsC > c.maxTenthsC)) {
    return 'a temperature check needs its limits: minTenthsC and maxTenthsC (tenths of °C, min ≤ max)';
  }
  if (c.kind !== 'temperature' && c.items.length === 0) return `a ${c.kind} check needs at least one item to tick`;
  const ids = c.items.map((i) => i.itemId);
  if (ids.some((id) => !isStr(id)) || new Set(ids).size !== ids.length || c.items.some((i) => !isStr(i.label))) {
    return 'each checklist item needs its own itemId and a label';
  }
  return null;
}

/** Is `at` one of this check's slots? */
export function isSlotOf(check: FoodSafetyCheck, at: string): boolean {
  if (check.everyMinutes === undefined || check.startsAt === undefined) return false;
  const off = Date.parse(at) - Date.parse(check.startsAt);
  return Number.isFinite(off) && off >= 0 && off % (check.everyMinutes * MINUTE_MS) === 0;
}

/** The slots of a scheduled check falling in [from, to] (ISO times, ascending). */
export function slotsOf(check: FoodSafetyCheck, from: string, to: string): string[] {
  if (check.everyMinutes === undefined || check.startsAt === undefined) return [];
  const step = check.everyMinutes * MINUTE_MS;
  const start = Date.parse(check.startsAt);
  const lo = Math.max(start, Date.parse(from));
  const hi = Date.parse(to);
  const out: string[] = [];
  let t = start + Math.ceil((lo - start) / step) * step;
  for (; t <= hi; t += step) out.push(new Date(t).toISOString());
  return out;
}

export type RecordRefusal =
  | 'not_a_slot' | 'slot_not_yet_open' | 'needs_a_delivery' | 'reading_required' | 'items_incomplete' | 'corrective_action_required';

export type RecordAssessment =
  | { readonly ok: true; readonly record: FoodSafetyCheckRecord }
  | { readonly ok: false; readonly refusal: RecordRefusal; readonly detail: string };

/** What a person sends for a check (the engine works out the outcome, the failures and lateness). */
export type CheckRecordDraft = Omit<FoodSafetyCheckRecord, 'outcome' | 'failures' | 'late'>;

/**
 * Judge one check as done. A failure — a reading outside the limits, an item failed, failed equipment — needs its
 * corrective action written down, or the record is refused. A check recorded past its grace is kept, marked late.
 */
export function assessCheckRecord(check: FoodSafetyCheck, draft: CheckRecordDraft): RecordAssessment {
  const late = check.kind !== 'receiving' && draft.slotDueAt !== undefined
    && Date.parse(draft.performedAt) > Date.parse(draft.slotDueAt) + check.graceMinutes * MINUTE_MS;
  if (check.kind === 'receiving') {
    if (!isStr(draft.subjectRef)) return { ok: false, refusal: 'needs_a_delivery', detail: `"${check.title}" is a receiving checklist — say which delivery (goods receipt) it is for` };
  } else {
    if (draft.slotDueAt === undefined || !isSlotOf(check, draft.slotDueAt)) {
      return { ok: false, refusal: 'not_a_slot', detail: `${draft.slotDueAt ?? '(none)'} is not a scheduled time of "${check.title}" (every ${check.everyMinutes} minutes from ${check.startsAt})` };
    }
    // A check is done when it is due: one opening more than its grace early is not that slot's check.
    if (Date.parse(draft.performedAt) < Date.parse(draft.slotDueAt) - check.graceMinutes * MINUTE_MS) {
      return { ok: false, refusal: 'slot_not_yet_open', detail: `"${check.title}" at ${draft.slotDueAt} is not due yet — it can be done from ${check.graceMinutes} minute(s) before` };
    }
  }

  const failures: string[] = [];
  if (check.kind === 'temperature') {
    if (!isInt(draft.readingTenthsC)) return { ok: false, refusal: 'reading_required', detail: `"${check.title}" is a temperature check — the reading (tenths of °C) is the record` };
    if (draft.readingTenthsC < check.minTenthsC! || draft.readingTenthsC > check.maxTenthsC!) {
      failures.push(`reading ${(draft.readingTenthsC / 10).toFixed(1)}°C is outside ${(check.minTenthsC! / 10).toFixed(1)}–${(check.maxTenthsC! / 10).toFixed(1)}°C`);
    }
  } else if (isInt(draft.readingTenthsC) && isInt(check.minTenthsC) && isInt(check.maxTenthsC)
    && (draft.readingTenthsC < check.minTenthsC || draft.readingTenthsC > check.maxTenthsC)) {
    failures.push(`reading ${(draft.readingTenthsC / 10).toFixed(1)}°C is outside ${(check.minTenthsC / 10).toFixed(1)}–${(check.maxTenthsC / 10).toFixed(1)}°C`);
  }
  if (check.items.length > 0) {
    const results = draft.itemResults ?? {};
    const missing = check.items.filter((i) => results[i.itemId] !== 'pass' && results[i.itemId] !== 'fail');
    if (missing.length > 0) {
      return { ok: false, refusal: 'items_incomplete', detail: `"${check.title}" is not done until every item is ticked pass or fail — not ticked: ${missing.map((i) => i.label).join(', ')}` };
    }
    for (const i of check.items) if (results[i.itemId] === 'fail') failures.push(`${i.label}: failed`);
  }
  if (failures.length > 0 && !isStr(draft.correctiveAction)) {
    return {
      ok: false, refusal: 'corrective_action_required',
      detail: `"${check.title}" failed (${failures.join('; ')}) — write down the corrective action taken. A failed check with nothing done about it is not recorded.`,
    };
  }
  return {
    ok: true,
    record: {
      ...draft,
      ...(isStr(draft.correctiveAction) ? { correctiveAction: draft.correctiveAction.trim() } : {}),
      outcome: failures.length > 0 ? 'fail' : 'pass', failures, late,
    },
  };
}

export type SlotState = 'done' | 'done_failed' | 'done_late' | 'due' | 'missed' | 'upcoming';

export interface SlotStatus {
  readonly checkId: string;
  readonly title: string;
  readonly kind: FoodSafetyCheckKind;
  readonly branchId: string;
  readonly slotDueAt: string;
  readonly state: SlotState;
  readonly recordId?: string;
  readonly performedBy?: string;
  readonly correctiveAction?: string;
  /** Who a missed check escalates to (set when missed). */
  readonly escalateTo?: string;
  readonly detail: string;
}

export interface FoodSafetyStatus {
  readonly asAt: string;
  readonly from: string;
  /** Missed checks first (oldest first) — the ones that need a person now. */
  readonly missed: readonly SlotStatus[];
  readonly due: readonly SlotStatus[];
  /** Failed checks in the window, with the corrective action taken. */
  readonly failed: readonly SlotStatus[];
  readonly slots: readonly SlotStatus[];
  /** Receiving checklists in the window (per delivery; never "missed"). */
  readonly receiving: readonly FoodSafetyCheckRecord[];
  readonly detail: string;
}

/**
 * NEW-8: the versions of each check in the order they came into force, each with the window it governs: from its own
 * `effectiveFrom` (the first version: from the beginning) up to — not including — the next version's.
 */
export function versionWindows(checks: readonly FoodSafetyCheck[]): { readonly check: FoodSafetyCheck; readonly fromMs: number; readonly toMs: number }[] {
  const byId = new Map<string, FoodSafetyCheck[]>();
  for (const c of checks) byId.set(c.checkId, [...(byId.get(c.checkId) ?? []), c]);
  const out: { check: FoodSafetyCheck; fromMs: number; toMs: number }[] = [];
  for (const versions of byId.values()) {
    // Stable: versions without a stamp keep their order; stamped ones go by when they came into force.
    const ordered = versions.map((v, i) => ({ v, i })).sort((a, b) => {
      const ea = a.v.effectiveFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.v.effectiveFrom);
      const eb = b.v.effectiveFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.v.effectiveFrom);
      return ea - eb || a.i - b.i;
    }).map((x) => x.v);
    ordered.forEach((v, i) => {
      const fromMs = i === 0 || v.effectiveFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(v.effectiveFrom);
      const next = ordered[i + 1];
      const toMs = next === undefined || next.effectiveFrom === undefined ? Number.POSITIVE_INFINITY : Date.parse(next.effectiveFrom);
      out.push({ check: v, fromMs, toMs });
    });
  }
  return out;
}

/** NEW-8: the version of a check that governed the moment `at` (undefined when the check is unknown). */
export function checkInForceAt(versions: readonly FoodSafetyCheck[], checkId: string, at: string): FoodSafetyCheck | undefined {
  const ms = Date.parse(at);
  return versionWindows(versions.filter((v) => v.checkId === checkId)).find((w) => ms >= w.fromMs && ms < w.toMs)?.check;
}

/**
 * Where every scheduled check stands over [from, asAt]: done, failed (with its action), late, due, or MISSED. `checks` may
 * carry every VERSION of a check (NEW-8): each version's slots are derived only over the window it was in force, so a
 * redefinition or deactivation never erases a slot that fell due — and was missed — under the version before it.
 */
export function foodSafetyStatus(input: {
  readonly checks: readonly FoodSafetyCheck[];
  readonly records: readonly FoodSafetyCheckRecord[];
  readonly from: string;
  readonly asAt: string;
}): FoodSafetyStatus {
  const asAtMs = Date.parse(input.asAt);
  const slots: SlotStatus[] = [];
  for (const { check, fromMs, toMs } of versionWindows(input.checks).filter((w) => w.check.active && w.check.kind !== 'receiving')) {
    const mine = input.records.filter((r) => r.checkId === check.checkId);
    // Include the slot that opens within its grace before asAt (so "due" shows), never one further ahead — and only the
    // slots that fell due while THIS version was in force.
    const lo = Math.max(Date.parse(input.from), fromMs);
    const hi = Math.min(asAtMs + check.graceMinutes * MINUTE_MS, toMs - 1);
    if (hi < lo) continue;
    for (const slot of slotsOf(check, new Date(lo).toISOString(), new Date(hi).toISOString())) {
      const rec = mine.find((r) => r.slotDueAt === slot);
      const base = { checkId: check.checkId, title: check.title, kind: check.kind, branchId: check.branchId, slotDueAt: slot };
      const dueMs = Date.parse(slot);
      if (rec !== undefined) {
        const state: SlotState = rec.outcome === 'fail' ? 'done_failed' : rec.late ? 'done_late' : 'done';
        slots.push({
          ...base, state, recordId: rec.recordId, performedBy: rec.performedBy,
          ...(rec.correctiveAction === undefined ? {} : { correctiveAction: rec.correctiveAction }),
          detail: state === 'done_failed'
            ? `"${check.title}" at ${slot} failed (${rec.failures.join('; ')}) — action: ${rec.correctiveAction ?? ''}${rec.late ? ' (done late)' : ''}`
            : state === 'done_late' ? `"${check.title}" at ${slot} was done late by ${rec.performedBy} — it was missed first` : `"${check.title}" at ${slot} done by ${rec.performedBy}`,
        });
      } else if (asAtMs > dueMs + check.graceMinutes * MINUTE_MS) {
        slots.push({ ...base, state: 'missed', escalateTo: check.escalatesTo, detail: `"${check.title}" due ${slot} was MISSED — nobody recorded it within ${check.graceMinutes} minute(s); escalated to ${check.escalatesTo}` });
      } else if (asAtMs >= dueMs - check.graceMinutes * MINUTE_MS) {
        slots.push({ ...base, state: 'due', detail: `"${check.title}" is due at ${slot}` });
      } else {
        slots.push({ ...base, state: 'upcoming', detail: `"${check.title}" next at ${slot}` });
      }
    }
  }
  slots.sort((a, b) => a.slotDueAt.localeCompare(b.slotDueAt) || a.checkId.localeCompare(b.checkId));
  const missed = slots.filter((s) => s.state === 'missed');
  const failed = slots.filter((s) => s.state === 'done_failed');
  const receivingIds = new Set(input.checks.filter((c) => c.kind === 'receiving').map((c) => c.checkId));
  const receiving = input.records
    .filter((r) => receivingIds.has(r.checkId) && r.performedAt >= input.from && Date.parse(r.performedAt) <= asAtMs)
    .sort((a, b) => a.performedAt.localeCompare(b.performedAt));
  return {
    asAt: input.asAt, from: input.from, missed, due: slots.filter((s) => s.state === 'due'), failed, slots, receiving,
    detail: missed.length === 0
      ? `no food-safety check missed since ${input.from}${failed.length === 0 ? '' : ` — ${failed.length} failed, each with its corrective action`}`
      : `${missed.length} food-safety check(s) MISSED since ${input.from} — each escalated to the person named`,
  };
}
