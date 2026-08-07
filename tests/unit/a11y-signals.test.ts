import { describe, it, expect } from 'vitest';
import {
  presentSyncBadge, presentStatus, checkTouchTarget, checkInteractionBudget, checkFocusOrder,
  WCAG_MINIMUM_TARGET_PX, DESIGN_SYSTEM_TARGET_PX, type FocusableItem,
} from '../../packages/a11y/src/signals';
import * as a11y from '../../packages/a11y/src/signals';

// NFR-07, NFR-13, §27.1 — the design-system rules that were previously sentences in a document.

describe('colour is never the only signal', () => {
  it('returns a label, an icon and an announcement alongside every tone', () => {
    const badge = presentSyncBadge({ connection: 'online', unsentCount: 0 });
    expect(badge.tone).toBe('ok');
    // A surface rendering colour-only has to actively DISCARD three fields — a deliberate act a
    // reviewer sees in a diff, rather than an omission nobody notices.
    expect(badge.label).toBe('Online');
    expect(badge.icon).not.toBe('');
    expect(badge.announcement).toContain('Everything is synced');
  });

  it('REFUSES to build a status with no label', () => {
    expect(() => presentStatus({ tone: 'error', label: '   ', icon: 'alert' }))
      .toThrow(/Colour is never the only signal/);
  });

  it('REFUSES to build a status with no icon — a shape is what survives greyscale', () => {
    expect(() => presentStatus({ tone: 'ok', label: 'Online', icon: '' }))
      .toThrow(/survives greyscale, glare and colour blindness/);
  });

  it('gives every tone a DIFFERENT icon, so greyscale still distinguishes them', () => {
    const icons = new Set([
      presentSyncBadge({ connection: 'online', unsentCount: 0 }).icon,
      presentSyncBadge({ connection: 'offline', unsentCount: 3 }).icon,
      presentSyncBadge({ connection: 'degraded', unsentCount: 3 }).icon,
    ]);
    expect(icons.size).toBe(3);
  });

  it('exposes no way to get a tone on its own', () => {
    // Absence as a control: a `toneOf()` or `colourFor()` helper is exactly how a surface ends
    // up rendering a dot, because it makes the wrong thing the convenient thing.
    const names = Object.keys(a11y);
    for (const forbidden of ['toneOf', 'colourFor', 'statusColour', 'badgeColour', 'toneColour']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('the sync badge tells a cashier what is actually at stake (§27.1, P-08)', () => {
  it('puts the unsent COUNT in the label, not beside it', () => {
    // "Offline" alone invites the reasonable assumption that nothing is at stake.
    const badge = presentSyncBadge({ connection: 'offline', unsentCount: 42 });
    expect(badge.label).toBe('Offline — 42 sales waiting');
    expect(badge.needsAttention).toBe(true);
  });

  it('treats OFFLINE as degraded, not as an error — the shop is meant to keep trading (P-01)', () => {
    // A red alarm teaches cashiers that the normal offline state is a fault, which is how they
    // learn to ignore it — and then they ignore the real one.
    const badge = presentSyncBadge({ connection: 'offline', unsentCount: 5 });
    expect(badge.tone).toBe('degraded');
    expect(badge.announcement).toContain('still working normally');
  });

  it('gets the singular right, because "1 sales waiting" is what a cheap system looks like', () => {
    expect(presentSyncBadge({ connection: 'offline', unsentCount: 1 }).label).toBe('Offline — 1 sale waiting');
  });

  it('does not ask for attention when everything is sent', () => {
    expect(presentSyncBadge({ connection: 'online', unsentCount: 0 }).needsAttention).toBe(false);
  });

  it('carries staleness when it is known (P-08)', () => {
    const badge = presentSyncBadge({ connection: 'degraded', unsentCount: 4, minutesSinceSync: 1 });
    expect(badge.announcement).toContain('1 minute ago');
    expect(presentSyncBadge({ connection: 'degraded', unsentCount: 4, minutesSinceSync: 12 }).announcement)
      .toContain('12 minutes ago');
  });

  it('keeps the announcement able to stand alone, without the screen it came from', () => {
    for (const connection of ['online', 'degraded', 'offline'] as const) {
      const badge = presentSyncBadge({ connection, unsentCount: 7 });
      // Read once, on change, with no context. Longer than the glanceable label, by design.
      expect(badge.announcement.length).toBeGreaterThan(badge.label.length);
    }
  });
});

describe('touch targets are held to the shop\'s bar, not only the standard\'s', () => {
  it('passes a 44×44 control', () => {
    const r = checkTouchTarget({ name: 'Tender cash', widthPx: 96, heightPx: 64 });
    expect(r.meetsWcag).toBe(true);
    expect(r.meetsDesignSystem).toBe(true);
  });

  it('separates "legal under WCAG" from "big enough for a cashier in a rush"', () => {
    // 32px clears WCAG 2.5.8's 24px and is still under the 44px this design system sets, for a
    // reason that is about this shop rather than the standard.
    const r = checkTouchTarget({ name: 'Void line', widthPx: 32, heightPx: 32 });
    expect(r.meetsWcag).toBe(true);
    expect(r.meetsDesignSystem).toBe(false);
    expect(r.detail).toContain('a cashier working fast at arm\'s length');
  });

  it('fails a control below the WCAG minimum outright', () => {
    const r = checkTouchTarget({ name: 'Close', widthPx: 18, heightPx: 18 });
    expect(r.meetsWcag).toBe(false);
    expect(r.detail).toContain(`${WCAG_MINIMUM_TARGET_PX}px`);
  });

  it('judges on the SMALLEST dimension — a 200×20 bar is still 20px to hit', () => {
    expect(checkTouchTarget({ name: 'Slider', widthPx: 200, heightPx: 20 }).meetsWcag).toBe(false);
  });

  it('sets the design-system bar above the standard, deliberately', () => {
    expect(DESIGN_SYSTEM_TARGET_PX).toBeGreaterThan(WCAG_MINIMUM_TARGET_PX);
  });
});

describe('the interaction budget is a number, not a memory (NFR-13)', () => {
  const cashierScan = { task: 'Sell one item for cash', role: 'cashier', maxInteractions: 3 };

  it('passes the common cashier path at three interactions', () => {
    const r = checkInteractionBudget({
      budget: cashierScan,
      interactions: ['scan the item', 'press Cash', 'confirm the amount'],
    });
    expect(r.withinBudget).toBe(true);
    expect(r.used).toBe(3);
  });

  it('FAILS at four, and names the steps rather than counting them', () => {
    const r = checkInteractionBudget({
      budget: cashierScan,
      interactions: ['scan the item', 'confirm the category', 'press Cash', 'confirm the amount'],
    });
    expect(r.withinBudget).toBe(false);
    // "4 of 3" starts an argument about what counts. The list starts a conversation about which
    // step to remove.
    expect(r.detail).toContain('scan the item → confirm the category → press Cash → confirm the amount');
    expect(r.detail).toContain('nobody re-counted');
  });

  it('lets a rarer task carry a larger budget, because not every path is the lane', () => {
    const r = checkInteractionBudget({
      budget: { task: 'Approve a purchase order', role: 'manager', maxInteractions: 6 },
      interactions: ['open approvals', 'open the order', 'check the match', 'add a note', 'approve'],
    });
    expect(r.withinBudget).toBe(true);
  });
});

describe('every control is reachable by keyboard, labelled, and shows focus', () => {
  const item = (over: Partial<FocusableItem> = {}): FocusableItem => ({
    id: 'btn-cash', label: 'Cash', tabIndex: 0,
    keyboardReachable: true, hasVisibleFocusIndicator: true, ...over,
  });

  it('passes a clean surface', () => {
    const r = checkFocusOrder([item(), item({ id: 'btn-card', label: 'Card' })]);
    expect(r.reachable).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('catches a pointer-only control', () => {
    const r = checkFocusOrder([item({ keyboardReachable: false })]);
    expect(r.issues[0]?.kind).toBe('not_keyboard_reachable');
    expect(r.issues[0]?.detail).toContain('touchscreen has stopped registering the bottom inch');
  });

  it('catches an invisible focus ring (2.4.7)', () => {
    const r = checkFocusOrder([item({ hasVisibleFocusIndicator: false })]);
    expect(r.issues[0]?.kind).toBe('no_visible_focus_indicator');
    expect(r.issues[0]?.detail).toContain('glare');
  });

  it('catches an icon-only control with no label', () => {
    const r = checkFocusOrder([item({ label: '  ' })]);
    expect(r.issues.some((i) => i.kind === 'unlabelled')).toBe(true);
  });

  it('catches two controls claiming the same tab position', () => {
    const r = checkFocusOrder([item({ tabIndex: 3 }), item({ id: 'btn-card', label: 'Card', tabIndex: 3 })]);
    expect(r.issues.some((i) => i.kind === 'duplicate_tab_index')).toBe(true);
    expect(r.issues[0]?.detail).toContain('not the same browser everywhere');
  });

  it('does NOT flag many controls at tabIndex 0 — that is the correct default order', () => {
    const r = checkFocusOrder([item(), item({ id: 'b', label: 'B' }), item({ id: 'c', label: 'C' })]);
    expect(r.issues).toHaveLength(0);
  });

  it('reports EVERY issue at once, not the first', () => {
    const r = checkFocusOrder([item({ keyboardReachable: false, hasVisibleFocusIndicator: false, label: ' ' })]);
    expect([...r.issues.map((i) => i.kind)].sort())
      .toEqual(['no_visible_focus_indicator', 'not_keyboard_reachable', 'unlabelled']);
  });
});

describe('the POS lane actually uses it, rather than having a parallel implementation', () => {
  it('exposes the badge with its words, from the real view adapter', async () => {
    const { presentSyncBadge } = await import('../../packages/a11y/src/signals');
    // All four states the product has (§27.1) are covered — no state falls through to a default
    // that renders as something the cashier has to interpret.
    for (const connection of ['online', 'degraded', 'offline', 'reconnecting'] as const) {
      const badge = presentSyncBadge({ connection, unsentCount: 2 });
      expect(badge.label.trim(), connection).not.toBe('');
      expect(badge.icon.trim(), connection).not.toBe('');
    }
  });

  it('distinguishes "reconnecting" from "slow" — two situations, two words', () => {
    const reconnecting = presentSyncBadge({ connection: 'reconnecting', unsentCount: 4 });
    const degraded = presentSyncBadge({ connection: 'degraded', unsentCount: 4 });
    expect(reconnecting.label).not.toBe(degraded.label);
    expect(reconnecting.icon).not.toBe(degraded.icon);
    // Coming back on its own — nothing for anybody to do, and a badge that cries wolf here is
    // one that gets ignored when it matters.
    expect(reconnecting.needsAttention).toBe(false);
    expect(degraded.needsAttention).toBe(true);
  });
});
