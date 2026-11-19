// Batch 18a · OB-855 (owner, 19 Nov 2026, in writing: one language at a time) — THE STORE COMPUTER'S OWN SYSTEM PAGES
// (About, Licence, Software update, Head office sign-in, Handheld seal) and its sign-in page show ONE language at a time.
//
//   • every page opens in English; a language switch at the top right shows Tamil only (and back);
//   • the choice is remembered on this device under the same key the office pages fall back to (`sre.lang`), so a person
//     who chose தமிழ் on an office page finds the system pages in Tamil too, and the reverse;
//   • each bilingual part carries its two languages as `lang="en"` and `lang="ta"` elements; the stylesheet shows only
//     the one that matches the page's `<html lang>`. With no script the page stays readable in English.
// Nothing here is a setting or a secret: an empty or refused browser store simply means English.

/** The device's remembered language — the same key the office pages read when a person has no choice of their own. */
export const DEVICE_LANG_KEY = 'sre.lang';

/** One phrase in each language — only one shows, the page's own. */
export const both = (en: string, ta: string): string => `<span lang="en">${en}</span><span lang="ta">${ta}</span>`;

/** The stylesheet: hide the other language, and the switch's look (a round pill, 44px, at the top right of the page). */
export const ONE_LANGUAGE_STYLE = [
  'html:not([lang="ta"]) body [lang="ta"],html[lang="ta"] body [lang="en"]{display:none!important}',
  'html:not([lang="ta"]) [data-one-lang="ta"],html[lang="ta"] [data-one-lang="en"]{display:none!important}',
  'html:not([lang="ta"]) [data-switch-to="en"],html[lang="ta"] [data-switch-to="ta"]{display:none!important}',
  '.sre-lang-bar{display:flex;justify-content:flex-end;max-width:760px;margin:12px auto 0;padding:0 16px}',
  '.sre-lang-switch{font:600 15px/1.2 system-ui,"Segoe UI","Nirmala UI",sans-serif;min-height:44px;min-width:44px;padding:8px 16px;border:1px solid #c9d2da;border-radius:22px;background:#fff;color:#14202b;cursor:pointer}',
  '.sre-lang-switch:focus-visible{outline:3px solid #0b5394;outline-offset:2px}',
].join('');

/** In <head>, before the page paints: open in the remembered language (English when none, or when the store refuses). */
export const LANGUAGE_HEAD_SCRIPT = `<script>(function(){try{if(window.localStorage.getItem(${JSON.stringify(DEVICE_LANG_KEY)})==="ta")document.documentElement.lang="ta";}catch(e){}})();</script>`;

/** The switch — it names the OTHER language — and its one script: flip `<html lang>`, remember the choice on this device. */
export const LANGUAGE_SWITCH = [
  '<div class="sre-lang-bar"><button type="button" id="sre-lang-switch" class="sre-lang-switch" aria-label="Language — மொழி">',
  '<span data-switch-to="ta">தமிழ்</span><span data-switch-to="en">English</span></button></div>',
  '<script>(function(){var b=document.getElementById("sre-lang-switch");if(!b)return;b.addEventListener("click",function(){',
  'var to=document.documentElement.lang==="ta"?"en":"ta";document.documentElement.lang=to;',
  `try{window.localStorage.setItem(${JSON.stringify(DEVICE_LANG_KEY)},to);}catch(e){}});})();</script>`,
].join('');

/** Put the language's stylesheet and early script into a page's <head>, and the switch at the top of its <body>. */
export function withOneLanguage(html: string): string {
  let out = html.replace(/<\/head>/i, `<style>${ONE_LANGUAGE_STYLE}</style>${LANGUAGE_HEAD_SCRIPT}</head>`);
  const m = /<body\b[^>]*>/i.exec(out);
  if (m !== null) out = `${out.slice(0, m.index + m[0].length)}${LANGUAGE_SWITCH}${out.slice(m.index + m[0].length)}`;
  return out;
}
