// Container entry point for the store edge. Three lines on purpose — everything it does is in
// `main.ts`, which is exported so a test can start it exactly as the container does.

import { startEdge } from './main';
import { runTillPinCommand } from './till-pin-command';

// The administrator's till-PIN command shares this entry (ADR-0020 §2): `node start.js till-pin --user … --by "…"`.
if (process.argv[2] === 'till-pin') {
  const result = runTillPinCommand(process.argv.slice(3), process.env);
  for (const line of result.lines) (result.ok ? process.stdout : process.stderr).write(`${line}\n`);
  process.exit(result.ok ? 0 : 2);
}

const edge = await startEdge();
if (edge !== undefined) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // Drain briefly, then go. Nothing is lost by stopping mid-drain: an unacknowledged item stays
    // pending in the outbox, which is the whole reason there is one.
    process.on(signal, () => { void edge.stop().then(() => process.exit(0)); });
  }
}
