// The ABOUT screen of the store computer — CR-01 step 2d (OI-03): which shop this PC is (its tenant id, made by the setup
// program and never typed), which store and till it serves, and which release it runs. Served by the till's screen
// server on this PC only (loopback), at /about/. Names only: the tenant id is a name, not a secret (it is written in the
// setup workbook); no setting's value, no key, no PIN is ever on it.

import { both, withOneLanguage } from './system-page-language';

export const ABOUT_PATH = '/about/';

export interface AboutFacts {
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly laneId?: string;
  readonly release?: string;
  readonly commit?: string;
}

/** The release this PC runs, from the release folder's release.json (written by scripts/build-store-pc-release.mjs). */
export function releaseFrom(text: string | undefined): { release?: string; commit?: string } {
  if (text === undefined) return {};
  try {
    const r = JSON.parse(text) as { version?: unknown; commit?: unknown };
    return {
      ...(typeof r.version === 'string' ? { release: r.version } : {}),
      ...(typeof r.commit === 'string' ? { commit: r.commit.slice(0, 8) } : {}),
    };
  } catch { return {}; }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page — one language at a time (OB-855): English, or Tamil once தமிழ் is pressed. A fact this PC does not know says so. */
export function aboutPage(f: AboutFacts): string {
  const row = (en: string, ta: string, value: string | undefined): string =>
    `<tr><th>${both(en, ta)}</th><td>${value === undefined || value === '' ? `<em>${both('not known on this PC', 'இந்தக் கணினியில் தெரியவில்லை')}</em>` : `<code>${esc(value)}</code>`}</td></tr>`;
  return withOneLanguage([
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>About this store computer</title>',
    '<style>body{font:16px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:720px;margin:24px auto;padding:0 16px}',
    'h1{font-size:22px;margin:0 0 4px}p{color:#5b6470}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d6dae0;border-radius:8px}',
    'th,td{text-align:left;padding:12px;border-top:1px solid #d6dae0;vertical-align:top}th{width:40%;font-weight:600}code{font-size:17px;word-break:break-all}em{color:#5b6470}</style>',
    '</head><body><main>',
    `<h1>${both('About this store computer', 'இந்தக் கடைக் கணினி பற்றி')}</h1>`,
    `<p>${both('Which shop this PC is, which store and till it serves, and which release it runs. The tenant id was made by the setup program on this PC; it is a name, not a secret.', 'இந்தக் கணினி எந்தக் கடை, எந்தக் கிளை மற்றும் பணப்பெட்டிக்குச் சேவை செய்கிறது, எந்தப் பதிப்பு இயங்குகிறது. டெனன்ட் எண் இந்தக் கணினியில் அமைப்பு நிரலால் உருவாக்கப்பட்டது; அது ஒரு பெயர், ரகசியம் அல்ல.')}</p>`,
    '<table>',
    row("Shop's tenant id", 'கடையின் டெனன்ட் எண்', f.tenantId),
    row('Store', 'கடை', f.storeId),
    row('This till', 'இந்தப் பணப்பெட்டி', f.laneId),
    row('Release', 'வெளியீடு', f.release === undefined ? undefined : `${f.release}${f.commit === undefined ? '' : ` (${f.commit})`}`),
    '</table>',
    `<p>${both('<a href="/licence/">Licence</a> — which shop this copy is licensed to, until when, and (for the owner) loading a new licence or a renewal.', '<a href="/licence/">உரிமம்</a> — இந்தப் பிரதி எந்தக் கடைக்கு, எதுவரை உரிமம் பெற்றது; (உரிமையாளருக்கு) புதிய உரிமம் அல்லது புதுப்பித்தலை ஏற்றுதல்.')}</p>`,
    `<p>${both('<a href="/update/">Software update</a> — what version this PC runs, whether a newer one is ready, and (for the owner) the Update button.', '<a href="/update/">மென்பொருள் புதுப்பிப்பு</a> — இந்தக் கணினியின் பதிப்பு, புதியது தயாரா, (உரிமையாளருக்கு) புதுப்பிக்கும் பொத்தான்.')}</p>`,
    '</main></body></html>',
  ].join(''));
}
