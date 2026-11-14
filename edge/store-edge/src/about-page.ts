// The ABOUT screen of the store computer — CR-01 step 2d (OI-03): which shop this PC is (its tenant id, made by the setup
// program and never typed), which store and till it serves, and which release it runs. Served by the till's screen
// server on this PC only (loopback), at /about/. Names only: the tenant id is a name, not a secret (it is written in the
// setup workbook); no setting's value, no key, no PIN is ever on it.

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

/** The page, English and Tamil side by side. A fact this PC does not know says so; it is never left blank. */
export function aboutPage(f: AboutFacts): string {
  const row = (en: string, ta: string, value: string | undefined): string =>
    `<tr><th>${en}<br><span lang="ta">${ta}</span></th><td>${value === undefined || value === '' ? '<em>not known on this PC / இந்தக் கணினியில் தெரியவில்லை</em>' : `<code>${esc(value)}</code>`}</td></tr>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>About this store computer</title>',
    '<style>body{font:16px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:720px;margin:24px auto;padding:0 16px}',
    'h1{font-size:22px;margin:0 0 4px}p{color:#5b6470}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d6dae0;border-radius:8px}',
    'th,td{text-align:left;padding:12px;border-top:1px solid #d6dae0;vertical-align:top}th{width:40%;font-weight:600}code{font-size:17px;word-break:break-all}em{color:#5b6470}</style>',
    '</head><body><main>',
    '<h1>About this store computer <span lang="ta">· இந்தக் கடைக் கணினி பற்றி</span></h1>',
    '<p>Which shop this PC is, which store and till it serves, and which release it runs. The tenant id was made by the setup program on this PC; it is a name, not a secret. <span lang="ta">டெனன்ட் எண் இந்தக் கணினியில் அமைப்பு நிரலால் உருவாக்கப்பட்டது; அது ஒரு பெயர், ரகசியம் அல்ல.</span></p>',
    '<table>',
    row("Shop's tenant id", 'கடையின் டெனன்ட் எண்', f.tenantId),
    row('Store', 'கடை', f.storeId),
    row('This till', 'இந்தப் பணப்பெட்டி', f.laneId),
    row('Release', 'வெளியீடு', f.release === undefined ? undefined : `${f.release}${f.commit === undefined ? '' : ` (${f.commit})`}`),
    '</table>',
    '<p><a href="/licence/">Licence</a> <span lang="ta">· உரிமம்</span> — which shop this copy is licensed to, until when, and (for the owner) loading a new licence or a renewal.</p>',
    '<p><a href="/update/">Software update</a> <span lang="ta">· மென்பொருள் புதுப்பிப்பு</span> — what version this PC runs, whether a newer one is ready, and (for the owner) the Update button.</p>',
    '</main></body></html>',
  ].join('');
}
