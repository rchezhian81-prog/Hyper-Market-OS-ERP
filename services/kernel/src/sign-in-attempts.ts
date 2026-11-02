// D13-FR-06 (W3) — the office sign-in attempts head office KEEPS: each failed office sign-in (a token presented to the
// API that was not believed) and each lockout it trips (the source address locked by the backoff in `rate-limit.ts`).
//
// The lockout itself stays in memory, exactly as before — it is the fast path and must not wait on a database. What is
// new is the RECORD: the pipeline hands each failed try and each lockout to this port, and head office's adapter writes it
// append-only on PostgreSQL, so the security report reads real figures that survive a restart (P-08).
//
// What a record holds, and what it never holds:
//   • when, the outcome ('failed' or 'locked_out'), the path that was asked for;
//   • WHO WAS TRIED — the shop and the person the token CLAIMED, read from its payload without believing it (the token
//     was refused, so these are claims, and named as claims). Nothing readable → null;
//   • the source as an ADDRESS CLASS (loopback / private / public / unknown) and its network with the last part masked
//     (203.0.113.x) — enough to see repeated tries from one place, never the full address;
//   • NEVER the token, a password, a PIN, a code or any other secret (hard rule #4).
//
// Pure: no clock (the caller passes `at`), no I/O.

/** One kept sign-in attempt. */
export interface OfficeSignInAttempt {
  readonly at: string;
  readonly outcome: 'failed' | 'locked_out';
  /** The shop the refused token claimed (a UUID), or null when none could be read. A claim, never believed. */
  readonly claimedTenantId: string | null;
  /** The person the refused token claimed (`sre_user_id`, else `sub`), or null. A claim, never believed. */
  readonly claimedUserId: string | null;
  readonly sourceClass: 'loopback' | 'private' | 'public' | 'unknown';
  /** The source's network with its last part masked ("203.0.113.x", "2001:db8:1:2:x"), or "unknown". */
  readonly sourceNetwork: string;
  readonly path: string;
  /** For a lockout: how long the source is locked for, in whole seconds. */
  readonly lockedForSeconds?: number;
  /** Ties the record to the request's audit line and log. */
  readonly traceId: string;
}

/** Where the pipeline hands each attempt. It must never throw into the request; the pipeline guards it anyway. */
export interface SignInAttemptLog {
  record(attempt: OfficeSignInAttempt): void | Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A claim made safe to keep: a short string of plain characters, or null. */
function cleanClaim(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^A-Za-z0-9._@:+-]/g, '').slice(0, 120);
  return s === '' ? null : s;
}

/**
 * The shop and person a token CLAIMS, read from its payload WITHOUT verifying it. Only the two claims are read; the
 * token itself is never returned or kept.
 */
export function claimedIdentityOf(token: string): { readonly tenantId: string | null; readonly userId: string | null } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length > 8_192) return { tenantId: null, userId: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (payload === null || typeof payload !== 'object') return { tenantId: null, userId: null };
    const t = payload['tenant_id'];
    return {
      tenantId: typeof t === 'string' && UUID.test(t.trim()) ? t.trim().toLowerCase() : null,
      userId: cleanClaim(payload['sre_user_id']) ?? cleanClaim(payload['sub']),
    };
  } catch {
    return { tenantId: null, userId: null };
  }
}

/** The source address as a class and a masked network — never the whole address. */
export function sourceOf(clientIp: string | undefined): { readonly sourceClass: OfficeSignInAttempt['sourceClass']; readonly sourceNetwork: string } {
  const ip = (clientIp ?? '').trim().replace(/^::ffff:/i, '');
  if (ip === '' || ip === 'unknown') return { sourceClass: 'unknown', sourceNetwork: 'unknown' };
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const sourceClass = a === 127 ? 'loopback'
      : a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ? 'private' : 'public';
    return { sourceClass, sourceNetwork: `${v4[1]}.${v4[2]}.${v4[3]}.x` };
  }
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return { sourceClass: 'loopback', sourceNetwork: '::1' };
    const sourceClass = /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) ? 'private' : 'public';
    const groups = lower.split(':').filter((g) => /^[0-9a-f]{1,4}$/.test(g)).slice(0, 4);
    return { sourceClass, sourceNetwork: `${groups.join(':')}:x` };
  }
  return { sourceClass: 'unknown', sourceNetwork: 'unknown' };
}

/** Build the record the pipeline hands on. */
export function officeSignInAttempt(input: {
  readonly at: string; readonly outcome: OfficeSignInAttempt['outcome']; readonly token: string; readonly clientIp?: string;
  readonly path: string; readonly traceId: string; readonly lockedForSeconds?: number;
}): OfficeSignInAttempt {
  const claimed = claimedIdentityOf(input.token);
  return {
    at: input.at, outcome: input.outcome, claimedTenantId: claimed.tenantId, claimedUserId: claimed.userId,
    ...sourceOf(input.clientIp), path: input.path.slice(0, 200), traceId: input.traceId.slice(0, 80),
    ...(input.lockedForSeconds === undefined ? {} : { lockedForSeconds: input.lockedForSeconds }),
  };
}
