// A fetch that keeps the program alive until it has an answer (owner setup on the store PC, 5 Nov 2026).
//
// Why: the one-shot owner tools (`store-computer up`, `owner-setup`, `migration-slice`, `standup-check`) asked with
// `fetch(url, { signal: AbortSignal.timeout(ms) })`. That timer does NOT keep Node running, and while the store
// computer's API was still starting behind Docker Desktop on Windows, nothing else did either: Node saw an empty event
// loop, gave up on the waiting `await` and ended with "Detected unsettled top-level await" (exit code 13) in the middle
// of "Waiting for the API to say it is ready". Here the timeout is an ordinary timer, held until the whole answer,
// body included, has been read — then cleared, so a finished tool still ends at once. A slow or silent API now gives
// the tool's own words ("NOT READY", "Could not reach …") instead of a crash.

/** The time out a held fetch raises — named, so a caller can say "did not answer within …". */
export class HeldFetchTimeout extends Error {
  constructor(url, ms) {
    super(`no answer from ${url} within ${Math.round(ms / 1000)} seconds`);
    this.name = 'TimeoutError';
  }
}

/**
 * `fetch(url, init)`, with a time limit held by a normal timer for as long as the request AND the reading of its body
 * take. Returns a Response whose body has already been read in full (so `.json()` / `.text()` are safe afterwards).
 */
export async function heldFetch(url, init = {}, ms = 30_000, deps = { fetch: globalThis.fetch }) {
  const controller = new AbortController();
  let timer;
  // The timer both keeps Node alive and ENDS the wait: even an answer that never settles (whatever the network or a
  // port proxy does with the connection) becomes a named time-out, never a silent exit.
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new HeldFetchTimeout(String(url), ms);
      controller.abort(e);
      reject(e);
    }, ms);
  });
  const answer = (async () => {
    const res = await deps.fetch(url, { ...init, signal: controller.signal });
    const body = await res.arrayBuffer();
    return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  })();
  answer.catch(() => { /* the race below reports it */ });
  try {
    return await Promise.race([answer, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
