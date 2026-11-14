// The LICENCE screen of the store computer (About / Licence) — CR-01 step 5 (OI-10 · M33-FR-04 · OB-710 · P-01 · P-06 ·
// P-07 · P-08 · hard rule 6).
//
// Served by the till's screen server on this PC only (loopback), at /licence/, behind the office PIN sign-in (OB-259).
// It shows the licence's STANDING on the shop's own day (in force, ending soon, grace, no licence yet, reduced mode), its
// terms (tenant id, shop, GSTIN, tills, stores, modules, end), the licence request to send the seller, and the history of
// every load and refusal. RENEWAL is here: the owner loads the new licence file the seller sent — no code, no reinstall.
//
//   • Loading is the OWNER's (role `owner` at this store, holding platform.setup.write), with his OWN till PIN typed again
//     — exactly as the Software update page (OB-719);
//   • the file is checked OFFLINE (the seller's signature with the release's public key, its terms, THIS shop's tenant id):
//     a forged, edited or copied licence is refused BY NAME;
//   • every load and every refusal — the owner check and the PIN included — is written to the append-only licence history
//     BEFORE the answer (hard rule 6, P-08); a load that cannot be written down is not made.
//   • Whatever the licence says, the till sells (a sale never reads the licence — hard rule 1) and the shop can view and
//     export every record (P-06). In reduced mode (OB-750) only what LICENCE_POLICY.reduced names waits.

import type { LicenceStanding, LicenceRead } from '../../../scripts/lib/licence.mjs';
import type { LoadOutcome } from '../../../scripts/lib/store-licence.mjs';

export const LICENCE_PATHS = Object.freeze({ page: '/licence/', load: '/licence/load', request: '/licence/request.json' });
export const LICENCE_AUTHORITY = 'platform.setup.write';
export const LICENCE_OWNER_ROLE = 'owner';
/** A licence file is small; the posted body (the file's text and a PIN) is refused above this. */
export const LICENCE_POST_MAX_BYTES = 24 * 1024;

/** What the screen shows, read per request. */
export interface LicenceView {
  readonly standing: LicenceStanding;
  readonly keyBuiltIn: boolean;
  readonly problem?: LicenceRead | undefined;
  readonly tenantId?: string | undefined;
  readonly history: readonly Record<string, unknown>[];
}

export interface LicenceDeps {
  /** The licence now: standing, terms, any problem with the file on this PC. */
  readonly now: () => LicenceView;
  /** The person's roles at this store, from the signed store pack (null: not known). */
  readonly rolesOf: (userId: string) => readonly string[] | null;
  /** Their own till PIN, by the till's PIN register (same guess limits), holding `authority`. */
  readonly verifyPin: (userId: string, pin: string, authority: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly laneMessage: string }>;
  /** Check and load the file (store-licence loadLicence: history first). */
  readonly load: (text: string, by: string) => LoadOutcome;
  /** Write a refusal that happened before the file was looked at (who / PIN) to the same history. Throws when it cannot. */
  readonly record: (entry: Record<string, unknown>) => void;
  /** The licence request (names only) to send the seller. */
  readonly request: () => Record<string, unknown> | undefined;
}

export type LicenceAnswer =
  | { readonly ok: true; readonly en: string; readonly ta: string }
  | { readonly ok: false; readonly refusedBecause: string; readonly en: string; readonly ta: string; readonly detail?: string };

const WORDS = Object.freeze({
  not_signed_in: { en: 'Your office sign-in has ended. Sign in again with your own PIN.', ta: 'உங்கள் அலுவலக உள்நுழைவு முடிந்தது. உங்கள் PIN-உடன் மீண்டும் உள்நுழையவும்.' },
  not_the_owner: { en: 'Only the owner may load a licence.', ta: 'உரிமையாளர் மட்டுமே உரிமத்தை ஏற்ற முடியும்.' },
  pin_not_confirmed: { en: 'Your PIN was not confirmed.', ta: 'உங்கள் PIN உறுதிசெய்யப்படவில்லை.' },
  not_recorded: { en: 'The licence could not be written down on this PC, so it was not loaded.', ta: 'உரிமத்தை இந்தக் கணினியில் பதிவு செய்ய முடியவில்லை; அது ஏற்றப்படவில்லை.' },
});

/** The owner's load, decided in order: signed in → the owner → his PIN → the file itself. Every refusal written first. */
export async function requestLicenceLoad(deps: LicenceDeps, who: { readonly userId: string } | null, pin: unknown, text: unknown, at: string): Promise<LicenceAnswer> {
  const refuse = (why: keyof typeof WORDS, detail?: string): LicenceAnswer => {
    try { deps.record({ kind: 'licence_load', at, by: who?.userId ?? null, via: 'licence_screen', outcome: `refused:${why}` }); } catch { return { ok: false, refusedBecause: 'not_recorded', ...WORDS.not_recorded }; }
    return { ok: false, refusedBecause: why, ...WORDS[why], ...(detail === undefined ? {} : { detail }) };
  };
  if (who === null) return refuse('not_signed_in');
  if (!(deps.rolesOf(who.userId) ?? []).includes(LICENCE_OWNER_ROLE)) return refuse('not_the_owner');
  const confirmed = await deps.verifyPin(who.userId, typeof pin === 'string' ? pin : '', LICENCE_AUTHORITY);
  if (!confirmed.ok) return refuse('pin_not_confirmed', confirmed.laneMessage);
  const r = deps.load(typeof text === 'string' ? text : '', who.userId);
  return r.ok ? { ok: true, en: r.en, ta: r.ta } : { ok: false, refusedBecause: r.refusedBecause, en: r.en, ta: r.ta, ...(r.detail === undefined ? {} : { detail: r.detail }) };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STATE_WORDS: Readonly<Record<LicenceStanding['state'], { readonly en: string; readonly ta: string; readonly tone: 'green' | 'amber' | 'red' | 'grey' }>> = Object.freeze({
  not_in_force: { en: 'Licensing not switched on', ta: 'உரிமச் சரிபார்ப்பு இயக்கப்படவில்லை', tone: 'grey' },
  owner: { en: 'Owner\'s licence', ta: 'உரிமையாளர் உரிமம்', tone: 'green' },
  valid: { en: 'Licensed', ta: 'உரிமம் உள்ளது', tone: 'green' },
  expiring: { en: 'Licence ending soon', ta: 'உரிமம் விரைவில் முடிகிறது', tone: 'amber' },
  grace: { en: 'Licence ended — grace period', ta: 'உரிமம் முடிந்தது — சலுகைக் காலம்', tone: 'amber' },
  no_licence: { en: 'No licence loaded yet', ta: 'இன்னும் உரிமம் ஏற்றப்படவில்லை', tone: 'amber' },
  reduced: { en: 'Reduced mode', ta: 'குறைந்த பயன்முறை', tone: 'red' },
});

/** The notice every office page carries while the licence needs attention (null when all is well). Names only. */
export function licenceNotice(s: LicenceStanding): string | null {
  if (!s.warn) return null;
  const w = STATE_WORDS[s.state];
  const bg = w.tone === 'red' ? '#8a1f11' : '#8a4b00';
  return `<div id="sre-licence-notice" role="status" style="background:${bg};color:#fff;padding:8px 16px;font:15px/1.4 system-ui,'Segoe UI','Nirmala UI',sans-serif">`
    + `<strong>${esc(w.en)} · <span lang="ta">${esc(w.ta)}</span></strong> — ${esc(s.en)} <a href="${LICENCE_PATHS.page}" style="color:#fff;text-decoration:underline">Licence / உரிமம்</a></div>`;
}

/** Put the notice at the top of an office page (after <body …>). An empty notice leaves the page as it is. */
export function withLicenceNotice(html: string, notice: string | null): string {
  if (notice === null) return html;
  const m = /<body\b[^>]*>/i.exec(html);
  return m === null ? `${notice}${html}` : `${html.slice(0, m.index + m[0].length)}${notice}${html.slice(m.index + m[0].length)}`;
}

/** The screen, English and Tamil. Server-rendered; one small script reads the chosen file and posts it from this page. */
export function licencePage(v: LicenceView & { readonly isOwner: boolean; readonly displayName: string }): string {
  const s = v.standing;
  const w = STATE_WORDS[s.state];
  const l = s.licence;
  const row = (en: string, ta: string, value: string): string => `<tr><th>${en}<br><span lang="ta">${ta}</span></th><td>${value}</td></tr>`;
  const code = (x: string | number | undefined | null): string => (x === undefined || x === null || x === '' ? '<em>not known / தெரியவில்லை</em>' : `<code>${esc(String(x))}</code>`);
  const terms = l === null ? '' : [
    '<h2>The licence <span lang="ta">· உரிமம்</span></h2><table>',
    row('Licence number', 'உரிம எண்', code(l.licenceId)),
    row('Kind', 'வகை', l.kind === 'owner' ? 'Owner\'s own shop <span lang="ta">· உரிமையாளரின் கடை</span>' : 'Shop licence <span lang="ta">· கடை உரிமம்</span>'),
    row('Shop', 'கடை', code(l.shopName)),
    row('GSTIN', 'GSTIN', code(l.gstin)),
    row("Shop's tenant id", 'கடையின் டெனன்ட் எண்', code(l.tenantId)),
    row('Tills', 'பணப்பெட்டிகள்', code(l.tills)),
    row('Stores', 'கடைகள்', code(l.stores)),
    row('Modules', 'தொகுதிகள்', code(l.modules.join(', ') === 'all' ? 'all (M01–M36)' : l.modules.join(', '))),
    row('Issued on', 'வழங்கிய தேதி', code(l.issuedOn)),
    row('Ends', 'முடியும் தேதி', l.expiresOn === null ? 'No end date <span lang="ta">· முடிவுத் தேதி இல்லை</span>' : code(l.expiresOn)),
    '</table>',
  ].join('');
  const problem = v.problem === undefined || v.problem.ok ? '' : `<p class="warn" id="licence-problem">The licence file on this PC is NOT in force: ${esc(v.problem.en)}${v.problem.detail === undefined ? '' : ` (${esc(v.problem.detail)})`} <span lang="ta">${esc(v.problem.ta)}</span></p>`;
  const always = '<p class="ok" id="always">Whatever the licence says, the till keeps selling, and every record can be viewed and exported. <span lang="ta">உரிமம் எதுவாயினும், பணப்பெட்டி தொடர்ந்து விற்கும்; எல்லாப் பதிவுகளையும் பார்க்கவும் ஏற்றுமதி செய்யவும் முடியும்.</span></p>';
  const request = v.tenantId === undefined ? '' : `<p id="request">To ask the seller for a licence or a renewal, send the licence request (it holds names only: the tenant id <code>${esc(v.tenantId)}</code>, the shop's name and GSTIN): <a href="${LICENCE_PATHS.request}" download="licence-request.json">Download the licence request</a> <span lang="ta">· உரிமக் கோரிக்கையைப் பதிவிறக்கவும்</span></p>`;
  const form = !v.keyBuiltIn
    ? '<p class="note" id="no-key">This program version carries no seller key, so there is nothing to load yet. <span lang="ta">இந்தப் பதிப்பில் விற்பனையாளர் சாவி இல்லை.</span></p>'
    : !v.isOwner
      ? `<p class="note" id="owner-only">${esc(WORDS.not_the_owner.en)} <span lang="ta">${esc(WORDS.not_the_owner.ta)}</span></p>`
      : [
        '<h2>Load a licence (or a renewal) <span lang="ta">· உரிமத்தை ஏற்றவும் (அல்லது புதுப்பித்தல்)</span></h2>',
        '<form id="licence-form" autocomplete="off">',
        '<label for="file">The licence file the seller sent <span lang="ta">விற்பனையாளர் அனுப்பிய உரிமக் கோப்பு</span></label>',
        '<input id="file" name="file" type="file" accept=".json,application/json" required>',
        `<label for="pin">${esc(v.displayName)}, type your own till PIN to confirm <span lang="ta">உறுதிசெய்ய உங்கள் PIN-ஐ உள்ளிடவும்</span></label>`,
        '<input id="pin" name="pin" type="password" inputmode="numeric" maxlength="12" required>',
        '<button type="submit" id="load-button">Load the licence <span lang="ta">· உரிமத்தை ஏற்றவும்</span></button>',
        '<p id="answer" role="status" aria-live="polite"></p>',
        '</form>',
        '<script>',
        "document.getElementById('licence-form').addEventListener('submit',async function(e){e.preventDefault();",
        "var a=document.getElementById('answer'),b=document.getElementById('load-button'),p=document.getElementById('pin'),f=document.getElementById('file').files[0];if(!f){return;}b.disabled=true;a.textContent='…';",
        `try{var t=await f.text();var r=await fetch('${LICENCE_PATHS.load}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:p.value,licence:t})});`,
        "var o=await r.json();a.textContent=o.en+(o.detail?' ('+o.detail+')':'')+' — '+o.ta;a.className=o.ok?'ok':'warn';if(o.ok){setTimeout(function(){location.reload();},1500);}}catch(x){a.textContent='The store computer did not answer. Nothing was loaded.';a.className='warn';}",
        "p.value='';b.disabled=false;});",
        '</script>',
      ].join('');
  const hist = v.history.slice(-10).reverse();
  const history = hist.length === 0 ? '' : [
    '<h2>History <span lang="ta">· வரலாறு</span></h2><table id="history">',
    ...hist.map((h) => `<tr><td>${esc(String(h['at'] ?? ''))}</td><td>${esc(String(h['outcome'] ?? ''))}</td><td>${esc(String(h['licenceId'] ?? ''))}</td><td>${esc(String(h['by'] ?? ''))}</td></tr>`),
    '</table>',
  ].join('');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Licence</title>',
    '<style>body{font:16px/1.5 system-ui,"Segoe UI","Nirmala UI",sans-serif;margin:0;background:#f5f6f8;color:#1b1f24}main{max-width:760px;margin:24px auto;padding:0 16px}',
    'h1{font-size:22px;margin:0 0 8px}h2{font-size:19px;margin:20px 0 8px}.green{color:#1d6b3a}.amber{color:#8a4b00}.red{color:#8a1f11}.grey{color:#5b6470}',
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d6dae0;border-radius:8px}th,td{text-align:left;padding:10px 12px;border-top:1px solid #d6dae0;vertical-align:top}th{width:38%;font-weight:600}code{word-break:break-all}',
    'label{display:block;margin-top:16px;font-weight:600}input{font-size:18px;padding:8px;margin:8px 0}button{font-size:18px;padding:12px 20px;min-height:48px;border:0;border-radius:24px;background:#1d6b3a;color:#fff;cursor:pointer}button[disabled]{opacity:.5}',
    '.warn{color:#8a1f11;font-weight:600}.ok{color:#1d6b3a;font-weight:600}.note{color:#5b6470}em{color:#5b6470}</style>',
    '</head><body><main>',
    '<h1>Licence <span lang="ta">· உரிமம்</span></h1>',
    `<h2 class="${w.tone}" id="standing" data-state="${s.state}">${esc(w.en)} <span lang="ta">· ${esc(w.ta)}</span></h2>`,
    `<p id="standing-said">${esc(s.en)} <span lang="ta">${esc(s.ta)}</span></p>`,
    problem, always, terms, request, form, history,
    '<p><a href="/about/">About this store computer</a> <span lang="ta">· இந்தக் கடைக் கணினி பற்றி</span></p>',
    '</main></body></html>',
  ].join('');
}
