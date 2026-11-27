// Audit 27 Nov 2026 item 4 — a request whose address cannot be read.
//
// `new URL(req.url, base)` throws for a request line such as `GET //` ("//" reads as a host with no name). Each of the store
// computer's sockets (lane, screens, handheld door) asks here first and answers such a request 400 in these words, so the
// caller learns what was wrong and the process never meets the throw.

/** The words for a request whose address cannot be read. */
export const UNREADABLE_ADDRESS = 'The address in this request could not be read. Nothing was changed.';

/** True when the request's address can be read; `GET //` cannot. */
export function readableAddress(raw: string | undefined): boolean {
  try { void new URL(raw ?? '/', 'http://box'); return true; } catch { return false; }
}
