// D14 / M32 round 10 — the SSRF guard for outbound webhooks (P-04 secure by design · §30.1).
//
// A partner subscription names a URL head office will POST business events to. Without a guard, anyone with setup
// rights could point it at head office's own network — the database, the cloud metadata service that hands out
// credentials, a router's admin page — and head office would send signed requests there on a timer. So a destination
// must resolve ONLY to public internet addresses:
//
//   • refused: loopback, private (RFC 1918), carrier-grade NAT, link-local (incl. the 169.254.169.254 metadata
//     service), unspecified, multicast, broadcast, reserved, documentation/benchmark ranges, IPv6 unique-local,
//     link-local, site-local, multicast, and IPv4 addresses embedded in IPv6 (mapped, NAT64, 6to4) when the embedded
//     address is itself not public; host names `localhost`, `*.localhost`, `metadata`, `metadata.google.internal`,
//     `*.internal`, `*.local`; a URL carrying a user name or password;
//   • checked when the subscription is made AND again before every send — DNS can change after the subscription was
//     approved (rebinding), so a destination that has turned private is not sent to; the send is dead-lettered, said;
//   • a name that does not resolve is refused (it cannot be shown to be public).
//
// The vetted address is handed to the transport, so a real HTTPS transport connects to exactly the address that was
// checked (no second lookup between the check and the connection).

import { isIP } from 'node:net';

/** Resolve a host name to every address it has (A and AAAA). Rejects or returns [] when it does not resolve. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

const v4ToInt = (ip: string): number => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inV4 = (n: number, base: string, bits: number): boolean => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
};

const V4_BLOCKED: readonly [string, number, string][] = [
  ['0.0.0.0', 8, 'this network / unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata lives here)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / broadcast'],
];

function v4Reason(ip: string): string | undefined {
  const n = v4ToInt(ip);
  for (const [base, bits, why] of V4_BLOCKED) if (inV4(n, base, bits)) return why;
  return undefined;
}

/** The eight 16-bit groups of an IPv6 address (with any trailing dotted IPv4 folded in). */
function v6Groups(ip: string): number[] {
  let s = ip.split('%')[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted !== null) {
    const n = v4ToInt(dotted[1]!);
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') as [string, string] : [s, undefined];
  const h = head === '' ? [] : head.split(':').map((g) => parseInt(g, 16));
  if (tail === undefined) return h;
  const t = tail === '' ? [] : tail.split(':').map((g) => parseInt(g, 16));
  return [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
}

function v6Reason(ip: string): string | undefined {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return 'not a readable address';
  const embedded = (hi: number, lo: number): string => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judged as the IPv4 address they carry.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const r = v4Reason(embedded(g[6]!, g[7]!));
    return r === undefined ? undefined : `IPv4 ${r} inside IPv6`;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const r = v4Reason(embedded(g[6]!, g[7]!));
    return r === undefined ? undefined : `IPv4 ${r} behind NAT64`;
  }
  if (g[0] === 0x2002) {
    const r = v4Reason(embedded(g[1]!, g[2]!));
    return r === undefined ? undefined : `IPv4 ${r} inside 6to4`;
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique-local (private)';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return 'discard-only';
  if (g[0] === 0x2001 && g[1]! < 0x0200) return 'IETF special-purpose';
  return undefined;
}

/** Why one address is not a public internet address; undefined when it is. */
export function nonPublicAddressReason(address: string): string | undefined {
  const kind = isIP(address);
  if (kind === 4) return v4Reason(address);
  if (kind === 6) return v6Reason(address);
  return 'not an IP address';
}

const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal)$|\.(localhost|internal|local)$/;

export type DestinationVerdict =
  | { readonly ok: true; readonly hostname: string; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly hostname: string; readonly why: string };

/** Judge a webhook URL: every address its host resolves to must be public. Never throws. */
export async function judgeDestination(url: string, resolve: ResolveHost): Promise<DestinationVerdict> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, hostname: '', why: 'it is not a URL' }; }
  const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (u.username !== '' || u.password !== '') return { ok: false, hostname, why: 'it carries a user name or password in the address' };
  if (BLOCKED_NAMES.test(hostname)) return { ok: false, hostname, why: `${hostname} names a local or internal machine` };
  let addresses: readonly string[];
  if (isIP(hostname) !== 0) addresses = [hostname];
  else {
    try { addresses = await resolve(hostname); } catch { addresses = []; }
    if (addresses.length === 0) return { ok: false, hostname, why: `${hostname} does not resolve, so it cannot be shown to be a public address` };
  }
  for (const a of addresses) {
    const why = nonPublicAddressReason(a);
    if (why !== undefined) return { ok: false, hostname, why: `${hostname} resolves to ${a} (${why}) — not a public internet address` };
  }
  return { ok: true, hostname, addresses };
}

/** The production resolver: the operating system's own lookup of every A and AAAA address. */
export const systemResolveHost: ResolveHost = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);
};
