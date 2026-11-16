// How often a store computer asks head office for news — its catalogue pack among it (D-054 · OB-800 THE PLAN fix batch
// 4b · P-08). ONE place for both figures: the store computer's sync loop runs on them (edge/store-edge/src/main.ts), and
// the office page that sends a pack to the tills says in plain words how soon a store computer that is online takes it.
// A pass that moves nothing waits a little longer each time (15 s, 30 s, 60 s …) up to the ceiling; one that sends
// something starts again at the base. So a store computer that is online takes a new pack within the ceiling.

/** The gap after a pass that moved something. */
export const STORE_PULL_BASE_MS = 15_000;
/** The longest gap between two passes when nothing is getting through. Five minutes, not five hours. */
export const STORE_PULL_MAX_MS = 300_000;

/** The ceiling in whole minutes, as the office pages say it. */
export const storePullMaxMinutes = (): number => Math.ceil(STORE_PULL_MAX_MS / 60_000);
