// THE STORE PC REACHES HEAD OFFICE AS THE PERSON SIGNED IN — OB-388 (owner, 26 Oct 2026, in writing) · ADR-0029 ·
// ADR-0019 · M02-FR-01 · SEC-02/03 · P-01 · P-04 · P-08 · hard rules #1, #4.
//
// Before this, the store computer served the office pages head office answers (OB-380) but dropped every `/v1` call they
// made, so in the shop each page said "head office cannot be reached" even with the line up. Now, when the box is told
// where head office's sign-in is (`EDGE_HEAD_OFFICE_SIGN_IN_ISSUER`) and where its API is (`CLOUD_API_URL`):
//
//   • a person who opens an office page is sent through the PRODUCT'S OWN sign-in service (services/identity/src/sign-in.ts,
//     run here in the box's process): authorisation code + PKCE (S256), a one-time state and nonce, the code exchanged by
//     the box, the token believed only through head office's own checker (`verifyToken`, RS256 against the identity
//     server's published keys, pinned to THIS shop's tenant). The identity server asks for their own password and their
//     second step on every sign-in (`prompt=login`) — a shared PC never hands the next person the last one's session;
//   • a sign-in without a second step (`amr` showing a factor known AND one held) is refused and ended at once;
//   • the session is held HERE, in memory: the browser keeps only a random id in an HttpOnly, Secure, SameSite=Strict
//     cookie; the access token is renewed with the refresh token before it runs out, and a refusal at renewal (signed out
//     elsewhere, a leaver switched off, locked) ends it; ten hours at most; Sign out ends it;
//   • every `/v1` call a page makes is carried to head office with THAT person's own current token — never the store
//     computer's machine credential (`CLOUD_API_TOKEN`), never a PIN. Head office answers as it would anywhere else: its own
//     permission check, branch scope and step-up. A 401 from head office (a revoked token — a leaver, "sign me out
//     everywhere") ends the session here too;
//   • when head office or the internet is down, the call fails as a lost link (the socket is closed — never a made-up
//     answer), so each page says in its own words that head office cannot be reached (P-08), and the sign-in page says so
//     plainly before sending anybody anywhere.
//
// Nothing here is on the till's sale path (hard rule #1): the lane socket never imports this file, and a sale commits on
// the box's disk whatever head office or the identity server is doing. No token, code, session id or address is ever
// written to the box's log or disk — the log names the event and the person, nothing else.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSignInHandler, cookieOf, SESSION_COOKIE, type SignInResponse } from '../../../services/identity/src/sign-in';
import { verifyToken, type TokenPolicy } from '../../../services/identity/src/token';
import { jwksKeyring, type JwksKeyring } from '../../../services/identity/src/jwks';
import type { PublicKeyring } from '../../../services/identity/src/token';

/** Where head office's sign-in and API are, and who this box is. Every value comes from the box's settings. */
export interface HeadOfficeLinkSettings {
  /** The identity server realm's address — the `iss` every token must carry, and where the browser is sent. */
  readonly issuer: string;
  /** Head office's API (`CLOUD_API_URL`), where each `/v1` call is carried. */
  readonly apiBase: string;
  /** This product's public client at the identity server (PKCE binds each sign-in; no client secret exists). */
  readonly clientId: string;
  /** The API's name in the tokens. */
  readonly audience: string;
  /** The ONE shop this box is (`EDGE_TENANT_ID`): a sign-in naming any other shop is refused. */
  readonly tenantId: string;
  /** This PC's own screen address (`http://127.0.0.1:<port>`): the sign-in returns to `${origin}/login/callback`. */
  readonly origin: string;
  /** The longest a token may be valid for, whatever the issuer wrote. */
  readonly maxLifetimeSeconds?: number;
}

export interface HeadOfficeLinkDeps {
  readonly settings: HeadOfficeLinkSettings;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
  /** For the box's log: the event and the person. Never a token, a code, a session id or an address. */
  readonly audit: (line: { readonly event: string; readonly userId?: string; readonly why?: string }) => void;
  /** The identity server's published keys (default: fetched from the issuer). A test hands in its own. */
  readonly keyring?: PublicKeyring;
  /** How long one `/v1` call may take before it is treated as a lost link (default 20 s). */
  readonly callTimeoutMs?: number;
}

/** The head-office session a request carries: whose it is and their CURRENT token (never shown to the browser). */
export interface HeadOfficeSession { readonly userId: string; readonly bearer: string }

export type HeadOfficeCallRefusal = 'head_office_sign_in_needed' | 'office_sign_in_needed' | 'not_the_signed_in_person' | 'not_at_this_store' | 'not_from_this_screen' | 'too_large';

/** What a page is told, in head office's own refusal shape (`error.code`, `error.whatHappened`), in both languages. */
export const HEAD_OFFICE_CALL_WORDS: Readonly<Record<HeadOfficeCallRefusal, { readonly en: string; readonly ta: string }>> = Object.freeze({
  head_office_sign_in_needed: {
    en: 'Sign in to head office on this computer first, with your own head-office login and second step: open the page again. Nothing was sent.',
    ta: 'முதலில் இந்தக் கணினியில் உங்கள் சொந்தத் தலைமை அலுவலக உள்நுழைவாலும் இரண்டாம் படியாலும் தலைமை அலுவலகத்தில் உள்நுழையுங்கள்: பக்கத்தை மீண்டும் திறக்கவும். எதுவும் அனுப்பப்படவில்லை.',
  },
  office_sign_in_needed: {
    en: 'Your office sign-in on this computer has ended. Enter your PIN again. Nothing was sent.',
    ta: 'இந்தக் கணினியில் உங்கள் அலுவலக உள்நுழைவு முடிந்தது. மீண்டும் உங்கள் PIN-ஐ உள்ளிடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
  },
  not_the_signed_in_person: {
    en: 'The person signed in to head office is not the person signed in to the office screens. Sign out and sign in again as yourself. Nothing was sent.',
    ta: 'தலைமை அலுவலகத்தில் உள்நுழைந்தவரும் அலுவலகத் திரைகளில் உள்நுழைந்தவரும் ஒரே நபர் அல்ல. வெளியேறி, நீங்களாகவே மீண்டும் உள்நுழையுங்கள். எதுவும் அனுப்பப்படவில்லை.',
  },
  not_at_this_store: {
    en: 'You do not work at this store in this store computer\'s setup, so it will not carry your head-office session. Nothing was sent.',
    ta: 'இந்தக் கடை கணினியின் அமைப்பில் நீங்கள் இந்தக் கடையில் பணிபுரிபவராக இல்லை; அதனால் உங்கள் தலைமை அலுவலக அமர்வை இது கொண்டு செல்லாது. எதுவும் அனுப்பப்படவில்லை.',
  },
  not_from_this_screen: {
    en: 'Refused: this did not come from a page this store computer served. Nothing was sent.',
    ta: 'மறுக்கப்பட்டது: இது இந்தக் கடை கணினி வழங்கிய பக்கத்திலிருந்து வரவில்லை. எதுவும் அனுப்பப்படவில்லை.',
  },
  too_large: {
    en: 'That is too large to send to head office from here. Nothing was sent.',
    ta: 'இங்கிருந்து தலைமை அலுவலகத்துக்கு அனுப்ப இது மிகப் பெரியது. எதுவும் அனுப்பப்படவில்லை.',
  },
});

/** The sign-in's own refusals, as the box's page says them (English and Tamil together). */
export type HeadOfficeSignInProblem = 'unreachable' | 'not_confirmed' | 'second_step_needed' | 'expired' | 'not_the_same_person';
export const HEAD_OFFICE_SIGN_IN_WORDS: Readonly<Record<HeadOfficeSignInProblem, { readonly en: string; readonly ta: string }>> = Object.freeze({
  unreachable: {
    en: 'Head office cannot be reached from this computer right now, so nobody can sign in to it here. The till keeps selling. The office pages that need head office will open once the line is back.',
    ta: 'இப்போது இந்தக் கணினியிலிருந்து தலைமை அலுவலகத்தை அடைய முடியவில்லை; அதனால் இங்கு யாரும் அதில் உள்நுழைய முடியாது. விற்பனை முனையம் விற்பனையைத் தொடர்கிறது. இணைப்பு திரும்பியதும் தலைமை அலுவலகம் தேவைப்படும் அலுவலகப் பக்கங்கள் திறக்கும்.',
  },
  not_confirmed: {
    en: 'Head office did not confirm this sign-in for this shop. Nothing was changed. Start again with your own head-office login.',
    ta: 'இந்தக் கடைக்கான இந்த உள்நுழைவைத் தலைமை அலுவலகம் உறுதிப்படுத்தவில்லை. எதுவும் மாற்றப்படவில்லை. உங்கள் சொந்தத் தலைமை அலுவலக உள்நுழைவுடன் மீண்டும் தொடங்குங்கள்.',
  },
  second_step_needed: {
    en: 'Head office needs your second step (the code from your phone) as well as your password. This sign-in did not have it, so it was ended. Start again.',
    ta: 'தலைமை அலுவலகத்துக்கு உங்கள் கடவுச்சொல்லுடன் இரண்டாம் படியும் (உங்கள் தொலைபேசியிலுள்ள குறியீடு) தேவை. இந்த உள்நுழைவில் அது இல்லை; அதனால் அது முடிக்கப்பட்டது. மீண்டும் தொடங்குங்கள்.',
  },
  expired: {
    en: 'This sign-in link was already used or is too old. Start again.',
    ta: 'இந்த உள்நுழைவு இணைப்பு ஏற்கனவே பயன்படுத்தப்பட்டது அல்லது மிகப் பழையது. மீண்டும் தொடங்குங்கள்.',
  },
  not_the_same_person: {
    en: 'The person signed in to head office on this computer is not the person signed in to the office screens. Sign out, then sign in again as yourself — both times.',
    ta: 'இந்தக் கணினியில் தலைமை அலுவலகத்தில் உள்நுழைந்தவர் அலுவலகத் திரைகளில் உள்நுழைந்தவர் அல்ல. வெளியேறி, இரண்டிலும் நீங்களாகவே மீண்டும் உள்நுழையுங்கள்.',
  },
});

/** The most a page may send head office in one call through this box (a statement upload is well inside it). */
export const HEAD_OFFICE_CALL_MAX_BYTES = 8 * 1024 * 1024;
/** The request headers a page's call keeps on its way to head office. Never a cookie, never who-is-this headers. */
const PASS_REQUEST = ['accept', 'content-type', 'idempotency-key', 'if-match', 'if-none-match', 'x-request-id'] as const;
/** The answer headers a page gets back. Never a cookie. */
const PASS_RESPONSE = ['content-type', 'content-disposition', 'cache-control', 'etag', 'retry-after', 'x-request-id', 'idempotency-replayed'] as const;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE_STYLE = [
  'body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;background:#f4f6f8;color:#14202b}',
  'main{max-width:34rem;margin:4rem auto;background:#fff;border:1px solid #c9d2da;border-radius:8px;padding:2rem}',
  'h1{font-size:1.5rem;margin:0 0 .25rem}', 'p.ta,h1 .ta{display:block;font-size:1.05rem;color:#33424f;margin-top:.25rem}',
  'a.go,button{display:inline-flex;align-items:center;min-height:48px;min-width:48px;padding:.6rem 1.2rem;border:0;border-radius:4px;background:#0b5394;color:#fff;font-size:1.05rem;text-decoration:none;margin-top:1rem;cursor:pointer}',
  '.problem{border-left:4px solid #b3261e;background:#fdecea;padding:.75rem;margin-top:1rem}',
].join('');

/** The box's own page for the head-office sign-in: what happened, in both languages, and the one way on. */
export function headOfficeSignInPage(input: { readonly problem: HeadOfficeSignInProblem; readonly next: string }): string {
  const w = HEAD_OFFICE_SIGN_IN_WORDS[input.problem];
  const again = input.problem === 'not_the_same_person'
    ? '<form method="post" action="/office/sign-out" id="ho-sign-out"><button type="submit">Sign out <span lang="ta">· வெளியேறு</span></button></form>'
    : input.problem === 'unreachable'
    ? `<a class="go" id="ho-back" href="/manager/">Back to the store computer's own screens <span lang="ta">· கடை கணினியின் சொந்தத் திரைகளுக்குத் திரும்பு</span></a>`
    : `<a class="go" id="ho-again" href="/login/?next=${encodeURIComponent(input.next)}">Sign in to head office <span lang="ta">· தலைமை அலுவலகத்தில் உள்நுழை</span></a>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Head office sign-in — store computer</title>', `<style>${PAGE_STYLE}</style></head><body><main>`,
    '<h1 id="ho-heading"><span lang="en">Head office sign-in</span><span lang="ta" class="ta">தலைமை அலுவலக உள்நுழைவு</span></h1>',
    `<div class="problem" role="alert" id="ho-problem" data-problem="${input.problem}"><p lang="en">${esc(w.en)}</p><p lang="ta" class="ta">${esc(w.ta)}</p></div>`,
    again, '</main></body></html>',
  ].join('');
}

/** The page the sign-in lands on: it sets the session and moves on from THIS page, so the strict cookie travels with it. */
function landingPage(next: string): string {
  const to = esc(next);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="refresh" content="0;url=${to}">`, '<title>Signed in to head office — store computer</title>',
    `<style>${PAGE_STYLE}</style></head><body><main>`,
    '<h1 id="ho-heading"><span lang="en">Signed in to head office</span><span lang="ta" class="ta">தலைமை அலுவலகத்தில் உள்நுழைந்தீர்கள்</span></h1>',
    `<a class="go" id="ho-continue" href="${to}">Continue <span lang="ta">· தொடர்க</span></a>`, '</main></body></html>',
  ].join('');
}

/** A session id from a Cookie header (the product's sign-in cookie), only when it is a plausible random id. */
function sessionCookieOf(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  const id = cookieOf({ cookie: raw });
  return id !== undefined && /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : undefined;
}

export interface HeadOfficeLink {
  /** Does this box serve the head-office sign-in at this path (`/login/`, `/login/callback`, `/login/logout`)? */
  isSignInPath(path: string): boolean;
  /** Answer a sign-in door. Writes the whole answer. A POST must already be known to come from a page this box served. */
  signInDoor(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The head-office session this request carries — renewed when it is about to run out — or null (none, ended, refused). */
  sessionOf(req: IncomingMessage): Promise<HeadOfficeSession | null>;
  /** End this request's head-office session here (office sign-out; a 401 from head office). */
  end(req: IncomingMessage): Promise<void>;
  /** Carry one `/v1` call to head office with the session's token. A lost link closes the socket (P-08). */
  carry(req: IncomingMessage, res: ServerResponse, session: HeadOfficeSession, body: Buffer | null): Promise<void>;
}

export function createHeadOfficeLink(deps: HeadOfficeLinkDeps): HeadOfficeLink {
  const { settings } = deps;
  const now = deps.now ?? (() => Date.now());
  const issuer = settings.issuer.replace(/\/+$/, '');
  const apiBase = settings.apiBase.replace(/\/+$/, '');
  const jwks: JwksKeyring | undefined = deps.keyring === undefined
    ? jwksKeyring({ url: `${issuer}/protocol/openid-connect/certs`, fetch: deps.fetch, onProblem: () => { deps.audit({ event: 'identity_server_keys_not_read' }); } })
    : undefined;
  const keyring: PublicKeyring = deps.keyring ?? jwks!;
  const policy: TokenPolicy = {
    algorithm: 'RS256', secret: '', keyring, subjectClaim: 'sre_user_id', issuer: settings.issuer, audience: settings.audience,
    tenantId: settings.tenantId, maxLifetimeSeconds: settings.maxLifetimeSeconds ?? 2_678_400,
  };
  // The handler's own audit line names the event, the person and why; the why can quote a network error, so only its
  // kind is kept — never an address (the box's log is read by people who need no head-office address).
  const audit = (line: Record<string, unknown>): void => {
    const why = typeof line['why'] === 'string' ? line['why'] : undefined;
    const kind = why === undefined ? undefined
      : /could not be reached/.test(why) ? 'identity server unreachable'
        : /answered \d+/.test(why) ? (/answered (\d+)/.exec(why)![0]).replace('answered', 'identity server answered')
          : /not believed \(([a-z_]+)\)/.test(why) ? `token not believed (${/not believed \(([a-z_]+)\)/.exec(why)![1]})`
            : /nonce/.test(why) ? 'nonce does not match' : /state/.test(why) ? 'unknown or used state' : 'refused';
    deps.audit({ event: String(line['event'] ?? 'sign_in'), ...(typeof line['userId'] === 'string' ? { userId: line['userId'] } : {}), ...(kind === undefined ? {} : { why: kind }) });
  };
  const handle = createSignInHandler({
    settings: { issuer: settings.issuer, internalIssuer: settings.issuer, clientId: settings.clientId, origin: settings.origin, alwaysAskForCredentials: true },
    policy, fetch: deps.fetch, now, audit,
  });
  const headersOf = (req: IncomingMessage): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
    return out;
  };
  const write = (res: ServerResponse, out: SignInResponse): void => { res.writeHead(out.status, { ...out.headers, 'x-frame-options': 'DENY' }).end(out.body); };
  const page = (res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', ...extra,
    }).end(html);
  };
  /** The identity server's keys are held (fetched now if this box has none yet — it may have started with the line down). */
  const keysReady = async (): Promise<boolean> => {
    if (jwks === undefined || jwks.size() > 0) return true;
    try { return (await jwks.refresh()) > 0; } catch { return false; }
  };
  /** Can the identity server be reached at all? Asked before anybody is sent there, so a line down is said, not a browser error. */
  const reachable = async (): Promise<boolean> => {
    try {
      const res = await deps.fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch { return false; }
  };
  const endSession = async (cookie: string): Promise<void> => {
    await handle({ method: 'POST', url: '/login/logout', headers: { cookie: `${SESSION_COOKIE}=${cookie}`, origin: settings.origin }, body: '' });
  };
  const end = async (req: IncomingMessage): Promise<void> => {
    const id = sessionCookieOf(req.headers['cookie']);
    if (id !== undefined) await endSession(id);
  };
  const current = async (cookie: string | undefined): Promise<HeadOfficeSession | null> => {
    if (cookie === undefined) return null;
    const out = await handle({ method: 'GET', url: '/login/verify-optional', headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, body: '' });
    const userId = out.headers['x-sre-user'];
    const bearer = out.headers['x-sre-bearer']?.replace(/^Bearer /, '');
    return userId === undefined || bearer === undefined ? null : { userId, bearer };
  };

  return {
    isSignInPath: (path) => path === '/login' || path === '/login/' || path === '/login/callback' || path === '/login/logout',

    async signInDoor(req, res) {
      const url = new URL(req.url ?? '/', 'http://box.invalid');
      // Where to go afterwards: a path on this box (the sign-in service refuses anything else); the office home by default.
      const next = url.searchParams.get('next') ?? '/manager/';
      if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login/')) {
        // P-08: never send a person to a sign-in page that cannot load — say so here, in the box's own words.
        if (!(await reachable()) || !(await keysReady())) {
          deps.audit({ event: 'head_office_sign_in_unreachable' });
          page(res, 503, headOfficeSignInPage({ problem: 'unreachable', next }));
          return;
        }
        write(res, await handle({ method: 'GET', url: `/login/?next=${encodeURIComponent(next)}`, headers: headersOf(req), body: '' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login/callback') {
        await keysReady();
        const out = await handle({ method: 'GET', url: req.url ?? '/login/callback', headers: headersOf(req), body: '' });
        if (out.status !== 303) {
          page(res, out.status, headOfficeSignInPage({ problem: out.status === 400 ? 'expired' : 'not_confirmed', next: '/manager/' }));
          return;
        }
        const setCookie = out.headers['set-cookie'] ?? '';
        const id = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)?.[1];
        const session = await current(id);
        // The second step: a sign-in that shows no factor held (a one-time code) as well as one known is ended at once.
        const verdict = session === null ? null : verifyToken(session.bearer, policy, now());
        if (id === undefined || session === null || verdict === null || !verdict.ok || !(verdict.principal?.amr ?? []).includes('mfa')) {
          if (id !== undefined) await endSession(id);
          deps.audit({ event: 'head_office_sign_in_refused', ...(session === null ? {} : { userId: session.userId }), why: 'no second step' });
          page(res, 401, headOfficeSignInPage({ problem: 'second_step_needed', next: '/manager/' }), { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
          return;
        }
        // The session cookie is SameSite=Strict, and the browser arrived here from the identity server's site: it would not
        // send the cookie on a redirect that continues that same trip. So the box answers with a page that moves on from
        // ITSELF — a navigation this site starts, which carries the cookie.
        page(res, 200, landingPage(out.headers['location'] ?? '/manager/'), { 'set-cookie': setCookie });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/logout') {
        // The screen socket has already checked the request came from a page it served (these pages send no referrer, so
        // the browser's Origin reads "null"); the sign-in service is told this PC's own origin.
        write(res, await handle({ method: 'POST', url: '/login/logout', headers: { ...headersOf(req), origin: settings.origin }, body: '' }));
        return;
      }
      page(res, 405, headOfficeSignInPage({ problem: 'expired', next }));
    },

    sessionOf: (req) => current(sessionCookieOf(req.headers['cookie'])),

    end,

    async carry(req, res, session, body) {
      const headers: Record<string, string> = { authorization: `Bearer ${session.bearer}` };
      for (const h of PASS_REQUEST) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      let answer: Response;
      try {
        answer = await deps.fetch(`${apiBase}${req.url ?? '/v1'}`, {
          method: req.method ?? 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(deps.callTimeoutMs ?? 20_000),
          ...(body === null || body.length === 0 ? {} : { body: new Uint8Array(body) }),
        });
      } catch {
        // P-08: head office or the line is down — the call fails as a lost link; the page says so in its own words.
        req.socket.destroy();
        return;
      }
      if (answer.status === 401) {
        // Head office no longer believes this person's token (revoked — a leaver, "sign me out everywhere" — or expired):
        // the session ends here too, so nothing keeps carrying it.
        await end(req);
        deps.audit({ event: 'head_office_ended_session', userId: session.userId });
      }
      const out: Record<string, string> = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      for (const h of PASS_RESPONSE) {
        const v = answer.headers.get(h);
        if (v !== null) out[h] = v;
      }
      if (out['cache-control'] === undefined) out['cache-control'] = 'no-store';
      let buf: Buffer;
      try { buf = Buffer.from(await answer.arrayBuffer()); } catch { req.socket.destroy(); return; }
      out['content-length'] = String(buf.length);
      res.writeHead(answer.status, out).end(buf);
    },
  };
}

/** The refusal a page reads for a `/v1` call this box would not carry — head office's own error shape. */
export function headOfficeCallRefusal(code: HeadOfficeCallRefusal): string {
  return JSON.stringify({ error: { code, whatHappened: HEAD_OFFICE_CALL_WORDS[code].en, whatHappenedTa: HEAD_OFFICE_CALL_WORDS[code].ta, wasItSaved: 'not_saved' } });
}

/**
 * The box's settings for the link, or why it is not on. Off unless BOTH the identity server and head office's API are
 * named; an address that is not https is refused unless it is this PC's own loopback (a test, or a tunnel on the PC).
 */
export function headOfficeLinkSettingsFrom(env: Readonly<Record<string, string | undefined>>): { readonly on: false; readonly why: string | null } | { readonly on: true; readonly settings: Omit<HeadOfficeLinkSettings, 'origin'> } {
  const issuer = env['EDGE_HEAD_OFFICE_SIGN_IN_ISSUER'];
  const apiBase = env['CLOUD_API_URL'];
  if (issuer === undefined || issuer.trim() === '') return { on: false, why: null };
  if (apiBase === undefined || apiBase.trim() === '') return { on: false, why: 'the head-office sign-in is named but head office\'s API (CLOUD_API_URL) is not' };
  const loopback = (u: string): boolean => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; } catch { return false; } };
  for (const [name, value] of [['EDGE_HEAD_OFFICE_SIGN_IN_ISSUER', issuer], ['CLOUD_API_URL', apiBase]] as const) {
    if (!/^https:\/\//.test(value) && !(/^http:\/\//.test(value) && loopback(value))) return { on: false, why: `${name} must be an https address — a sign-in over plain http can be read on the way` };
  }
  const tenantId = env['EDGE_TENANT_ID'];
  if (tenantId === undefined || tenantId === '') return { on: false, why: 'the box names no shop (EDGE_TENANT_ID)' };
  return {
    on: true,
    settings: {
      issuer: issuer.trim(), apiBase: apiBase.trim(), tenantId,
      clientId: env['EDGE_HEAD_OFFICE_SIGN_IN_CLIENT_ID'] ?? 'sre-web',
      audience: env['EDGE_HEAD_OFFICE_AUDIENCE'] ?? 'sre-retail-os-api',
    },
  };
}
