// Store setup screen (ADR-0003 §4 "onboarding is configuration, not code" · M01-FR-02/03 ·
// M33-FR-01 · M36-FR-02 · §27 role surfaces).
//
// The screen a retailer completes to configure its own store. It presents the setup status the
// platform API computes (GET /v1/platform/setup): every setting with its plain question and its
// value in force, grouped by how much attention it needs, with a headline that says — in one
// sentence — whether the store can open yet and what is still missing. Writes go back through the
// api-client to PUT /v1/platform/setup/:key; this model is the pure presenter.
//
// Pure and deterministic — no I/O, no framework. Any SSR/browser view can render it.

import type { SetupStatus, SetupGroup, ItemState } from '../../../packages/tenant/src/index';

/** What this screen is given: the tenant's setup status, injected by the store box. */
export interface SetupPorts {
  status(): SetupStatus;
}

export interface SetupConfig {
  readonly tenantId: string;
  /** Who is looking. `null` = the box was not told, so nothing may be changed here. */
  readonly userId: string | null;
}

export interface SetupScreenItem {
  readonly key: string;
  readonly label: string;
  readonly question: string;
  readonly required: boolean;
  readonly state: ItemState;
  /** The value in force — the tenant's answer, or the safe default. */
  readonly value: unknown;
  readonly isDefault: boolean;
}

export interface SetupGroupView {
  readonly group: SetupGroup;
  readonly items: readonly SetupScreenItem[];
}

export interface SetupBlocker {
  readonly key: string;
  readonly question: string;
}

export interface SetupHeadline {
  /** True when no required setting is still missing: the store can open. */
  readonly complete: boolean;
  readonly answered: number;
  readonly total: number;
  readonly progressBp: number;
  /** The required settings still missing — what stops the store opening. */
  readonly blocking: readonly SetupBlocker[];
  /** A plain sentence the screen can show as-is (no jargon). */
  readonly sentence: string;
}

export interface SetupSession {
  /** One-line state: can the store open, how far along, and what is still needed. */
  headline(): SetupHeadline;
  /** Every setting, grouped by how much attention it needs, in a stable order. */
  groups(): readonly SetupGroupView[];
  /**
   * Whether the person at this desk may change a setting. `false` when the box was not told who is
   * looking — a change to how the whole store trades carries a name. Editing is also
   * permission-gated on the server (platform.setup.write); this is the screen's own guard.
   */
  canEdit(): boolean;
}

/** Give-now first (the ones that most need a person), then defaults to check, then settled. */
const GROUP_ORDER: readonly SetupGroup[] = ['give_now', 'check_default', 'already_set'];

export function createSetupSession(config: SetupConfig, ports: SetupPorts): SetupSession {
  const toScreenItem = (i: SetupStatus['items'][number]): SetupScreenItem => ({
    key: i.key, label: i.label, question: i.question, required: i.required,
    state: i.state, value: i.value, isDefault: i.isDefault,
  });

  return {
    headline: () => {
      const status = ports.status();
      const blocking: SetupBlocker[] = status.blocking.map((key) => ({
        key,
        question: status.items.find((i) => i.key === key)?.question ?? key,
      }));
      const sentence = status.complete
        ? `Setup is complete — the store can open. ${status.answered} of ${status.total} settings chosen; the rest run on safe defaults you can change any time.`
        : `${blocking.length} setting${blocking.length === 1 ? '' : 's'} still needed before the store can open. Everything else runs on a safe default.`;
      return {
        complete: status.complete,
        answered: status.answered,
        total: status.total,
        progressBp: status.progressBp,
        blocking,
        sentence,
      };
    },

    groups: () => {
      const status = ports.status();
      const views: SetupGroupView[] = [];
      for (const group of GROUP_ORDER) {
        const items = status.items.filter((i) => i.group === group).map(toScreenItem);
        if (items.length > 0) views.push({ group, items });
      }
      return views;
    },

    canEdit: () => config.userId !== null,
  };
}
