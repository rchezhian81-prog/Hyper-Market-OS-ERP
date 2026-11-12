// The one chrome every ERP page carries (Stage G slice 5a · OB-13 UX-1a · design system §1 rules 4 and 6, §7 · P-08).
//
// Forty-nine pages, one product. Before this each page drew its own header line, its own "served from cache"
// strip, its own language toggle with one of two labels — and most of them had no sync badge at all, so a manager
// could work a page for an hour with no word on whether the store computer was even reachable (design system §1
// rule 4: EVERY screen shows connection state and last-sync freshness). This file is that badge, that strip and
// that toggle, once, loaded after each page's own script so the page's words come first and the chrome finishes
// the frame. Since OB-13 it is also the back office's shell: the rail down the left of every page.
//
// What it owns:
//   • the sync badge — the store computer's own account of itself (`GET /lane/sync-status` at the address the
//     page was served from; never a guessed one), in words as well as a dot, every ten seconds;
//   • the "served from this device's cache, at …" strip (the service worker stamps `window.shellCachedAt`);
//   • the language toggle's label and name — the OTHER language, so the button says what you get;
//   • the menu — the screens THIS person may open on THIS store computer, as the box worked them out from its
//     role register (`window.sreNavigation`, Stage G slice 5b · §27 role surfaces · P-07) — drawn as the RAIL of
//     the owner's look (OB-13): on a desk it stands open down the left of the page; on a phone it is a drawer the
//     ☰ button opens and Escape closes. Nothing when a page was opened off the box, and a stated reason when the
//     box could name nobody or holds no register;
//   • opening the tab a menu link asked for (`?tab=…`) on a page that has that tab;
//   • the icons beside the chrome's words (OB-201): which shape of the ONE set (sre-icons.js) fits each workspace,
//     each screen on the rail and each control — always with its word, never instead of it;
//   • repainting all of it whenever `<html lang>` changes, however the page changed it.
// What it does not own: the page's words. A page keeps its own `en` / `ta` tables and its own toggle handler.
//
// Framework-free and static (§19), like every shell in this folder: it opens with the shop's wifi down.

(() => {
  const WORDS = {
    en: {
      staleShell: 'No connection to the store computer. This page is what it was last told, at',
      notConnected: 'Not connected to the store computer', checkingBox: 'Checking the store computer…',
      connected: 'Connected', boxNotAnswering: 'Store computer not answering',
      noCloud: 'Head office cannot be reached — working from the store computer',
      cloudLoginRefused: 'This store computer\'s head office login needs renewing', cloudNotSetUp: 'No head office link on this store computer', cloudUnknown: 'Head office not checked yet',
      lastContact: 'last contact', switchLanguage: 'Switch language', otherLanguage: 'தமிழ்',
      screens: 'Screens', screensFor: 'Screens for', workspace: 'Store workspace', closeScreens: 'Close the screens list',
      newVersion: 'A newer version of this screen has arrived. Reload when you are ready.', reload: 'Reload',
      noUser: 'Nobody is named on this screen, so no other screens can be offered.',
      noRoles: 'This store computer has no role register, so no screens can be offered.',
      inList: '{n} in the list',
      workspaceWord: 'Workspace', branchWorkspace: 'Branch workspace', findScreen: 'Find a screen', noScreenMatches: 'No screen matches',
      findScreenHint: 'Find a screen — type a word like cash, GST or expiry', matchesOne: '1 screen matches', matchesMany: '{n} screens match',
      pinned: 'Pinned', recent: 'Recently opened', pinPage: 'Pin this page', unpinPage: 'Unpin this page',
      signOut: 'Sign out',
      storeAlarm: 'The store computer needs you',
      storeCopy: 'These figures are the store computer\'s copy of head office\'s records, as head office last sent it at {at} ({age}). Anything changed at head office since then is not shown yet.',
      storeCopyNone: 'Head office has not sent this store computer its records yet, so this page shows only what the store computer itself knows.',
      ageJustNow: 'just now', ageMinutes: '{n} minute(s) old', ageHours: '{n} hour(s) old', ageDays: '{n} day(s) old',
    },
    ta: {
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
      notConnected: 'கடை கணினியுடன் இணைப்பு இல்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
      connected: 'இணைப்பில்', boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை',
      noCloud: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — கடை கணினியிலிருந்து வேலை',
      cloudLoginRefused: 'இந்தக் கடை கணினியின் தலைமை அலுவலக உள்நுழைவைப் புதுப்பிக்க வேண்டும்', cloudNotSetUp: 'இந்தக் கடை கணினியில் தலைமை அலுவலக இணைப்பு இல்லை', cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை',
      lastContact: 'கடைசித் தொடர்பு', switchLanguage: 'மொழியை மாற்று', otherLanguage: 'English',
      screens: 'திரைகள்', screensFor: 'இவருக்கான திரைகள்', workspace: 'கடை பணியிடம்', closeScreens: 'திரைகள் பட்டியலை மூடு',
      newVersion: 'இந்தத் திரையின் புதிய பதிப்பு வந்துள்ளது. தயாரானதும் மீண்டும் ஏற்றவும்.', reload: 'மீண்டும் ஏற்று',
      noUser: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை, எனவே வேறு திரைகள் வழங்க முடியாது.',
      noRoles: 'இந்தக் கடை கணினியில் பங்கு பதிவேடு இல்லை, எனவே திரைகள் வழங்க முடியாது.',
      inList: 'பட்டியலில் {n}',
      workspaceWord: 'பணியிடம்', branchWorkspace: 'கிளைப் பணியிடம்', findScreen: 'ஒரு திரையைத் தேடு', noScreenMatches: 'பொருந்தும் திரை இல்லை',
      findScreenHint: 'திரையைத் தேடு — பணம், ஜிஎஸ்டி, காலாவதி போன்ற சொல்லைத் தட்டச்சு செய்க', matchesOne: '1 திரை பொருந்துகிறது', matchesMany: '{n} திரைகள் பொருந்துகின்றன',
      pinned: 'மேலே வைத்தவை', recent: 'சமீபத்தில் திறந்தவை', pinPage: 'இந்தப் பக்கத்தை மேலே வை', unpinPage: 'மேலிருந்து எடு',
      signOut: 'வெளியேறு',
      storeAlarm: 'கடை கணினிக்கு உங்கள் கவனம் தேவை',
      storeCopy: 'இந்த எண்கள் தலைமை அலுவலகப் பதிவுகளின் கடைக் கணினி நகல் — தலைமை அலுவலகம் கடைசியாக {at} அன்று அனுப்பியது ({age}). அதன் பிறகு தலைமை அலுவலகத்தில் மாறியவை இன்னும் காட்டப்படவில்லை.',
      storeCopyNone: 'தலைமை அலுவலகம் தன் பதிவுகளை இந்தக் கடைக் கணினிக்கு இன்னும் அனுப்பவில்லை, எனவே இந்தப் பக்கம் கடைக் கணினிக்குத் தெரிந்ததை மட்டுமே காட்டுகிறது.',
      ageJustNow: 'இப்போதுதான்', ageMinutes: '{n} நிமிடம் பழையது', ageHours: '{n} மணி நேரம் பழையது', ageDays: '{n} நாள் பழையது',
    },
  };
  const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
  const t = (key) => WORDS[lang()][key] ?? WORDS.en[key];
  const byId = (id) => document.getElementById(id);

  // ── The badge's place in the header: reuse what a page already has, create what it lacks ──────────
  function badgeElements() {
    const header = document.querySelector('header');
    if (!header) return null;
    let sync = header.querySelector('.sync');
    if (!sync) {
      sync = document.createElement('span');
      sync.className = 'sync';
      header.append(sync);
    }
    let dot = byId('conn-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'dot';
      dot.id = 'conn-dot';
      dot.title = 'Store link';
      sync.prepend(dot);
    }
    let text = byId('conn-text');
    if (!text) {
      text = document.createElement('span');
      text.id = 'conn-text';
      dot.after(text);
    }
    // OB-201: the dot and its words are one chip in the state's tone — the dot carries the state's shape from the one
    // icon set, the words stay exactly the words. Same elements, same ids; they are only held together.
    let badge = byId('sre-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'sre-badge';
      badge.className = 'sre-badge';
      dot.before(badge);
      badge.append(dot, text);
    }
    if (window.sreIcon && typeof window.sreIcon.statusDot === 'function') window.sreIcon.statusDot(dot);
    // The toggle belongs beside the badge, as it does on the till and the handhelds.
    const toggle = byId('lang');
    if (toggle && toggle.parentElement !== sync) sync.append(toggle);
    return { dot, text, badge };
  }

  // ── The sync badge — connection · freshness, from the store computer (rule 4) ──────────────────────
  let box = { asked: false, reachable: false, status: null };
  const laneBase = () => (typeof window.laneWriteBase === 'string' ? window.laneWriteBase : null);
  // OB-607: the badge's time of day is the SHOP's clock (the page's shop's day, in the zone the store computer served) —
  // never this device's. The page's bundle runs before this chrome (module scripts run in order).
  const clock = (iso) => window.sreShopDay?.timeOf(iso) ?? '';

  function paintBadge() {
    const els = badgeElements();
    if (!els) return;
    const { dot, text, badge } = els;
    dot.classList.remove('unknown', 'degraded', 'error', 'idle');
    paintBadgeWords(dot, text);
    // the chip's tone follows the dot's class — the one fact, said once, in the dot, the shape, the colour and the words
    const tone = dot.classList.contains('error') ? 'error' : dot.classList.contains('idle') ? 'idle'
      : dot.classList.contains('unknown') || dot.classList.contains('degraded') ? 'degraded' : 'ok';
    if (badge.dataset.tone !== tone) badge.dataset.tone = tone;
  }
  function paintBadgeWords(dot, text) {
    // A page that could not read its own registers says so first — the link to the store is one fact.
    if (window.sreBlind === true) { dot.classList.add('unknown'); text.textContent = t('notConnected'); return; }
    if (laneBase() === null) { dot.classList.add('idle'); text.textContent = t('notConnected'); return; }
    if (!box.asked) { dot.classList.add('idle'); text.textContent = t('checkingBox'); return; }
    if (!box.reachable) { dot.classList.add('error'); text.textContent = t('boxNotAnswering'); return; }
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    if (s.cloud === 'online') { text.textContent = `${t('connected')}${when}`; return; }
    dot.classList.add(s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded');
    text.textContent = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'login_refused' ? t('cloudLoginRefused') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
  }

  async function refreshBadge() {
    const base = laneBase();
    if (base === null) { paintBadge(); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const res = await fetch(`${base}/lane/sync-status`, { cache: 'no-store', signal: ctl.signal });
      box = res.ok ? { asked: true, reachable: true, status: await res.json() } : { asked: true, reachable: false, status: null };
    } catch {
      box = { asked: true, reachable: false, status: null };
    } finally {
      clearTimeout(timer);
    }
    paintBadge();
    paintStoreComputer();
  }

  // ── The store computer's own red light (audit row 6 · P-08 · P-03) ───────────────────────────────
  // The store computer checks itself every 15 minutes (store-computer status: the last backup, the till's queue, the
  // disk, the database) and its box hands the answer over with the sync status. Anything wrong is a RED banner at the
  // top of every office page — the manager's and owner's home included — in the reader's language, with the words, the
  // shape and the colour. It does not fade and it cannot be dismissed: it goes when the store computer says it is fixed.
  // No banner when the box reports no store-computer check (a box that is not the shop's store computer).
  function paintStoreComputer() {
    let strip = byId('sre-store-alarm');
    const sc = box.reachable && box.status && typeof box.status.storeComputer === 'object' ? box.status.storeComputer : null;
    const alerts = sc && Array.isArray(sc.alerts) ? sc.alerts : [];
    if (alerts.length === 0) { if (strip) strip.hidden = true; return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'sre-store-alarm';
      strip.className = 'sre-alarm';
      strip.setAttribute('role', 'alert');
      (byId('sre-page') ?? document.body).prepend(strip);
    }
    strip.hidden = false;
    const title = t('storeAlarm');
    const words = alerts.map((a) => (lang() === 'ta' ? a.ta : a.en) || a.en || '');
    const key = `${lang()}|${words.join('|')}`;
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;
    const head = document.createElement('strong');
    const mark = icon('triangle-alert', 22);
    if (mark) head.append(mark);
    head.append(document.createTextNode(title));
    const list = document.createElement('ul');
    for (const w of words) { const li = document.createElement('li'); li.textContent = w; list.append(li); }
    strip.replaceChildren(head, list);
  }

  // ── The "served from this device's cache" strip (P-08) ──────────────────────────────────────────
  // A page may carry its own sharper wording on the element (`data-en` / `data-ta`) — the manager's says
  // "do not close the day on it". Otherwise the one wording. The time is the reader's own local clock.
  function paintStale() {
    let strip = byId('stale');
    if (!strip) {
      strip = document.createElement('p');
      strip.className = 'stale';
      strip.id = 'stale';
      strip.hidden = true;
      strip.setAttribute('role', 'status');
      (byId('sre-page') ?? document.body).prepend(strip);
    }
    const at = window.shellCachedAt;
    strip.hidden = at === undefined;
    if (at === undefined) return;
    const own = strip.dataset[lang()];
    // the words, with the one set's "history" shape before them (OB-201) — the words alone are the message
    let words = strip.querySelector(':scope > .sre-words');
    if (!words) {
      strip.replaceChildren();
      const mark = icon(CHROME_ICONS.stale, 20);
      if (mark) strip.append(mark);
      words = document.createElement('span');
      words.className = 'sre-words';
      strip.append(words);
    }
    setText(words, `${own ?? t('staleShell')} ${window.sreShopDay?.dateTimeOf(at) ?? ''}`); // OB-607: the shop's clock
  }

  // ── Round A (P-08): "the store computer's copy, as head office last sent it at …, N old" ──────────────────
  // Only on a page that asks for it with a `#store-copy` element — a page whose figures come from head office's store
  // setup on the box. The box injects `window.storeCopy` ({ shownAt, ageMinutes } in the shop's clock, or null when head
  // office has sent nothing yet); a page opened off the box gets no injection and the line stays hidden.
  function paintStoreCopy() {
    const strip = byId('store-copy');
    if (!strip || window.storeCopy === undefined) return;
    const copy = window.storeCopy;
    strip.hidden = false;
    if (copy === null || typeof copy !== 'object') { setText(strip, t('storeCopyNone')); return; }
    const n = Math.max(0, Math.floor(Number(copy.ageMinutes) || 0));
    const age = n < 1 ? t('ageJustNow') : n < 60 ? t('ageMinutes').replace('{n}', String(n))
      : n < 60 * 24 ? t('ageHours').replace('{n}', String(Math.floor(n / 60))) : t('ageDays').replace('{n}', String(Math.floor(n / (60 * 24))));
    setText(strip, t('storeCopy').replace('{at}', String(copy.shownAt ?? '')).replace('{age}', age));
  }

  // ── The header line in the reader's language (U0 · G1 of the UI/UX gap audit, 1 Nov 2026 · §1 rule 6) ───────────
  // Every page's header line (`h1.who`) was a text node written once in English: the page repaints its own `#title`
  // on the toggle, the header line stayed. The menu already carries the page's name in both languages, so when the
  // heading IS the menu's name (in either language) the chrome writes it in the reader's language — the same words the
  // rail shows for this screen. A page with its own heading (Today's store workspace line, a page that translates its
  // own h1) is left exactly as the page wrote it. The `#whoami` small and every other child stay where they are.
  function paintHeading() {
    const h1 = document.querySelector('header h1.who');
    if (!h1) return;
    const nav = navigation();
    const place = nav ? currentPlace(nav) : null;
    const label = place && place.item && typeof place.item.label === 'object' && place.item.label !== null ? place.item.label : null;
    if (!label) return;
    const en = String(label.en ?? '');
    const ta = String(label.ta ?? '');
    if (en === '') return;
    const slot = h1.querySelector('#title-text') ?? [...h1.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim() !== '') ?? null;
    if (!slot) return;
    const current = slot.textContent.replace(/\s+/g, ' ').trim();
    if (!(current === en || current === ta || h1.dataset.sreHeading === en)) return;
    h1.dataset.sreHeading = en;
    const want = word(label);
    const text = slot.nodeType === 3 ? `${want}${/\s$/.test(slot.textContent) ? ' ' : ''}` : want;
    if (slot.textContent !== text) slot.textContent = text;
  }

  // U2 (G16): the header's "who" small — a page writes the signed-in person's ID there (`u-mgr`); when the signed pack
  // names that person, the name is shown in its place. Only an id the directory really knows is replaced; anything
  // else stays exactly as the page wrote it (never a guess).
  function paintWhoAmI() {
    const small = document.querySelector('header h1.who #whoami, header #whoami');
    if (!small) return;
    const text = small.textContent ?? '';
    if (text.trim() === '') return;
    const d = directory();
    if (!d || !Array.isArray(d.people) || d.people.length === 0) return;
    const replaced = text.replace(/\bu-[A-Za-z0-9][A-Za-z0-9_.-]*\b/g, (id) => { const hit = d.people.find((p) => p.id === id); return hit ? hit.name : id; });
    if (replaced !== text) small.textContent = replaced;
  }

  // ── The toggle says what you get ─────────────────────────────────────────────────────────────────
  function paintToggle() {
    const toggle = byId('lang');
    if (!toggle) return;
    // OB-201: the globe from the one set before the word; the word is still the whole of the button's text.
    toggle.classList.add('sre-lang');
    const mark = icon(CHROME_ICONS.language, 18);
    if (mark) toggle.replaceChildren(mark, document.createTextNode(t('otherLanguage')));
    else toggle.textContent = t('otherLanguage');
    toggle.setAttribute('aria-label', t('switchLanguage'));
  }

  // ── The menu: what THIS person may open on THIS store computer (§27 role surfaces · P-07) ──────────
  // The box works the list out per request from its role register and the screen's named viewer, and injects it as
  // `window.sreNavigation` — this file only draws it. No injection means the page was opened off the box (a cached
  // shell, a test's static server): then there is no menu and no rail, because there is nothing honest to offer. An
  // empty list comes with its reason, and the reason is shown instead of a blank panel (P-08).
  const navigation = () => (window.sreNavigation && typeof window.sreNavigation === 'object' ? window.sreNavigation : null);
  const word = (pair) => (pair && typeof pair === 'object' ? (pair[lang()] ?? pair.en ?? '') : String(pair ?? ''));
  // A desk shows the rail open beside the page; a phone keeps it as a drawer behind the ☰ button (OB-13, UX-1a).
  const desk = window.matchMedia('(min-width: 1000px)');
  // U5 (G11): a phone — the header shows the page's name ONCE with the badge and the toggle; the breadcrumb goes, and
  // Find and Pin fold into the menu drawer so the first screenful is the page's first task.
  const phone = window.matchMedia('(max-width: 519px)');
  let topTools = null; // { line, pin, findWrap, count } — kept by reference: the menu's own repaint detaches them on a phone
  let drawerOpen = false;

  // The shell: the rail first in <body>, then the page — everything the page had in <body>, moved as one into
  // `.sre-page` so its own column layout is untouched (node identity, listeners and ids all survive a move).
  // Scripts stay where they are; anything fixed to the viewport (a sheet, a banner) is unaffected either way.
  function shell(panel) {
    let page = byId('sre-page');
    if (!page) {
      page = document.createElement('div');
      page.id = 'sre-page';
      page.className = 'sre-page';
      for (const child of [...document.body.children]) {
        if (child === panel || child.tagName === 'SCRIPT') continue;
        page.append(child);
      }
      document.body.prepend(page);
      document.body.classList.add('sre-shell');
    }
    if (panel.parentElement !== document.body || document.body.firstElementChild !== panel) document.body.prepend(panel);
    return page;
  }

  function menuElements() {
    const header = document.querySelector('header');
    if (!header) return null;
    let button = byId('sre-menu-button');
    let panel = byId('sre-menu');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'sre-menu-button';
      button.className = 'sre-menu-button';
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', 'sre-menu');
      header.prepend(button);
    }
    if (!panel) {
      panel = document.createElement('nav');
      panel.id = 'sre-menu';
      panel.className = 'sre-menu';
      panel.hidden = true;
      shell(panel);
      button.addEventListener('click', () => toggleMenu());
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !desk.matches) { toggleMenu(false); button.focus(); }
      });
      desk.addEventListener('change', () => layout());
      phone.addEventListener('change', () => foldTopline());
    }
    return { button, panel };
  }

  // On a desk the rail is simply there: open, no button, nothing to dismiss. On a phone the button and the drawer
  // state decide, and a scrim behind the open drawer closes it on a tap, like Escape does.
  function layout() {
    const els = menuElements();
    if (!els) return;
    const { button, panel } = els;
    foldTopline(); // U5: the menu was just redrawn — Find and Pin go back where the width says
    if (desk.matches) {
      panel.hidden = false;
      button.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      scrim(false);
      return;
    }
    button.hidden = false;
    panel.hidden = !drawerOpen;
    button.setAttribute('aria-expanded', String(drawerOpen));
    scrim(drawerOpen);
  }

  function scrim(on) {
    let el = byId('sre-scrim');
    if (!on) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'sre-scrim';
      el.className = 'sre-scrim';
      el.addEventListener('click', () => { toggleMenu(false); const b = byId('sre-menu-button'); if (b) b.focus(); });
      document.body.append(el);
    }
    el.setAttribute('aria-label', t('closeScreens'));
  }

  function toggleMenu(open) {
    const els = menuElements();
    if (!els) return;
    if (desk.matches) return; // the rail stands open on a desk; there is nothing to toggle
    drawerOpen = open === undefined ? els.panel.hidden : open;
    layout();
    if (drawerOpen) {
      const first = els.panel.querySelector('a[aria-current="page"]') ?? els.panel.querySelector('a');
      if (first) first.focus();
    }
  }

  // The box says which items open the screen being served. Where several do — the admin screen has an item per
  // tab — the one whose `?tab=` matches the address is current, or the plain one when no tab was asked for.
  function isCurrent(item) {
    if (item.current !== true) return false;
    const asked = new URLSearchParams(window.location.search).get('tab');
    const own = new URLSearchParams(String(item.path).split('?')[1] ?? '').get('tab');
    return asked === own;
  }

  // W3 · M36-FR-02 (OB-321): the shop's own name and colours, as head office signed them into the pack this store computer
  // holds (`window.sreBrand`, no network). Absent → the menu keeps its own words; a colour is used only when it is a hex.
  function shopBrand() {
    const b = window.sreBrand;
    if (!b || typeof b !== 'object') return null;
    const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
    const name = typeof b.productName === 'string' && b.productName.trim() !== '' ? b.productName.trim() : null;
    return { name, primary: hex(b.colours?.primary), onPrimary: hex(b.colours?.onPrimary) };
  }

  function brand() {
    const own = shopBrand();
    const block = document.createElement('div');
    block.className = 'brand';
    if (own) block.setAttribute('data-shop-brand', '');
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = own?.name ? own.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() : 'SRE';
    if (own?.primary && own?.onPrimary) { mark.style.background = own.primary; mark.style.color = own.onPrimary; }
    const words = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = own?.name ?? 'Hyper Market';
    const what = document.createElement('small');
    what.textContent = t('workspace');
    words.append(name, what);
    block.append(mark, words);
    return block;
  }

  function paintMenu() {
    const nav = navigation();
    if (!nav) return;
    const els = menuElements();
    if (!els) return;
    const { button, panel } = els;
    // the one set's menu shape (OB-201) where the ☰ glyph was, then the word — the word is the button's name
    const menuMark = icon(CHROME_ICONS.menu, 20);
    if (menuMark) button.replaceChildren(menuMark, document.createTextNode(t('screens')));
    else button.textContent = `☰ ${t('screens')}`;
    panel.setAttribute('aria-label', t('screens'));
    panel.replaceChildren(brand());
    const groups = Array.isArray(nav.groups) ? nav.groups : [];
    if (groups.length === 0) {
      const why = document.createElement('p');
      why.className = 'who-can';
      why.textContent = nav.why === 'no_roles' ? t('noRoles') : t('noUser');
      panel.append(why);
      layout();
      return;
    }
    if (nav.branch && typeof nav.branch.name === 'string' && nav.branch.name !== '') panel.append(branchCard(nav.branch.name));
    // The groups scroll on their own between the branch card and the person, so the person is always in view at the
    // foot however long the list (OB-16); the current link is scrolled into view.
    const scroller = document.createElement('div');
    scroller.className = 'groups';
    panel.append(scroller);
    noteVisit(nav);
    // W1: what this person keeps at the top (pinned) and what they opened last (recent) — this browser's own memory,
    // only ever screens the rail already offers them (a pin to a screen they lost is simply not drawn).
    const offered = new Map(groups.flatMap((g) => (g.items ?? []).map((item) => [item.id, item])));
    const pins = remembered('pins').filter((id) => offered.has(id));
    const here = currentPlace(nav)?.item.id ?? null;
    const recent = remembered('recent').filter((id) => offered.has(id) && id !== here && !pins.includes(id)).slice(0, 5);
    if (pins.length > 0) scroller.append(quickSection('pinned', t('pinned'), pins.map((id) => offered.get(id))));
    if (recent.length > 0) scroller.append(quickSection('recent', t('recent'), recent.map((id) => offered.get(id))));
    const total = groups.reduce((n, g) => n + (g.items ?? []).length, 0);
    const opened = rememberedObject('open');
    for (const [index, group] of groups.entries()) {
      const key = typeof group.key === 'string' ? group.key : `g${index}`;
      const section = document.createElement('div');
      section.className = 'group-section';
      section.dataset.key = key;
      const title = document.createElement('p');
      title.className = 'group';
      const list = document.createElement('ul');
      list.id = `sre-group-${index}`;
      // OB-201: on the rail each SCREEN carries its shape, so the workspace heading is words alone — one icon per row,
      // never two stacked. The workspace's own shape (GROUP_ICONS) is still the Today page's workspace tiles'.
      // W1: a short list stands open; a long one opens only the person's daily work, the workspace they are in and the
      // ones they opened themselves — every heading is a button that shows or hides its screens, so a long list is a
      // dozen plain headings instead of a hundred links.
      const isHere = (group.items ?? []).some((item) => isCurrent(item));
      const open = total <= 24 || key === 'Daily' || isHere || opened[key] === true;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'group-toggle';
      toggle.setAttribute('aria-controls', list.id);
      toggle.append(document.createTextNode(word(group.group)));
      toggle.addEventListener('click', () => {
        const nowOpen = toggle.getAttribute('aria-expanded') !== 'true';
        const all = rememberedObject('open');
        all[key] = nowOpen;
        remember('open', all);
        setOpen(section, nowOpen);
        filterMenu(byId('sre-find')?.value ?? '');
      });
      title.append(toggle);
      for (const item of group.items ?? []) {
        const li = document.createElement('li');
        li.dataset.find = findText(item, group);
        li.append(railLink(item, true));
        list.append(li);
      }
      section.append(title, list);
      setOpen(section, open);
      scroller.append(section);
    }
    panel.append(personCard(nav));
    // Round 4c: "Sign out" inside the product's own menu, under the person — where the box drew no Sign out bar of its
    // own (the hosted copy: the front signed the person in, and its door ends the session). A plain same-origin POST.
    const out = window.sreSignOut && typeof window.sreSignOut.action === 'string' && window.sreSignOut.action.startsWith('/') ? window.sreSignOut.action : null;
    if (out !== null && !byId('sre-office-bar')) {
      const form = document.createElement('form');
      form.method = 'post'; form.action = out; form.id = 'sre-sign-out';
      const b = document.createElement('button');
      b.type = 'submit'; b.className = 'sre-sign-out'; b.textContent = t('signOut');
      form.append(b);
      panel.append(form);
    }
    filterMenu(byId('sre-find')?.value ?? '');
    layout();
    const current = scroller.querySelector('.group-section a[aria-current="page"]');
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  // ── W1: the rail's own parts ─────────────────────────────────────────────────────────────────────────────────
  /** A rail link: the screen's shape from the one set, then its name (OB-201); the name alone is the link's text. */
  function railLink(item, main) {
    const link = document.createElement('a');
    link.href = item.path;
    const shape = itemIcon(item);
    if (shape) link.append(shape);
    link.append(document.createTextNode(word(item.label)));
    if (main && isCurrent(item)) link.setAttribute('aria-current', 'page');
    if (!main) link.className = 'sre-quick-link';
    return link;
  }
  function quickSection(key, heading, items) {
    const section = document.createElement('div');
    section.className = 'group-section sre-quick';
    section.dataset.key = key;
    const title = document.createElement('p');
    title.className = 'group sre-quick-title';
    title.textContent = heading;
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.find = findText(item, null);
      li.append(railLink(item, false));
      list.append(li);
    }
    section.append(title, list);
    return section;
  }
  function setOpen(section, open) {
    const toggle = section.querySelector('.group-toggle');
    const list = section.querySelector('ul');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    section.dataset.open = String(open);
    if (list) list.hidden = !open;
  }
  /** Everything a person might type to find a screen: its name and plain words in both languages, its workspace's name. */
  function findText(item, group) {
    const both = (pair) => (pair && typeof pair === 'object' ? `${pair.en ?? ''} ${pair.ta ?? ''}` : String(pair ?? ''));
    return `${both(item.label)} ${both(item.words)} ${group ? both(group.group) : ''}`.toLowerCase();
  }

  // This browser's memory of the rail (pins, recent, open workspaces) — per person, a convenience only: it may be empty
  // or refused (a private window), and the rail is whole without it. Never a fact anybody else relies on.
  const storeKey = (what) => `sre.rail.${what}.${String(navigation()?.userId ?? 'nobody')}`;
  function remembered(what) {
    try { const v = JSON.parse(window.localStorage.getItem(storeKey(what)) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
  }
  function rememberedObject(what) {
    try { const v = JSON.parse(window.localStorage.getItem(storeKey(what)) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }
  function remember(what, value) {
    try { window.localStorage.setItem(storeKey(what), JSON.stringify(value)); } catch { /* the rail works without it */ }
  }
  let visited = false;
  function noteVisit(nav) {
    if (visited) return;
    const place = currentPlace(nav);
    if (!place) return;
    visited = true;
    remember('recent', [place.item.id, ...remembered('recent').filter((id) => id !== place.item.id)].slice(0, 8));
  }
  function togglePin() {
    const place = currentPlace(navigation());
    if (!place) return;
    const pins = remembered('pins');
    remember('pins', pins.includes(place.item.id) ? pins.filter((id) => id !== place.item.id) : [...pins, place.item.id]);
    paintMenu();
    paintTopline();
  }


  // ── Icons (UX-2b · OB-201 "Icons A"): the ONE set, packages/ui/web/sre-icons.js (`window.sreIcon`), loaded before
  // every page's own script — thin line, 1.5px, 24 grid, inline SVG, no network (P-01). The chrome only says WHICH
  // shape fits what: a workspace (by its English name), a screen on the rail (by the catalogue's item id), and the
  // few figure names the Today page asks for. Every one is drawn beside its word, never instead of it; a name the set
  // does not know draws nothing and the word stands alone. tests/guardrails/every-icon-comes-from-the-one-set.test.ts
  // proves every name here is in the set and every item in apps/web-erp/src/navigation.ts has one.
  const GROUP_ICONS = Object.freeze({
    'Your daily work': 'calendar-check',
    'Today & approvals': 'layout-dashboard',
    'Products & prices': 'tag',
    'Buying from suppliers': 'shopping-cart',
    'Goods coming in': 'package-check',
    'Stock & counts': 'warehouse',
    'Waste, expiry & returns': 'trash',
    'Shelves & shop floor': 'store',
    'Customers & service': 'users',
    'Sales & service': 'receipt',
    'Online orders & delivery': 'truck',
    'Fresh food & café': 'chef-hat',
    'Cash, accounts & GST': 'wallet',
    'Staff, rota & tasks': 'clipboard-list',
    'My work & pay': 'user-round',
    'Checks & investigations': 'shield-alert',
    'Reports & figures': 'chart-column',
    'Setup, people & access': 'shield-check',
    'Tills, devices & connections': 'monitor',
    'Open a device screen': 'monitor-smartphone',
  });
  const ITEM_ICONS = Object.freeze({
    'dashboard': 'layout-dashboard',
    'approval-requests': 'badge-check',
    'products': 'package',
    'pricing': 'tag',
    'promotions': 'percent',
    'category-policy': 'layers',
    'product-publish-review': 'send',
    'data-quality': 'list-checks',
    'buying': 'shopping-cart',
    'suppliers': 'factory',
    'supplier-bills': 'file-text',
    'goods-receipt': 'package-check',
    'indents': 'clipboard-list',
    'counts': 'scan-barcode',
    'count-plans': 'calendar-check',
    'transfers': 'arrow-left-right',
    'waste': 'trash',
    'write-off-capture': 'package-minus',
    'stock-health': 'activity',
    'held-returns': 'rotate-ccw',
    'unsellable': 'search-x',
    'merchandising': 'layout-grid',
    'expiry': 'calendar-clock',
    'recall-trace': 'shield-alert',
    'production': 'chef-hat',
    'warehouse-supervisor': 'warehouse',
    'finance': 'landmark',
    'day-book': 'book-open',
    'finance-close': 'calendar-days',
    'company-report': 'building', // OB-391
    'reconciliation': 'git-compare-arrows',
    'gst-reconciliation': 'git-merge',
    'gst-returns': 'receipt-text',
    'itc-review': 'file-text',
    'epr': 'trash', // R4 Lane 1 (B20–B22): the EPR registers page — this one line only
    'online-store': 'receipt-text', // R4 Lane 2
    'product-content': 'package', // R4 Lane 2
    // Round 4a (products and prices): icons already in the set.
    'product-details': 'package', 'product-categories': 'layers', 'product-merges': 'git-merge', 'tax-rates': 'receipt', 'price-lists': 'indian-rupee', 'offer-results': 'chart-column',
    'payroll': 'banknote',
    'my-payslip': 'wallet',
    'ess': 'user-round',
    'rostering': 'calendar',
    'schedule': 'calendar-clock',
    // ── R4 Lane 3: the insight pages (existing icons only) ──
    'customers': 'users',
    'basket-affinity': 'shopping-basket',
    'demand-events': 'calendar-days',
    'morning-brief': 'book-open',
    'owner-alerts': 'shield-alert', // OB-288 lane 4 · P2 — an icon already in the set
    // ── end R4 Lane 3 ──
    // R4 Lane 4 — begin: the two new pages' menu icons, from icons already in the set (no restyle).
    'supplier-scorecard': 'list-checks',
    // QG-02 lane 1 R4: the four new pages' menu icons, from icons already in the set.
    'blanket-orders': 'files',
    'dock-diary': 'truck',
    'promotion-funding': 'banknote',
    'rebates': 'percent', // QG-02 · OB-404 — an icon already in the set
    'scrap': 'package-minus', // round 6 · M28-FR-02 — an icon already in the set
    'packaging': 'boxes', // round 6 · M28-FR-03 — an icon already in the set
    'branch-compare': 'chart-column', // round 6 · M29-FR-02 — an icon already in the set
    'shelf-tags': 'tag', // round 7 · OB-505 — an icon already in the set
    'quotations': 'file-text', // round 7 · OB-506 — an icon already in the set
    'certificates': 'badge-check', // round 8 · OB-522 — an icon already in the set
    'findings': 'clipboard-check', // OB-609 — an icon already in the set
    'staff': 'users', // Round 4c — an icon already in the set
    'posh-committee': 'book', // Round 4c — an icon already in the set
    'branches': 'store', // Round 4c — an icon already in the set
    'do-not-contact': 'message-circle', // Round 4c — an icon already in the set
    'posting-map': 'book-open', // Round 4d — an icon already in the set
    'settlement': 'banknote', // W3 — an icon already in the set
    'facilities-setup': 'wrench', // Round 4d — an icon already in the set
    'production-recipes': 'chef-hat', // Round 4d — an icon already in the set
    'production-costs': 'banknote', // W4 — an icon already in the set
    'data-requests': 'shield-check', // W3 — an icon already in the set
    'customer-value': 'chart-column', // W3 — an icon already in the set
    'message-queue': 'message-circle', // W3 — an icon already in the set
    'compensation-limits': 'banknote', // W3 — an icon already in the set
    'compensation': 'banknote', // U6 — an icon already in the set
    'satisfaction': 'clipboard-check', // U6 — an icon already in the set
    'consent-check': 'shield-check', // U6 — an icon already in the set
    'gift-cards': 'ticket', // W3 — an icon already in the set
    'partner-webhooks': 'send', // Wave 3 — an icon already in the set
    'partners': 'key-round', // Wave 3 — an icon already in the set
    'developer-docs': 'book-open', // Wave 3 — an icon already in the set
    'floor-devices': 'tag', // Wave 3 — an icon already in the set
    'branding': 'store', // Wave 3 — an icon already in the set
    'old-system': 'history', // W3 — an icon already in the set
    'cert-in': 'shield-check', // Round 4c — an icon already in the set
    'emergency-access': 'key-round', // Wave 3 — an icon already in the set
    'training-checks': 'badge-check', // Wave 3 · OB-675 — an icon already in the set
    'safety-incidents': 'shield-alert', // Wave 3 — an icon already in the set
    'ops-alerts': 'triangle-alert', // Wave 3 — an icon already in the set
    'failed-jobs': 'history', // W4 — an icon already in the set
    'compliance-registers': 'shield-check', // W5 — an icon already in the set
    'payroll-legal': 'scale', // W5 · OB-684 — an icon already in the set
    'document-retention': 'files', // Wave 3 — an icon already in the set
    'sales-commission': 'percent', // Wave 3 — an icon already in the set
    'space-setup': 'boxes', // Wave 2 — an icon already in the set
    'display-contracts': 'banknote', // Wave 2 — an icon already in the set
    'range-clusters': 'calendar-days', // Wave 2 — an icon already in the set
    'product-checks': 'clipboard-check', // Wave 2 — an icon already in the set
    'switches': 'history',
    'planogram-compliance': 'layout-grid',
    'floor-heat-map': 'layout-dashboard', // OB-288 P2 (OB-308) — an icon already in the set
    'requisitions': 'clipboard-list',
    // R4 Lane 4 — end
    'checklist': 'clipboard-check',
    'users': 'users-round',
    'organisation': 'building',
    'delegation': 'git-branch',
    'incidents': 'life-buoy',
    'store-computers': 'database',
    'scales': 'scale',
    'support-access': 'key-round',
    'fleet': 'monitor',
    'integration-health': 'plug',
    'facilities': 'wrench',
    'food-safety': 'thermometer',
    'price-integrity': 'barcode',
    'store-tasks': 'list-plus',
    'my-tasks': 'check-square',
    'waste-analytics': 'trending-down',
    'ai': 'sparkles',
    'migration': 'database-backup',
    'store-setup': 'settings',
    'document-templates': 'files',
    'settings': 'settings-2',
    'audit': 'history',
    'operations': 'shield-alert',
    'loss-prevention': 'fingerprint',
    'reporting': 'chart-column',
    'service': 'headphones',
    'stored-value': 'ticket',
    'service-desk': 'message-circle',
    'ai-drafts': 'message-square-plus',
    'substitution-exceptions': 'repeat',
    'return-governance': 'circle-dollar-sign',
    'cash-office': 'calculator',
    'risk-acceptance': 'hand',
    'gates': 'badge-check', // OB-288 gates lane (QG-12) — an icon already in the set
    'access-review': 'users-round', // OB-288 lane 1 · P1 — an icon already in the set
    'help': 'book-open', // OB-288 LP/workforce package — an icon already in the set
    'adoption': 'clipboard-check', // OB-288 LP/workforce package — an icon already in the set
    'appointment-letters': 'file-text', // OB-288 LP/workforce package — an icon already in the set
    'related-parties': 'shield-check', // OB-288 LP/workforce package — an icon already in the set
    'rollout': 'sliders', // OB-288 P4 — an icon already in the set
    'tally-files': 'book-open', // OB-288 P5 (OB-293) — an icon already in the set
    'dispatch': 'truck', // OB-288 fulfilment & delivery — an icon already in the set
    'loyalty-desk': 'badge-check', // OB-288 wave 3 (OB-329 · OB-295) — an icon already in the set
    'online-orders': 'package-check', // W3 (M18) — an icon already in the set
    'delivery-area': 'truck', // W3 (M18-FR-01/03) — an icon already in the set
    'order-refunds': 'indian-rupee', // OB-288 wave 3 (M18-FR-04) — an icon already in the set
    'campaigns': 'send', // OB-288 wave 3 (M21-FR-01) — an icon already in the set
    'b2b': 'building', // OB-288 commercial desks (M22) — an icon already in the set
    'supplier-submissions': 'package-check', // OB-288 commercial desks (M24) — an icon already in the set
    'concessions': 'store', // OB-288 commercial desks (M27) — an icon already in the set
    'approval-rules': 'sliders', // OB-288 lane 1 · P1 — an icon already in the set
    'day-reopen': 'lock',
    'data-io': 'arrow-up-down',
    'workforce': 'users',
    'till': 'scan-line',
    'owner-figures': 'chart-line',
    'warehouse-handheld': 'boxes',
    'picker-handheld': 'shopping-basket',
    'driver-handheld': 'navigation',
    'posh-report': 'book',
  });
  // The Today page's figure tiles (app.js) name their figure, not a shape.
  const FIGURE_ICONS = Object.freeze({ rupee: 'indian-rupee', check: 'circle-check', alert: 'triangle-alert', cloud: 'upload', list: 'list' });
  // The chrome's own controls.
  const CHROME_ICONS = Object.freeze({ menu: 'menu', find: 'search', language: 'globe', branch: 'store', update: 'refresh-cw', stale: 'history' });

  /** The set's name for what the chrome or a page asked for: a workspace, a figure, or a name already in the set. */
  const shapeFor = (name) => GROUP_ICONS[name] ?? FIGURE_ICONS[name] ?? name;
  function icon(name, size) {
    if (typeof window.sreIcon !== 'function') return null;
    return window.sreIcon(shapeFor(name), size);
  }
  const itemIcon = (item) => (item && typeof item.id === 'string' && ITEM_ICONS[item.id] ? icon(ITEM_ICONS[item.id], 18) : null);

  // ── The branch and the person (OB-16): the rail names the shop and the person, as head office named them ──
  // The pack carries the branch's name and, when head office sent one, the person's name and role. Without them the
  // rail still says WHO by id — never a blank, never an invented name.
  function branchCard(name) {
    const card = document.createElement('div');
    card.className = 'branch';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    const shop = icon(CHROME_ICONS.branch, 20);
    if (shop) mark.append(shop); else mark.textContent = '⌂';
    const words = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = name;
    const small = document.createElement('small');
    small.textContent = t('branchWorkspace');
    words.append(b, small);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    card.append(mark, words, dot);
    return card;
  }
  function personCard(nav) {
    const person = nav.person && typeof nav.person.name === 'string' && nav.person.name !== '' ? nav.person : null;
    if (!person) {
      const who = document.createElement('p');
      who.className = 'who-can';
      who.textContent = `${t('screensFor')} `;
      const name = document.createElement('b');
      name.textContent = String(nav.userId ?? '');
      who.append(name);
      return who;
    }
    const card = document.createElement('div');
    card.className = 'person';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = person.name.split(/\s+/).filter((w) => /^[A-Za-z\u0B80-\u0BFF]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '•';
    const words = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = person.name;
    const small = document.createElement('small');
    small.textContent = person.role ?? String(nav.userId ?? '');
    words.append(b, small);
    card.append(avatar, words);
    return card;
  }

  // ── The top line (OB-16): where you are, and a way to find any screen you may open ──────────────────────
  // The breadcrumb is read off the rail — the group and the item that are current — never typed on a page. The search
  // filters the rail's own links as you type (a screen you may not open is not in the rail, so it cannot be found);
  // Enter opens the first match; on a phone, typing opens the drawer so the matches are seen.
  function currentPlace(nav) {
    for (const group of nav?.groups ?? []) for (const item of group.items ?? []) if (isCurrent(item)) return { group, item };
    return null;
  }
  function filterMenu(query) {
    const panel = byId('sre-menu');
    if (!panel) return;
    const q = String(query ?? '').trim().toLowerCase();
    // W1: every word typed must be found — in the screen's name, its plain words ("cash", "salary", "expiry") or its
    // workspace's name, in either language. Searching looks in every workspace, open or not; clearing the field
    // puts the workspaces back as the person left them. Pinned and recent stand aside while searching (no doubles).
    const words = q.split(/\s+/).filter((w) => w !== '');
    let count = 0;
    for (const section of panel.querySelectorAll('.group-section')) {
      const quick = section.classList.contains('sre-quick');
      const list = section.querySelector('ul');
      if (q === '') {
        for (const li of section.querySelectorAll('li')) li.hidden = false;
        section.hidden = false;
        if (list && !quick) list.hidden = section.dataset.open === 'false';
        continue;
      }
      let hit = false;
      for (const li of section.querySelectorAll('li')) {
        const hay = li.dataset.find ?? li.textContent.toLowerCase();
        const match = !quick && words.every((w) => hay.includes(w));
        li.hidden = !match;
        if (match) { hit = true; count += 1; }
      }
      section.hidden = !hit;
      if (list && hit) list.hidden = false;
    }
    let none = byId('sre-find-none');
    if (q !== '' && count === 0) {
      if (!none) { none = document.createElement('p'); none.id = 'sre-find-none'; none.className = 'who-can'; (panel.querySelector('.groups') ?? panel).append(none); }
      setText(none, t('noScreenMatches'));
    } else if (none) none.remove();
    const said = byId('sre-find-count');
    if (said) setText(said, q === '' || count === 0 ? '' : count === 1 ? t('matchesOne') : t('matchesMany').replace('{n}', String(count)));
    if (q !== '' && !desk.matches && byId('sre-menu')?.hidden) toggleMenu(true);
  }
  function paintTopline() {
    const header = document.querySelector('header');
    if (!header) return;
    const nav = navigation();
    let line = byId('sre-topline');
    if (!line) {
      line = document.createElement('div');
      line.id = 'sre-topline';
      line.className = 'sre-topline';
      const crumbs = document.createElement('p');
      crumbs.id = 'sre-crumbs';
      crumbs.className = 'sre-crumbs';
      const find = document.createElement('input');
      find.type = 'search';
      find.id = 'sre-find';
      find.className = 'sre-find';
      find.autocomplete = 'off';
      find.addEventListener('input', () => filterMenu(find.value));
      find.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { const first = byId('sre-menu')?.querySelector('.group-section:not([hidden]) ul:not([hidden]) li:not([hidden]) a'); if (first) { e.preventDefault(); first.click(); } }
        if (e.key === 'Escape') { find.value = ''; filterMenu(''); }
      });
      // the magnifier sits inside the field (OB-201); the field keeps its own name and its own hidden state
      const findWrap = document.createElement('span');
      findWrap.id = 'sre-find-wrap';
      findWrap.className = 'sre-find-wrap';
      const lens = icon(CHROME_ICONS.find, 18);
      if (lens) findWrap.append(lens);
      findWrap.append(find);
      // W1: how many screens the words found, said once for a screen reader as well as seen
      const count = document.createElement('span');
      count.id = 'sre-find-count';
      count.className = 'sre-find-count';
      count.setAttribute('role', 'status');
      count.setAttribute('aria-live', 'polite');
      // W1: keep this page at the top of the rail (this browser remembers it for this person)
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.id = 'sre-pin';
      pin.className = 'sre-btn sre-btn-quiet sre-pin';
      pin.addEventListener('click', () => togglePin());
      line.append(crumbs, pin, findWrap, count);
      header.prepend(line);
      topTools = { line, pin, findWrap, count };
    }
    foldTopline(); // the elements below are looked up by id: they must be in the document first
    const place = nav ? currentPlace(nav) : null;
    const parts = [t('workspaceWord')];
    if (place) {
      parts.push(word(place.group.group));
      const leaf = word(place.item.label);
      if (leaf !== parts[parts.length - 1]) parts.push(leaf);
    }
    setText(byId('sre-crumbs'), parts.join(' › '));
    const pin = byId('sre-pin');
    pin.hidden = place === null;
    if (place) {
      const pinned = remembered('pins').includes(place.item.id);
      const words = pinned ? t('unpinPage') : t('pinPage');
      if (pin.dataset.words !== words) {
        pin.dataset.words = words;
        const mark = icon(pinned ? 'check' : 'list-plus', 18);
        pin.replaceChildren(...(mark ? [mark] : []), document.createTextNode(words));
      }
      pin.setAttribute('aria-pressed', String(pinned));
    }
    const find = byId('sre-find');
    find.title = t('findScreenHint');
    find.setAttribute('aria-label', t('findScreen'));
    find.placeholder = t('findScreen');
    find.hidden = !nav || (nav.groups ?? []).length === 0;
    byId('sre-find-wrap').hidden = find.hidden;
    foldTopline();
  }
  /** On a phone, Find and Pin live at the top of the menu drawer under "This page"; on anything wider, on the top line. */
  function foldTopline() {
    const panel = byId('sre-menu');
    if (!topTools || !panel) return;
    const { line, pin, findWrap, count } = topTools;
    if (phone.matches) {
      let tools = panel.querySelector(':scope > .sre-rail-tools');
      if (!tools) {
        tools = document.createElement('div');
        tools.className = 'sre-rail-tools';
        const brandEl = panel.querySelector(':scope > .brand');
        if (brandEl) brandEl.after(tools); else panel.prepend(tools);
      }
      let head = tools.querySelector(':scope > .sre-rail-tools-head');
      if (!head) { head = document.createElement('p'); head.className = 'sre-rail-tools-head'; tools.prepend(head); }
      setText(head, ow('thisPage'));
      if (findWrap.parentElement !== tools) tools.append(findWrap, count, pin);
    } else {
      panel.querySelector(':scope > .sre-rail-tools')?.remove();
      if (pin.parentElement !== line) line.append(pin, findWrap, count);
    }
  }

  // ── A menu link may name a tab: /manager/?tab=approvals opens the manager on Approvals ─────────────
  // Only on a page that has that tab, and only if the page has not already opened it itself.
  function openAskedTab() {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (!wanted) return;
    const tab = byId(`tab-${wanted}`);
    if (tab && tab.getAttribute('aria-current') !== 'page') tab.click();
  }

  // ── A deploy reached this browser (RL-1, P-08): say so and offer the reload — never a silent swap, never a silent stale ──
  // The worker activates the new shell on the next visit; the page already open keeps the files it loaded. So when
  // the controller changes under an open page, a strip says a newer version has arrived and a button reloads it.
  // Only a CHANGE of controller counts: the first install, on a page that had none, is not news.
  let updateReady = false;
  function paintUpdate() {
    let strip = byId('sre-update');
    if (!updateReady) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement('p');
      strip.id = 'sre-update';
      strip.className = 'stale sre-update';
      strip.setAttribute('role', 'status');
      const words = document.createElement('span');
      const mark = icon(CHROME_ICONS.update, 20);
      if (mark) words.append(mark);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sre-btn';
      button.addEventListener('click', () => window.location.reload());
      strip.append(words, button);
      (byId('sre-page') ?? document.body).prepend(strip);
    }
    // one span: the shape (if any) and the words as its own text, so the span's text is exactly the message
    const words = strip.firstElementChild;
    const shape = words.querySelector('svg');
    words.replaceChildren(...(shape ? [shape] : []), t('newVersion'));
    strip.lastElementChild.textContent = t('reload');
  }
  if ('serviceWorker' in navigator) {
    let hadController = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) { updateReady = true; paintUpdate(); }
      hadController = true;
    });
  }

  // ── The page anatomy (OB-13 · UX-1c · OB-14): the head's eyebrow, the tab strip as subpage tiles, every table a register ──
  // Nothing moves and nothing is renamed. The chrome marks what the page already has — its title and purpose line
  // become the head with the module's name above them; its own tab buttons become tiles that say what each subpage
  // is for and how many things are in its list right now; its tables take the register look; its sheet opens as a
  // record drawer at a desk (the foundation does that part). The page's scripts keep writing the labels, the leads
  // and the rows; the chrome re-decorates whenever they do, and only writes what changed, so nothing loops.
  const visible = (el) => el !== null && el !== undefined && el.closest('[hidden]') === null;
  const firstSentence = (text) => { const one = text.trim().split(/(?<=[.!?।])\s/)[0] ?? ''; return one.length > 90 ? `${one.slice(0, 88)}…` : one; };
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  function currentGroup() {
    const nav = navigation();
    if (!nav || !Array.isArray(nav.groups)) return null;
    const group = nav.groups.find((g) => (g.items ?? []).some((item) => isCurrent(item)));
    if (!group) return null;
    const label = group.group;
    return typeof label === 'object' && label !== null ? String(label[lang()] ?? label.en ?? '') : String(label ?? '');
  }
  function paintHead() {
    const main = document.querySelector('main');
    if (!main) return;
    const h2 = [...main.querySelectorAll('h2')].find((el) => visible(el) && el.closest('.sheet, .sre-sheet, [role="dialog"]') === null) ?? null;
    for (const old of main.querySelectorAll('.sre-eyebrow')) if (h2 === null || old.nextElementSibling !== h2) old.remove();
    for (const marked of main.querySelectorAll('[data-sre-head]')) if (h2 === null || marked !== h2.parentElement) marked.removeAttribute('data-sre-head');
    if (h2 === null) return;
    h2.parentElement.setAttribute('data-sre-head', '');
    const group = currentGroup();
    const before = h2.previousElementSibling;
    let eyebrow = before && before.classList.contains('sre-eyebrow') ? before : null;
    if (!group) { if (eyebrow) eyebrow.remove(); return; }
    if (!eyebrow) { eyebrow = document.createElement('p'); eyebrow.className = 'sre-eyebrow'; h2.before(eyebrow); }
    setText(eyebrow, group);
  }
  // A subpage that is not open is hidden as a whole; its list still counts. Only a row hidden WITHIN the section is skipped.
  const shownWithin = (el, root) => { for (let n = el; n && n !== root; n = n.parentElement) if (n.hidden) return false; return true; };
  const countIn = (section) => (section ? [...section.querySelectorAll('tbody > tr, .rows > li, .sre-rows > li, .sre-row')].filter((row) => shownWithin(row, section)).length : 0);
  function paintTabs() {
    const tabs = byId('tabs');
    if (!tabs) return;
    tabs.classList.add('sre-tabs');
    for (const button of tabs.querySelectorAll('button')) {
      const section = button.id.startsWith('tab-') ? byId(`view-${button.id.slice(4)}`) : null;
      let title = button.querySelector(':scope > .t');
      if (!title) {
        // a bare label: the page's first paint, or its own repaint (a language switch) — wrap it
        const label = button.textContent.trim();
        button.replaceChildren();
        title = document.createElement('span'); title.className = 't'; title.textContent = label;
        const d = document.createElement('span'); d.className = 'd'; d.id = `${button.id}-d`;
        const c = document.createElement('span'); c.className = 'c'; c.id = `${button.id}-c`;
        button.append(title, d, c);
        button.classList.add('sre-tab');
        button.setAttribute('aria-describedby', `${d.id} ${c.id}`);
      }
      // the accessible name stays exactly the label the page wrote — a test, a screen reader and a person agree
      if (button.getAttribute('aria-label') !== title.textContent) button.setAttribute('aria-label', title.textContent);
      const lead = section ? section.querySelector(':scope > p.lead') : null;
      const d = button.querySelector(':scope > .d');
      setText(d, lead ? firstSentence(lead.textContent) : '');
      d.hidden = d.textContent === '';
      const n = countIn(section);
      const c = button.querySelector(':scope > .c');
      setText(c, n > 0 ? t('inList').replace('{n}', String(n)) : '');
      c.hidden = n === 0;
    }
  }
  function paintRegisters() {
    for (const table of document.querySelectorAll('main table')) table.classList.add('sre-register');
  }
  function paintAnatomy() { paintHead(); paintTabs(); paintRegisters(); }
  let anatomyQueued = false;
  const scheduleAnatomy = () => { if (anatomyQueued) return; anatomyQueued = true; requestAnimationFrame(() => { anatomyQueued = false; paintAnatomy(); }); };

  // ── The office page components (W1 · P-07 · P-08 · design system §4.1) ───────────────────────────────────────────
  // One register, one set of states, one summary card, one chip and one form field for every office page, so a page
  // hands over its REAL rows and its words and gets search, filters, sort, paging, a column choice and a record drawer
  // — the same everywhere, in English and Tamil. A page reaches them as `window.sreOffice` (after the chrome loads; a
  // page that paints first listens for `sre:chrome`). Nothing here makes up a figure: a value the page does not have is
  // drawn as "Not known", and an empty list says "nothing yet" — never "all clear" (P-08).
  const OFFICE_WORDS = {
    en: {
      search: 'Search this list', filterAll: 'All', columns: 'Columns', columnsShown: 'Columns to show', open: 'Open', close: 'Close',
      showing: 'Showing {from}–{to} of {n}', showingNone: 'Showing 0 of {n}', previous: 'Previous page', next: 'Next page', page: 'Page {p} of {q}',
      sortBy: 'Sort by {c}', clear: 'Clear search and filters',
      // U5: the sort direction said in words beside the heading (never an arrow alone), the tax-class kind, the box fallback
      sortedAsc: 'low to high', sortedDesc: 'high to low', sortedAscText: 'A to Z', sortedDescText: 'Z to A', notSorted: 'tap to sort',
      'pick_tax-class': 'Which tax class?', 'pickHint_tax-class': 'An HSN code, or a product under it',
      taxClassRowOne: 'HSN {code} — 1 product', taxClassRowMany: 'HSN {code} — {n} products',
      pickFromBox: 'Head office cannot be reached — this list is from this store computer\'s copy of the catalogue (version {v}). A product published since is not in it.',
      thisPage: 'This page', datePlaceholder: 'dd/mm/yyyy',
      loading: 'Reading the records…', loadingDetail: 'This takes a moment. Nothing is shown until it is read.',
      empty: 'Nothing here yet', emptyDetail: 'No records have been found for this list. An empty list does not mean everything is fine — it means there is nothing to show yet.',
      noMatch: 'No rows match', noMatchDetail: 'Nothing in this list matches the search or filter. The list itself still has {n} row(s).',
      error: 'Could not read this list', errorDetail: 'Nothing was changed. Try again; if it keeps happening, tell the manager.',
      offline: 'Head office cannot be reached', offlineDetail: 'This list could not be read, so nothing here is current. Nothing was changed.',
      denied: 'Your role cannot open this', deniedDetail: 'Ask the owner or the manager if you need it.',
      notKnown: 'Not known', required: 'required', fillIn: 'Fill in "{f}".', fixFields: 'Some answers need fixing before this can be sent:', tryAgain: 'Try again',
      beforeThis: 'Before this is sent', goBack: 'Go back', confirm: 'Confirm', reasonShort: 'Say why in at least {n} letters.',
      pick_product: 'Which product?', pick_supplier: 'Which supplier?', pick_person: 'Which person?', pick_place: 'Which place?', pick_store: 'Which store?', pick_customer: 'Which customer?', pick_approval: 'Which approval?',
      pickSearch: 'Type a few letters of the name, or the code', pickHint: 'A name, a code or a barcode',
      pickHint_product: 'A name, an item code or a barcode', pickHint_supplier: 'A supplier\'s name or code', pickHint_person: 'A person\'s name', pickHint_place: 'A place or bin', pickHint_store: 'A store\'s name', pickHint_customer: 'A customer number', pickHint_approval: 'What was asked for',
      pickCount: '{n} found', pickMore: '{n} more — type more letters', pickRecent: 'Chosen recently on this computer', recentPick: 'recent',
      pickEmptyDetail: 'Head office holds nothing in this list yet, so there is nothing to pick from.', pickNoMatchDetail: 'Nothing in this list matches what was typed. The list has {n} to choose from.',
      pickUnknownDetail: 'The store computer has not been given this list, so it cannot be searched here.', pickCodeDetail: 'The list could not be read. If you know the code, type it below.',
      pickNoBarcode: 'No product carries that barcode at head office.',
      typeCodeInstead: 'Type the code instead', useThisCode: 'Use this code', choose: 'Choose…', clearPick: 'Clear', nothingChosen: 'Nothing chosen yet',
      dateHint: 'Day / month / year, for example 31/10/2026', dateBad: 'That is not a real date. Write it as day/month/year, for example 31/10/2026.', dateTooEarly: 'That is before {d}.', dateTooLate: 'That is after {d}.',
      refused: 'Head office refused:', refusedPlain: 'it did not accept what was sent', nothingChangedWord: 'Nothing was changed.', tryAgainTell: 'Try again; if it keeps happening, tell the manager.',
    },
    ta: {
      search: 'இந்தப் பட்டியலில் தேடு', filterAll: 'அனைத்தும்', columns: 'நெடுவரிசைகள்', columnsShown: 'காட்ட வேண்டிய நெடுவரிசைகள்', open: 'திற', close: 'மூடு',
      showing: '{n} இல் {from}–{to} காட்டப்படுகிறது', showingNone: '{n} இல் 0 காட்டப்படுகிறது', previous: 'முந்தைய பக்கம்', next: 'அடுத்த பக்கம்', page: 'பக்கம் {p} / {q}',
      sortBy: '{c} படி வரிசைப்படுத்து', clear: 'தேடலையும் வடிகட்டியையும் அழி',
      sortedAsc: 'குறைவிலிருந்து அதிகம்', sortedDesc: 'அதிகத்திலிருந்து குறைவு', sortedAscText: 'அகரவரிசை', sortedDescText: 'எதிர் அகரவரிசை', notSorted: 'வரிசைப்படுத்தத் தட்டவும்',
      'pick_tax-class': 'எந்த வரி வகுப்பு?', 'pickHint_tax-class': 'HSN குறியீடு, அல்லது அதன் கீழுள்ள ஒரு பொருள்',
      taxClassRowOne: 'HSN {code} — 1 பொருள்', taxClassRowMany: 'HSN {code} — {n} பொருள்கள்',
      pickFromBox: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இந்தப் பட்டியல் இந்தக் கடை கணினியின் பட்டியல் நகலிலிருந்து (பதிப்பு {v}). அதன் பின் வெளியிடப்பட்ட பொருள் இதில் இல்லை.',
      thisPage: 'இந்தப் பக்கம்', datePlaceholder: 'நா/மா/ஆண்டு',
      loading: 'பதிவுகளைப் படிக்கிறது…', loadingDetail: 'சிறிது நேரம் ஆகும். படிக்கும் வரை எதுவும் காட்டப்படாது.',
      empty: 'இன்னும் எதுவும் இல்லை', emptyDetail: 'இந்தப் பட்டியலுக்கு எந்தப் பதிவும் கிடைக்கவில்லை. காலியான பட்டியல் எல்லாம் சரி என்று பொருளல்ல — காட்ட இன்னும் எதுவும் இல்லை என்று பொருள்.',
      noMatch: 'பொருந்தும் வரிசை இல்லை', noMatchDetail: 'தேடலுக்கோ வடிகட்டிக்கோ இந்தப் பட்டியலில் எதுவும் பொருந்தவில்லை. பட்டியலில் இன்னும் {n} வரிசை(கள்) உள்ளன.',
      error: 'இந்தப் பட்டியலைப் படிக்க முடியவில்லை', errorDetail: 'எதுவும் மாற்றப்படவில்லை. மீண்டும் முயலவும்; தொடர்ந்தால் மேலாளரிடம் சொல்லவும்.',
      offline: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை', offlineDetail: 'இந்தப் பட்டியலைப் படிக்க முடியவில்லை, எனவே இங்கு எதுவும் தற்போதையது அல்ல. எதுவும் மாற்றப்படவில்லை.',
      denied: 'உங்கள் பங்கால் இதைத் திறக்க முடியாது', deniedDetail: 'தேவையெனில் உரிமையாளர் அல்லது மேலாளரிடம் கேளுங்கள்.',
      notKnown: 'தெரியவில்லை', required: 'கட்டாயம்', fillIn: '"{f}" நிரப்பவும்.', fixFields: 'அனுப்பும் முன் சில பதில்களைச் சரிசெய்ய வேண்டும்:', tryAgain: 'மீண்டும் முயல்',
      beforeThis: 'இது அனுப்பப்படும் முன்', goBack: 'பின் செல்', confirm: 'உறுதிப்படுத்து', reasonShort: 'குறைந்தது {n} எழுத்துகளில் ஏன் என்று சொல்லவும்.',
      pick_product: 'எந்தப் பொருள்?', pick_supplier: 'எந்த விநியோகஸ்தர்?', pick_person: 'யார்?', pick_place: 'எந்த இடம்?', pick_store: 'எந்தக் கடை?', pick_customer: 'எந்த வாடிக்கையாளர்?', pick_approval: 'எந்த அனுமதி?',
      pickSearch: 'பெயரின் சில எழுத்துகள், அல்லது குறியீடு', pickHint: 'பெயர், குறியீடு அல்லது பார்கோடு',
      pickHint_product: 'பெயர், பொருள் குறியீடு அல்லது பார்கோடு', pickHint_supplier: 'விநியோகஸ்தரின் பெயர் அல்லது குறியீடு', pickHint_person: 'ஒருவரின் பெயர்', pickHint_place: 'இடம் அல்லது தட்டு', pickHint_store: 'கடையின் பெயர்', pickHint_customer: 'வாடிக்கையாளர் எண்', pickHint_approval: 'என்ன கேட்கப்பட்டது',
      pickCount: '{n} கிடைத்தன', pickMore: 'இன்னும் {n} — மேலும் எழுத்துகளைத் தட்டச்சு செய்க', pickRecent: 'இந்தக் கணினியில் சமீபத்தில் தேர்ந்தவை', recentPick: 'சமீபம்',
      pickEmptyDetail: 'இந்தப் பட்டியலில் தலைமை அலுவலகத்தில் இன்னும் எதுவும் இல்லை, எனவே தேர்ந்தெடுக்க எதுவும் இல்லை.', pickNoMatchDetail: 'தட்டச்சு செய்ததற்கு இந்தப் பட்டியலில் எதுவும் பொருந்தவில்லை. பட்டியலில் {n} உள்ளன.',
      pickUnknownDetail: 'கடை கணினிக்கு இந்தப் பட்டியல் கொடுக்கப்படவில்லை, எனவே இங்கு தேட முடியாது.', pickCodeDetail: 'பட்டியலைப் படிக்க முடியவில்லை. குறியீடு தெரிந்தால் கீழே தட்டச்சு செய்யவும்.',
      pickNoBarcode: 'அந்தப் பார்கோடு கொண்ட பொருள் தலைமை அலுவலகத்தில் இல்லை.',
      typeCodeInstead: 'அதற்குப் பதிலாகக் குறியீட்டைத் தட்டச்சு செய்க', useThisCode: 'இந்தக் குறியீட்டைப் பயன்படுத்து', choose: 'தேர்ந்தெடு…', clearPick: 'அழி', nothingChosen: 'இன்னும் எதுவும் தேர்ந்தெடுக்கப்படவில்லை',
      dateHint: 'நாள் / மாதம் / ஆண்டு, எடுத்துக்காட்டாக 31/10/2026', dateBad: 'அது உண்மையான தேதி அல்ல. நாள்/மாதம்/ஆண்டு என எழுதவும், எடுத்துக்காட்டாக 31/10/2026.', dateTooEarly: 'அது {d} க்கு முன்.', dateTooLate: 'அது {d} க்குப் பின்.',
      refused: 'தலைமை அலுவலகம் மறுத்தது:', refusedPlain: 'அனுப்பியதை அது ஏற்கவில்லை', nothingChangedWord: 'எதுவும் மாற்றப்படவில்லை.', tryAgainTell: 'மீண்டும் முயலவும்; தொடர்ந்தால் மேலாளரிடம் சொல்லவும்.',
    },
  };
  const ow = (key) => OFFICE_WORDS[lang()][key] ?? OFFICE_WORDS.en[key];
  const fill = (text, values) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
  /** A page's words: a plain string, or `{ en, ta }` drawn in the reader's language. */
  const said = (pair) => word(pair);
  const STATE_ICONS = Object.freeze({ loading: 'clock', empty: 'list', noMatch: 'search-x', error: 'circle-alert', offline: 'triangle-alert', denied: 'lock', unknown: 'circle-help' });

  /** A plain-language state in place of content: loading · empty ("nothing yet") · no match · error · offline · denied. */
  function officeState(host, kind, opts = {}) {
    const box = document.createElement('div');
    box.className = 'sre-empty sre-state';
    box.dataset.state = kind;
    box.setAttribute('role', kind === 'error' || kind === 'offline' ? 'alert' : 'status');
    const mark = icon(STATE_ICONS[kind] ?? 'circle-help', 32);
    if (mark) box.append(mark);
    const title = document.createElement('strong');
    title.textContent = opts.title !== undefined ? said(opts.title) : ow(kind === 'noMatch' ? 'noMatch' : kind);
    const detail = document.createElement('span');
    detail.className = 'sre-state-detail';
    detail.textContent = opts.detail !== undefined ? said(opts.detail) : fill(ow(`${kind}Detail`) ?? '', opts.values ?? {});
    box.append(title, detail);
    if (typeof opts.action === 'function') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sre-btn';
      b.textContent = opts.actionLabel !== undefined ? said(opts.actionLabel) : ow('tryAgain');
      b.addEventListener('click', opts.action);
      box.append(b);
    }
    if (host) host.replaceChildren(box);
    return box;
  }

  /** A status chip: the tone's shape and its words (never colour alone). */
  function officeChip(tone, label) {
    const words = said(label);
    if (window.sreIcon && typeof window.sreIcon.chip === 'function') return window.sreIcon.chip({ tone, label: words });
    const span = document.createElement('span'); span.className = 'sre-chip'; span.dataset.tone = tone; span.textContent = words; return span;
  }

  // U5 (G13): a record's lifecycle state as the one chip — the tone's shape and the words of both languages, never a bare
  // pill, a two-tone colour or a ⚠/✓ character. A state the table does not know is shown as it was given, in the unknown
  // tone (said, never guessed). A page may pass its own words for the label and keep the state's tone.
  const RECORD_STATES = Object.freeze({
    draft: { tone: 'idle', en: 'Draft', ta: 'வரைவு' },
    proposed: { tone: 'pending', en: 'Proposed', ta: 'முன்மொழியப்பட்டது' },
    pending: { tone: 'pending', en: 'Waiting', ta: 'காத்திருக்கிறது' },
    waiting: { tone: 'pending', en: 'Waiting', ta: 'காத்திருக்கிறது' },
    submitted: { tone: 'pending', en: 'Sent for approval', ta: 'அனுமதிக்கு அனுப்பப்பட்டது' },
    approved: { tone: 'ok', en: 'Approved', ta: 'அனுமதிக்கப்பட்டது' },
    rejected: { tone: 'error', en: 'Rejected', ta: 'நிராகரிக்கப்பட்டது' },
    refused: { tone: 'error', en: 'Refused', ta: 'மறுக்கப்பட்டது' },
    open: { tone: 'pending', en: 'Open', ta: 'திறந்துள்ளது' },
    closed: { tone: 'idle', en: 'Closed', ta: 'மூடப்பட்டது' },
    done: { tone: 'ok', en: 'Done', ta: 'முடிந்தது' },
    completed: { tone: 'ok', en: 'Done', ta: 'முடிந்தது' },
    cancelled: { tone: 'idle', en: 'Cancelled', ta: 'ரத்து செய்யப்பட்டது' },
    active: { tone: 'ok', en: 'Active', ta: 'செயலில்' },
    inactive: { tone: 'idle', en: 'Not active', ta: 'செயலில் இல்லை' },
    archived: { tone: 'idle', en: 'Archived', ta: 'காப்பகப்படுத்தப்பட்டது' },
    held: { tone: 'pending', en: 'On hold', ta: 'நிறுத்தி வைக்கப்பட்டது' },
    released: { tone: 'ok', en: 'Released', ta: 'விடுவிக்கப்பட்டது' },
    sent: { tone: 'ok', en: 'Sent', ta: 'அனுப்பப்பட்டது' },
    unsent: { tone: 'pending', en: 'Not sent yet', ta: 'இன்னும் அனுப்பப்படவில்லை' },
    received: { tone: 'ok', en: 'Received', ta: 'பெறப்பட்டது' },
    partial: { tone: 'pending', en: 'Partly done', ta: 'பகுதி முடிந்தது' },
    failed: { tone: 'error', en: 'Failed', ta: 'தோல்வி' },
    error: { tone: 'error', en: 'Error', ta: 'பிழை' },
    overdue: { tone: 'error', en: 'Overdue', ta: 'தாமதம்' },
    due: { tone: 'pending', en: 'Due', ta: 'நிலுவை' },
    paid: { tone: 'ok', en: 'Paid', ta: 'செலுத்தப்பட்டது' },
    unpaid: { tone: 'pending', en: 'Not paid', ta: 'செலுத்தப்படவில்லை' },
    matched: { tone: 'ok', en: 'Matched', ta: 'பொருந்தியது' },
    unmatched: { tone: 'pending', en: 'Not matched', ta: 'பொருந்தவில்லை' },
    posted: { tone: 'ok', en: 'Posted', ta: 'பதிவிடப்பட்டது' },
    locked: { tone: 'idle', en: 'Locked', ta: 'பூட்டப்பட்டது' },
    expired: { tone: 'error', en: 'Expired', ta: 'காலாவதி' },
    recalled: { tone: 'error', en: 'Recalled', ta: 'திரும்பப் பெறப்பட்டது' },
    scheduled: { tone: 'pending', en: 'Scheduled', ta: 'திட்டமிடப்பட்டது' },
    running: { tone: 'pending', en: 'Running', ta: 'இயங்குகிறது' },
    stopped: { tone: 'idle', en: 'Stopped', ta: 'நிறுத்தப்பட்டது' },
    ok: { tone: 'ok', en: 'OK', ta: 'சரி' },
    warning: { tone: 'degraded', en: 'Needs attention', ta: 'கவனம் தேவை' },
    unknown: { tone: 'unknown', en: 'Not known', ta: 'தெரியவில்லை' },
  });
  function officeRecordChip(state, label) {
    const key = String(state ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    const known = RECORD_STATES[key] ?? RECORD_STATES[key.replace(/-/g, '')] ?? null;
    const tone = known ? known.tone : 'unknown';
    const words = () => (label !== undefined ? said(label) : known ? said(known) : (key === '' ? ow('notKnown') : String(state)));
    const chip = officeChip(tone, words());
    chip.dataset.state = key;
    // the words follow the toggle while the chip is on the page; a chip the page has since replaced is let go
    adapterRepaints.add(() => {
      if (!chip.isConnected) throw new Error('gone');
      const text = [...chip.childNodes].reverse().find((n) => n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'SPAN' && !n.classList.contains('sre-icon')));
      if (text) text.textContent = words();
    });
    return chip;
  }

  /**
   * Summary cards: `{ label, value, note?, tone?, href?, icon? }` each. `value` null or undefined is "Not known" — never 0.
   * A number is drawn as the page gave it (a page formats money itself, from its own figures).
   */
  function officeCards(host, cards) {
    const list = document.createElement('div');
    list.className = 'sre-summary';
    for (const c of cards) {
      const card = document.createElement(c.href ? 'a' : 'div');
      card.className = 'sre-summary-card';
      if (c.href) card.href = c.href;
      if (c.tone) card.dataset.tone = c.tone;
      const head = document.createElement('span');
      head.className = 'sre-summary-label';
      const mark = c.icon ? icon(c.icon, 18) : null;
      if (mark) head.append(mark);
      head.append(document.createTextNode(said(c.label)));
      const value = document.createElement('b');
      value.className = 'sre-summary-value';
      const known = c.value !== null && c.value !== undefined && c.value !== '';
      value.textContent = known ? String(c.value) : ow('notKnown');
      if (!known) value.classList.add('sre-unknown');
      card.append(head, value);
      if (c.note !== undefined && said(c.note) !== '') {
        const note = document.createElement('span');
        note.className = 'sre-summary-note';
        note.textContent = said(c.note);
        card.append(note);
      }
      list.append(card);
    }
    if (host) host.replaceChildren(list);
    return list;
  }

  /**
   * A form field: a visible label (the field's name), a required mark said in words for a screen reader, a hint, and a
   * message slot the checker fills in plain language. Returns the `<div class="sre-field">`; the control is its `input`.
   */
  function officeField({ id, label, type = 'text', required = false, hint, options, value, inputmode, autocomplete = 'off' }) {
    const wrap = document.createElement('div');
    wrap.className = 'sre-field';
    const lab = document.createElement('label');
    lab.htmlFor = id;
    lab.className = 'sre-field-label';
    lab.append(document.createTextNode(said(label)));
    if (required) {
      const mark = document.createElement('span');
      mark.className = 'sre-req';
      mark.textContent = ` (${ow('required')})`;
      lab.append(mark);
    }
    let control;
    if (type === 'select') {
      control = document.createElement('select');
      control.className = 'sre-select';
      for (const o of options ?? []) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = said(o.label); control.append(opt); }
    } else if (type === 'textarea') {
      control = document.createElement('textarea');
      control.className = 'sre-input';
      control.rows = 3;
    } else {
      control = document.createElement('input');
      control.type = type;
      control.className = 'sre-input';
      control.autocomplete = autocomplete;
      if (inputmode) control.inputMode = inputmode;
    }
    control.id = id;
    if (value !== undefined) control.value = value;
    if (required) { control.required = true; control.setAttribute('aria-required', 'true'); }
    const describedBy = [];
    if (hint !== undefined) {
      const h = document.createElement('span');
      h.className = 'sre-field-hint';
      h.id = `${id}-hint`;
      h.textContent = said(hint);
      describedBy.push(h.id);
      wrap.append(lab, h);
    } else wrap.append(lab);
    const msg = document.createElement('span');
    msg.className = 'sre-field-msg';
    msg.id = `${id}-msg`;
    msg.hidden = true;
    describedBy.push(msg.id);
    control.setAttribute('aria-describedby', describedBy.join(' '));
    wrap.append(control, msg);
    // the field's own words follow the toggle (U3 · NFR-08): the label, "(required)", the hint
    wrap.sreWords = { label, required, hint };
    adapterRepaints.add(() => { if (!wrap.isConnected) throw new Error('gone'); repaintFieldWords(wrap); });
    return wrap;
  }
  /** Rewrite a shared field's label, "(required)" mark and hint in the reader's language (the control keeps its value). */
  function repaintFieldWords(wrap) {
    const w = wrap.sreWords;
    if (!w) return;
    const lab = wrap.querySelector(':scope > .sre-field-label');
    if (lab && lab.firstChild && lab.firstChild.nodeType === 3) lab.firstChild.textContent = said(w.label);
    const req = lab ? lab.querySelector('.sre-req') : null;
    if (req) req.textContent = ` (${ow('required')})`;
    const hint = wrap.querySelector(':scope > .sre-field-hint');
    if (hint) hint.textContent = w.hint !== undefined ? said(w.hint) : (wrap.classList.contains('sre-date') ? ow('dateHint') : hint.textContent);
    if (typeof wrap.sreRepaint === 'function') wrap.sreRepaint();
  }

  /**
   * Check a form's fields before anything is sent: every required field filled in, every field's own browser rule kept.
   * Each wrong field says what to do beside it, the first one takes the focus, and the answer is true only when all are
   * right. A page sends nothing on false.
   */
  function officeCheck(form) {
    const bad = [];
    for (const field of form.querySelectorAll('.sre-field')) {
      // a pick field keeps its id in a hidden input; the words and the focus go to what the person sees (U2)
      const isPick = field.classList.contains('sre-pick');
      const control = isPick ? field.querySelector('input[type="hidden"]') : field.querySelector('input, select, textarea');
      const seen = isPick ? field.querySelector('.sre-pick-shown') : control;
      const landing = isPick ? field.querySelector('.sre-pick-choose') : control;
      const msg = field.querySelector('.sre-field-msg');
      if (!control || !msg) continue;
      const name = (field.querySelector('.sre-field-label')?.firstChild?.textContent ?? '').trim();
      let problem = '';
      if (control.required && String(control.value ?? '').trim() === '') problem = fill(ow('fillIn'), { f: name });
      else if (typeof control.checkValidity === 'function' && !control.checkValidity()) problem = control.validationMessage || fill(ow('fillIn'), { f: name });
      msg.hidden = problem === '';
      msg.textContent = problem;
      if (problem === '') seen.removeAttribute('aria-invalid'); else { seen.setAttribute('aria-invalid', 'true'); bad.push(landing); }
    }
    if (bad.length > 0) bad[0].focus();
    return bad.length === 0;
  }

  // ── The record drawer: one record, opened from a register row; Escape or Close shuts it and the focus goes back ──
  let drawerReturn = null;
  function officeDrawer({ title, body }) {
    let aside = byId('sre-drawer');
    if (!aside) {
      aside = document.createElement('aside');
      aside.id = 'sre-drawer';
      aside.className = 'sre-drawer';
      aside.setAttribute('role', 'dialog');
      aside.setAttribute('aria-modal', 'true');
      aside.setAttribute('aria-labelledby', 'sre-drawer-title');
      aside.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
      document.body.append(aside);
    }
    drawerReturn = document.activeElement;
    const head = document.createElement('div');
    head.className = 'sre-drawer-head';
    const h = document.createElement('h2');
    h.id = 'sre-drawer-title';
    h.textContent = said(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sre-btn';
    close.id = 'sre-drawer-close';
    const x = icon('x', 18);
    if (x) close.append(x);
    close.append(document.createTextNode(ow('close')));
    close.addEventListener('click', () => closeDrawer());
    head.append(h, close);
    const inner = document.createElement('div');
    inner.className = 'sre-drawer-body';
    if (body) inner.append(body);
    aside.replaceChildren(head, inner);
    aside.hidden = false;
    close.focus();
    return aside;
  }
  function closeDrawer() {
    const aside = byId('sre-drawer');
    if (!aside || aside.hidden) return;
    aside.hidden = true;
    if (drawerReturn && typeof drawerReturn.focus === 'function' && document.contains(drawerReturn)) drawerReturn.focus();
    drawerReturn = null;
  }
  // ── The confirm sheet (OB-698, 2 Nov 2026 · design system §1.3 · §27.1): consequence, authority, then the person's
  // own word — BEFORE money, stock, a price or a privilege moves. `await sreOffice.confirm({ title, detail, authority,
  // confirmLabel, tone, reason? })` → `{ ok: true, reason? }` only on the confirm button; Go back, Escape, a tap on the
  // scrim, a second ask or leaving the page all answer `{ ok: false }`, and the page sends nothing on that. The safe
  // answer holds the focus; Enter never confirms unless the focus is on the confirm button itself. A required reason
  // refuses a blank with the message beside the field (the shared field rules). Never a browser dialog.
  let confirmOpen = null;
  function officeConfirm(spec) {
    if (confirmOpen) confirmOpen.finish(false);
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const tone = spec.tone === 'danger' ? 'danger' : 'primary';
      const sheet = document.createElement('div');
      sheet.className = 'sre-sheet sre-confirm';
      sheet.id = 'sre-confirm';
      sheet.dataset.tone = tone;
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-labelledby', 'sre-confirm-title');
      sheet.setAttribute('aria-describedby', 'sre-confirm-detail');
      const inner = document.createElement('form');
      inner.className = 'sre-sheet-inner';
      inner.noValidate = true;
      inner.addEventListener('submit', (e) => { e.preventDefault(); });
      const kicker = document.createElement('p');
      kicker.className = 'sre-confirm-kicker';
      const h = document.createElement('h2');
      h.id = 'sre-confirm-title';
      const detail = document.createElement('p');
      detail.id = 'sre-confirm-detail';
      detail.className = 'sre-confirm-detail';
      const authority = document.createElement('p');
      authority.className = 'sre-confirm-authority';
      let reasonWrap = null;
      if (spec.reason) {
        reasonWrap = officeField({ id: 'sre-confirm-reason', label: spec.reason.label, type: 'textarea', required: spec.reason.required !== false, hint: spec.reason.hint });
      }
      const actions = document.createElement('div');
      actions.className = 'sre-confirm-actions';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'sre-btn';
      back.id = 'sre-confirm-back';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = `sre-btn ${tone === 'danger' ? 'sre-btn-danger' : 'sre-btn-primary'}`;
      go.id = 'sre-confirm-go';
      actions.append(back, go);
      inner.append(kicker, h, detail, authority);
      if (reasonWrap) inner.append(reasonWrap);
      inner.append(actions);
      sheet.append(inner);

      const paintWords = () => {
        kicker.textContent = ow('beforeThis');
        h.textContent = said(spec.title);
        detail.textContent = said(spec.detail);
        authority.textContent = spec.authority ? said(spec.authority) : '';
        authority.hidden = !spec.authority;
        back.textContent = ow('goBack');
        go.textContent = spec.confirmLabel ? said(spec.confirmLabel) : ow('confirm');
        if (reasonWrap) {
          const lab = reasonWrap.querySelector('.sre-field-label');
          if (lab) { lab.replaceChildren(document.createTextNode(said(spec.reason.label))); if (spec.reason.required !== false) { const mark = document.createElement('span'); mark.className = 'sre-req'; mark.textContent = ` (${ow('required')})`; lab.append(mark); } }
          const hint = reasonWrap.querySelector('.sre-field-hint');
          if (hint && spec.reason.hint) hint.textContent = said(spec.reason.hint);
        }
      };
      const observer = new MutationObserver(paintWords);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

      const focusables = () => [...inner.querySelectorAll('button, textarea, input, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && visible(el));
      const finish = (ok) => {
        if (confirmOpen !== me) return;
        let reason;
        if (ok && reasonWrap) {
          const control = reasonWrap.querySelector('textarea');
          const msg = reasonWrap.querySelector('.sre-field-msg');
          const text = String(control.value ?? '').trim();
          const min = spec.reason.minLength ?? 1;
          let problem = '';
          if (text === '' && spec.reason.required !== false) problem = fill(ow('fillIn'), { f: said(spec.reason.label) });
          else if (text !== '' && text.length < min) problem = fill(ow('reasonShort'), { n: min });
          msg.hidden = problem === '';
          msg.textContent = problem;
          if (problem !== '') { control.setAttribute('aria-invalid', 'true'); control.focus(); return; }
          control.removeAttribute('aria-invalid');
          reason = text;
        }
        confirmOpen = null;
        observer.disconnect();
        window.removeEventListener('pagehide', onLeave);
        sheet.remove();
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        resolve(ok ? (reason === undefined ? { ok: true } : { ok: true, reason }) : { ok: false });
      };
      const onLeave = () => finish(false);
      const me = { finish };
      confirmOpen = me;
      window.addEventListener('pagehide', onLeave);
      back.addEventListener('click', () => finish(false));
      go.addEventListener('click', () => finish(true));
      sheet.addEventListener('click', (e) => { if (e.target === sheet) finish(false); });
      sheet.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
        if (e.key === 'Enter' && e.target !== go && e.target !== back && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); return; }
        if (e.key === 'Tab') {
          const list = focusables();
          if (list.length === 0) return;
          const first = list[0]; const last = list[list.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
      paintWords();
      document.body.append(sheet);
      back.focus();
    });
  }

  // ── U2 (G5 · G14 · G16): pick a thing by its NAME, a date a shop person reads, a name for an id, who is looking ──────
  //
  // A shop person knows "Toor dal", "Ravi" and "the back store", not `p-dal`, `u-ravi` and `S1-BACK`. The picker is one
  // sheet with a search box and a list; the lists come from the store computer's signed pack (people, places, the store —
  // there with head office down, P-01) or from head office's own routes in the person's session (products, suppliers,
  // customers, approvals) — never from a route the person may not read. When a list cannot be read the sheet SAYS so and,
  // where the page allows, offers "Type the code instead", so nothing is ever a dead end (P-08). The last ten picks per
  // kind are this browser's convenience only.
  const directory = () => (window.sreDirectory && typeof window.sreDirectory === 'object' ? window.sreDirectory : null);
  const PICK_KINDS = Object.freeze(['product', 'supplier', 'person', 'place', 'store', 'customer', 'approval', 'tax-class']);
  const listCache = new Map(); // kind → { at, rows } for a minute: the person types, the list does not re-read on every key
  const LIST_TTL_MS = 60_000;
  const pickKey = (kind) => `sre.pick.${kind}.${String(navigation()?.userId ?? directory()?.me?.userId ?? 'nobody')}`;
  function recentPicks(kind) {
    try { const v = JSON.parse(window.localStorage.getItem(pickKey(kind)) ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string') : []; } catch { return []; }
  }
  function rememberPick(kind, row) {
    try {
      const kept = [{ id: row.id, name: row.name, ...(row.code === undefined ? {} : { code: row.code }) }, ...recentPicks(kind).filter((r) => r.id !== row.id)].slice(0, 10);
      window.localStorage.setItem(pickKey(kind), JSON.stringify(kept));
    } catch { /* a convenience only */ }
  }
  const asRow = (id, name, code, item) => ({ id: String(id), name: String(name ?? id), ...(code === undefined || code === null || code === '' ? {} : { code: String(code) }), item });
  /** Head office, in the person's own session — the same relative `/v1` read every office page makes. */
  async function readHeadOffice(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) return { state: 'denied' };
    if (!res.ok) return { state: 'error' };
    try { return { state: 'ok', body: await res.json() }; } catch { return { state: 'error' }; }
  }
  /**
   * The rows of one kind: `{ state: 'ok', rows }` or `{ state: 'denied' | 'offline' | 'error' | 'unknown' }`.
   * `unknown` is a register the pack never held (said, not guessed).
   */
  async function listOf(kind, scope = {}) {
    const d = directory();
    if (kind === 'person') {
      if (d && d.known && d.known.people) return { state: 'ok', rows: d.people.map((p) => asRow(p.id, p.name, p.roleId ?? undefined, p)) };
      const got = await readHeadOffice('/v1/identity/people').catch(() => ({ state: 'offline' }));
      return got.state === 'ok' ? { state: 'ok', rows: (got.body.people ?? []).map((p) => asRow(p.userId, p.displayName, p.username, p)) } : got;
    }
    if (kind === 'place') {
      if (d && d.known && d.known.places) {
        const storeId = scope.storeId ?? d.store?.id;
        return { state: 'ok', rows: d.places.filter((p) => storeId === undefined || p.kind !== 'bin' || true).map((p) => asRow(p.id, p.name, p.kind, p)) };
      }
      return { state: 'unknown' };
    }
    if (kind === 'store') {
      const rows = d && d.store ? [asRow(d.store.id, d.store.name, 'store', d.store)] : [];
      const got = await readHeadOffice('/v1/org/nodes').catch(() => ({ state: 'offline' }));
      if (got.state === 'ok') {
        for (const n of got.body.nodes ?? []) if (n.kind === 'branch' && !rows.some((r) => r.id === n.nodeId)) rows.push(asRow(n.nodeId, n.name, n.gstin ?? undefined, n));
        return { state: 'ok', rows };
      }
      return rows.length > 0 ? { state: 'ok', rows } : got;
    }
    const cached = listCache.get(kind);
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return { state: 'ok', rows: cached.rows };
    const paths = { product: '/v1/catalogue/products', supplier: '/v1/purchase/suppliers', customer: '/v1/customer/overview', approval: '/v1/approvals/requests', 'tax-class': '/v1/catalogue/products' };
    const got = await readHeadOffice(paths[kind]).catch(() => ({ state: 'offline' }));
    // U5 (P-01): a product can still be picked with head office down — from this store computer's own signed catalogue,
    // and the sheet SAYS so (a product published since is not in that copy). Any other list stays honest: unreadable.
    if (got.state !== 'ok' && kind === 'product') { const box = await productsFromBox(); if (box !== null) return box; }
    if (got.state !== 'ok') return got;
    let rows = [];
    if (kind === 'product') rows = (got.body.products ?? []).map((p) => asRow(p.productId, p.name, p.sku, p));
    else if (kind === 'tax-class') {
      // every HSN head office's products carry, with how many products stand under it — the same count the Tax rates page shows
      const counts = new Map();
      for (const p of got.body.products ?? []) { const c = typeof p.taxClass === 'string' ? p.taxClass.trim() : ''; if (c === '') continue; counts.set(c, (counts.get(c) ?? 0) + 1); }
      rows = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => asRow(c, n === 1 ? fill(ow('taxClassRowOne'), { code: c }) : fill(ow('taxClassRowMany'), { code: c, n }), c, { hsnCode: c, products: n }));
      return { state: 'ok', rows }; // not cached: the words are in the reader's language
    }
    else if (kind === 'supplier') rows = (got.body.suppliers ?? []).map((s) => asRow(s.supplierId, s.name ?? s.supplierId, s.status, s));
    else if (kind === 'customer') rows = (got.body.customers ?? []).map((c) => asRow(c.customerRef, typeof c.name === 'string' && c.name.trim() !== '' ? c.name : c.customerRef, c.customerRef, c));
    else if (kind === 'approval') rows = [...(got.body.waitingForMe ?? []), ...(got.body.mine ?? [])].map((a) => asRow(a.requestId, a.summary ?? a.label ?? a.requestId, a.status, a));
    listCache.set(kind, { at: Date.now(), rows });
    return { state: 'ok', rows };
  }
  /** The store computer's own signed catalogue (`/directory/products`, served from the pack on this box) — null when the box has none. */
  async function productsFromBox() {
    try {
      const res = await fetch(`${'/directory/products'}?limit=5000`, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body || body.known !== true || !Array.isArray(body.products)) return null;
      const rows = body.products.map((p) => asRow(p.id, p.name, p.code, p));
      return { state: 'ok', rows, source: 'box', version: body.version ?? null };
    } catch { return null; }
  }
  /** A product by its barcode — head office's own lookup, when the person typed digits that look like one. */
  async function productByBarcode(code) {
    const got = await readHeadOffice(`/v1/catalogue/barcodes/${encodeURIComponent(code)}`).catch(() => ({ state: 'offline' }));
    if (got.state !== 'ok' || !got.body.barcode) return null;
    const b = got.body.barcode;
    const productId = b.productId ?? b.product?.productId;
    if (typeof productId !== 'string') return null;
    const known = (listCache.get('product')?.rows ?? []).find((r) => r.id === productId);
    return known ?? asRow(productId, b.product?.name ?? b.name ?? productId, code, b);
  }
  const normalise = (s) => String(s ?? '').toLowerCase().normalize('NFC');
  /** Every word typed must be found in the name or the code — the same rule as the rail's search. */
  function matches(row, query) {
    const hay = `${normalise(row.name)} ${normalise(row.code)} ${normalise(row.id)}`;
    return normalise(query).split(/\s+/).filter((w) => w !== '').every((w) => hay.includes(w));
  }

  let pickOpen = null;
  function officePick(spec) {
    if (pickOpen) pickOpen.finish({ ok: false });
    const kind = PICK_KINDS.includes(spec.kind) ? spec.kind : 'product';
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const sheet = document.createElement('div');
      sheet.className = 'sre-sheet sre-picker';
      sheet.id = 'sre-picker';
      sheet.dataset.kind = kind;
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-labelledby', 'sre-picker-title');
      const inner = document.createElement('form');
      inner.className = 'sre-sheet-inner';
      inner.noValidate = true;
      inner.addEventListener('submit', (e) => { e.preventDefault(); });
      const h = document.createElement('h2');
      h.id = 'sre-picker-title';
      const searchWrap = document.createElement('div');
      searchWrap.className = 'sre-field sre-picker-search';
      const searchLabel = document.createElement('label');
      searchLabel.htmlFor = 'sre-picker-q';
      searchLabel.className = 'sre-field-label';
      const search = document.createElement('input');
      search.type = 'search';
      search.id = 'sre-picker-q';
      search.className = 'sre-input';
      search.autocomplete = 'off';
      search.setAttribute('aria-describedby', 'sre-picker-count');
      const count = document.createElement('p');
      count.id = 'sre-picker-count';
      count.className = 'sre-picker-count';
      count.setAttribute('role', 'status');
      // U5: where the list came from when it is not head office — said once, in words, above the rows
      const source = document.createElement('p');
      source.id = 'sre-picker-source';
      source.className = 'sre-picker-source';
      source.setAttribute('role', 'status');
      source.hidden = true;
      searchWrap.append(searchLabel, search, count, source);
      const list = document.createElement('ul');
      list.className = 'sre-picker-list';
      list.id = 'sre-picker-list';
      list.setAttribute('aria-label', '');
      const stateHost = document.createElement('div');
      stateHost.className = 'sre-picker-state';
      const codeWrap = document.createElement('div');
      codeWrap.className = 'sre-picker-code';
      codeWrap.hidden = true;
      const codeField = officeField({ id: 'sre-picker-typed', label: { en: 'Type the code instead', ta: 'அதற்குப் பதிலாகக் குறியீட்டைத் தட்டச்சு செய்க' } });
      const useCode = document.createElement('button');
      useCode.type = 'button';
      useCode.className = 'sre-btn';
      useCode.id = 'sre-picker-use-code';
      codeWrap.append(codeField, useCode);
      const actions = document.createElement('div');
      actions.className = 'sre-confirm-actions';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'sre-btn';
      back.id = 'sre-picker-back';
      actions.append(back);
      inner.append(h, searchWrap, stateHost, list, codeWrap, actions);
      sheet.append(inner);

      let rows = null; // null until read
      let listState = 'loading';
      let listSource = null; // 'box' when the rows are this store computer's copy
      let shownRows = [];
      const MAX = 50;
      const paintWords = () => {
        h.textContent = said(spec.title ?? ow(`pick_${kind}`));
        source.hidden = listSource !== 'box';
        source.textContent = listSource === 'box' ? fill(ow('pickFromBox'), { v: sourceVersion ?? '?' }) : '';
        searchLabel.textContent = ow('pickSearch');
        search.placeholder = ow(`pickHint_${kind}`) ?? ow('pickHint');
        back.textContent = ow('goBack');
        useCode.textContent = ow('useThisCode');
        const lab = codeField.querySelector('.sre-field-label');
        if (lab) lab.replaceChildren(document.createTextNode(ow('typeCodeInstead')));
        list.setAttribute('aria-label', said(spec.title ?? ow(`pick_${kind}`)));
        paintList();
      };
      const choose = (row) => { rememberPick(kind, row); finish({ ok: true, id: row.id, name: row.name, ...(row.code === undefined ? {} : { code: row.code }), item: row.item ?? null }); };
      const rowButton = (row, recent) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sre-picker-row';
        b.dataset.id = row.id;
        const name = document.createElement('span');
        name.className = 'sre-picker-name';
        name.textContent = row.name;
        b.append(name);
        if (row.code !== undefined || recent) {
          const small = document.createElement('small');
          small.className = 'sre-picker-code-word';
          small.textContent = [row.code, recent ? ow('recentPick') : ''].filter((x) => x).join(' · ');
          b.append(small);
        }
        b.addEventListener('click', () => choose(row));
        li.append(b);
        return li;
      };
      const paintList = () => {
        stateHost.replaceChildren();
        list.replaceChildren();
        codeWrap.hidden = true;
        const q = search.value.trim();
        if (listState !== 'ok') {
          if (listState === 'loading') { stateHost.append(officeState(document.createElement('div'), 'loading')); count.textContent = ''; return; }
          const kindWord = listState === 'denied' ? 'denied' : listState === 'offline' ? 'offline' : listState === 'unknown' ? 'unknown' : 'error';
          const detail = listState === 'unknown' ? ow('pickUnknownDetail') : spec.allowCode ? ow('pickCodeDetail') : undefined;
          stateHost.append(officeState(document.createElement('div'), kindWord, { title: listState === 'unknown' ? ow('notKnown') : undefined, ...(detail === undefined ? {} : { detail }) }));
          count.textContent = '';
          codeWrap.hidden = !spec.allowCode;
          return;
        }
        const pool = (spec.filter ? rows.filter((r) => { try { return spec.filter(r.item ?? r); } catch { return true; } }) : rows);
        let hits;
        let recent = false;
        if (q === '') {
          const remembered = recentPicks(kind).map((r) => pool.find((p) => p.id === r.id) ?? { ...r, item: null }).filter((r) => pool.some((p) => p.id === r.id) || pool.length === 0);
          if (remembered.length > 0) { hits = remembered; recent = true; } else hits = pool.slice(0, MAX);
        } else hits = pool.filter((r) => matches(r, q));
        shownRows = hits.slice(0, MAX);
        if (pool.length === 0) { stateHost.append(officeState(document.createElement('div'), 'empty', { detail: ow('pickEmptyDetail') })); count.textContent = ''; codeWrap.hidden = !spec.allowCode; return; }
        if (hits.length === 0) {
          stateHost.append(officeState(document.createElement('div'), 'noMatch', { detail: fill(ow('pickNoMatchDetail'), { n: pool.length }) }));
          count.textContent = '';
          codeWrap.hidden = !spec.allowCode;
          return;
        }
        for (const r of shownRows) list.append(rowButton(r, recent));
        count.textContent = recent ? ow('pickRecent') : hits.length > MAX ? fill(ow('pickMore'), { n: hits.length - MAX }) : fill(ow('pickCount'), { n: hits.length });
        // the box's copy may be short of a product published since: the typed code stays offered beside it (never a dead end)
        codeWrap.hidden = !(spec.allowCode && listSource === 'box');
      };
      const observer = new MutationObserver(paintWords);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      const finish = (answer) => {
        if (pickOpen !== me) return;
        pickOpen = null;
        observer.disconnect();
        window.removeEventListener('pagehide', onLeave);
        sheet.remove();
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        resolve(answer);
      };
      const onLeave = () => finish({ ok: false });
      let sourceVersion = null;
      const me = { finish };
      pickOpen = me;
      window.addEventListener('pagehide', onLeave);
      back.addEventListener('click', () => finish({ ok: false }));
      useCode.addEventListener('click', () => {
        const typed = String(codeField.querySelector('input').value ?? '').trim();
        const msg = codeField.querySelector('.sre-field-msg');
        if (typed === '') { msg.hidden = false; msg.textContent = fill(ow('fillIn'), { f: ow('typeCodeInstead') }); codeField.querySelector('input').focus(); return; }
        finish({ ok: true, id: typed, name: typed, code: typed, item: null, typed: true });
      });
      sheet.addEventListener('click', (e) => { if (e.target === sheet) finish({ ok: false }); });
      sheet.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish({ ok: false }); return; }
        if (e.key === 'Enter' && e.target === search) {
          e.preventDefault();
          // Enter in the search box: a barcode or a code typed in full picks it; one hit picks it; otherwise nothing.
          const q = search.value.trim();
          if (shownRows.length === 1 && q !== '') { choose(shownRows[0]); return; }
          const exact = (rows ?? []).find((r) => r.id === q || r.code === q);
          if (exact) { choose(exact); return; }
          if (kind === 'product' && /^\d{8,14}$/.test(q)) { void productByBarcode(q).then((row) => { if (row && pickOpen === me) choose(row); else if (pickOpen === me) { count.textContent = ow('pickNoBarcode'); } }); }
          return;
        }
        if (e.key === 'Enter' && e.target !== back && e.target !== useCode && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); return; }
        if (e.key === 'Tab') {
          const items = [...inner.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.closest('[hidden]') === null);
          if (items.length === 0) return;
          const first = items[0]; const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
      search.addEventListener('input', () => {
        paintList();
        const q = search.value.trim();
        if (kind === 'product' && listState === 'ok' && /^\d{8,14}$/.test(q) && shownRows.length === 0) {
          void productByBarcode(q).then((row) => { if (row && pickOpen === me && search.value.trim() === q) { shownRows = [row]; list.replaceChildren(rowButton(row, false)); stateHost.replaceChildren(); count.textContent = fill(ow('pickCount'), { n: 1 }); } });
        }
      });
      paintWords();
      document.body.append(sheet);
      search.focus();
      void listOf(kind, spec.scope ?? {}).then((got) => {
        if (pickOpen !== me) return;
        listState = got.state;
        rows = got.state === 'ok' ? got.rows : [];
        listSource = got.source ?? null;
        sourceVersion = got.version ?? null;
        paintWords();
      }).catch(() => { if (pickOpen !== me) return; listState = 'error'; rows = []; paintList(); });
    });
  }

  /** A form field that holds a picked thing: "name (code)" shown, the id kept, "Choose…" ≥ 44px, "(required)" in words. */
  function officePickField({ id, label, kind, required = false, scope, filter, allowCode, hint, value }) {
    const wrap = document.createElement('div');
    wrap.className = 'sre-field sre-pick';
    wrap.dataset.kind = kind;
    const lab = document.createElement('label');
    lab.htmlFor = `${id}-shown`;
    lab.className = 'sre-field-label';
    lab.append(document.createTextNode(said(label)));
    if (required) { const mark = document.createElement('span'); mark.className = 'sre-req'; mark.textContent = ` (${ow('required')})`; lab.append(mark); }
    const row = document.createElement('div');
    row.className = 'sre-pick-row';
    const shown = document.createElement('input');
    shown.type = 'text';
    shown.id = `${id}-shown`;
    shown.className = 'sre-input sre-pick-shown';
    shown.readOnly = true;
    shown.placeholder = ow('nothingChosen');
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = id;
    hidden.name = id;
    if (required) { hidden.required = true; hidden.setAttribute('aria-required', 'true'); }
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'sre-btn sre-pick-choose';
    choose.id = `${id}-choose`;
    choose.textContent = ow('choose');
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sre-btn sre-btn-quiet sre-pick-clear';
    clear.id = `${id}-clear`;
    clear.textContent = ow('clearPick');
    clear.hidden = true;
    row.append(shown, choose, clear);
    const describedBy = [];
    if (hint !== undefined) { const hnt = document.createElement('span'); hnt.className = 'sre-field-hint'; hnt.id = `${id}-hint`; hnt.textContent = said(hint); describedBy.push(hnt.id); wrap.append(lab, hnt); } else wrap.append(lab);
    const msg = document.createElement('span');
    msg.className = 'sre-field-msg';
    msg.id = `${id}-msg`;
    msg.hidden = true;
    describedBy.push(msg.id);
    shown.setAttribute('aria-describedby', describedBy.join(' '));
    wrap.append(row, hidden, msg);
    const set = (picked) => {
      if (picked === null) { hidden.value = ''; shown.value = ''; delete wrap.dataset.name; delete wrap.dataset.code; clear.hidden = true; return; }
      hidden.value = picked.id;
      wrap.dataset.name = picked.name;
      if (picked.code !== undefined) wrap.dataset.code = picked.code; else delete wrap.dataset.code;
      shown.value = picked.code !== undefined && picked.code !== picked.name ? `${picked.name} (${picked.code})` : picked.name;
      clear.hidden = false;
      msg.hidden = true;
      shown.removeAttribute('aria-invalid');
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    wrap.sreSet = set;
    wrap.sreWords = { label, required, hint };
    wrap.sreRepaint = () => { shown.placeholder = ow('nothingChosen'); choose.textContent = ow('choose'); clear.textContent = ow('clearPick'); };
    adapterRepaints.add(() => { if (!wrap.isConnected) throw new Error('gone'); repaintFieldWords(wrap); });
    const open = async () => {
      const picked = await officePick({ kind, title: { en: `${said(label)}?`, ta: `${said(label)}?` }, ...(scope === undefined ? {} : { scope }), ...(filter === undefined ? {} : { filter }), ...(allowCode === undefined ? {} : { allowCode }) });
      if (picked.ok) set(picked);
      choose.focus();
    };
    choose.addEventListener('click', () => { void open(); });
    shown.addEventListener('click', () => { void open(); });
    shown.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(); } });
    clear.addEventListener('click', () => { set(null); choose.focus(); });
    if (value) set(value);
    return wrap;
  }
  const pickedValue = (id) => { const el = byId(id); const v = el ? String(el.value ?? '').trim() : ''; return v === '' ? null : v; };
  const setPicked = (id, picked) => { const el = byId(id); const wrap = el ? el.closest('.sre-pick') : null; if (wrap && typeof wrap.sreSet === 'function') wrap.sreSet(picked); };

  // ── A date a shop person reads: dd/mm/yyyy (NFR-08), the shop's calendar; the page gets ISO ──────────────────────
  const TA_MONTHS = ['ஜன', 'பிப்', 'மார்', 'ஏப்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக', 'செப்', 'அக்', 'நவ', 'டிச'];
  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // the calendar's own arithmetic — no Date, no clock, no zone: a date typed by a person is a date, not an instant
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysIn = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  /** "31/10/2026" (also "31-10-2026", "31.10.2026", "31/10/26") → "2026-10-31", or null when it is not a real day. */
  function parseShopDate(text) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\s*$/.exec(String(text ?? ''));
    if (!m) return null;
    const d = Number(m[1]); const mo = Number(m[2]); const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || y < 1900 || y > 2200) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function dateWords(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
    if (!m) return ow('notKnown');
    const months = lang() === 'ta' ? TA_MONTHS : EN_MONTHS;
    return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
  }
  const shownDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  function officeDateField({ id, label, required = false, min, max, hint, value }) {
    const wrap = officeField({ id, label, type: 'text', required, hint: hint ?? ow('dateHint'), inputmode: 'numeric', autocomplete: 'off' });
    wrap.classList.add('sre-date');
    wrap.sreWords = { label, required, hint }; // the chrome's own hint is re-said in the reader's language; a page's hint is `{ en, ta }`
    const control = wrap.querySelector('input');
    control.placeholder = ow('datePlaceholder');
    control.setAttribute('pattern', '\\s*\\d{1,2}[/.\\-]\\d{1,2}[/.\\-](\\d{2}|\\d{4})\\s*');
    control.dataset.min = min ?? '';
    control.dataset.max = max ?? '';
    const check = () => {
      const msg = wrap.querySelector('.sre-field-msg');
      const text = control.value.trim();
      if (text === '') { delete control.dataset.iso; control.setCustomValidity(''); msg.hidden = true; return; }
      const iso = parseShopDate(text);
      let problem = '';
      if (iso === null) problem = ow('dateBad');
      else if (control.dataset.min && iso < control.dataset.min) problem = fill(ow('dateTooEarly'), { d: dateWords(control.dataset.min) });
      else if (control.dataset.max && iso > control.dataset.max) problem = fill(ow('dateTooLate'), { d: dateWords(control.dataset.max) });
      if (problem === '') { control.dataset.iso = iso; control.setCustomValidity(''); msg.hidden = true; control.removeAttribute('aria-invalid'); }
      else { delete control.dataset.iso; control.setCustomValidity(problem); msg.hidden = false; msg.textContent = problem; control.setAttribute('aria-invalid', 'true'); }
    };
    control.addEventListener('input', check);
    control.addEventListener('blur', check);
    if (value) { control.value = shownDate(value); check(); }
    wrap.sreSetDate = (iso) => { control.value = shownDate(iso); check(); };
    // on the toggle: the placeholder, and a problem already shown is said again in the new language
    wrap.sreWords = { label, required, hint };
    wrap.sreRepaint = () => { control.placeholder = ow('datePlaceholder'); if (control.value.trim() !== '') check(); };
    return wrap;
  }
  const dateValue = (id) => { const el = byId(id); if (!el) return null; const iso = el.dataset.iso; return iso ? iso : (el.value.trim() === '' ? null : parseShopDate(el.value)); };
  const setShopDate = (id, iso) => { const el = byId(id); const wrap = el ? el.closest('.sre-date') : null; if (wrap && typeof wrap.sreSetDate === 'function') wrap.sreSetDate(iso); else if (el) { el.value = iso ? shownDate(iso) : ''; el.dispatchEvent(new Event('input', { bubbles: true })); } };

  // ── U5: the page-side adapters of U2/U2b, in the chrome ───────────────────────────────────────────────────────────
  // Thirteen page scripts carried the same six lines to put the picker on an input the page built itself, and the same
  // lines again to swap a typed date box for the shared field. Here once, for every page, repainted on the toggle.
  const adapterRepaints = new Set();
  function repaintAdapters() { for (const f of [...adapterRepaints]) { try { f(); } catch { adapterRepaints.delete(f); } } }
  /**
   * Put the picker on a page's own input (an element or its id): "Choose…" beside it (≥ 44px), the picked id lands in the
   * input and the NAME is shown beside it (`#<id>-name`); what a person typed stays the fallback. `extra`: `scope()`,
   * `filter(item)`, `kindOf()`, `titleOf()`, `idOf(picked)`, `append(input, id)`, `onPick(picked)`, `allowCode` (true).
   */
  function officePickable(target, kind, title, extra = {}) {
    const input = typeof target === 'string' ? byId(target) : target;
    if (!input || input.dataset.pickable === 'on') return null;
    input.dataset.pickable = 'on';
    const row = document.createElement('div');
    row.className = 'sre-pick-row';
    input.replaceWith(row);
    row.append(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    if (input.id) btn.id = `${input.id}-pick`;
    btn.className = 'sre-btn sre-btn-quiet sre-pick-button';
    const name = document.createElement('span');
    if (input.id) name.id = `${input.id}-name`;
    name.className = 'sre-pick-name';
    row.append(btn, name);
    const titleOf = () => { const t = typeof extra.titleOf === 'function' ? extra.titleOf() : title; return t && typeof t === 'object' ? t : { en: ow(`pick_${kind}`), ta: ow(`pick_${kind}`) }; };
    const paint = () => { btn.textContent = ow('choose'); btn.setAttribute('aria-label', `${ow('choose')} — ${said(titleOf())}`); };
    paint();
    adapterRepaints.add(paint);
    btn.addEventListener('click', async () => {
      const k = typeof extra.kindOf === 'function' ? extra.kindOf() : kind;
      const picked = await officePick({ kind: k, title: titleOf(), allowCode: extra.allowCode !== false, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
      if (!picked || picked.ok !== true) return;
      const id = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
      if (typeof extra.append === 'function') extra.append(input, id); else input.value = id;
      name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof extra.onPick === 'function') extra.onPick(picked);
    });
    input.addEventListener('input', () => { name.textContent = ''; });
    return row;
  }
  /**
   * Swap a page's own date box for the shared dd/mm/yyyy field, keeping its id: a value already on it is carried over
   * (ISO as the page set it, or dd/mm/yyyy as a person typed it); the page reads ISO back with `dateOf(id)` and sets one
   * with `setShopDate(id, iso)`. `label` is `{ en, ta }` and follows the toggle. The page's own `<label for>` is hidden.
   */
  function officeShopDate(id, label, opts = {}) {
    const input = byId(id);
    if (!input || input.dataset.shopDate === 'on') return null;
    const typed = String(input.value ?? '').trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : parseShopDate(typed);
    const field = officeDateField({ id, label, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}), ...(opts.min ? { min: opts.min } : {}), ...(opts.max ? { max: opts.max } : {}) });
    const ownLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (ownLabel && !ownLabel.contains(input)) ownLabel.hidden = true;
    (input.closest('label') ?? input).replaceWith(field);
    field.querySelector('input').dataset.shopDate = 'on';
    const paint = () => { const lab = field.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = said(label); };
    adapterRepaints.add(paint);
    return field;
  }

  // ── A name for an id, and who is looking ─────────────────────────────────────────────────────────────────────
  const ZONE_WORDS = { 'Asia/Kolkata': { en: 'India time (Kolkata)', ta: 'இந்திய நேரம் (கொல்கத்தா)' }, 'Asia/Dubai': { en: 'Gulf time (Dubai)', ta: 'வளைகுடா நேரம் (துபாய்)' }, UTC: { en: 'UTC', ta: 'UTC' } };
  function nameOf(kind, id) {
    const key = String(id ?? '');
    if (key === '') return '';
    const d = directory();
    if (kind === 'person') {
      const hit = d?.people?.find((p) => p.id === key);
      if (hit) return hit.name;
      const session = window.sreOfficeSession;
      if (session && session.userId === key && session.displayName) return session.displayName;
      return key;
    }
    if (kind === 'store') return d?.store && d.store.id === key ? d.store.name : key;
    if (kind === 'place') { const hit = d?.places?.find((p) => p.id === key); return hit ? hit.name : (d?.store && d.store.id === key ? d.store.name : key); }
    if (kind === 'zone') return ZONE_WORDS[key] ? said(ZONE_WORDS[key]) : key;
    if (kind === 'role') { const r = navigation()?.roles?.find?.((x) => x.id === key); return r ? r.name : key; }
    const cached = listCache.get(kind)?.rows?.find((r) => r.id === key) ?? recentPicks(kind).find((r) => r.id === key);
    return cached ? cached.name : key;
  }
  function me() {
    const d = directory();
    const session = window.sreOfficeSession;
    const nav = navigation();
    const userId = d?.me?.userId ?? session?.userId ?? nav?.userId ?? null;
    const storeId = d?.store?.id ?? nav?.branch?.branchId ?? nav?.branchId ?? null;
    return {
      userId,
      name: userId === null ? null : nameOf('person', userId),
      storeId,
      storeName: storeId === null ? null : nameOf('store', storeId),
      roleIds: d?.me?.roleIds ?? [],
      permissions: d?.me?.permissions ?? [],
    };
  }
  /** The three-part refusal words, from the ONE source (`refusal-words.ts`, exposed by the bundle every page loads). */
  function officeRefusalWords(out) {
    const words = window.sreRefusalWords;
    if (words && typeof words.refusalWords === 'function') return words.refusalWords(lang(), out ?? {});
    const said = (out && typeof out.whatHappened === 'string' && out.whatHappened.trim() !== '' && !/^status \d{3}$/i.test(out.whatHappened)) ? out.whatHappened.trim() : ow('refusedPlain');
    return `${ow('refused')} ${said}${/[.!?।]$/.test(said) ? '' : '.'} ${ow('nothingChangedWord')} ${ow('tryAgainTell')}`;
  }
  /** A record's facts as a definition list, for the drawer: `[[label, value], …]`; a missing value is "Not known". */
  function officeFacts(pairs) {
    const dl = document.createElement('dl');
    dl.className = 'sre-facts';
    for (const [label, value] of pairs) {
      const row = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = said(label);
      const dd = document.createElement('dd');
      if (value instanceof Node) dd.append(value);
      else if (value === null || value === undefined || value === '') { dd.textContent = ow('notKnown'); dd.className = 'sre-unknown'; } else dd.textContent = String(value);
      row.append(dt, dd);
      dl.append(row);
    }
    return dl;
  }

  // ── The register (data table) ────────────────────────────────────────────────────────────────────────────────
  // opts: { id, label, columns: [{ key, label, value?(row), render?(row) → Node|string, sort?: 'text'|'number',
  //         filter?: true, hidden?: true, align?: 'end' }], rows: [] | null, pageSize = 10, rowKey?(row),
  //         bodyId?: the tbody's id, rowData?(row) → { name: value } written on each row's dataset,
  //         drawer?: { title(row), body(row) → Node }, empty?: { title, detail } }
  // `rows: null` is "not read yet" (loading); `[]` is "nothing yet". `setState('error' | 'offline' | 'denied', opts)`
  // replaces the rows with that state. The search matches every shown column's words; filters are drawn from the
  // values the rows actually have; the column choice is this browser's own memory for this register.
  const liveTables = new Set();
  function officeTable(host, opts) {
    const id = opts.id;
    const state = { rows: opts.rows === undefined ? null : opts.rows, query: '', filters: {}, sort: null, dir: 1, page: 0, kind: null, kindOpts: {} };
    const pageSize = opts.pageSize ?? 10;
    // U5: `sortable: true` makes every column sortable (a column may say `sort: false`); `search: false` hides the search box
    const sortableCol = (col) => (col.sort !== undefined && col.sort !== null && col.sort !== false) || (opts.sortable === true && col.sort !== false);
    const showSearch = opts.search !== false;
    const valueOf = (col, row) => (typeof col.value === 'function' ? col.value(row) : row[col.key]);
    const textOf = (col, row) => { const v = valueOf(col, row); return v === null || v === undefined ? '' : said(v); };
    const hiddenKey = `sre.table.${id}.hidden`;
    const hidden = new Set((() => { try { const v = JSON.parse(window.localStorage.getItem(hiddenKey) ?? 'null'); return Array.isArray(v) ? v : opts.columns.filter((c) => c.hidden).map((c) => c.key); } catch { return opts.columns.filter((c) => c.hidden).map((c) => c.key); } })());
    const shown = () => opts.columns.filter((c) => !hidden.has(c.key));

    const root = document.createElement('div');
    root.className = 'sre-datatable';
    root.id = `${id}-table`;
    host.replaceChildren(root);

    function visibleRows() {
      const rows = state.rows ?? [];
      const words = state.query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
      let out = rows.filter((row) => {
        for (const [key, want] of Object.entries(state.filters)) {
          if (want === '') continue;
          const col = opts.columns.find((c) => c.key === key);
          if (col && textOf(col, row) !== want) return false;
        }
        if (words.length === 0) return true;
        const hay = shown().map((c) => textOf(c, row)).join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (state.sort !== null) {
        const col = opts.columns.find((c) => c.key === state.sort);
        if (col) {
          const num = col.sort === 'number';
          out = [...out].sort((a, b) => {
            const x = valueOf(col, a); const y = valueOf(col, b);
            if (x === null || x === undefined) return 1;
            if (y === null || y === undefined) return -1;
            return (num ? Number(x) - Number(y) : said(x).localeCompare(said(y), lang() === 'ta' ? 'ta' : 'en', { numeric: true })) * state.dir;
          });
        }
      }
      return out;
    }

    function toolbar() {
      const bar = document.createElement('div');
      bar.className = 'sre-datatable-tools';
      if (showSearch) {
        const searchLabel = document.createElement('label');
        searchLabel.className = 'sre-datatable-search';
        const lens = icon('search', 18);
        if (lens) searchLabel.append(lens);
        const search = document.createElement('input');
        search.type = 'search';
        search.id = `${id}-search`;
        search.className = 'sre-input';
        search.value = state.query;
        search.placeholder = ow('search');
        search.setAttribute('aria-label', `${ow('search')} — ${said(opts.label)}`);
        search.addEventListener('input', () => { state.query = search.value; state.page = 0; paintBody(); });
        searchLabel.append(search);
        bar.append(searchLabel);
      }
      for (const col of opts.columns.filter((c) => c.filter)) {
        const values = [...new Set((state.rows ?? []).map((r) => textOf(col, r)).filter((v) => v !== ''))].sort((a, b) => a.localeCompare(b));
        const wrap = document.createElement('label');
        wrap.className = 'sre-datatable-filter';
        const span = document.createElement('span');
        span.textContent = said(col.label);
        const select = document.createElement('select');
        select.className = 'sre-select';
        select.id = `${id}-filter-${col.key}`;
        const all = document.createElement('option'); all.value = ''; all.textContent = ow('filterAll'); select.append(all);
        for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v; select.append(o); }
        select.value = values.includes(state.filters[col.key] ?? '') ? state.filters[col.key] : '';
        select.addEventListener('change', () => { state.filters[col.key] = select.value; state.page = 0; paintBody(); });
        wrap.append(span, select);
        bar.append(wrap);
      }
      // the column choice: a disclosure with one tick box per column (at least one stays shown)
      const choose = document.createElement('details');
      choose.className = 'sre-datatable-columns';
      const sum = document.createElement('summary');
      sum.className = 'sre-btn';
      const cols = icon('layout-grid', 18);
      if (cols) sum.append(cols);
      sum.append(document.createTextNode(ow('columns')));
      const box = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = ow('columnsShown'); box.append(legend);
      for (const col of opts.columns) {
        const l = document.createElement('label');
        l.className = 'sre-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = `${id}-col-${col.key}`;
        cb.checked = !hidden.has(col.key);
        cb.addEventListener('change', () => {
          if (!cb.checked && shown().length <= 1) { cb.checked = true; return; }
          if (cb.checked) hidden.delete(col.key); else hidden.add(col.key);
          try { window.localStorage.setItem(hiddenKey, JSON.stringify([...hidden])); } catch { /* a convenience only */ }
          paintBody();
        });
        l.append(cb, document.createTextNode(` ${said(col.label)}`));
        box.append(l);
      }
      choose.append(sum, box);
      bar.append(choose);
      return bar;
    }

    function paintBody() {
      let body = root.querySelector(':scope > .sre-datatable-body');
      if (!body) { body = document.createElement('div'); body.className = 'sre-datatable-body'; root.append(body); }
      if (state.kind !== null) { officeState(body, state.kind, state.kindOpts); return; }
      if (state.rows === null) { officeState(body, 'loading'); return; }
      if (state.rows.length === 0) { officeState(body, 'empty', opts.empty ?? {}); return; }
      const rows = visibleRows();
      if (rows.length === 0) {
        officeState(body, 'noMatch', { values: { n: state.rows.length }, action: () => { state.query = ''; state.filters = {}; state.page = 0; paint(); }, actionLabel: ow('clear') });
        return;
      }
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      state.page = Math.min(state.page, pages - 1);
      const from = state.page * pageSize;
      const slice = rows.slice(from, from + pageSize);
      const scroll = document.createElement('div');
      scroll.className = 'sre-scroll-x';
      const table = document.createElement('table');
      table.className = 'sre-register';
      table.id = `${id}-grid`;
      const caption = document.createElement('caption');
      caption.className = 'sr-only';
      caption.textContent = said(opts.label);
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const col of shown()) {
        const th = document.createElement('th');
        th.scope = 'col';
        if (col.align === 'end') th.className = 'sre-end';
        if (sortableCol(col)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sre-sort';
          b.dataset.col = col.key;
          b.textContent = said(col.label);
          b.title = fill(ow('sortBy'), { c: said(col.label) });
          const sorted = state.sort === col.key;
          th.setAttribute('aria-sort', sorted ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
          // U5: which way the list is sorted, said in words beside the heading — the arrow alone is not a message
          const dir = document.createElement('span');
          dir.className = 'sre-sort-dir';
          dir.textContent = sorted ? ow(col.sort === 'number' ? (state.dir === 1 ? 'sortedAsc' : 'sortedDesc') : (state.dir === 1 ? 'sortedAscText' : 'sortedDescText')) : '';
          dir.hidden = !sorted;
          b.append(dir);
          b.addEventListener('click', () => {
            if (state.sort === col.key) state.dir = -state.dir; else { state.sort = col.key; state.dir = 1; }
            state.page = 0; paintBody();
            root.querySelector(`.sre-sort[data-col="${col.key}"]`)?.focus();
          });
          th.append(b);
        } else th.textContent = said(col.label);
        hr.append(th);
      }
      if (opts.drawer) { const th = document.createElement('th'); th.scope = 'col'; th.className = 'sre-end'; const s = document.createElement('span'); s.className = 'sr-only'; s.textContent = ow('open'); th.append(s); hr.append(th); }
      thead.append(hr);
      const tbody = document.createElement('tbody');
      if (opts.bodyId) tbody.id = opts.bodyId;
      for (const row of slice) {
        const tr = document.createElement('tr');
        if (opts.rowKey) tr.dataset.key = String(opts.rowKey(row));
        if (typeof opts.rowData === 'function') for (const [k, v] of Object.entries(opts.rowData(row))) tr.dataset[k] = String(v);
        for (const col of shown()) {
          const td = document.createElement('td');
          if (col.align === 'end') td.className = 'sre-end';
          td.dataset.label = said(col.label); // U5: on a phone the rows stack and each cell says its column
          const v = typeof col.render === 'function' ? col.render(row) : valueOf(col, row);
          if (v instanceof Node) td.append(v);
          else if (v === null || v === undefined || v === '') { td.textContent = ow('notKnown'); td.classList.add('sre-unknown'); } else td.textContent = said(v);
          tr.append(td);
        }
        if (opts.drawer) {
          const td = document.createElement('td');
          td.className = 'sre-end';
          td.dataset.label = ow('open');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sre-btn sre-row-open';
          b.textContent = ow('open');
          b.setAttribute('aria-label', `${ow('open')} ${textOf(shown()[0], row)}`);
          b.addEventListener('click', () => officeDrawer({ title: opts.drawer.title(row), body: opts.drawer.body(row) }));
          td.append(b);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(caption, thead, tbody);
      scroll.append(table);
      const foot = document.createElement('div');
      foot.className = 'sre-datatable-foot';
      const count = document.createElement('p');
      count.className = 'sre-datatable-count';
      count.id = `${id}-count`;
      count.setAttribute('role', 'status');
      count.textContent = fill(ow('showing'), { from: from + 1, to: from + slice.length, n: rows.length });
      count.hidden = opts.count === false;
      const nav = document.createElement('div');
      nav.className = 'sre-pager';
      const prev = document.createElement('button');
      prev.type = 'button'; prev.className = 'sre-btn'; prev.id = `${id}-prev`; prev.textContent = ow('previous'); prev.disabled = state.page === 0;
      prev.addEventListener('click', () => { state.page -= 1; paintBody(); byId(`${id}-prev`)?.focus(); });
      const where = document.createElement('span'); where.className = 'sre-pager-where'; where.textContent = fill(ow('page'), { p: state.page + 1, q: pages });
      const next = document.createElement('button');
      next.type = 'button'; next.className = 'sre-btn'; next.id = `${id}-next`; next.textContent = ow('next'); next.disabled = state.page >= pages - 1;
      next.addEventListener('click', () => { state.page += 1; paintBody(); byId(`${id}-next`)?.focus(); });
      nav.append(prev, where, next);
      foot.append(count, nav);
      body.replaceChildren(scroll, foot);
    }

    function paint() {
      const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
      root.replaceChildren(toolbar());
      paintBody();
      if (focused) byId(focused)?.focus();
    }
    const controller = {
      setRows(rows) { state.rows = rows; state.kind = null; paint(); },
      setState(kind, kindOpts = {}) { state.kind = kind; state.kindOpts = kindOpts; paint(); },
      rows: () => state.rows,
      shownRows: () => visibleRows(),
      repaint: paint,
      connected: () => root.isConnected,
    };
    liveTables.add(controller);
    paint();
    return controller;
  }

  /** The state for an answer that is not ok: no link → offline; refused for the role → denied; anything else → error. */
  function officeStateOf(out) {
    if (!out || out.result === 'lost_link') return 'offline';
    if (out.result === 'refused' && (out.status === 401 || out.status === 403)) return 'denied';
    return 'error';
  }

  window.sreOffice = Object.freeze({
    table: officeTable, state: officeState, cards: officeCards, chip: officeChip, field: officeField, check: officeCheck,
    drawer: officeDrawer, closeDrawer, facts: officeFacts, stateOf: officeStateOf, words: (key) => ow(key),
    // U2: pick a thing by its name, a date a shop person reads, a name for an id, who is looking, the three-part refusal
    pick: officePick, pickField: officePickField, pickedValue, setPicked, dateField: officeDateField, dateValue, dateWords, nameOf, me, refusalWords: officeRefusalWords, parseShopDate,
    confirm: officeConfirm,
    // U5: the adapters every page used to carry, the record chip, and a date box's ISO by its id
    pickable: officePickable, shopDate: officeShopDate, setShopDate, dateOf: dateValue, recordChip: officeRecordChip,
  });

  // a register that is still on the page is redrawn in the new language; one its page has since replaced is let go
  function repaintTables() { for (const table of [...liveTables]) { if (table.connected()) table.repaint(); else liveTables.delete(table); } }

  function repaint() { paintToggle(); paintHeading(); paintWhoAmI(); paintStale(); paintStoreCopy(); paintBadge(); paintStoreComputer(); paintMenu(); paintTopline(); paintUpdate(); repaintAdapters(); paintAnatomy(); }

  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  new MutationObserver(repaintTables).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  repaint();
  // the page paints its rows, switches its sections and rewrites its labels in its own time — follow it
  const mainEl = document.querySelector('main');
  if (mainEl) new MutationObserver(scheduleAnatomy).observe(mainEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const tabsEl = byId('tabs');
  if (tabsEl) new MutationObserver(scheduleAnatomy).observe(tabsEl, { childList: true, subtree: true });
  openAskedTab();
  void refreshBadge();
  setInterval(() => { void refreshBadge(); }, 10_000);

  window.sreChrome = { repaint, icon, icons: { group: GROUP_ICONS, item: ITEM_ICONS, figure: FIGURE_ICONS, chrome: CHROME_ICONS }, badge: { refresh: refreshBadge, state: () => box }, menu: { toggle: toggleMenu, open: () => !byId('sre-menu')?.hidden } };
  // A page that paints before the chrome loaded (its own script runs first) may now take the icons: it listens for this.
  document.dispatchEvent(new Event('sre:chrome'));
})();
