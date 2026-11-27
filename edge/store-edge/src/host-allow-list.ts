// Audit 27 Nov 2026 item 6 — which names the store computer's sockets answer to (DNS rebinding).
//
// A web page on `evil.example` can have its name re-pointed to 127.0.0.1 after it has loaded. To the browser on the till
// the page and the store computer's socket are then the SAME origin: a GET carries no Origin header and the page reads
// the answer. Binding to 127.0.0.1 does not stop it, because the browser making the call is on this computer. What the
// page cannot change is the name it asked for — the `Host` header still says `evil.example`. So each socket answers only
// the names it is really reached by, and refuses everything else, before anything is read or written:
//
//   • the lane socket (`lane-server.ts`): the loopback names only — it is bound to 127.0.0.1 and reached only by the
//     till's own browser on this PC and, in the hosted demo, by the relay inside the same container (ADR-0004);
//   • the screen socket (`screen-server.ts`): the loopback names, the address it was told to bind (`EDGE_SCREEN_HOST`)
//     and the names the deployment configured (`EDGE_ALLOWED_HOSTS` — the hosted copy's public name, ADR-0018);
//   • the handheld door (`device-server.ts`): the loopback names, the shop-network addresses its certificate was made
//     for (the handhelds reach it by the store PC's address on the wifi, ADR-0030) and the configured names.
//
// The OB-840 remote door is not held to this: it answers only a request carrying the owner's signed relay token, which a
// rebinding page does not have.

/** The loopback names: this computer, by any of its own names. Any port. */
export const LOOPBACK_HOST_NAMES: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/** The words for a refused name, in the answer of every socket. */
export const NOT_THIS_COMPUTER = 'Refused: this request named an address that is not this store computer, so nothing was read or changed. Open the page by this computer\'s own address.';

/** The machine-readable reason, beside the words. */
export const NOT_THIS_COMPUTER_CODE = 'not_this_computers_address';

/**
 * The name in a `Host` header (or an allow-list entry), lower case, without port, brackets, scheme or trailing dot;
 * null when it cannot be read. `[::1]:8095` → `::1`; `Shop.Example:443` → `shop.example`; `https://a.b` → `a.b`.
 */
export function hostNameOf(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  try {
    const name = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    return bare === '' ? null : bare;
  } catch { return null; }
}

/** `EDGE_ALLOWED_HOSTS` read: names or addresses separated by commas or spaces (the shape of `SRE_PUBLIC_HOST`). */
export function parseAllowedHosts(setting: string | undefined): readonly string[] {
  return (setting ?? '').split(/[\s,]+/).map((v) => hostNameOf(v)).filter((v): v is string => v !== null);
}

/**
 * The names a socket answers: the loopback names, the address it binds (unless that is every address — `0.0.0.0` / `::`
 * names no one), and the extra names given.
 */
export function allowedHostNames(input: { readonly bind?: string; readonly extra?: readonly string[] }): ReadonlySet<string> {
  const names = new Set(LOOPBACK_HOST_NAMES);
  const bind = hostNameOf(input.bind);
  if (bind !== null && bind !== '0.0.0.0' && bind !== '::') names.add(bind);
  for (const e of input.extra ?? []) { const n = hostNameOf(e); if (n !== null) names.add(n); }
  return names;
}

/** True when the request's `Host` header names one of `allowed`. A missing or unreadable Host is refused. */
export function hostAllowed(hostHeader: string | undefined, allowed: ReadonlySet<string>): boolean {
  const name = hostNameOf(hostHeader);
  return name !== null && allowed.has(name);
}
