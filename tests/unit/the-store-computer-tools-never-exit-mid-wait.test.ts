import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { heldFetch, HeldFetchTimeout } from '../../scripts/lib/held-fetch.mjs';

// Store PC, 5 Nov 2026 (OB-240 · OB-244 · P-08): `pnpm run store-computer -- up` started the database and the API, then
// died at "Waiting for the API to say it is ready…" with Node's "Detected unsettled top-level await" (exit code 13).
// The wait asked with `fetch(url, { signal: AbortSignal.timeout(5_000) })`, whose timer does not keep Node running —
// so an answer that did not come left an empty event loop, and Node ended the tool mid-wait instead of letting it say
// NOT READY. heldFetch holds a normal timer until the answer (body included) is in, and ends the wait itself.

const LIB = pathToFileURL(resolve('scripts/lib')).href;
const runChild = (code: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'held-fetch-'));
  const file = join(dir, 'child.mjs');
  writeFileSync(file, code);
  return spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 });
};
// An answer that never settles and holds nothing open — what the store PC's wait met.
const NEVER = '() => new Promise(() => {})';

describe('the store computer tools never exit in the middle of a wait (exit code 13)', () => {
  it('the old way — AbortSignal.timeout over an answer that never comes — ends the program mid-wait with exit 13', () => {
    const r = runChild(`
      import { waitReady } from '${LIB}/store-computer.mjs';
      const never = ${NEVER};
      const deps = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        fetch: (url) => Promise.race([never(), new Promise((_, rej) => { AbortSignal.timeout(500).addEventListener('abort', () => rej(new Error('timeout'))); })]) };
      const ok = await waitReady(deps, 1, 2_000);
      console.log('WAIT ENDED ' + ok);`);
    expect(r.status).toBe(13);
    expect(r.stdout).not.toContain('WAIT ENDED');
  });

  it('with heldFetch the same wait runs to its end and says it is not ready — no crash', () => {
    const r = runChild(`
      import { waitReady } from '${LIB}/store-computer.mjs';
      import { heldFetch } from '${LIB}/held-fetch.mjs';
      const never = ${NEVER};
      const deps = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        fetch: (url) => heldFetch(url, {}, 500, { fetch: never }) };
      const ok = await waitReady(deps, 1, 2_000);
      console.log('WAIT ENDED ' + ok);`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('WAIT ENDED false');
  });

  it('the store computer tool itself waits with heldFetch (its default fetch keeps Node alive)', () => {
    const r = runChild(`
      import { defaultDeps } from '${LIB}/store-computer.mjs';
      const res = await defaultDeps().fetch('http://127.0.0.1:9/readyz').then(() => 'answered', (e) => 'gave up');
      console.log('DONE ' + res);`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('DONE gave up');
  });

  it('a timely answer is returned whole, its body readable, and the timer cleared (a finished tool ends at once)', async () => {
    const started = Date.now();
    const res = await heldFetch('http://x/readyz', {}, 20_000, { fetch: async () => new Response('{"ready":true}', { status: 200 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('an answer that never comes is a named time-out, never a silent hang', async () => {
    await expect(heldFetch('http://x/readyz', {}, 200, { fetch: () => new Promise(() => {}) })).rejects.toBeInstanceOf(HeldFetchTimeout);
  });
});
