import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { startOfficeBox, type OfficeBox } from '../support/office-box';
import { SIGN_IN_FONT_FILES, signInFontFaces, signInFontFile } from '../../packages/ui/src/sign-in-style';
import { notAllowedPage, signInPage, tillOnlyPage } from '../../edge/store-edge/src/office-sign-in';
import { createDemoLoginHandler, FailureThrottle } from '../../infra/pilot/demo-login/login';
import { LOGIN_PAGE_CSS, LOGIN_FONTS_PATH } from '../../infra/pilot/demo-login/ui';

/**
 * Batch 16 · P-01 (owner: "the sign-in page uses the self-hosted Plus Jakarta Sans and Anek Tamil fonts, offline, with no
 * internet"). The store PC's screen server hands out the sign-in page's own font files BEFORE anyone signs in, from its own
 * disk, at `/fonts/<file>.woff2` — only the exact allow-listed files, as font/woff2 with a long cache, and nothing else:
 * no other file, no folder listing, no path escape. The hosted demo sign-in does the same at `/login/fonts/`.
 */

const FONTS = join(process.cwd(), 'packages/ui/web/fonts');

function get(base: string, path: string, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  // A raw request, so a path like `/fonts/../x` reaches the server exactly as written (fetch would tidy it first).
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('batch 16: the sign-in page fonts come from the box itself, before sign-in', () => {
  let box: OfficeBox;
  beforeAll(async () => { box = await startOfficeBox(); }, 60_000);
  afterAll(async () => { await box?.stop(); });

  it('names only the seven faces the page uses, each in the same unicode-range as the shared foundation', () => {
    expect(SIGN_IN_FONT_FILES).toEqual([
      'plus-jakarta-sans-400.woff2', 'plus-jakarta-sans-600.woff2', 'plus-jakarta-sans-700.woff2', 'plus-jakarta-sans-800.woff2',
      'anek-tamil-400.woff2', 'anek-tamil-600.woff2', 'anek-tamil-700.woff2',
    ]);
    const css = signInFontFaces('/fonts/');
    expect(css.match(/@font-face/g)).toHaveLength(7);
    expect(css.match(/font-display:swap/g)).toHaveLength(7);
    expect(css).not.toMatch(/https?:/);
    const foundation = readFileSync(join(process.cwd(), 'packages/ui/web/sre-foundation.css'), 'utf8');
    const rangeOf = (family: string, text: string): string => {
      const m = new RegExp(`font-family:\\s*"${family}"[^}]*unicode-range:\\s*([^;}]+)`).exec(text);
      return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
    };
    expect(rangeOf('Plus Jakarta Sans', css)).toBe(rangeOf('Plus Jakarta Sans', foundation));
    expect(rangeOf('Anek Tamil', css)).toBe(rangeOf('Anek Tamil', foundation));
    expect(rangeOf('Anek Tamil', css)).toContain('U+0B82-0BFA');
  });

  it('the store PC sign-in, the till-only page and the not-your-screen page all carry the faces at /fonts/', () => {
    for (const html of [signInPage({ storeName: 'SRE Hyper Market', next: '/' }), tillOnlyPage(), notAllowedPage({ displayName: 'Test Person', links: [] })]) {
      for (const file of SIGN_IN_FONT_FILES) expect(html).toContain(`url("/fonts/${file}")`);
    }
  });

  it('serves every allow-listed face before sign-in: the exact file, font/woff2, kept a year', async () => {
    for (const file of SIGN_IN_FONT_FILES) {
      const res = await get(box.base, `/fonts/${file}`);
      expect(res.status, file).toBe(200);
      expect(res.headers['content-type']).toBe('font/woff2');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body.equals(readFileSync(join(FONTS, file))), file).toBe(true);
      expect(res.body.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('refuses everything else under /fonts/: other files, the folder, escapes, and writes', async () => {
    for (const path of [
      '/fonts/', '/fonts', '/fonts/plus-jakarta-sans-500.woff2', '/fonts/OFL-anek-tamil.txt', '/fonts/../app.js',
      '/fonts/..%2fapp.js', '/fonts/%2e%2e/%2e%2e/package.json', '/fonts/plus-jakarta-sans-400.woff2/', '/fonts//etc/passwd',
      '/fonts/PLUS-JAKARTA-SANS-400.WOFF2', '/fonts/plus-jakarta-sans-400.woff2%00.txt',
    ]) {
      const res = await get(box.base, path);
      expect(res.status, path).not.toBe(200);
      expect(String(res.headers['content-type'] ?? ''), path).not.toBe('font/woff2');
    }
    expect((await get(box.base, '/fonts/plus-jakarta-sans-400.woff2', 'POST')).status).toBe(405);
    expect(signInFontFile('../anek-tamil-400.woff2')).toBeNull();
    expect(signInFontFile('anek-tamil-400.woff2')).toBe('anek-tamil-400.woff2');
  });

  it('the office screens themselves still ask for the PIN — the fonts open nothing else', async () => {
    const res = await get(box.base, '/manager/');
    expect(res.status).toBe(401);
    expect(res.body.toString('utf8')).toContain('url("/fonts/plus-jakarta-sans-400.woff2")');
  });

  it('the hosted demo sign-in serves the same faces from its own files at /login/fonts/, and only those', () => {
    const handle = createDemoLoginHandler({
      logins: () => ({ version: 1, logins: [] }),
      idp: { secret: 'x'.repeat(48), issuer: 'https://idp.test', audience: 'sre' },
      throttle: new FailureThrottle(), now: () => 0, audit: () => {},
      font: (name) => readFileSync(join(FONTS, name)),
    });
    expect(LOGIN_FONTS_PATH).toBe('/login/fonts/');
    for (const file of SIGN_IN_FONT_FILES) {
      expect(LOGIN_PAGE_CSS).toContain(`url("/login/fonts/${file}")`);
      const res = handle({ method: 'GET', url: `/login/fonts/${file}`, headers: {}, body: '' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('font/woff2');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.bytes?.equals(readFileSync(join(FONTS, file)))).toBe(true);
    }
    for (const url of ['/login/fonts/', '/login/fonts/OFL-anek-tamil.txt', '/login/fonts/../login.ts', '/login/fonts/plus-jakarta-sans-500.woff2']) {
      const res = handle({ method: 'GET', url, headers: {}, body: '' });
      expect(res.status, url).toBe(404);
      expect(res.bytes).toBeUndefined();
    }
    // The page's policy lets it load fonts from itself — and from nowhere else.
    const page = handle({ method: 'GET', url: '/login/', headers: {}, body: '' });
    expect(String(page.headers['content-security-policy'])).toContain("font-src 'self'");
    // With no font files at all (`font` absent) the page still works: the faces 404 and the system fonts stand in.
    const bare = createDemoLoginHandler({
      logins: () => ({ version: 1, logins: [] }), idp: { secret: 'x'.repeat(48), issuer: 'https://idp.test', audience: 'sre' },
      throttle: new FailureThrottle(), now: () => 0, audit: () => {},
    });
    expect(bare({ method: 'GET', url: '/login/fonts/anek-tamil-400.woff2', headers: {}, body: '' }).status).toBe(404);
  });
});
