// Container entry point for the store edge. Three lines on purpose — everything it does is in
// `main.ts`, which is exported so a test can start it exactly as the container does.

import { startEdge } from './main';

const edge = await startEdge();
if (edge !== undefined) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // Drain briefly, then go. Nothing is lost by stopping mid-drain: an unacknowledged item stays
    // pending in the outbox, which is the whole reason there is one.
    process.on(signal, () => { void edge.stop().then(() => process.exit(0)); });
  }
}
