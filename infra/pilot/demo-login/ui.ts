// The sign-in page in the owner's approved design (UX-3 · OB-18, 5 October 2026): a light sage canvas, the S+ mark, a
// restrained stripe above a white card, labelled inputs and ONE primary "Sign in" — the design pack's markup, styles and
// bilingual copy carried onto the REAL sign-in service, with every sample state removed. What the page says about the
// connection is the server's truth (this is the hosted, online copy; the store computer's own status is read inside the
// workspace after sign-in — RL-2), never a sample. No external asset is fetched: the stylesheet and the script are served
// by this same service under a content hash, the icons are inline SVG, the fonts are the system's (with Tamil coverage).
//
// Progressive by design: the form posts and validates with no script at all (keyboard submission, native focus, the
// `required` attributes); the script adds the language switch, show/hide password, the Caps Lock hint, the help and
// connection dialogs, and the pending-submit guard. Nothing here authenticates — the handler in login.ts does, exactly as
// before (same-site POST, scrypt, lockout, one generic answer for a wrong password and an unknown login).

import { createHash } from 'node:crypto';
import { DEMO_BANNER_TEXT_EN, DEMO_BANNER_TEXT_TA } from '../../../packages/ui/src/demo-banner';
import { SIGN_IN_CSS } from '../../../packages/ui/src/sign-in-style';

export type Lang = 'en' | 'ta';

/** Every word on the page, in both languages (72-key parity is a test). */
export const LOGIN_COPY = {
  en: {
    strip: DEMO_BANNER_TEXT_EN,
    languageLabel: 'Language', workspaceLabel: 'SRE store workspace', help: 'Help',
    eyebrow: 'YOUR EVERYDAY STORE WORKSPACE', hero1: 'Your store.', hero2: 'One workspace.',
    heroCopy: 'From the first delivery to the last bill. Bring your team and your store day together.',
    workspace: 'Store workspace', purchase: 'Purchase', inventory: 'Inventory', sales: 'Sales & cash',
    storeDesktop: 'Store desktop', onlineWorkspace: 'Online workspace',
    staffAccess: 'STAFF ACCESS', welcome: 'Welcome back.', subtitle: 'Sign in to your store workspace.',
    staffId: 'Staff ID or work email', passwordLabel: 'Password', show: 'Show', hide: 'Hide', caps: 'Caps Lock is on.',
    needHelp: 'Need help signing in?', personal: 'Use your own staff account. Sign out when you finish.',
    details: 'Details', footer: 'A clear start to every store day.', retailWorkspace: 'Retail workspace', gotIt: 'Got it',
    onlineContext: 'SRE Hyper Market', onlineSub: 'Online workspace', cloud: 'ONLINE',
    idPlaceholder: 'Enter your staff ID', passwordPlaceholder: 'Enter your password',
    signIn: 'Sign in', signingIn: 'Signing in…',
    connectionOnline: 'Online sign-in available',
    expired: 'Your session has ended. Sign in again to continue.',
    invalid: 'The sign-in details could not be verified. Check your details and try again.',
    requiredId: 'Enter your staff ID or work email.', requiredPassword: 'Enter your password.',
    helpTitle: 'Need a hand signing in?',
    helpCopy: 'Use the staff ID or work email given to you by your store administrator.\n\nFor a forgotten password, a new account or an access problem, contact your store administrator. Do not share your password.\n\nOffline access is available only when this device and your account have been authorised for it.',
    connectionTitle: 'Connection details',
    onlineCopy: 'This is the online workspace: you sign in through head office over the internet.\n\nThe store computer\'s own status — whether it is running and whether its records have synchronised — is shown inside the workspace after you sign in. A sign-in here does not say that a store computer is running or that sales can be recorded.',
    close: 'Close', showPassword: 'Show password', hidePassword: 'Hide password',
    signedInAs: 'Signed in as', accountLead: 'The product is one workspace: every screen you may open is in its left-hand rail, and the till and the handhelds are under Devices there.',
    openWorkspace: 'Open the store workspace', signOut: 'Sign out',
  },
  ta: {
    strip: DEMO_BANNER_TEXT_TA,
    languageLabel: 'மொழி', workspaceLabel: 'SRE கடைப் பணித்தளம்', help: 'உதவி',
    eyebrow: 'தினசரி கடைப் பணிகளுக்கான பணித்தளம்', hero1: 'உங்கள் கடை.', hero2: 'ஒரே பணித்தளம்.',
    heroCopy: 'முதல் சரக்கு வரவு முதல் கடைசி விற்பனை வரை. உங்கள் குழுவும் கடைப் பணிகளும் ஒரே இடத்தில்.',
    workspace: 'கடைப் பணித்தளம்', purchase: 'கொள்முதல்', inventory: 'சரக்கு இருப்பு', sales: 'விற்பனை & பணம்',
    storeDesktop: 'கடை கணினி', onlineWorkspace: 'இணையப் பணித்தளம்',
    staffAccess: 'பணியாளர் உள்நுழைவு', welcome: 'மீண்டும் வருக.', subtitle: 'உங்கள் கடைப் பணித்தளத்தில் உள்நுழையவும்.',
    staffId: 'பணியாளர் எண் அல்லது பணி மின்னஞ்சல்', passwordLabel: 'கடவுச்சொல்', show: 'காட்டு', hide: 'மறை', caps: 'Caps Lock இயக்கத்தில் உள்ளது.',
    needHelp: 'உள்நுழைய உதவி வேண்டுமா?', personal: 'உங்கள் சொந்த பணியாளர் கணக்கைப் பயன்படுத்தவும். பணி முடிந்ததும் வெளியேறவும்.',
    details: 'விவரங்கள்', footer: 'ஒவ்வொரு கடை நாளுக்கும் தெளிவான தொடக்கம்.', retailWorkspace: 'கடை நிர்வாகப் பணித்தளம்', gotIt: 'சரி',
    onlineContext: 'SRE Hyper Market', onlineSub: 'இணையப் பணித்தளம்', cloud: 'இணையம்',
    idPlaceholder: 'பணியாளர் எண்ணை உள்ளிடவும்', passwordPlaceholder: 'கடவுச்சொல்லை உள்ளிடவும்',
    signIn: 'உள்நுழைக', signingIn: 'உள்நுழைகிறது…',
    connectionOnline: 'இணைய உள்நுழைவு கிடைக்கிறது',
    expired: 'உங்கள் அமர்வு முடிந்தது. தொடர மீண்டும் உள்நுழையவும்.',
    invalid: 'உள்நுழைவு விவரங்களைச் சரிபார்க்க முடியவில்லை. விவரங்களைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.',
    requiredId: 'பணியாளர் எண் அல்லது பணி மின்னஞ்சலை உள்ளிடவும்.', requiredPassword: 'கடவுச்சொல்லை உள்ளிடவும்.',
    helpTitle: 'உள்நுழைய உதவி வேண்டுமா?',
    helpCopy: 'கடை நிர்வாகி வழங்கிய பணியாளர் எண் அல்லது பணி மின்னஞ்சலைப் பயன்படுத்தவும்.\n\nகடவுச்சொல் மறந்துவிட்டால், புதிய கணக்கு தேவைப்பட்டால் அல்லது அணுகல் சிக்கல் இருந்தால் கடை நிர்வாகியை அணுகவும். கடவுச்சொல்லைப் பகிர வேண்டாம்.\n\nஇந்தக் கணினிக்கும் உங்கள் கணக்கிற்கும் அனுமதி இருந்தால் மட்டுமே இணையமின்றி உள்நுழையலாம்.',
    connectionTitle: 'இணைப்பு விவரங்கள்',
    onlineCopy: 'இது இணையப் பணித்தளம்: தலைமை அலுவலகம் வழியாக இணையத்தில் உள்நுழைகிறீர்கள்.\n\nகடை கணினியின் நிலை — அது இயங்குகிறதா, பதிவுகள் ஒத்திசைந்தனவா — உள்நுழைந்த பிறகு பணித்தளத்தினுள் காட்டப்படும். இங்கு உள்நுழைவது கடை கணினி இயங்குகிறது என்றோ விற்பனை பதிவு செய்ய முடியும் என்றோ உறுதிப்படுத்தாது.',
    close: 'மூடு', showPassword: 'கடவுச்சொல்லைக் காட்டு', hidePassword: 'கடவுச்சொல்லை மறை',
    signedInAs: 'உள்நுழைந்தவர்', accountLead: 'இந்தத் தயாரிப்பு ஒரே பணித்தளம்: நீங்கள் திறக்கக்கூடிய ஒவ்வொரு திரையும் இடது பக்கப் பட்டியில் உள்ளது; கல்லாவும் கையடக்கக் கருவிகளும் அங்கே Devices-இன் கீழ் உள்ளன.',
    openWorkspace: 'கடைப் பணித்தளத்தைத் திறக்க', signOut: 'வெளியேறு',
  },
} as const;

export type CopyKey = keyof typeof LOGIN_COPY.en;
export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(LOGIN_COPY.en) as CopyKey[]);
const t = (key: CopyKey, lang: Lang = 'en'): string => LOGIN_COPY[lang][key];

/** Inline icons (24×24 strokes, the design pack's Lucide shapes — ISC licence, docs/design/reference/login-pack-2026-10-05/LUCIDE-LICENSE.txt) — nothing is fetched. */
const ICONS: Readonly<Record<string, string>> = {
  store: '<path d="M2 7l1.5-4h17L22 7"/><path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M4 10v11h16V10"/><path d="M9 21v-6h6v6"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  boxes: '<path d="M3 21V8l9-4 9 4v13"/><path d="M3 21h18"/><rect x="7" y="13" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/><path d="M10 9h4"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  lock: '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  arrow: '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  usercheck: '<path d="M2 21a8 8 0 0 1 13.29-6"/><circle cx="10" cy="8" r="5"/><path d="M16 19l2 2 4-4"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
};
const icon = (name: string): string =>
  `<svg class="sl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`;

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ── the stylesheet — the design pack's, scoped to #sre-login — shared with the store computer's own sign-in (batch 12) ──
export const LOGIN_CSS = SIGN_IN_CSS;

// ── the script — language, show/hide, Caps Lock, dialogs, the pending-submit guard; nothing else ────────────────
export const LOGIN_JS = `(function(){
  var root=document.getElementById('sre-login'); if(!root) return;
  var copy=${JSON.stringify(LOGIN_COPY)};
  var $=function(s){return root.querySelector(s);};
  var language='en', dialogKind=null, opener=null;
  try{ var saved=localStorage.getItem('sre.lang'); if(saved==='ta'||saved==='en') language=saved; }catch(e){}
  var t=function(key){return (copy[language]&&copy[language][key])||copy.en[key]||key;};
  var user=$('#login'), password=$('#password'), form=$('#sl-form'), submit=$('#sl-submit'), msg=$('#sl-form-message'), dialogHost=$('#sl-dialog-host'), reveal=$('#sl-reveal'), caps=$('#sl-caps');
  function showMessage(key,tone){ if(!msg) return; msg.hidden=!key; msg.textContent=key?t(key):''; if(key) msg.setAttribute('data-copy',key); else msg.removeAttribute('data-copy'); msg.dataset.tone=tone||'green'; msg.setAttribute('role',tone==='red'?'alert':'status'); }
  function renderReveal(){ if(!reveal||!password) return; var shown=password.type==='text'; reveal.textContent=t(shown?'hide':'show'); reveal.setAttribute('aria-label',t(shown?'hidePassword':'showPassword')); reveal.setAttribute('aria-pressed',String(shown)); }
  function renderDialog(){ if(!dialogKind) return; $('#sl-dialog-title').textContent=t(dialogKind==='help'?'helpTitle':'connectionTitle'); $('#sl-dialog-copy').textContent=t(dialogKind==='help'?'helpCopy':'onlineCopy'); }
  function setLanguage(next){
    language=next; root.lang=next; document.documentElement.lang=next;
    try{ localStorage.setItem('sre.lang',next); }catch(e){}
    root.querySelectorAll('[data-copy-aria]').forEach(function(el){ el.setAttribute('aria-label',t(el.getAttribute('data-copy-aria'))); });
    root.querySelectorAll('[data-copy]').forEach(function(el){ el.textContent=t(el.getAttribute('data-copy')); });
    root.querySelectorAll('[data-copy-placeholder]').forEach(function(el){ el.placeholder=t(el.getAttribute('data-copy-placeholder')); });
    root.querySelectorAll('[data-language]').forEach(function(el){ el.setAttribute('aria-pressed',String(el.getAttribute('data-language')===next)); });
    var close=$('#sl-dialog-close'); if(close) close.setAttribute('aria-label',t('close'));
    renderReveal(); renderDialog();
  }
  function setInert(on){ ['.sl-topbar','.sl-main','.sl-footer'].forEach(function(s){ var el=$(s); if(el) el.inert=on; }); }
  function closeDialog(){ if(!dialogHost) return; dialogHost.hidden=true; dialogKind=null; setInert(false); if(opener) opener.focus(); }
  root.querySelectorAll('[data-language]').forEach(function(b){ b.addEventListener('click',function(){ setLanguage(b.getAttribute('data-language')); }); });
  if(reveal&&password){ reveal.hidden=false; reveal.addEventListener('click',function(){ password.type=password.type==='password'?'text':'password'; renderReveal(); password.focus(); }); }
  if(password&&caps){
    var onCaps=function(e){ if(e.getModifierState) caps.hidden=!e.getModifierState('CapsLock'); };
    password.addEventListener('keydown',onCaps); password.addEventListener('keyup',onCaps); password.addEventListener('blur',function(){ caps.hidden=true; });
  }
  [user,password].forEach(function(el){ if(!el) return; el.addEventListener('input',function(){ el.removeAttribute('aria-invalid'); if(msg&&msg.getAttribute('data-copy')&&msg.dataset.tone==='red'&&msg.getAttribute('data-copy')!=='invalid') showMessage(''); }); });
  if(form&&submit){
    form.noValidate=true; // with the script present, the messages below replace the browser's own; without it, the required attributes still hold
    form.addEventListener('submit',function(e){
      if(submit.getAttribute('aria-busy')==='true'){ e.preventDefault(); return; }
      [user,password].forEach(function(el){ if(el) el.removeAttribute('aria-invalid'); });
      if(user&&!user.value.trim()){ e.preventDefault(); user.setAttribute('aria-invalid','true'); showMessage('requiredId','red'); user.focus(); return; }
      if(password&&!password.value){ e.preventDefault(); password.setAttribute('aria-invalid','true'); showMessage('requiredPassword','red'); password.focus(); return; }
      submit.setAttribute('aria-busy','true'); var label=$('#sl-submit-text'); if(label) label.textContent=t('signingIn');
      setTimeout(function(){ submit.removeAttribute('aria-busy'); if(label) label.textContent=t('signIn'); }, 15000);
    });
  }
  root.querySelectorAll('[data-open]').forEach(function(b){ b.addEventListener('click',function(){ if(!dialogHost) return; opener=b; dialogKind=b.getAttribute('data-open'); dialogHost.hidden=false; setInert(true); renderDialog(); $('#sl-dialog-close').focus({preventScroll:true}); }); });
  if(dialogHost){
    $('#sl-dialog-close').addEventListener('click',closeDialog); $('#sl-dialog-done').addEventListener('click',closeDialog);
    dialogHost.addEventListener('click',function(e){ if(e.target===dialogHost) closeDialog(); });
    dialogHost.addEventListener('keydown',function(e){
      if(e.key==='Escape'){ e.preventDefault(); closeDialog(); }
      if(e.key==='Tab'){ var first=$('#sl-dialog-close'), last=$('#sl-dialog-done'); if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); } else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); } }
    });
  }
  setLanguage(language);
})();
`;

const version = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
export const LOGIN_CSS_VERSION = version(LOGIN_CSS);
export const LOGIN_JS_VERSION = version(LOGIN_JS);
export const LOGIN_CSS_PATH = '/login/login.css';
export const LOGIN_JS_PATH = '/login/login.js';

/** Where this sign-in stands — the server's truth, never a sample. Today: the hosted, online copy. */
export interface SignInContext {
  readonly name: string;
  readonly subKey: CopyKey;
  readonly modeKey: CopyKey;
}
export const ONLINE_CONTEXT: SignInContext = { name: 'SRE Hyper Market', subKey: 'onlineSub', modeKey: 'cloud' };

export interface SignInView {
  readonly next: string;
  /** A refusal to show — already a generic, non-enumerating sentence. */
  readonly error?: string;
  /** True when the visitor was sent here because their session ended (the proxy adds `expired=1` when a cookie was present). */
  readonly expired?: boolean;
  readonly context?: SignInContext;
}

const brand = (): string => `<div class="sl-brand" aria-label="SRE Hyper Market">
<div class="sl-mark" aria-hidden="true">S<span>+</span></div>
<div class="sl-brand-name">SRE<small>HYPER MARKET</small></div>
</div>`;

const topbar = (): string => `<header class="sl-topbar">
${brand()}
<div class="sl-top-actions">
<div class="sl-language" role="group" aria-label="${t('languageLabel')}" data-copy-aria="languageLabel">
<button type="button" data-language="en" lang="en" aria-pressed="true">English</button>
<button type="button" data-language="ta" lang="ta" aria-pressed="false">தமிழ்</button>
</div>
<button class="sl-text-button sl-top-help" data-open="help" type="button">${icon('help')}<span data-copy="help">${t('help')}</span></button>
</div>
</header>`;

const intro = (): string => `<section class="sl-intro" aria-label="${t('workspaceLabel')}" data-copy-aria="workspaceLabel">
<div class="sl-eyebrow" data-copy="eyebrow">${t('eyebrow')}</div>
<p class="sl-hero"><span class="sl-hero-ink" data-copy="hero1">${t('hero1')}</span><span data-copy="hero2">${t('hero2')}</span></p>
<p class="sl-intro-copy" data-copy="heroCopy">${t('heroCopy')}</p>
<div class="sl-illustration" aria-hidden="true">
<div class="sl-workspace">
<div class="sl-workspace-head"><div class="sl-workspace-icon">${icon('store')}</div><div><strong>SRE Hyper Market</strong><small data-copy="workspace">${t('workspace')}</small></div></div>
<div class="sl-three">
<div>${icon('cart')}<span data-copy="purchase">${t('purchase')}</span></div>
<div>${icon('boxes')}<span data-copy="inventory">${t('inventory')}</span></div>
<div>${icon('receipt')}<span data-copy="sales">${t('sales')}</span></div>
</div>
</div>
<div class="sl-illustration-label">${icon('monitor')}<span data-copy="storeDesktop">${t('storeDesktop')}</span><span>·</span>${icon('cloud')}<span data-copy="onlineWorkspace">${t('onlineWorkspace')}</span></div>
</div>
</section>`;

const footer = (): string => `<footer class="sl-footer"><span>${icon('leaf')}<span data-copy="footer">${t('footer')}</span></span><span>SRE Hyper Market<span aria-hidden="true">·</span><span data-copy="retailWorkspace">${t('retailWorkspace')}</span></span></footer>`;

const dialog = (): string => `<div id="sl-dialog-host" class="sl-dialog-host" hidden>
<section class="sl-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-dialog-title" aria-describedby="sl-dialog-copy">
<div class="sl-dialog-head"><h3 id="sl-dialog-title"></h3><button id="sl-dialog-close" type="button" class="sl-close" aria-label="${t('close')}">${icon('x')}</button></div>
<p id="sl-dialog-copy"></p><button id="sl-dialog-done" class="sl-submit" type="button" data-copy="gotIt">${t('gotIt')}</button>
</section>
</div>`;

/** The whole document: the practice strip, the top bar, the two-column main, the footer, the dialog host. */
function shell(title: string, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — SRE Hyper Market</title>
<link rel="stylesheet" href="${LOGIN_CSS_PATH}?v=${LOGIN_CSS_VERSION}">
</head><body>
<div id="sre-login" lang="en">
<div class="sl-strip" role="status" data-copy="strip">${esc(t('strip'))}</div>
<div class="sl-product">
${topbar()}
<main class="sl-main">
${intro()}
${main}
</main>
${footer()}
${dialog()}
</div>
</div>
<script src="${LOGIN_JS_PATH}?v=${LOGIN_JS_VERSION}" defer></script>
</body></html>`;
}

const contextBox = (c: SignInContext): string => `<div class="sl-store">
${icon('store')}
<div><strong id="sl-context-name">${esc(c.name)}</strong><small id="sl-context-sub" data-copy="${c.subKey}">${t(c.subKey)}</small></div>
<span class="sl-mode" id="sl-context-mode" data-copy="${c.modeKey}">${t(c.modeKey)}</span>
</div>`;

const connectionLine = (): string => `<div class="sl-status" id="sl-connection-status" data-tone="green"><span class="sl-dot" aria-hidden="true"></span><span id="sl-connection-text" data-copy="connectionOnline">${t('connectionOnline')}</span><button type="button" data-open="connection" data-copy="details">${t('details')}</button></div>`;

/** The sign-in card. The form works with no script: `required`, native focus, Enter submits. */
export function renderSignIn(view: SignInView): string {
  const context = view.context ?? ONLINE_CONTEXT;
  const notice = view.expired === true
    ? `<div id="sl-state-notice" class="sl-notice" data-tone="amber">${icon('info')}<span id="sl-state-text" data-copy="expired">${t('expired')}</span></div>`
    : '';
  // The refusal is the handler's own generic sentence; when it IS the generic one, the language switch translates it.
  const message = view.error === undefined
    ? '<div id="sl-form-message" class="sl-message" role="status" aria-live="polite" hidden></div>'
    : `<div id="sl-form-message" class="sl-message" role="alert" data-tone="red"${view.error === t('invalid') ? ' data-copy="invalid"' : ''}>${esc(view.error)}</div>`;
  return shell(t('signIn'), `<section class="sl-login-area" aria-labelledby="sl-welcome">
<div class="sl-login-card">
<div class="sl-login-kicker">${icon('login')}<span data-copy="staffAccess">${t('staffAccess')}</span></div>
<h1 id="sl-welcome" data-copy="welcome">${t('welcome')}</h1>
<p class="sl-subtitle" data-copy="subtitle">${t('subtitle')}</p>
${contextBox(context)}
${notice}
<form id="sl-form" method="post" action="/login/">
<input type="hidden" name="next" value="${esc(view.next)}">
<div class="sl-field">
<label for="login" data-copy="staffId">${t('staffId')}</label>
<div class="sl-input-wrap">${icon('user')}<input id="login" name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${t('idPlaceholder')}" data-copy-placeholder="idPlaceholder" aria-describedby="sl-form-message" required${view.error === undefined ? '' : ' aria-invalid="true"'}></div>
</div>
<div class="sl-field">
<label for="password" data-copy="passwordLabel">${t('passwordLabel')}</label>
<div class="sl-input-wrap">${icon('lock')}<input id="password" name="password" class="sl-password" type="password" autocomplete="current-password" placeholder="${t('passwordPlaceholder')}" data-copy-placeholder="passwordPlaceholder" aria-describedby="sl-caps sl-form-message" required><button id="sl-reveal" class="sl-reveal" type="button" aria-label="${t('showPassword')}" aria-pressed="false" hidden>${t('show')}</button></div>
<p id="sl-caps" class="sl-caps" hidden data-copy="caps">${t('caps')}</p>
</div>
${message}
<button id="sl-submit" class="sl-submit" type="submit"><span id="sl-submit-text" data-copy="signIn">${t('signIn')}</span>${icon('arrow')}</button>
</form>
<div class="sl-help-row"><button type="button" data-open="help" class="sl-text-button" data-copy="needHelp">${t('needHelp')}</button></div>
<div class="sl-personal">${icon('usercheck')}<span data-copy="personal">${t('personal')}</span></div>
</div>
${connectionLine()}
</section>`);
}

/** The account page for somebody already signed in: who they are, the one way into the product, sign out. */
export function renderAccount(who: string, landing: string): string {
  return shell('Your account', `<section class="sl-login-area" aria-labelledby="sl-welcome">
<div class="sl-login-card">
<div class="sl-login-kicker">${icon('usercheck')}<span data-copy="staffAccess">${t('staffAccess')}</span></div>
<h1 id="sl-welcome"><span data-copy="signedInAs">${t('signedInAs')}</span> ${esc(who)}</h1>
<p class="sl-subtitle" data-copy="accountLead">${t('accountLead')}</p>
${contextBox(ONLINE_CONTEXT)}
<a class="sl-submit" href="${esc(landing)}"><span data-copy="openWorkspace">${t('openWorkspace')}</span>${icon('arrow')}</a>
<form method="post" action="/login/logout"><button type="submit" class="sl-secondary" data-copy="signOut">${t('signOut')}</button></form>
</div>
${connectionLine()}
</section>`);
}

/** A plain page in the same shell — a refusal (a cross-site post) or a miss: no form, nothing echoed but our own sentence. */
export function renderPlain(title: string, sentence: string): string {
  return shell(title, `<section class="sl-login-area"><div class="sl-login-card"><h1>${esc(title)}</h1><div class="sl-message" role="alert" data-tone="red">${esc(sentence)}</div><p class="sl-help-row"><a class="sl-text-button" href="/login/" data-copy="signIn">${t('signIn')}</a></p></div></section>`);
}
