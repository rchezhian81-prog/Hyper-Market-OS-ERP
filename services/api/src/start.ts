// Container entry point. Nothing but the call — everything worth testing is in `main.ts`.
import { main } from './main';

void main().catch((e: unknown) => {
  process.stderr.write(`\nsre-api failed to start: ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exitCode = 1;
});
