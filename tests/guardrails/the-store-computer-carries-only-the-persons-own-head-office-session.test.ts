import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **OB-388 (owner, 26 Oct 2026, in writing) · ADR-0029 · hard rules #1 and #4 — the store computer reaches head office for
 * the office pages ONLY with the signed-in person's own session.**
 *
 * This fails when:
 *   • the link to head office for the office pages reads the store computer's machine credential (`CLOUD_API_TOKEN`) or a
 *     PIN, or puts anything but the person's own session token on a call;
 *   • a page's cookie, or a who-is-this header, is passed on to head office;
 *   • the link writes anything to disk (a token must never be on the box's disk) or logs anything but an event and a person;
 *   • the identity server is no longer asked for the password on every sign-in (a shared PC), or the second step is no
 *     longer required;
 *   • the till's sale path (the lane socket, the till app) comes to depend on the link (hard rule #1);
 *   • the decision record goes missing, or stops covering the six §19 headings.
 */

const LINK = readFileSync('edge/store-edge/src/head-office-link.ts', 'utf8');
const SCREENS = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
const MAIN = readFileSync('edge/store-edge/src/main.ts', 'utf8');
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('OB-388: only the person\'s own head-office session reaches head office from the office pages', () => {
  it('the link never reads the machine credential or a PIN; the only Authorization it sets is the session\'s bearer', () => {
    const src = code(LINK);
    expect(src).not.toMatch(/CLOUD_API_TOKEN|cloudToken|machineToken|verifyPerson|tillPin|\.pin\b/);
    const auth = [...src.matchAll(/authorization:\s*([^,}]+)/g)].map((m) => m[1]!.trim());
    expect(auth).toEqual(['`Bearer ${session.bearer']); // (the match stops at the template's closing brace)
    // The carry path in the screen socket names no credential of its own either.
    const carry = /const carryToHeadOffice = [\s\S]*?\n {2}};\n/.exec(SCREENS)?.[0] ?? '';
    expect(carry.length).toBeGreaterThan(200);
    expect(code(carry)).not.toMatch(/CLOUD_API_TOKEN|cloudToken|authorization/i);
    // main.ts hands the link its settings — never the machine token.
    const wiring = /headOffice: \(origin: string\) => createHeadOfficeLink\(\{[\s\S]*?\}\),\n/.exec(MAIN)?.[0] ?? '';
    expect(wiring.length).toBeGreaterThan(50);
    expect(wiring).not.toMatch(/cloudToken|CLOUD_API_TOKEN/);
  });

  it('a page\'s cookie and who-is-this headers never go to head office; head office\'s cookies never come back', () => {
    const pass = /const PASS_REQUEST = \[([^\]]*)\]/.exec(LINK)![1]!;
    for (const h of ['cookie', 'authorization', 'x-sre-user', 'x-sre-bearer', 'x-forwarded-for', 'x-forwarded-prefix']) expect(pass).not.toContain(`'${h}'`);
    const back = /const PASS_RESPONSE = \[([^\]]*)\]/.exec(LINK)![1]!;
    expect(back).not.toContain("'set-cookie'");
  });

  it('nothing of the link is written to disk, and its log carries an event and a person only', () => {
    expect(code(LINK)).not.toMatch(/from 'node:fs|from 'fs|openFileLog|writeFile|appendFile/);
    expect(LINK).toMatch(/deps\.audit\(\{ event: String\(line\['event'\] \?\? 'sign_in'\)/);
  });

  it('every sign-in asks for the password again (a shared PC), and one without a second step is ended', () => {
    expect(code(LINK)).toMatch(/alwaysAskForCredentials: true/);
    expect(code(LINK)).toMatch(/\.includes\('mfa'\)/);
    expect(code(LINK)).toMatch(/tenantId: settings\.tenantId/); // the one shop
  });

  it('the till\'s sale path never depends on the link (hard rule #1)', () => {
    const tillSide = ['edge/store-edge/src/lane-server.ts', 'edge/store-edge/src/cloud-sale.ts', 'edge/store-edge/src/real-trading.ts',
      ...readdirSync('apps/pos/src').filter((f) => f.endsWith('.ts')).map((f) => join('apps/pos/src', f))];
    for (const f of tillSide) expect(readFileSync(f, 'utf8'), f).not.toMatch(/head-office-link/);
  });

  it('the decision is recorded: ADR-0029 covers offline, support, security, cost, portability and maintainability', () => {
    const adr = readdirSync('docs/adr').find((f) => f.startsWith('0029-'));
    expect(adr).toBeDefined();
    const text = readFileSync(join('docs/adr', adr!), 'utf8');
    for (const h of ['Offline', 'Support', 'Security', 'Cost', 'Portability', 'Maintainability']) expect(text).toMatch(new RegExp(`\\*\\*${h}:\\*\\*`));
    expect(text).toContain('OB-388');
  });
});
