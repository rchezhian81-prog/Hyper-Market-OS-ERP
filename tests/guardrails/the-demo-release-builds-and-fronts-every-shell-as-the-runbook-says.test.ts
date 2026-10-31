// Round 3 of the screen gap audit (31 Oct 2026, "Round C — the demo is not set up"):
//   • the demo release builds EVERY app shell that has a screen model — the supplier portal, self-checkout, the price kiosk,
//     the queue till and the business-customer portal were left out, so they opened on their stand-ins;
//   • the demo front routes the queue till (through the store box's handheld door) and the business-customer portal, behind
//     the demo sign-in;
//   • the deployment runbooks give the SAME build setting the example does — they had dropped the hosted till's lane path
//     (`PILOT_DEMO_LANE_BASE`), so a box set up from the runbook rang no sale on the demo store box.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLE = readFileSync('infra/deploy/deploy.conf.example', 'utf8');
const RELEASE = readFileSync('infra/deploy/release.sh', 'utf8');
const setting = (text: string, name: string): string => new RegExp(`^${name}="([^"]*)"$`, 'm').exec(text)?.[1] ?? '';
const SHELLS = setting(EXAMPLE, 'SRE_BUILD_SHELLS').split(/\s+/).filter((x) => x !== '');
const BUILD_ENV = setting(EXAMPLE, 'SRE_BUILD_ENV');

describe('the demo release builds every shell', () => {
  it('every app with a screen model is built, and nothing that has none', () => {
    const withModel = readdirSync('apps').filter((a) => existsSync(join('apps', a, 'src', 'browser-entry.ts'))).sort();
    expect([...SHELLS].sort()).toEqual(withModel);
    for (const a of ['supplier-app', 'self-checkout', 'price-kiosk', 'queue-pos', 'b2b-app']) expect(SHELLS).toContain(a);
  });
  it('the release script\'s own default is the same list', () => {
    expect(RELEASE).toContain(`: "\${SRE_BUILD_SHELLS:=${SHELLS.join(' ')}}"`);
  });
});

describe('the demo front routes the queue till and the business-customer portal, behind the demo sign-in', () => {
  const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
  const RELAY = readFileSync('infra/compose/nginx.edge-relay.conf', 'utf8');
  const CADDY = readFileSync('infra/compose/Caddyfile', 'utf8');
  for (const conf of ['infra/compose/nginx.pilot.conf', 'infra/compose/nginx.identity.conf']) {
    it(`${conf}: /b2b/ and /queue-pos/ (with the handheld enrolment /device/) only behind the sign-in`, () => {
      const front = readFileSync(conf, 'utf8');
      expect(front).toMatch(/location ~ \^\/\(supplier\|b2b\)\/ \{\s*auth_request \/_auth\/verify;/);
      expect(front).toMatch(/location ~ \^\/\(queue-pos\|device\)\/ \{\s*auth_request \/_auth\/verify;\s*error_page 401 = @sre_sign_in;/);
    });
  }
  it('the relay hands the queue till to the box\'s handheld door on its own loopback; the overlay opens that door there and mounts the B2B portal', () => {
    expect(RELAY).toMatch(/location ~ \^\/\(queue-pos\|device\)\/ \{\s*proxy_pass https:\/\/127\.0\.0\.1:8097;/);
    expect(PILOT).toMatch(/EDGE_DEVICE_PORT: '8097'/);
    expect(PILOT).not.toMatch(/EDGE_DEVICE_HOST/); // loopback only: nothing on the network reaches the door but the relay
    expect(PILOT).toMatch(/- edge-device-tls:\/var\/lib\/sre-edge-device-tls/);
    expect(PILOT).toMatch(/\.\.\/\.\.\/apps\/b2b-app\/web:\/usr\/share\/nginx\/html\/b2b:ro/);
  });
  it('the public proxy forwards those paths only inside the demo gate (404 by name otherwise)', () => {
    for (const snippet of ['(staff-not-public)', '(staff-demo-gate)']) {
      const at = CADDY.indexOf(snippet);
      const body = CADDY.slice(at, CADDY.indexOf('\n}\n', at));
      for (const p of ['/b2b', '/queue-pos', '/device', '/store-handheld']) expect(body, `${snippet} ${p}`).toMatch(new RegExp(` ${p} ${p}/\\*`));
    }
  });
  it('the demo sign-in hands the B2B portal who is looking', () => {
    expect(readFileSync('infra/pilot/demo-login/screen-bridge.ts', 'utf8')).toContain("'/b2b/index.html': { global: 'b2bData' }");
  });
});

describe('the deployment runbooks and the example agree on the build setting (item 5)', () => {
  it('the example keeps the demo banner AND the hosted till\'s lane path', () => {
    expect(BUILD_ENV.split(/\s+/)).toEqual(['PILOT_DEMO_BANNER=1', 'PILOT_DEMO_LANE_BASE=/store-lane']);
  });
  it('every SRE_BUILD_ENV a runbook or ADR gives for the demo box is the example\'s, word for word (a real-data box gives none)', () => {
    const docs = [...readdirSync('docs/runbooks').map((f) => join('docs/runbooks', f)), ...readdirSync('docs/adr').map((f) => join('docs/adr', f))].filter((f) => f.endsWith('.md'));
    const given = docs.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/SRE_BUILD_ENV="([^"]*)"/g)].map((m) => ({ f, value: m[1]! })));
    expect(given.length).toBeGreaterThanOrEqual(3);
    for (const g of given) if (g.value !== '') expect(g.value, g.f).toBe(BUILD_ENV);
    expect(readFileSync('docs/runbooks/automatic-deployment.md', 'utf8')).toContain(`SRE_BUILD_ENV="${BUILD_ENV}"`);
  });
});
