// Status presentation, touch targets and the interaction budget — NFR-07, NFR-13, §10, §27.1,
// design system.
//
// The design system says **"colour is never the only signal (icon + text too), for colour-blind
// and glare conditions"**. That sentence has been true in the document since Stage 3 and
// enforced by nothing, which is the normal fate of a sentence in a document: the sync badge goes
// green, somebody removes the word "Online" because the header is tight on a 10-inch lane
// screen, and it renders correctly for everybody except the roughly one man in twelve who cannot
// tell it from the amber one.
//
// So this module makes it **structurally impossible** rather than remembered:
//
//   • **A TONE IS NEVER RETURNED ON ITS OWN.** `presentStatus` returns the label, the icon and
//     the screen-reader announcement in the same object as the tone. A surface that renders
//     colour-only has to actively discard three fields, which is a deliberate act a reviewer can
//     see in a diff — rather than an omission nobody notices.
//   • **THE LABEL IS NOT DECORATIVE.** It is the state, in words, in the till's language. A
//     cashier standing at a lane needs "Offline — 42 unsent", not a coloured dot whose meaning
//     they are expected to have learnt.
//   • **THE ANNOUNCEMENT IS SEPARATE FROM THE LABEL.** They are read in different situations and
//     want different words: the label is glanced at all day and must be short; the announcement
//     fires once, on change, and must stand alone without the screen it came from.
//
// **NFR-13 is the other half.** "≤3 interactions" is a design-system bar that only ever gets
// checked by somebody counting taps in a review, which happens once and then never again.
// `interactionBudget` makes it a number a test can assert, because the fourth tap is added by a
// well-meaning change six months later and nobody re-counts.
//
// Pure and deterministic: no I/O, no clock, no DOM.

/** The design system's four states. Colour is one expression of these, never the only one. */
export type Tone = 'ok' | 'degraded' | 'error' | 'idle';

export interface StatusPresentation {
  readonly tone: Tone;
  /** Short, glanceable, in words. Never absent — that is the entire point of this type. */
  readonly label: string;
  /** A shape, so the signal survives greyscale, glare and colour blindness. */
  readonly icon: string;
  /** Stands alone: read on change, without the screen it came from. */
  readonly announcement: string;
  /** True when a person must do something. Drives ordering, never colour alone. */
  readonly needsAttention: boolean;
}

/**
 * All four states the product actually has (`CONNECTION_STATES`, §27.1).
 *
 * `reconnecting` is deliberately not folded into `degraded`. They mean different things to the
 * person at the lane — *"slow"* is a condition to work around, *"coming back"* is a reason to
 * wait a moment before calling anybody — and a presentation layer that collapses them hands the
 * cashier one word for two situations.
 */
export type ConnectionTone = 'online' | 'degraded' | 'offline' | 'reconnecting';

/**
 * The permanent sync badge (§27.1, P-08), presented so it cannot be rendered as a dot.
 *
 * The unsent count is **in the label**, not beside it. "Offline" alone invites the reasonable
 * assumption that nothing is at stake; "Offline — 42 sales waiting" is the fact, and it is the
 * one that gets somebody to look at the connection before the end of the day.
 */
export function presentSyncBadge(input: {
  readonly connection: ConnectionTone;
  readonly unsentCount: number;
  /** Minutes since the last successful sync, where known. Staleness is its own signal (P-08). */
  readonly minutesSinceSync?: number;
}): StatusPresentation {
  const waiting = input.unsentCount === 1 ? '1 sale waiting' : `${input.unsentCount} sales waiting`;
  const since = input.minutesSinceSync === undefined
    ? ''
    : ` Last synced ${input.minutesSinceSync} minute${input.minutesSinceSync === 1 ? '' : 's'} ago.`;

  if (input.connection === 'online' && input.unsentCount === 0) {
    return {
      tone: 'ok', label: 'Online', icon: 'check-circle',
      announcement: `Online. Everything is synced.${since}`,
      needsAttention: false,
    };
  }
  if (input.connection === 'offline') {
    return {
      // Offline is NOT an error — the shop is meant to keep trading (P-01), and a red alarm
      // teaches cashiers that the normal offline state is a fault, which is how they learn to
      // ignore it. Degraded is the honest tone.
      tone: 'degraded', label: `Offline — ${waiting}`, icon: 'cloud-off',
      announcement: `Offline. The till is still working normally and ${waiting} to be sent.${since}`,
      needsAttention: input.unsentCount > 0,
    };
  }
  if (input.connection === 'reconnecting') {
    return {
      tone: 'degraded',
      label: input.unsentCount === 0 ? 'Reconnecting' : `Reconnecting — ${waiting}`,
      icon: 'cloud-retry',
      announcement: `Reconnecting. The till is still working normally and ${waiting} to be sent.${since}`,
      // Nothing for anybody to do yet — it is coming back on its own. Asking for attention here
      // is how a badge that matters becomes one that gets ignored.
      needsAttention: false,
    };
  }
  return {
    tone: 'degraded',
    label: input.unsentCount === 0 ? 'Syncing' : `Syncing — ${waiting}`,
    icon: 'cloud-sync',
    announcement: `Connection is slow. ${waiting} to be sent.${since}`,
    needsAttention: input.unsentCount > 0,
  };
}

/** Anything a surface shows as a state. Every one of them owes the user words. */
export function presentStatus(input: {
  readonly tone: Tone;
  readonly label: string;
  readonly icon: string;
  readonly announcement?: string;
  readonly needsAttention?: boolean;
}): StatusPresentation {
  const label = input.label.trim();
  const icon = input.icon.trim();
  if (label === '') {
    throw new RangeError(
      'A status must carry a label. Colour is never the only signal — a coloured dot is unreadable to somebody who cannot distinguish it, and unreadable to everybody under glare.',
    );
  }
  if (icon === '') {
    throw new RangeError(
      'A status must carry an icon. A shape is what survives greyscale, glare and colour blindness.',
    );
  }
  return {
    tone: input.tone,
    label,
    icon,
    announcement: (input.announcement ?? label).trim(),
    needsAttention: input.needsAttention ?? (input.tone === 'error' || input.tone === 'degraded'),
  };
}

// ── touch targets ─────────────────────────────────────────────────────────────

/** WCAG 2.2 AA 2.5.8 minimum, in CSS px. The floor, not the goal. */
export const WCAG_MINIMUM_TARGET_PX = 24;

/**
 * The design system's own bar: **≥44×44**, and it is higher than WCAG for a reason that is about
 * this shop rather than the standard — a cashier working fast, at arm's length, on a lane screen,
 * during a rush. A mis-tap there is a voided line and a queue.
 */
export const DESIGN_SYSTEM_TARGET_PX = 44;

export interface TargetCheck {
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly meetsWcag: boolean;
  readonly meetsDesignSystem: boolean;
  readonly detail: string;
}

export function checkTouchTarget(input: {
  readonly name: string;
  readonly widthPx: number;
  readonly heightPx: number;
}): TargetCheck {
  const smallest = Math.min(input.widthPx, input.heightPx);
  const meetsWcag = smallest >= WCAG_MINIMUM_TARGET_PX;
  const meetsDesignSystem = smallest >= DESIGN_SYSTEM_TARGET_PX;

  return {
    name: input.name, widthPx: input.widthPx, heightPx: input.heightPx, meetsWcag, meetsDesignSystem,
    detail: meetsDesignSystem
      ? `${input.name} is ${input.widthPx}×${input.heightPx}, meeting the 44px bar`
      : meetsWcag
        ? `${input.name} is ${input.widthPx}×${input.heightPx} — legal under WCAG 2.5.8 but under the 44px this shop's design system sets, which exists for a cashier working fast at arm's length`
        : `${input.name} is ${input.widthPx}×${input.heightPx} — below the WCAG 2.2 AA minimum of ${WCAG_MINIMUM_TARGET_PX}px`,
  };
}

// ── the interaction budget (NFR-13) ───────────────────────────────────────────

export interface TaskBudget {
  readonly task: string;
  readonly role: string;
  /** The design-system bar for this task. Three, for the cashier's common path. */
  readonly maxInteractions: number;
}

export interface BudgetCheck {
  readonly task: string;
  readonly role: string;
  readonly interactions: readonly string[];
  readonly used: number;
  readonly allowed: number;
  readonly withinBudget: boolean;
  readonly detail: string;
}

/**
 * Count the interactions a task actually costs, and name each one.
 *
 * The steps are **named, not counted**, because a budget report saying *"4 of 3"* starts an
 * argument about what counts as an interaction, while one that lists *"scan, confirm age, choose
 * tender, confirm amount, print"* starts a conversation about which step to remove.
 */
export function checkInteractionBudget(input: {
  readonly budget: TaskBudget;
  readonly interactions: readonly string[];
}): BudgetCheck {
  const used = input.interactions.length;
  const allowed = input.budget.maxInteractions;
  const withinBudget = used <= allowed;

  return {
    task: input.budget.task,
    role: input.budget.role,
    interactions: input.interactions,
    used,
    allowed,
    withinBudget,
    detail: withinBudget
      ? `${input.budget.task}: ${used} interactions against a bar of ${allowed} — ${input.interactions.join(' → ')}`
      : `${input.budget.task}: ${used} interactions against a bar of ${allowed}. The steps are ${input.interactions.join(' → ')} — the fourth one was added by a reasonable change and nobody re-counted`,
  };
}

// ── keyboard reachability ─────────────────────────────────────────────────────

export interface FocusableItem {
  readonly id: string;
  readonly label: string;
  /** Where it sits in the tab order. Duplicates and gaps are both defects. */
  readonly tabIndex: number;
  /** A control reachable only by pointer is unreachable to a keyboard and to a screen reader. */
  readonly keyboardReachable: boolean;
  /** Every focusable thing needs a visible ring — 2.4.7, and glare makes it non-optional here. */
  readonly hasVisibleFocusIndicator: boolean;
}

export type FocusIssueKind =
  | 'not_keyboard_reachable'
  | 'no_visible_focus_indicator'
  | 'duplicate_tab_index'
  | 'unlabelled';

export interface FocusIssue {
  readonly id: string;
  readonly kind: FocusIssueKind;
  readonly detail: string;
}

export interface FocusOrderReport {
  readonly items: readonly FocusableItem[];
  readonly issues: readonly FocusIssue[];
  readonly reachable: boolean;
  readonly detail: string;
}

/**
 * Check a surface's focus order.
 *
 * Every issue at once, not the first — a surface with four unreachable controls reported one at a
 * time takes four rounds, and by the third nobody is reading the report.
 */
export function checkFocusOrder(items: readonly FocusableItem[]): FocusOrderReport {
  const issues: FocusIssue[] = [];
  const seenIndex = new Map<number, string>();

  for (const item of items) {
    if (!item.keyboardReachable) {
      issues.push({
        id: item.id, kind: 'not_keyboard_reachable',
        detail: `"${item.label}" can only be reached with a pointer — which means it cannot be reached by a keyboard, a screen reader, or a cashier whose touchscreen has stopped registering the bottom inch`,
      });
    }
    if (!item.hasVisibleFocusIndicator) {
      issues.push({
        id: item.id, kind: 'no_visible_focus_indicator',
        detail: `"${item.label}" gives no visible focus ring (2.4.7) — under the glare of a lane light, an invisible focus is the same as no focus`,
      });
    }
    if (item.label.trim() === '') {
      issues.push({
        id: item.id, kind: 'unlabelled',
        detail: `${item.id} has no label — an icon-only control is a guess for a sighted user and silence for a screen reader`,
      });
    }
    const clash = seenIndex.get(item.tabIndex);
    if (clash !== undefined && item.tabIndex > 0) {
      issues.push({
        id: item.id, kind: 'duplicate_tab_index',
        detail: `"${item.label}" and "${clash}" both claim tab position ${item.tabIndex} — the order between them is then whatever the browser decides, which is not the same browser everywhere`,
      });
    }
    seenIndex.set(item.tabIndex, item.label);
  }

  const reachable = issues.length === 0;
  return {
    items,
    issues,
    reachable,
    detail: reachable
      ? `${items.length} controls, every one reachable by keyboard, labelled, and showing focus`
      : `${issues.length} accessibility issues across ${items.length} controls`,
  };
}
