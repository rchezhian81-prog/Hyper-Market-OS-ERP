import { describe, it, expect } from 'vitest';
import { aboutPage } from '../../edge/store-edge/src/about-page';
import { licencePage } from '../../edge/store-edge/src/licence-page';
import { updatePage } from '../../edge/store-edge/src/update-page';
import { headOfficeSignInPage } from '../../edge/store-edge/src/head-office-link';
import { handheldSealPage, SEAL_NOT_READY_WORDS } from '../../edge/store-edge/src/handheld-seal';
import { signInPage } from '../../edge/store-edge/src/office-sign-in';
import { DEVICE_LANG_KEY } from '../../edge/store-edge/src/system-page-language';

// Batch 18a · OB-855 (owner, 19 Nov 2026: one language at a time) — the store computer's own system pages (About, Licence,
// Software update, Head office sign-in, Handheld seal) carry the language switch and the one-language stylesheet, remember the
// choice on the device (`sre.lang`), and no longer join the two languages on one line ("English · தமிழ்" / "English / தமிழ்").
// The browser test (tests/e2e/b18a-…) proves what a person SEES; this pins the pages' shape.

const TAMIL = /[஀-௿]/;

/** Each text run outside a `lang="ta"` element must hold no Tamil, and outside a `lang="en"` element no English sentence. */
function stray(html: string): { tamilOutside: string[] } {
  const body = html.slice(html.indexOf('<main'), html.lastIndexOf('</main>'))
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<(span|p|ol|div|li|h1|h2)\b[^>]*lang="ta"[^>]*>[\s\S]*?<\/\1>/g, '');
  const runs = body.replace(/<[^>]+>/g, '\u0000').split('\u0000').map((t) => t.trim()).filter((t) => t !== '');
  return { tamilOutside: runs.filter((t) => TAMIL.test(t)) };
}

const pages: Record<string, string> = {
  About: aboutPage({ tenantId: 't-1', storeId: 'S1', laneId: 'lane-1', release: '1.0.2300' }),
  Licence: licencePage({
    standing: { state: 'no_licence', en: 'No licence is loaded on this PC yet.', ta: 'இந்தக் கணினியில் இன்னும் உரிமம் ஏற்றப்படவில்லை.', licence: null } as never,
    keyBuiltIn: true, tenantId: 't-1', history: [], isOwner: true, displayName: 'Owner',
  }),
  'Software update': updatePage({ check: { state: 'available', running: '1.0.2005', latest: '1.0.2012', checkedAt: '2026-11-19T03:00:00.000Z', said: 'ready', kind: 'update-check' } as never, isOwner: true, displayName: 'Owner', openShifts: [], updaterPending: false }),
  'Head office sign-in': headOfficeSignInPage({ problem: 'unreachable', next: '/finance-close/' }),
  'Handheld seal': handheldSealPage({ ok: false, reason: 'no_door', ...SEAL_NOT_READY_WORDS.no_door }),
};

describe('Batch 18a · OB-855 — the store computer\'s system pages show one language at a time', () => {
  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: English by default, the switch, the remembered choice, and no Tamil outside a Tamil part`, () => {
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('id="sre-lang-switch"');
      expect(html).toContain(`localStorage.getItem("${DEVICE_LANG_KEY}")`);
      expect(html).toContain(`localStorage.setItem("${DEVICE_LANG_KEY}"`);
      expect(html).toContain('html:not([lang="ta"]) body [lang="ta"],html[lang="ta"] body [lang="en"]{display:none!important}');
      expect(html).not.toMatch(/<span lang="ta">\s*·/); // no "English · தமிழ்" joined on one line
      expect(html).not.toMatch(/ \/ [஀-௿]/);   // no "English / தமிழ்"
      expect(stray(html).tamilOutside).toEqual([]);
    });
  }

  it('the sign-in page opens in the language last chosen on this device and remembers each press', () => {
    const html = signInPage({ next: '/office/' });
    expect(html).toContain(`localStorage.getItem(K)==="ta"`);
    expect(html).toContain('var K="sre.lang"');
    expect(html).toContain('id="sl-lang-ta"');
    expect(html.indexOf('localStorage.setItem(K,v)')).toBeGreaterThan(html.indexOf('id="sl-lang-ta"')); // the script runs after the switch exists
  });
});
