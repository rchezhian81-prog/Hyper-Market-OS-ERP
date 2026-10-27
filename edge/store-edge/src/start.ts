// Container entry point for the store edge. Three lines on purpose — everything it does is in
// `main.ts`, which is exported so a test can start it exactly as the container does.

import { startEdge } from './main';
import { readHiddenLine, runTillPinCommand } from './till-pin-command';
import { runDeviceAuthorityCommand } from './device-authority-command';

// The till-PIN command shares this entry (ADR-0020 §2): `node start.js till-pin --user … --by "…"` — the person then types
// their own new PIN at this keyboard, twice, hidden (round 4).
if (process.argv[2] === 'till-pin') {
  const result = await runTillPinCommand(process.argv.slice(3), process.env, {
    readSecret: (prompt) => readHiddenLine(process.stdin, process.stdout, prompt),
    say: (line) => { process.stdout.write(`${line}\n`); },
  });
  for (const line of result.lines) (result.ok ? process.stdout : process.stderr).write(`${line}\n`);
  process.exit(result.ok ? 0 : 2);
}

// OB-422: `node start.js device-authority` makes (at install) or checks the handheld door's lock on this computer.
if (process.argv[2] === 'device-authority') {
  const result = runDeviceAuthorityCommand(process.env);
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
