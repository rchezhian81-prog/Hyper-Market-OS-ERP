// The canonical SCREEN STATES every data surface must handle — loading, ready, empty, error, pending,
// locked and recovery (owner directive item 3; design system §10/§27.1). A screen that only ever draws its
// happy path is the one that shows a blank where "nothing yet" should read as a sentence, or a spinner that
// never resolves into "we could not reach the store". Making the set a closed union means a `switch` over it
// is exhaustive (the compiler flags a forgotten state), and presenting each through the a11y layer means a
// state is never a bare colour — it always carries a word, an icon and a screen-reader announcement.
//
// Pure and deterministic: no I/O, no DOM, no clock.

import { presentStatus, type StatusPresentation, type Tone } from '../../a11y/src/signals';

/**
 * The seven states a data surface can be in. `pending` is a human-facing "awaiting an answer" (a maker-checker
 * approval, a portal acknowledgement) — deliberately distinct from `loading` (fetching what we already have)
 * and from `recovery` (reconciling something that went unknown). `locked` is a terminal, deliberate state (a
 * closed period, a filed return), NOT an error — colouring it red would tell a person something is wrong when
 * nothing is.
 */
export type ScreenState = 'loading' | 'ready' | 'empty' | 'error' | 'pending' | 'locked' | 'recovery';

export const SCREEN_STATES: readonly ScreenState[] = ['loading', 'ready', 'empty', 'error', 'pending', 'locked', 'recovery'];

/** The tone + icon each state carries. Tone drives colour; the icon is the shape that survives greyscale. */
const STATE_FACE: Readonly<Record<ScreenState, { readonly tone: Tone; readonly icon: string }>> = {
  loading: { tone: 'idle', icon: '⏳' },
  ready: { tone: 'ok', icon: '✓' },
  empty: { tone: 'idle', icon: '—' },
  error: { tone: 'error', icon: '✕' },
  pending: { tone: 'degraded', icon: '…' },
  locked: { tone: 'idle', icon: '🔒' },
  recovery: { tone: 'degraded', icon: '↻' },
};

/**
 * Present a screen state with the caller's own (already-translated) label and optional announcement. The tone
 * and icon come from the state; the words come from the screen's bilingual copy — so this stays language-
 * neutral and testable while still guaranteeing colour is never the only signal (it delegates to
 * `presentStatus`, which refuses a blank label or icon). `needsAttention` is forced true for `pending` and
 * `recovery` as well as `error`, because all three are states a person has to come back to.
 */
export function presentScreenState(input: {
  readonly state: ScreenState;
  readonly label: string;
  readonly announcement?: string;
}): StatusPresentation {
  const face = STATE_FACE[input.state];
  const needsAttention = input.state === 'error' || input.state === 'pending' || input.state === 'recovery';
  return presentStatus({
    tone: face.tone,
    label: input.label,
    icon: face.icon,
    ...(input.announcement !== undefined ? { announcement: input.announcement } : {}),
    needsAttention,
  });
}
