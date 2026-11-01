import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ERP_NAVIGATION, NAV_SEARCH_WORDS } from '../../apps/web-erp/src/navigation';
import { HEAT_MAP_COPY } from '../../apps/web-erp/src/floor-heat-map-session';
import { BAYS_COPY } from '../../apps/web-erp/src/planogram-bays-session';

/**
 * OB-620 (owner, 1 Nov 2026): "Floor heat map" is now "Which areas earn most" and "Shelf compliance by bay" is now "Shelves
 * against the plan" — the menu label AND the page's own title together, in English and Tamil — and a person who types the
 * old name still finds the page.
 */
const pages = [
  { id: 'floor-heat-map', html: 'apps/web-erp/web/floor-heat-map.html', copy: HEAT_MAP_COPY, en: 'Which areas earn most', ta: 'எந்தப் பகுதிகள் அதிகம் ஈட்டுகின்றன', old: 'floor heat map' },
  { id: 'planogram-compliance', html: 'apps/web-erp/web/planogram-compliance.html', copy: BAYS_COPY, en: 'Shelves against the plan', ta: 'திட்டத்துடன் அலமாரிகள்', old: 'shelf compliance by bay' },
];

describe('the two shelf pages are named plainly (OB-620)', () => {
  for (const p of pages) {
    it(`${p.id}: the menu, the page's title in both languages and its HTML all say "${p.en}"`, () => {
      const item = ERP_NAVIGATION.find((n) => n.id === p.id)!;
      expect([item.label, item.labelTa]).toEqual([p.en, p.ta]);
      expect([p.copy.en.title, p.copy.ta.title]).toEqual([p.en, p.ta]);
      const html = readFileSync(p.html, 'utf8');
      expect(html).toContain(`<title>SRE ${p.en}</title>`);
      expect(html).toContain(`<h2 id="page-h">${p.en}</h2>`);
    });
    it(`${p.id}: the old name still finds it`, () => {
      expect(NAV_SEARCH_WORDS[p.id]!.en).toContain(p.old);
    });
  }
});
