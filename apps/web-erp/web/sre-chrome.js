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
      cloudNotSetUp: 'No head office link on this store computer', cloudUnknown: 'Head office not checked yet',
      lastContact: 'last contact', switchLanguage: 'Switch language', otherLanguage: 'தமிழ்',
      screens: 'Screens', screensFor: 'Screens for', workspace: 'Store workspace', closeScreens: 'Close the screens list',
      newVersion: 'A newer version of this screen has arrived. Reload when you are ready.', reload: 'Reload',
      noUser: 'Nobody is named on this screen, so no other screens can be offered.',
      noRoles: 'This store computer has no role register, so no screens can be offered.',
      inList: '{n} in the list',
      workspaceWord: 'Workspace', branchWorkspace: 'Branch workspace', findScreen: 'Find a screen', noScreenMatches: 'No screen matches',
    },
    ta: {
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
      notConnected: 'கடை கணினியுடன் இணைப்பு இல்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
      connected: 'இணைப்பில்', boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை',
      noCloud: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — கடை கணினியிலிருந்து வேலை',
      cloudNotSetUp: 'இந்தக் கடை கணினியில் தலைமை அலுவலக இணைப்பு இல்லை', cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை',
      lastContact: 'கடைசித் தொடர்பு', switchLanguage: 'மொழியை மாற்று', otherLanguage: 'English',
      screens: 'திரைகள்', screensFor: 'இவருக்கான திரைகள்', workspace: 'கடை பணியிடம்', closeScreens: 'திரைகள் பட்டியலை மூடு',
      newVersion: 'இந்தத் திரையின் புதிய பதிப்பு வந்துள்ளது. தயாரானதும் மீண்டும் ஏற்றவும்.', reload: 'மீண்டும் ஏற்று',
      noUser: 'இந்தத் திரையில் யாரும் பெயரிடப்படவில்லை, எனவே வேறு திரைகள் வழங்க முடியாது.',
      noRoles: 'இந்தக் கடை கணினியில் பங்கு பதிவேடு இல்லை, எனவே திரைகள் வழங்க முடியாது.',
      inList: 'பட்டியலில் {n}',
      workspaceWord: 'பணியிடம்', branchWorkspace: 'கிளைப் பணியிடம்', findScreen: 'ஒரு திரையைத் தேடு', noScreenMatches: 'பொருந்தும் திரை இல்லை',
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
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
    setText(words, `${own ?? t('staleShell')} ${new Date(at).toLocaleString()}`);
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
    for (const group of groups) {
      const section = document.createElement('div');
      section.className = 'group-section';
      const title = document.createElement('p');
      title.className = 'group';
      // OB-201: on the rail each SCREEN carries its shape, so the workspace heading is words alone — one icon per row,
      // never two stacked. The workspace's own shape (GROUP_ICONS) is still the Today page's workspace tiles'.
      title.append(document.createTextNode(word(group.group)));
      const list = document.createElement('ul');
      for (const item of group.items ?? []) {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = item.path;
        // the screen's shape from the one set, then its name (OB-201); the name alone is the link's text
        const shape = itemIcon(item);
        if (shape) link.append(shape);
        link.append(document.createTextNode(word(item.label)));
        if (isCurrent(item)) link.setAttribute('aria-current', 'page');
        li.append(link);
        list.append(li);
      }
      section.append(title, list);
      scroller.append(section);
    }
    panel.append(personCard(nav));
    filterMenu(byId('sre-find')?.value ?? '');
    layout();
    const current = scroller.querySelector('a[aria-current="page"]');
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }


  // ── Icons (UX-2b · OB-201 "Icons A"): the ONE set, packages/ui/web/sre-icons.js (`window.sreIcon`), loaded before
  // every page's own script — thin line, 1.5px, 24 grid, inline SVG, no network (P-01). The chrome only says WHICH
  // shape fits what: a workspace (by its English name), a screen on the rail (by the catalogue's item id), and the
  // few figure names the Today page asks for. Every one is drawn beside its word, never instead of it; a name the set
  // does not know draws nothing and the word stands alone. tests/guardrails/every-icon-comes-from-the-one-set.test.ts
  // proves every name here is in the set and every item in apps/web-erp/src/navigation.ts has one.
  const GROUP_ICONS = Object.freeze({
    'Today': 'layout-dashboard',
    'Products & pricing': 'tag',
    'Purchase': 'shopping-cart',
    'Receiving & QC': 'package-check',
    'Inventory & backstore': 'warehouse',
    'Shop floor': 'store',
    'Sales & service': 'receipt',
    'Orders & delivery': 'truck',
    'Cash & finance': 'wallet',
    'Customers & loyalty': 'users',
    'Fresh food & café': 'chef-hat',
    'People & tasks': 'clipboard-list',
    'Store operations': 'sliders',
    'Reports': 'chart-column',
    'Administration': 'shield-check',
    'Devices': 'monitor-smartphone',
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
    'production': 'chef-hat',
    'warehouse-supervisor': 'warehouse',
    'finance': 'landmark',
    'day-book': 'book-open',
    'finance-close': 'calendar-days',
    'reconciliation': 'git-compare-arrows',
    'gst-reconciliation': 'git-merge',
    'gst-returns': 'receipt-text',
    'itc-review': 'file-text',
    'epr': 'trash', // R4 Lane 1 (B20–B22): the EPR registers page — this one line only
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
    // ── end R4 Lane 3 ──
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
    let any = false;
    for (const section of panel.querySelectorAll('.group-section')) {
      // a workspace's name counts too: "cash" finds every screen under Cash & finance
      const groupHit = q !== '' && (section.querySelector('.group')?.textContent ?? '').toLowerCase().includes(q);
      let hit = false;
      for (const li of section.querySelectorAll('li')) {
        const match = q === '' || groupHit || li.textContent.toLowerCase().includes(q);
        li.hidden = !match;
        hit = hit || match;
      }
      section.hidden = !hit;
      any = any || hit;
    }
    let none = byId('sre-find-none');
    if (q !== '' && !any) {
      if (!none) { none = document.createElement('p'); none.id = 'sre-find-none'; none.className = 'who-can'; (panel.querySelector('.groups') ?? panel).append(none); }
      setText(none, t('noScreenMatches'));
    } else if (none) none.remove();
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
        if (e.key === 'Enter') { const first = byId('sre-menu')?.querySelector('li:not([hidden]) a'); if (first) { e.preventDefault(); first.click(); } }
        if (e.key === 'Escape') { find.value = ''; filterMenu(''); }
      });
      // the magnifier sits inside the field (OB-201); the field keeps its own name and its own hidden state
      const findWrap = document.createElement('span');
      findWrap.id = 'sre-find-wrap';
      findWrap.className = 'sre-find-wrap';
      const lens = icon(CHROME_ICONS.find, 18);
      if (lens) findWrap.append(lens);
      findWrap.append(find);
      line.append(crumbs, findWrap);
      header.prepend(line);
    }
    const place = nav ? currentPlace(nav) : null;
    const parts = [t('workspaceWord')];
    if (place) {
      parts.push(word(place.group.group));
      const leaf = word(place.item.label);
      if (leaf !== parts[parts.length - 1]) parts.push(leaf);
    }
    setText(byId('sre-crumbs'), parts.join(' › '));
    const find = byId('sre-find');
    find.setAttribute('aria-label', t('findScreen'));
    find.placeholder = t('findScreen');
    find.hidden = !nav || (nav.groups ?? []).length === 0;
    byId('sre-find-wrap').hidden = find.hidden;
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

  function repaint() { paintToggle(); paintStale(); paintBadge(); paintMenu(); paintTopline(); paintUpdate(); paintAnatomy(); }

  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
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
