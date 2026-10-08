import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LOGIN_CSS, LOGIN_COPY } from '../../infra/pilot/demo-login/ui';

/**
 * **The identity server's sign-in pages wear the owner's approved design, and only honest signals (OB-18 · ADR-0019).**
 *
 * The Keycloak login theme `infra/keycloak/themes/sre/login/` is the product's real sign-in surface. The owner
 * approved one look (OB-18, 5 Oct 2026), implemented once in `infra/pilot/demo-login/ui.ts`. This guardrail keeps the
 * theme on that look, and keeps out what OB-18 rules out:
 *   1. the theme's stylesheet contains `LOGIN_CSS` verbatim (one CSS source; `pnpm run build:keycloak-theme`
 *      regenerates it), and the generated blocks are up to date;
 *   2. no inline script body, no inline event handler and no `style="` in any template; no `<script>` without `src`;
 *   3. no URL to any other host: nothing is fetched from anywhere (the only `http(s)://` allowed is the SVG namespace
 *      name inside the stylesheet's data: icons, which is an identifier and is never fetched);
 *   4. no remember-me, no forgot-password link, no role selector;
 *   5. both message files carry every OB-18 word (each `LOGIN_COPY` key) in their own language, and the same keys;
 *   6. the login form keeps Keycloak's contract: id `kc-form-login` before `action="${url.loginAction}"`, fields
 *      `username` and `password`; the one-time-code form keeps field `otp`;
 *   7. the language switch is Keycloak's own (`locale.supported`, `l.url`), not a browser-only switch;
 *   8. the connection line says what the server knows: "Online sign-in available".
 * The rendered pages are proven against a real Keycloak 26 by the browser check recorded with the change; this test is
 * the always-on part.
 */

const THEME = 'infra/keycloak/themes/sre/login';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const ALL = files(THEME);
const FTL = ALL.filter((f) => f.endsWith('.ftl'));
const read = (f: string): string => readFileSync(f, 'utf8');
/** The text that reaches a page: template comments (<#-- -->), script/CSS comments and .properties comments removed. */
const code = (f: string): string => read(f)
  .replace(/<#--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*(?:\/\/|#).*$/gm, '');
const CSS = read(join(THEME, 'resources/css/sre-login.css'));
const TEMPLATE = read(join(THEME, 'template.ftl'));
const LOGIN = read(join(THEME, 'login.ftl'));
const OTP = read(join(THEME, 'login-otp.ftl'));
const PROPS = read(join(THEME, 'theme.properties'));

/** A Keycloak .properties file as a map (UTF-8; `\n` escapes decoded; MessageFormat's '' left as written). */
function properties(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of read(file).split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    out.set(line.slice(0, eq), line.slice(eq + 1).replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
  }
  return out;
}
const MESSAGES = { en: properties(join(THEME, 'messages/messages_en.properties')), ta: properties(join(THEME, 'messages/messages_ta.properties')) };
/** What Keycloak shows for a message: MessageFormat turns '' into '. */
const shown = (v: string | undefined): string | undefined => v?.replace(/''/g, "'");

describe('the sign-in theme is the owner\'s design (OB-18)', () => {
  it('is a Keycloak login theme on the plain base theme: no PatternFly, our own stylesheet', () => {
    expect(PROPS).toMatch(/^parent=base$/m);
    expect(PROPS).toMatch(/^locales=en,ta$/m);
    expect(PROPS).toMatch(/^styles=css\/sre-login\.css$/m);
    expect(code(join(THEME, 'theme.properties'))).not.toMatch(/patternfly|stylesCommon/i);
  });

  it('its stylesheet contains LOGIN_CSS from ui.ts verbatim, and every generated block is current', () => {
    expect(CSS.includes(LOGIN_CSS)).toBe(true);
    // The theme's additions come AFTER the design's stylesheet, so the design wins nowhere by accident.
    expect(CSS.indexOf(LOGIN_CSS)).toBeLessThan(CSS.indexOf('Theme additions for Keycloak'));
    const out = execFileSync(process.execPath, ['scripts/build-keycloak-theme.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/up to date/);
  });

  it('has no inline script, no inline event handler and no inline style in any template', () => {
    expect(FTL.length).toBeGreaterThanOrEqual(4);
    for (const f of FTL) {
      const text = read(f);
      for (const tag of text.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
        expect(tag, `${f}: a script must be a file, not inline`).toMatch(/^<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>$/);
      }
      expect(text, `${f}: inline style`).not.toMatch(/\bstyle\s*=/i);
      expect(text, `${f}: inline event handler`).not.toMatch(/\son[a-z]+\s*=/i);
      expect(text, `${f}: javascript: URL`).not.toMatch(/javascript:/i);
    }
  });

  it('fetches nothing from any other host: no http(s) URL anywhere in the theme', () => {
    for (const f of ALL) {
      const urls = read(f).match(/https?:\/\/[^\s'")<>]+/gi) ?? [];
      // The SVG namespace inside a data: icon is a name, never fetched.
      const offending = urls.filter((u) => !(f.endsWith('.css') && u === 'http://www.w3.org/2000/svg'));
      expect(offending, relative('.', f)).toEqual([]);
      expect(read(f), `${f}: protocol-relative URL`).not.toMatch(/(?:src|href)\s*=\s*["']\/\//i);
      expect(read(f), `${f}: @import`).not.toMatch(/@import\b/);
    }
  });

  it('offers no remember-me, no forgot-password link and no role selector', () => {
    for (const f of FTL) {
      const text = code(f);
      expect(text, f).not.toMatch(/rememberMe|remember-me|remember me/i);
      expect(text, f).not.toMatch(/loginResetCredentialsUrl|doForgotPassword|forgot/i);
      expect(text, f).not.toMatch(/name="role"|role-select|selectRole/i);
    }
    expect(code(join(THEME, 'resources/js/sre-login.js'))).not.toMatch(/localStorage|sessionStorage/);
  });

  it('both message files carry every OB-18 word in their own language, with the same keys', () => {
    for (const lang of ['en', 'ta'] as const) {
      for (const [key, value] of Object.entries(LOGIN_COPY[lang])) {
        expect(shown(MESSAGES[lang].get(`sre.${key}`)), `messages_${lang}: sre.${key}`).toBe(value);
      }
    }
    expect([...MESSAGES.ta.keys()].sort()).toEqual([...MESSAGES.en.keys()].sort());
    // Keycloak's own words have the design's voice (English, and the design's Tamil where it has the words).
    expect(shown(MESSAGES.en.get('doLogIn'))).toBe(LOGIN_COPY.en.signIn);
    expect(shown(MESSAGES.ta.get('doLogIn'))).toBe(LOGIN_COPY.ta.signIn);
    expect(shown(MESSAGES.en.get('invalidUserMessage'))).toBe(LOGIN_COPY.en.invalid);
    expect(shown(MESSAGES.ta.get('invalidUserMessage'))).toBe(LOGIN_COPY.ta.invalid);
    expect(shown(MESSAGES.en.get('loginAccountTitle'))).toBe(LOGIN_COPY.en.welcome);
    expect(shown(MESSAGES.ta.get('loginAccountTitle'))).toBe(LOGIN_COPY.ta.welcome);
    for (const key of ['usernameOrEmail', 'username', 'password', 'loginTotpStep1', 'loginTotpStep2', 'loginTotpStep3', 'loginOtpOneTime', 'locale_en', 'locale_ta']) {
      expect(MESSAGES.en.get(key), key).toBeTruthy();
      expect(MESSAGES.ta.get(key), key).toBeTruthy();
    }
  });

  it('every message survives Keycloak\'s MessageFormat: no lone single quote', () => {
    for (const lang of ['en', 'ta'] as const) {
      for (const [key, value] of MESSAGES[lang]) {
        expect(value.replace(/''/g, ''), `messages_${lang}: ${key}`).not.toMatch(/'/);
      }
    }
  });

  it('keeps Keycloak\'s form contract: kc-form-login, username, password, otp', () => {
    expect(LOGIN).toMatch(/<form id="kc-form-login" action="\$\{url\.loginAction\}" method="post"/);
    expect(LOGIN).toMatch(/<input id="username" name="username"/);
    expect(LOGIN).toMatch(/<input id="password" name="password"[^>]*type="password"/);
    expect(OTP).toMatch(/<form id="kc-otp-login-form"[^>]*action="\$\{url\.loginAction\}"/);
    expect(OTP).toMatch(/<input id="otp" name="otp"/);
    // One primary action.
    expect(LOGIN.match(/class="sl-submit"/g)).toHaveLength(1);
  });

  it('switches language through Keycloak\'s own locale mechanism, so the server renders the words', () => {
    expect(TEMPLATE).toMatch(/<#list locale\.supported as l>/);
    expect(TEMPLATE).toMatch(/href="\$\{l\.url\}"/);
    expect(TEMPLATE).toMatch(/<html lang="\$\{sreLang\}">/);
  });

  it('says only what the server knows: "Online sign-in available", no sample state', () => {
    expect(TEMPLATE).toMatch(/\$\{msg\("sre\.connectionOnline"\)\}/);
    expect(LOGIN_COPY.en.connectionOnline).toBe('Online sign-in available');
    for (const f of [...FTL, join(THEME, 'resources/js/sre-login.js')]) {
      expect(code(f), f).not.toMatch(/offline access available|sample|explore states|simulat/i);
    }
    // The practice strip is the pilot's switch, as everywhere else in the product: off unless PILOT_DEMO_BANNER is on.
    expect(PROPS).toMatch(/^sreTrialStrip=\$\{env\.PILOT_DEMO_BANNER:0\}$/m);
  });

  it('draws the design\'s own icons: every inline SVG shape in the template is one of ui.ts\'s', () => {
    const ui = readFileSync('infra/pilot/demo-login/ui.ts', 'utf8');
    const shapes = TEMPLATE.match(/<(?:path|circle|rect)\b[^>]*\/>/g) ?? [];
    expect(shapes.length).toBeGreaterThan(20);
    for (const shape of shapes) expect(ui.includes(shape), shape).toBe(true);
  });
});
