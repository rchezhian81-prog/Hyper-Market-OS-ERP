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
      cloudNotSetUp: 'No head office link on this store computer', cloudUnknown: 'Head office not checked yet',
      lastContact: 'last contact', switchLanguage: 'Switch language', otherLanguage: 'தமிழ்',
      screens: 'Screens', screensFor: 'Screens for', workspace: 'Store workspace', closeScreens: 'Close the screens list',
      noUser: 'Nobody is named on this screen, so no other screens can be offered.',
      noRoles: 'This store computer has no role register, so no screens can be offered.',
    },
    ta: {
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
      notConnected: 'கடை கணினியுடன் இணைப்பு இல்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
      connected: 'இணைப்பில்', boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை',
      noCloud: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — கடை கணினியிலிருந்து வேலை',
      cloudNotSetUp: 'இந்தக் கடை கணினியில் தலைமை அலுவலக இணைப்பு இல்லை', cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை',
      lastContact: 'கடைசித் தொடர்பு', switchLanguage: 'மொழியை மாற்று', otherLanguage: 'English',
      screens: 'திரைகள்', screensFor: 'இவருக்கான திரைகள்', workspace: 'கடை பணியிடம்', closeScreens: 'திரைகள் பட்டியலை மூடு',
      noUser: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை, எனவே வேறு திரைகள் வழங்க முடியாது.',
      noRoles: 'இந்தக் கடை கணினியில் பங்கு பதிவேடு இல்லை, எனவே திரைகள் வழங்க முடியாது.',
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
    // The toggle belongs beside the badge, as it does on the till and the handhelds.
    const toggle = byId('lang');
    if (toggle && toggle.parentElement !== sync) sync.append(toggle);
    return { dot, text };
  }

  // ── The sync badge — connection · freshness, from the store computer (rule 4) ──────────────────────
  let box = { asked: false, reachable: false, status: null };
  const laneBase = () => (typeof window.laneWriteBase === 'string' ? window.laneWriteBase : null);
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function paintBadge() {
    const els = badgeElements();
    if (!els) return;
    const { dot, text } = els;
    dot.classList.remove('unknown', 'degraded', 'error', 'idle');
    // A page that could not read its own registers says so first — the link to the store is one fact.
    if (window.sreBlind === true) { dot.classList.add('unknown'); text.textContent = t('notConnected'); return; }
    if (laneBase() === null) { dot.classList.add('idle'); text.textContent = t('notConnected'); return; }
    if (!box.asked) { dot.classList.add('idle'); text.textContent = t('checkingBox'); return; }
    if (!box.reachable) { dot.classList.add('error'); text.textContent = t('boxNotAnswering'); return; }
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    if (s.cloud === 'online') { text.textContent = `${t('connected')}${when}`; return; }
    dot.classList.add(s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded');
    text.textContent = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
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
    strip.textContent = `${own ?? t('staleShell')} ${new Date(at).toLocaleString()}`;
  }

  // ── The toggle says what you get ─────────────────────────────────────────────────────────────────
  function paintToggle() {
    const toggle = byId('lang');
    if (!toggle) return;
    toggle.textContent = t('otherLanguage');
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
    }
    return { button, panel };
  }

  // On a desk the rail is simply there: open, no button, nothing to dismiss. On a phone the button and the drawer
  // state decide, and a scrim behind the open drawer closes it on a tap, like Escape does.
  function layout() {
    const els = menuElements();
    if (!els) return;
    const { button, panel } = els;
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

  function brand() {
    const block = document.createElement('div');
    block.className = 'brand';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = 'SRE';
    const words = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = 'Hyper Market';
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
    button.textContent = `☰ ${t('screens')}`;
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
    const who = document.createElement('p');
    who.className = 'who-can';
    who.textContent = `${t('screensFor')} `;
    const name = document.createElement('b');
    name.textContent = String(nav.userId ?? '');
    who.append(name);
    panel.append(who);
    for (const group of groups) {
      const section = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'group';
      title.textContent = word(group.group);
      const list = document.createElement('ul');
      for (const item of group.items ?? []) {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = item.path;
        link.textContent = word(item.label);
        if (isCurrent(item)) link.setAttribute('aria-current', 'page');
        li.append(link);
        list.append(li);
      }
      section.append(title, list);
      panel.append(section);
    }
    layout();
  }

  // ── A menu link may name a tab: /manager/?tab=approvals opens the manager on Approvals ─────────────
  // Only on a page that has that tab, and only if the page has not already opened it itself.
  function openAskedTab() {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (!wanted) return;
    const tab = byId(`tab-${wanted}`);
    if (tab && tab.getAttribute('aria-current') !== 'page') tab.click();
  }

  function repaint() { paintToggle(); paintStale(); paintBadge(); paintMenu(); }

  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  repaint();
  openAskedTab();
  void refreshBadge();
  setInterval(() => { void refreshBadge(); }, 10_000);

  window.sreChrome = { repaint, badge: { refresh: refreshBadge, state: () => box }, menu: { toggle: toggleMenu, open: () => !byId('sre-menu')?.hidden } };
})();
