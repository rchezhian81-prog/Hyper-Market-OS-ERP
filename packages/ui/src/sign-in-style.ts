// The sign-in page's stylesheet in the owner's approved design (UX-3 · OB-18, 5 October 2026), scoped to `#sre-login`:
// a cream canvas, the SRE mark, a hero on the left, a white "Staff access" card on the right. ONE source for both sign-ins —
// the hosted demo's (the pilot's hosted sign-in, also the Keycloak theme) and the store computer's own front door
// (`edge/store-edge/src/office-sign-in.ts`, batch 12: the owner asked the store PC's sign-in to look like the demo's).
//
// Batch 16 (owner, Nov 2026): the page's own faces — Plus Jakarta Sans and Anek Tamil — come from the SAME box that serves
// the page, never the internet (P-01). SIGN_IN_CSS itself holds no url(); each server puts `signInFontFaces(base)` in front
// of it, naming the same-origin folder it serves the allow-listed files from (the store PC: `/fonts/`; the hosted demo:
// `/login/fonts/`). If a file cannot be fetched the page keeps the system fonts named in the stack (font-display: swap).

/**
 * The only font files a sign-in page needs — and the only files a server hands out before anyone has signed in. The page
 * uses weights 400–800; 550 draws with 600, 650 with 700 and 750 with 800 (CSS weight matching), so these seven suffice.
 */
export const SIGN_IN_FONT_FILES: readonly string[] = Object.freeze([
  'plus-jakarta-sans-400.woff2', 'plus-jakarta-sans-600.woff2', 'plus-jakarta-sans-700.woff2', 'plus-jakarta-sans-800.woff2',
  'anek-tamil-400.woff2', 'anek-tamil-600.woff2', 'anek-tamil-700.woff2',
]);

/** `name` if it is exactly one of SIGN_IN_FONT_FILES, else null — no folders, no escapes, no listing, no other file. */
export function signInFontFile(name: string): string | null {
  return SIGN_IN_FONT_FILES.includes(name) ? name : null;
}

/** How a server sends one of those files: the font type, kept a year (the faces never change under the same name). */
export const SIGN_IN_FONT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'font/woff2',
  'cache-control': 'public, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
});

// The same unicode-ranges as packages/ui/web/sre-foundation.css, so a Tamil letter is drawn by Anek Tamil and nothing else.
const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const TAMIL_RANGE = 'U+0964-0965, U+0B82-0BFA, U+200C-200D, U+20B9, U+25CC';

/** The `@font-face` rules for the sign-in page, each pointing at `<base><file>` on the page's own server. */
export function signInFontFaces(base: string): string {
  return SIGN_IN_FONT_FILES.map((file) => {
    const jakarta = file.startsWith('plus-jakarta-sans-');
    const weight = file.slice(file.lastIndexOf('-') + 1, -'.woff2'.length);
    return `@font-face{font-family:"${jakarta ? 'Plus Jakarta Sans' : 'Anek Tamil'}";font-style:normal;font-weight:${weight};font-display:swap;`
      + `src:url("${base}${file}") format("woff2");unicode-range:${jakarta ? LATIN_RANGE : TAMIL_RANGE}}`;
  }).join('\n') + '\n';
}

export const SIGN_IN_CSS = `
html,body{margin:0;min-height:100%}
body{background:#fbf8f1}
#sre-login{--sre-canvas:#fbf8f1;--sre-surface:#ffffff;--sre-ink:#173328;--sre-muted:#5c5646;--sre-green:#17654f;--sre-deep:#0e3b2e;--sre-sage:#f5f0e4;--sre-border:#ece4d2;--sre-field:#ffffff;--sre-amber:#9c4f17;--sre-amber-bg:#fbe7d6;--sre-red:#a03e36;--sre-red-bg:#fbeae6;color-scheme:light;font:16px/1.55 "Plus Jakarta Sans","Anek Tamil",Inter,"Segoe UI","Noto Sans Tamil","Nirmala UI","Latha",Arial,sans-serif;color:var(--sre-ink);background:var(--sre-canvas);width:100%;min-height:100vh;isolation:isolate;display:flex;flex-direction:column}
#sre-login *{box-sizing:border-box}
#sre-login h1,#sre-login h2,#sre-login h3,#sre-login p{margin:0}
#sre-login button,#sre-login input{font:inherit}
#sre-login button{color:inherit;cursor:pointer}
#sre-login button,#sre-login a{touch-action:manipulation}
#sre-login button:disabled{cursor:not-allowed}
#sre-login [hidden]{display:none!important}
#sre-login .sl-icon{width:20px;height:20px;flex-shrink:0}
#sre-login :focus-visible{outline:3px solid #0e3b2e;outline-offset:2px}
#sre-login .sl-strip{background:var(--sre-amber-bg);color:#66310e;border-bottom:1px solid #f0cba9;font-size:14px;font-weight:700;letter-spacing:.4px;text-align:center;padding:7px 16px}
#sre-login .sl-product{position:relative;overflow:hidden;flex:1;display:flex;flex-direction:column}
#sre-login .sl-topbar{width:100%;max-width:1400px;margin:0 auto;padding:29px 54px;display:flex;align-items:center;justify-content:space-between;gap:20px}
#sre-login .sl-brand{display:flex;align-items:center;gap:13px;text-decoration:none;color:var(--sre-ink)}
#sre-login .sl-mark{width:47px;height:47px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#d4a23a;color:#0e3b2e;font:800 31px/1 "Plus Jakarta Sans","Segoe UI",Arial,sans-serif;position:relative;padding-right:4px;flex-shrink:0}
#sre-login .sl-mark span{position:absolute;right:7px;top:7px;font-size:12.5px;font-weight:600;color:#0e3b2e}
#sre-login .sl-brand-name{font-size:22px;line-height:1.1;font-weight:750;letter-spacing:.4px}
#sre-login .sl-brand-name small{display:block;margin-top:6px;font-size:12.5px;font-weight:700;letter-spacing:1.6px;color:var(--sre-muted)}
#sre-login .sl-top-actions{display:flex;align-items:center;gap:25px}
#sre-login .sl-language{display:flex;align-items:center;padding:3px;border:1px solid var(--sre-border);border-radius:999px;background:#f5f0e4}
#sre-login .sl-language button{border:0;background:transparent;min-height:44px;padding:7px 16px;font-size:14px;color:var(--sre-muted);border-radius:999px}
#sre-login .sl-language button[aria-pressed="true"]{background:#fff;color:var(--sre-deep);font-weight:650;box-shadow:0 1px 4px #0e3b2e12}
#sre-login .sl-text-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:transparent;border:0;min-height:44px;font-size:14px;padding:8px 0;color:var(--sre-green);text-align:center;text-decoration:none}
#sre-login .sl-top-help{color:var(--sre-muted)}
#sre-login .sl-main{width:100%;max-width:1236px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.02fr) minmax(330px,.98fr);gap:76px;align-items:center;padding:49px 54px 66px;flex:1}
#sre-login .sl-intro{max-width:490px;padding:13px 0}
#sre-login .sl-eyebrow{display:flex;align-items:center;gap:10px;font-size:12.5px;letter-spacing:1.8px;font-weight:700;color:#17654f;text-transform:uppercase;margin-bottom:23px}
#sre-login .sl-eyebrow:before{content:"";width:24px;height:2px;background:#d4a23a}
#sre-login .sl-hero{font-size:clamp(38px,4.4vw,58px);font-weight:650;letter-spacing:-2.5px;line-height:1.12;max-width:480px}
#sre-login .sl-hero span{display:block;color:#17654f;margin-top:5px}
#sre-login .sl-hero span.sl-hero-ink{color:var(--sre-ink);margin:0}
#sre-login .sl-intro-copy{margin-top:23px;font-size:17px;line-height:1.75;color:var(--sre-muted);max-width:385px}
#sre-login .sl-illustration{margin-top:43px;width:min(100%,410px);position:relative;padding:0 0 20px 15px}
#sre-login .sl-illustration:before{content:"";position:absolute;inset:19px 16px 0 0;border:1px solid #ece4d2;border-radius:17px;background:#f5f0e4}
#sre-login .sl-workspace{position:relative;background:#fff;border:1px solid #ece4d2;border-radius:16px;overflow:hidden;box-shadow:0 15px 40px -28px #0e3b2e24}
#sre-login .sl-workspace-head{display:flex;align-items:center;gap:11px;padding:19px 20px;border-bottom:1px solid #f3eee2}
#sre-login .sl-workspace-icon{width:39px;height:39px;border-radius:10px;display:grid;place-items:center;background:#e8f2ec;color:var(--sre-green)}
#sre-login .sl-workspace-head strong{display:block;font-size:14px;font-weight:650}
#sre-login .sl-workspace-head small{display:block;color:var(--sre-muted);font-size:13px;margin-top:1px}
#sre-login .sl-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:22px 12px 24px;gap:6px}
#sre-login .sl-three div{display:flex;align-items:center;flex-direction:column;gap:11px;color:var(--sre-green);text-align:center}
#sre-login .sl-three div+div{border-left:1px solid #f3eee2}
#sre-login .sl-three span{font-size:13px;color:#2f4339;font-weight:550;line-height:1.35}
#sre-login .sl-illustration-label{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:#5c5646;padding:15px 10px 0}
#sre-login .sl-illustration-label .sl-icon{width:16px;height:16px}
#sre-login .sl-login-area{width:100%;max-width:451px;justify-self:end}
#sre-login .sl-login-card{background:#fff;border:1px solid #ece4d2;border-radius:20px;padding:31px 34px 26px;box-shadow:0 14px 48px -30px #0e3b2e24;position:relative;overflow:hidden}
#sre-login .sl-login-card:before{content:"";height:3px;position:absolute;top:0;left:34px;right:34px;background:linear-gradient(90deg,#17654f 0%,#17654f 68%,#d4a23a 68%,#d4a23a 90%,#ece4d2 90%);border-radius:0 0 5px 5px}
#sre-login .sl-login-kicker{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:650;letter-spacing:1.4px;text-transform:uppercase;color:#5c5646;margin-bottom:17px}
#sre-login .sl-login-kicker .sl-icon{width:16px;height:16px}
#sre-login .sl-login-card h1,#sre-login .sl-login-card h2{font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-.8px}
#sre-login .sl-subtitle{color:var(--sre-muted);font-size:14px;margin-top:10px;line-height:1.6}
#sre-login .sl-store{display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid #ece4d2;border-radius:12px;background:#f9f5ec;margin:23px 0}
#sre-login .sl-store>.sl-icon{width:22px;height:22px;color:var(--sre-green)}
#sre-login .sl-store strong{font-size:14px;font-weight:650;display:block}
#sre-login .sl-store small{font-size:14px;color:var(--sre-muted);display:block;margin-top:2px}
#sre-login .sl-store .sl-mode{margin-left:auto;color:#2f4339;background:#f5f0e4;border-radius:5px;padding:3px 7px;font-size:12.5px;letter-spacing:.6px;white-space:nowrap;align-self:flex-start}
#sre-login .sl-field{margin-top:18px}
#sre-login .sl-field label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}
#sre-login .sl-input-wrap{position:relative}
#sre-login .sl-input-wrap>.sl-icon{position:absolute;left:14px;top:17px;color:#5c5646;width:18px;height:18px;pointer-events:none}
#sre-login input[type="text"],#sre-login input[type="password"]{display:block;appearance:none;width:100%;height:53px;border:1px solid #8a806d;border-radius:12px;background:var(--sre-field);color:var(--sre-ink);padding:12px 43px;font-size:16px;line-height:1.4;box-shadow:none;min-width:0}
#sre-login input::placeholder{color:#5c5646;opacity:1;font-size:15px}
#sre-login input:disabled{background:#f3eee2;color:#5c5646}
#sre-login input[aria-invalid="true"]{border-color:var(--sre-red)}
#sre-login .sl-password{padding-right:68px!important}
#sre-login .sl-reveal{position:absolute;right:4px;top:4px;height:45px;min-width:55px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--sre-green);font-size:14px;font-weight:600;border-radius:5px}
#sre-login .sl-caps{font-size:14px;color:var(--sre-amber);margin-top:7px}
#sre-login .sl-submit{display:flex;align-items:center;justify-content:center;gap:11px;width:100%;min-height:53px;border:1px solid var(--sre-green);border-radius:999px;background:var(--sre-green);color:#fff;font-size:15px;font-weight:650;margin-top:25px;padding:13px 17px;box-shadow:0 3px 6px -4px #0e3b2e40;text-decoration:none}
#sre-login .sl-submit:hover:not(:disabled){background:#11533f;border-color:#11533f}
#sre-login .sl-submit:disabled,#sre-login .sl-submit[aria-busy="true"]{background:#ece4d2;border-color:#ece4d2;color:#5c5646;box-shadow:none}
#sre-login .sl-submit .sl-icon{width:18px;height:18px}
#sre-login .sl-secondary{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:12px;border:1px solid var(--sre-green);border-radius:999px;background:#fff;color:var(--sre-green);font-size:14px;font-weight:600}
#sre-login .sl-help-row{display:flex;justify-content:center;margin-top:10px}
#sre-login .sl-help-row button{font-size:14px;min-height:44px}
#sre-login .sl-personal{border-top:1px solid #f3eee2;margin-top:15px;padding-top:18px;display:flex;align-items:flex-start;gap:9px;color:var(--sre-muted);font-size:14px;line-height:1.6}
#sre-login .sl-personal .sl-icon{width:16px;height:16px;margin-top:2px}
#sre-login .sl-status{margin:17px 2px 0;display:flex;align-items:center;gap:9px;justify-content:center;flex-wrap:wrap;color:#5c5646;font-size:14px;line-height:1.5;text-align:center}
#sre-login .sl-status button{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:inherit;border:0;background:transparent;font-size:14px;text-decoration:underline;text-underline-offset:4px;min-height:44px;padding:4px}
#sre-login .sl-status .sl-dot{width:6px;height:6px;border-radius:50%;background:#17654f;flex-shrink:0}
#sre-login .sl-notice{display:flex;gap:9px;align-items:flex-start;font-size:14px;line-height:1.6;padding:12px;border-radius:8px;border:1px solid #cfe5d8;background:#e3f1e8;color:#0e4a35;margin-bottom:17px}
#sre-login .sl-notice .sl-icon{width:17px;height:17px;margin-top:2px}
#sre-login .sl-notice[data-tone="amber"]{background:var(--sre-amber-bg);border-color:#f0cba9;color:#66310e}
#sre-login .sl-message{font-size:14px;line-height:1.6;background:#e3f1e8;border:1px solid #cfe5d8;border-radius:8px;padding:12px;margin-top:17px;color:#0e4a35}
#sre-login .sl-message[data-tone="red"]{background:var(--sre-red-bg);color:var(--sre-red);border-color:#e5c7c1}
#sre-login .sl-footer{border-top:1px solid #ece4d2;width:100%;max-width:1292px;margin:0 auto;padding:22px 30px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:13px;color:#5c5646;font-size:13px}
#sre-login .sl-footer>span{display:flex;gap:9px;align-items:center}
#sre-login .sl-footer .sl-icon{width:16px;height:16px}
#sre-login .sl-dialog-host{position:absolute;inset:0;background:#0e3b2e8c;z-index:30;display:flex;align-items:center;justify-content:center;padding:26px}
#sre-login .sl-dialog{width:min(460px,100%);max-height:calc(100dvh - 52px);overflow:auto;overscroll-behavior:contain;border:1px solid #ece4d2;background:white;color:var(--sre-ink);border-radius:15px;padding:27px;box-shadow:0 20px 90px #0e3b2e24}
#sre-login .sl-dialog-head{display:flex;gap:15px;align-items:start;justify-content:space-between;margin-bottom:15px}
#sre-login .sl-dialog h3{font-size:21px;font-weight:650;line-height:1.4;letter-spacing:-.3px}
#sre-login .sl-dialog .sl-close{width:44px;height:44px;border:1px solid var(--sre-border);border-radius:7px;background:#f9f5ec;display:grid;place-items:center;flex-shrink:0;margin-top:-8px;margin-right:-8px}
#sre-login .sl-dialog p{font-size:14px;line-height:1.75;color:var(--sre-muted);white-space:pre-line}
#sre-login .sl-dialog .sl-submit{margin-top:22px}
#sre-login:lang(ta) .sl-hero{font-size:clamp(29px,3.1vw,42px);letter-spacing:-.3px;line-height:1.5}
#sre-login:lang(ta) .sl-login-card h1,#sre-login:lang(ta) .sl-login-card h2{font-size:25px;line-height:1.5;letter-spacing:0}
#sre-login:lang(ta) .sl-eyebrow,#sre-login:lang(ta) .sl-login-kicker{letter-spacing:0;line-height:1.7;font-size:13px}
#sre-login:lang(ta) .sl-intro-copy{font-size:15px;line-height:1.95}
@media(min-width:1300px){#sre-login .sl-main{gap:115px;padding-top:64px;padding-bottom:78px}}
@media(max-width:900px){#sre-login .sl-topbar{padding:23px 30px}#sre-login .sl-main{padding:35px 30px 46px;gap:35px;grid-template-columns:minmax(0,1fr) minmax(318px,1fr)}#sre-login .sl-login-card{padding:28px}#sre-login .sl-hero{font-size:42px;letter-spacing:-1.6px}#sre-login .sl-intro-copy{font-size:15px}#sre-login .sl-workspace-head{padding:16px}#sre-login .sl-three{padding:18px 8px}#sre-login .sl-illustration{padding-left:9px}}
@media(max-width:720px){#sre-login .sl-topbar{padding:22px 22px 20px}#sre-login .sl-top-actions{gap:12px}#sre-login .sl-top-help{display:none}#sre-login .sl-main{display:block;padding:22px 22px 37px;max-width:490px}#sre-login .sl-intro{display:none}#sre-login .sl-login-area{max-width:none}#sre-login .sl-login-card{padding:29px 28px 24px}#sre-login .sl-footer{margin:0 22px;padding:18px 0;justify-content:center;text-align:center;flex-direction:column;gap:6px;width:auto}}
@media(max-width:390px){#sre-login .sl-topbar{padding:19px 15px;gap:10px}#sre-login .sl-mark{width:39px;height:39px;font-size:26px;border-radius:10px}#sre-login .sl-brand{gap:8px}#sre-login .sl-brand-name{font-size:19px}#sre-login .sl-brand-name small{font-size:12.5px;letter-spacing:1px}#sre-login .sl-language button{padding:7px 9px;min-height:44px}#sre-login .sl-main{padding:12px 14px 27px}#sre-login .sl-login-card{padding:25px 21px 21px}#sre-login .sl-login-card h1,#sre-login .sl-login-card h2{font-size:28px}#sre-login .sl-store{padding:12px 10px;gap:8px}#sre-login .sl-store .sl-mode{display:none}#sre-login input::placeholder{font-size:14px}#sre-login .sl-password{padding-right:60px!important}#sre-login .sl-reveal{min-width:48px}}
@media(prefers-reduced-motion:reduce){#sre-login *{scroll-behavior:auto!important}}
`;

/**
 * Batch 18a · OB-855 (owner, 19 Nov 2026: one language at a time, the choice remembered on the device): the store computer's
 * sign-in page switches language with two radio buttons (`#sl-lang-en`, `#sl-lang-ta`) and no script of its own. This small
 * script opens the page in the language last chosen on THIS device — the same key (`sre.lang`) the hosted sign-in and the
 * office pages use — and remembers each press. With no script, or an empty or refused store, the page is simply English.
 */
export const SIGN_IN_LANGUAGE_MEMORY_SCRIPT = '<script>(function(){var K="sre.lang";'
  + 'var en=document.getElementById("sl-lang-en"),ta=document.getElementById("sl-lang-ta");if(!en||!ta)return;'
  + 'var set=function(v){document.documentElement.lang=v;};'
  + 'try{if(window.localStorage.getItem(K)==="ta"){ta.checked=true;set("ta");}}catch(e){}'
  + 'var save=function(v){set(v);try{window.localStorage.setItem(K,v);}catch(e){}};'
  + 'en.addEventListener("change",function(){if(en.checked)save("en");});ta.addEventListener("change",function(){if(ta.checked)save("ta");});'
  + '})();</script>';
