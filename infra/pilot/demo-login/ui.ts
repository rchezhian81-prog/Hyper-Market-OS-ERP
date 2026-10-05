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

// ── the stylesheet — the design pack's, scoped to #sre-login, with the preview removed ──────────────────────
export const LOGIN_CSS = `
html,body{margin:0;min-height:100%}
body{background:#f5f7f2}
#sre-login{--sre-canvas:#f5f7f2;--sre-surface:#ffffff;--sre-ink:#193b31;--sre-muted:#586e61;--sre-green:#17654f;--sre-deep:#143f32;--sre-sage:#eaf0e1;--sre-border:#dce4d9;--sre-field:#fcfdfb;--sre-amber:#86571b;--sre-amber-bg:#fbf4e7;--sre-red:#a13932;--sre-red-bg:#fcf0ec;color-scheme:light;font:16px/1.55 Inter,"Segoe UI","Noto Sans Tamil","Nirmala UI","Latha",Arial,sans-serif;color:var(--sre-ink);background:var(--sre-canvas);width:100%;min-height:100vh;isolation:isolate;display:flex;flex-direction:column}
#sre-login *{box-sizing:border-box}
#sre-login h1,#sre-login h2,#sre-login h3,#sre-login p{margin:0}
#sre-login button,#sre-login input{font:inherit}
#sre-login button{color:inherit;cursor:pointer}
#sre-login button,#sre-login a{touch-action:manipulation}
#sre-login button:disabled{cursor:not-allowed}
#sre-login [hidden]{display:none!important}
#sre-login .sl-icon{width:20px;height:20px;flex-shrink:0}
#sre-login :focus-visible{outline:3px solid #0f4c3a;outline-offset:2px}
#sre-login .sl-strip{background:var(--sre-amber-bg);color:#5a3e14;border-bottom:1px solid #e8d7b8;font-size:14px;font-weight:700;letter-spacing:.4px;text-align:center;padding:7px 16px}
#sre-login .sl-product{position:relative;overflow:hidden;flex:1;display:flex;flex-direction:column}
#sre-login .sl-topbar{width:100%;max-width:1400px;margin:0 auto;padding:29px 54px;display:flex;align-items:center;justify-content:space-between;gap:20px}
#sre-login .sl-brand{display:flex;align-items:center;gap:13px;text-decoration:none;color:var(--sre-ink)}
#sre-login .sl-mark{width:47px;height:47px;border-radius:13px;display:flex;align-items:center;justify-content:center;background:var(--sre-deep);color:#fff;font:750 31px/1 "Segoe UI",Arial,sans-serif;position:relative;padding-right:4px;flex-shrink:0}
#sre-login .sl-mark span{position:absolute;right:7px;top:7px;font-size:12.5px;font-weight:600;color:#ccdda5}
#sre-login .sl-brand-name{font-size:22px;line-height:1.1;font-weight:750;letter-spacing:.4px}
#sre-login .sl-brand-name small{display:block;margin-top:6px;font-size:12.5px;font-weight:700;letter-spacing:1.6px;color:var(--sre-muted)}
#sre-login .sl-top-actions{display:flex;align-items:center;gap:25px}
#sre-login .sl-language{display:flex;align-items:center;padding:3px;border:1px solid var(--sre-border);border-radius:9px;background:#edf1e8}
#sre-login .sl-language button{border:0;background:transparent;min-height:44px;padding:7px 13px;font-size:14px;color:var(--sre-muted);border-radius:6px}
#sre-login .sl-language button[aria-pressed="true"]{background:#fff;color:var(--sre-deep);font-weight:650;box-shadow:0 1px 4px #193b3112}
#sre-login .sl-text-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:transparent;border:0;min-height:44px;font-size:14px;padding:8px 0;color:var(--sre-green);text-align:center;text-decoration:none}
#sre-login .sl-top-help{color:var(--sre-muted)}
#sre-login .sl-main{width:100%;max-width:1236px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.02fr) minmax(330px,.98fr);gap:76px;align-items:center;padding:49px 54px 66px;flex:1}
#sre-login .sl-intro{max-width:490px;padding:13px 0}
#sre-login .sl-eyebrow{display:flex;align-items:center;gap:10px;font-size:12.5px;letter-spacing:1.8px;font-weight:700;color:#5e7452;text-transform:uppercase;margin-bottom:23px}
#sre-login .sl-eyebrow:before{content:"";width:24px;height:2px;background:#8da578}
#sre-login .sl-hero{font-size:clamp(38px,4.4vw,58px);font-weight:650;letter-spacing:-2.5px;line-height:1.12;max-width:480px}
#sre-login .sl-hero span{display:block;color:#68825b;margin-top:5px}
#sre-login .sl-hero span.sl-hero-ink{color:var(--sre-ink);margin:0}
#sre-login .sl-intro-copy{margin-top:23px;font-size:17px;line-height:1.75;color:var(--sre-muted);max-width:385px}
#sre-login .sl-illustration{margin-top:43px;width:min(100%,410px);position:relative;padding:0 0 20px 15px}
#sre-login .sl-illustration:before{content:"";position:absolute;inset:19px 16px 0 0;border:1px solid #d6dfce;border-radius:17px;background:#e8efdf}
#sre-login .sl-workspace{position:relative;background:#fff;border:1px solid #d8e2d4;border-radius:16px;overflow:hidden;box-shadow:0 15px 40px -28px #28413145}
#sre-login .sl-workspace-head{display:flex;align-items:center;gap:11px;padding:19px 20px;border-bottom:1px solid #e7ece2}
#sre-login .sl-workspace-icon{width:39px;height:39px;border-radius:10px;display:grid;place-items:center;background:#eef3e9;color:var(--sre-green)}
#sre-login .sl-workspace-head strong{display:block;font-size:14px;font-weight:650}
#sre-login .sl-workspace-head small{display:block;color:var(--sre-muted);font-size:13px;margin-top:1px}
#sre-login .sl-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:22px 12px 24px;gap:6px}
#sre-login .sl-three div{display:flex;align-items:center;flex-direction:column;gap:11px;color:var(--sre-green);text-align:center}
#sre-login .sl-three div+div{border-left:1px solid #e4eadd}
#sre-login .sl-three span{font-size:13px;color:#496551;font-weight:550;line-height:1.35}
#sre-login .sl-illustration-label{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:#586e47;padding:15px 10px 0}
#sre-login .sl-illustration-label .sl-icon{width:16px;height:16px}
#sre-login .sl-login-area{width:100%;max-width:451px;justify-self:end}
#sre-login .sl-login-card{background:#fff;border:1px solid #dbe3d7;border-radius:19px;padding:31px 34px 26px;box-shadow:0 14px 48px -30px #203c313b;position:relative;overflow:hidden}
#sre-login .sl-login-card:before{content:"";height:3px;position:absolute;top:0;left:34px;right:34px;background:linear-gradient(90deg,#1b6551 0%,#1b6551 68%,#b8cba1 68%,#b8cba1 90%,#e6eddd 90%);border-radius:0 0 5px 5px}
#sre-login .sl-login-kicker{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:650;letter-spacing:1.4px;text-transform:uppercase;color:#667d5a;margin-bottom:17px}
#sre-login .sl-login-kicker .sl-icon{width:16px;height:16px}
#sre-login .sl-login-card h1,#sre-login .sl-login-card h2{font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-.8px}
#sre-login .sl-subtitle{color:var(--sre-muted);font-size:14px;margin-top:10px;line-height:1.6}
#sre-login .sl-store{display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid #e2e8dc;border-radius:9px;background:#f7f9f3;margin:23px 0}
#sre-login .sl-store>.sl-icon{width:22px;height:22px;color:var(--sre-green)}
#sre-login .sl-store strong{font-size:14px;font-weight:650;display:block}
#sre-login .sl-store small{font-size:14px;color:var(--sre-muted);display:block;margin-top:2px}
#sre-login .sl-store .sl-mode{margin-left:auto;color:#4f6244;background:#eaf0e2;border-radius:5px;padding:3px 7px;font-size:12.5px;letter-spacing:.6px;white-space:nowrap;align-self:flex-start}
#sre-login .sl-field{margin-top:18px}
#sre-login .sl-field label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}
#sre-login .sl-input-wrap{position:relative}
#sre-login .sl-input-wrap>.sl-icon{position:absolute;left:14px;top:17px;color:#6d8174;width:18px;height:18px;pointer-events:none}
#sre-login input[type="text"],#sre-login input[type="password"]{display:block;appearance:none;width:100%;height:53px;border:1px solid #819483;border-radius:8px;background:var(--sre-field);color:var(--sre-ink);padding:12px 43px;font-size:16px;line-height:1.4;box-shadow:none;min-width:0}
#sre-login input::placeholder{color:#586e61;opacity:1;font-size:15px}
#sre-login input:disabled{background:#f1f3ee;color:#6c776b}
#sre-login input[aria-invalid="true"]{border-color:var(--sre-red)}
#sre-login .sl-password{padding-right:68px!important}
#sre-login .sl-reveal{position:absolute;right:4px;top:4px;height:45px;min-width:55px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--sre-green);font-size:14px;font-weight:600;border-radius:5px}
#sre-login .sl-caps{font-size:14px;color:var(--sre-amber);margin-top:7px}
#sre-login .sl-submit{display:flex;align-items:center;justify-content:center;gap:11px;width:100%;min-height:53px;border:1px solid var(--sre-green);border-radius:8px;background:var(--sre-green);color:#fff;font-size:15px;font-weight:650;margin-top:25px;padding:13px 17px;box-shadow:0 3px 6px -4px #0c443160;text-decoration:none}
#sre-login .sl-submit:hover:not(:disabled){background:#104d3c;border-color:#104d3c}
#sre-login .sl-submit:disabled,#sre-login .sl-submit[aria-busy="true"]{background:#dfe6dc;border-color:#dfe6dc;color:#56674f;box-shadow:none}
#sre-login .sl-submit .sl-icon{width:18px;height:18px}
#sre-login .sl-secondary{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:12px;border:1px solid var(--sre-green);border-radius:8px;background:#fff;color:var(--sre-green);font-size:14px;font-weight:600}
#sre-login .sl-help-row{display:flex;justify-content:center;margin-top:10px}
#sre-login .sl-help-row button{font-size:14px;min-height:44px}
#sre-login .sl-personal{border-top:1px solid #e6eadf;margin-top:15px;padding-top:18px;display:flex;align-items:flex-start;gap:9px;color:var(--sre-muted);font-size:14px;line-height:1.6}
#sre-login .sl-personal .sl-icon{width:16px;height:16px;margin-top:2px}
#sre-login .sl-status{margin:17px 2px 0;display:flex;align-items:center;gap:9px;justify-content:center;flex-wrap:wrap;color:#506a53;font-size:14px;line-height:1.5;text-align:center}
#sre-login .sl-status button{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:inherit;border:0;background:transparent;font-size:14px;text-decoration:underline;text-underline-offset:4px;min-height:44px;padding:4px}
#sre-login .sl-status .sl-dot{width:6px;height:6px;border-radius:50%;background:#62805b;flex-shrink:0}
#sre-login .sl-notice{display:flex;gap:9px;align-items:flex-start;font-size:14px;line-height:1.6;padding:12px;border-radius:8px;border:1px solid #d7e3d1;background:#f1f7eb;color:#31563b;margin-bottom:17px}
#sre-login .sl-notice .sl-icon{width:17px;height:17px;margin-top:2px}
#sre-login .sl-notice[data-tone="amber"]{background:var(--sre-amber-bg);border-color:#e8d7b8;color:#704b1d}
#sre-login .sl-message{font-size:14px;line-height:1.6;background:#f0f5ed;border:1px solid #d6e3ce;border-radius:8px;padding:12px;margin-top:17px;color:#31563b}
#sre-login .sl-message[data-tone="red"]{background:var(--sre-red-bg);color:var(--sre-red);border-color:#e5c7c1}
#sre-login .sl-footer{border-top:1px solid #e0e7d8;width:100%;max-width:1292px;margin:0 auto;padding:22px 30px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:13px;color:#627257;font-size:13px}
#sre-login .sl-footer>span{display:flex;gap:9px;align-items:center}
#sre-login .sl-footer .sl-icon{width:16px;height:16px}
#sre-login .sl-dialog-host{position:absolute;inset:0;background:#19382f6b;z-index:30;display:flex;align-items:center;justify-content:center;padding:26px}
#sre-login .sl-dialog{width:min(460px,100%);max-height:calc(100dvh - 52px);overflow:auto;overscroll-behavior:contain;border:1px solid #d7e1d2;background:white;color:var(--sre-ink);border-radius:15px;padding:27px;box-shadow:0 20px 90px #1c3b2b24}
#sre-login .sl-dialog-head{display:flex;gap:15px;align-items:start;justify-content:space-between;margin-bottom:15px}
#sre-login .sl-dialog h3{font-size:21px;font-weight:650;line-height:1.4;letter-spacing:-.3px}
#sre-login .sl-dialog .sl-close{width:44px;height:44px;border:1px solid var(--sre-border);border-radius:7px;background:#f5f8f0;display:grid;place-items:center;flex-shrink:0;margin-top:-8px;margin-right:-8px}
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
