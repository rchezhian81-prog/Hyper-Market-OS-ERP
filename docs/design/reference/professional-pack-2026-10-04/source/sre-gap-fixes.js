/* ──────────────────────────────────────────────────────────────────────────────────────────────────────────
   SRE gap fixes — runs AFTER app.js, which it leaves untouched. Two fixtures every SRE screen carries that the
   owner's reference left out:
     1. The reader's language (design system §1 rule 6, NFR-08): an English / தமிழ் toggle in the header. In
        this preview it flips the chrome — menu, groups, roles, strip, the home page's headings and figures'
        labels — and says plainly that page titles stay English here. In the product every word has both
        languages already (apps/web-erp/src/navigation.ts labelTa, sre-chrome.js); new screens must too.
     2. Freshness on every figure and the honest "not known" (design system §1 rule 4, §2, P-08): each
        figure says where it came from and when; when the preview's own connection control is set to
        offline, every figure is marked "last known at", and a figure that needs the cloud says "Not known"
        with the reason instead of a reassuring number.
   Nothing here adds a module, page, field, rule or workflow.
   ────────────────────────────────────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const TA = {
    // groups and modules (the 15 workspaces) — the repo's words where it has them (navigation.ts / NAV_GROUP_LABELS)
    'Workspace': 'பணியிடம்', 'Store operations': 'கடை செயல்பாடுகள்', 'Business management': 'வணிக மேலாண்மை', 'Insights & controls': 'அறிக்கைகளும் கட்டுப்பாடுகளும்',
    'Today': 'இன்று', 'Products & pricing': 'பொருட்களும் விலையும்', 'Purchase': 'கொள்முதல்', 'Receiving & QC': 'சரக்கு வரவும் தரச் சோதனையும்',
    'Inventory & backstore': 'சரக்கும் பின்கடையும்', 'Shop floor': 'கடைத் தளம்', 'Sales & service': 'விற்பனையும் சேவையும்', 'Orders & delivery': 'ஆர்டர்களும் டெலிவரியும்',
    'Cash & finance': 'பணமும் நிதியும்', 'Customers & loyalty': 'வாடிக்கையாளர்களும் விசுவாசமும்', 'Fresh food & café': 'புதிய உணவும் கஃபேயும்', 'People & tasks': 'பணியாளர்களும் பணிகளும்',
    'Reports': 'அறிக்கைகள்', 'Administration': 'நிர்வாகம்',
    // roles
    'Store manager': 'கடை மேலாளர்', 'Owner': 'உரிமையாளர்', 'Buyer': 'வாங்குபவர்', 'Warehouse team': 'கிடங்கு குழு', 'Floor team': 'தளக் குழு', 'Cashier': 'காசாளர்', 'Accounts team': 'கணக்குக் குழு',
    // chrome
    'HYPER MARKET': 'ஹைப்பர் மார்க்கெட்', 'Store workspace': 'கடை பணியிடம்', 'SRE · Main store': 'SRE · பிரதான கடை', 'Store & head office': 'கடையும் தலைமை அலுவலகமும்',
    'Search pages, products…': 'பக்கங்கள், பொருட்களைத் தேடு…', 'All pages': 'எல்லாப் பக்கங்களும்', 'Help & SOPs': 'உதவியும் நடைமுறைகளும்', 'Design preview': 'வடிவமைப்பு முன்னோட்டம்',
    'DESIGN PREVIEW': 'வடிவமைப்பு முன்னோட்டம்', 'Sample data': 'மாதிரித் தரவு', 'Skip to workspace': 'பணியிடத்திற்குச் செல்',
    'Online · 0 unsent': 'இணைப்பில் · அனுப்பாதவை 0', 'Offline · 3 unsent': 'இணைப்பு இல்லை · அனுப்பாதவை 3', 'Conflict · 1 needs review': 'முரண்பாடு · 1 ஆய்வு தேவை',
    'Last synced just now': 'இப்போதுதான் ஒத்திசைந்தது', 'Last synced 10:32 am': 'கடைசி ஒத்திசைவு காலை 10:32',
    'SRE Hyper Market': 'SRE ஹைப்பர் மார்க்கெட்', 'Store operations workspace': 'கடை செயல்பாட்டுப் பணியிடம்', 'Explore the page map': 'பக்க வரைபடத்தைப் பார்',
    // the home page
    'Store overview': 'கடைக் கண்ணோட்டம்', 'Operational snapshot · today': 'இன்றைய செயல்பாட்டு நிலை', 'Review approvals': 'ஒப்புதல்களை ஆய்வு செய்',
    'SUNDAY, 4 OCTOBER 2026': 'ஞாயிறு, 4 அக்டோபர் 2026', 'Today · 4 Oct 2026': 'இன்று · 4 அக் 2026',
    'Net sales today': 'இன்றைய நிகர விற்பனை', 'Purchase commitments': 'கொள்முதல் உறுதிகள்', 'Floor requests': 'தளக் கோரிக்கைகள்', 'Stock availability': 'சரக்கு இருப்பு',
    'vs previous period': 'முந்தைய காலத்துடன்', '6 open purchase orders': '6 திறந்த கொள்முதல் ஆணைகள்', '4 awaiting your approval': '4 உங்கள் ஒப்புதலுக்காக', '24 products need attention': '24 பொருட்களுக்குக் கவனம் தேவை',
    'From purchase to the shelf': 'கொள்முதலில் இருந்து அடுக்கு வரை', 'Follow the stock. Every handover stays visible.': 'சரக்கைப் பின்தொடரவும். ஒவ்வொரு ஒப்படைப்பும் தெரியும்.',
    'View movement': 'நகர்வைப் பார்', 'Receive': 'பெறு', 'Backstore': 'பின்கடை', 'Indent': 'கோரிக்கை', 'Floor': 'தளம்', 'Sell': 'விற்பனை',
    'Your workspaces': 'உங்கள் பணியிடங்கள்', 'All modules': 'எல்லா தொகுதிகளும்', 'Needs your attention': 'உங்கள் கவனம் தேவை', '4 actions': '4 செயல்கள்',
    'Ordered by what needs action': 'செயல் தேவைப்படுவதன் வரிசையில்', 'View all': 'எல்லாம் பார்', 'CASH & DAY CLOSE': 'பணமும் நாள் முடிவும்', 'Cash reconciliation': 'பணச் சரிக்கட்டல்',
    'Open cash office': 'பண அலுவலகத்தைத் திற', 'Today’s purchase activity': 'இன்றைய கொள்முதல் நடவடிக்கை', 'View purchase orders': 'கொள்முதல் ஆணைகளைப் பார்', 'Connection details': 'இணைப்பு விவரங்கள்',
    'Changes carry a named owner, an approval trail and a clear sync status.': 'ஒவ்வொரு மாற்றத்திற்கும் பெயரிடப்பட்ட பொறுப்பாளர், ஒப்புதல் தடம், தெளிவான ஒத்திசைவு நிலை உண்டு.',
    'Separate approval, issue and receipt. Stock arrives on the floor only after receipt.': 'ஒப்புதல், வழங்கல், பெறுதல் தனித்தனி. பெற்ற பிறகே சரக்கு தளத்திற்கு வரும்.',
  };
  const FRESH = {
    en: { live: 'From the store computer · 2 min ago', stale: 'Last known 10:32 am · not refreshed', conflict: 'From the store computer · 1 record needs review', unknown: 'Not known', why: 'Needs the cloud count. Offline since 10:32 am — this is not a zero.', note: 'Page titles stay English in this preview; the product shows every word in your language.' },
    ta: { live: 'கடை கணினியிலிருந்து · 2 நிமிடம் முன்', stale: 'கடைசியாகத் தெரிந்தது காலை 10:32 · புதுப்பிக்கப்படவில்லை', conflict: 'கடை கணினியிலிருந்து · 1 பதிவுக்கு ஆய்வு தேவை', unknown: 'தெரியவில்லை', why: 'கிளவுட் எண்ணிக்கை தேவை. காலை 10:32 முதல் இணைப்பு இல்லை — இது பூஜ்ஜியம் அல்ல.', note: 'இந்த முன்னோட்டத்தில் பக்கத் தலைப்புகள் ஆங்கிலத்தில். தயாரிப்பில் ஒவ்வொரு சொல்லும் உங்கள் மொழியில்.' },
  };
  state.lang = 'en';

  // ── 1. the reader's language ──────────────────────────────────────────────────────────────────────────────
  const walk = (root, fn) => { const it = document.createNodeIterator(root, NodeFilter.SHOW_TEXT); let n; while ((n = it.nextNode())) fn(n); };
  function translate(root) {
    walk(root, (n) => {
      const raw = n.nodeValue, key = raw.trim();
      if (!key) return;
      if (state.lang === 'ta') {
        const ta = TA[key];
        if (ta) { if (n.sreEn === undefined) n.sreEn = raw; n.nodeValue = raw.replace(key, ta); }
      } else if (n.sreEn !== undefined) { n.nodeValue = n.sreEn; n.sreEn = undefined; }
    });
    root.querySelectorAll('[placeholder]').forEach((el) => {
      const key = el.getAttribute('placeholder');
      if (state.lang === 'ta' && TA[key]) { el.dataset.sreEn = key; el.setAttribute('placeholder', TA[key]); }
      else if (state.lang === 'en' && el.dataset.sreEn) { el.setAttribute('placeholder', el.dataset.sreEn); delete el.dataset.sreEn; }
    });
  }
  function langToggle() {
    let b = document.querySelector('.lang-toggle');
    if (!b) {
      b = document.createElement('button'); b.className = 'lang-toggle'; b.type = 'button'; b.setAttribute('data-sre-lang', '');
      const tools = document.querySelector('.top-tools'), role = tools && tools.querySelector('.role-select');
      if (tools) tools.insertBefore(b, role || null);
    }
    b.textContent = state.lang === 'ta' ? 'English' : 'தமிழ்';
    b.setAttribute('aria-pressed', state.lang === 'ta' ? 'true' : 'false');
    b.setAttribute('aria-label', state.lang === 'ta' ? 'Switch to English' : 'தமிழுக்கு மாற்று (switch to Tamil)');
    b.lang = state.lang === 'ta' ? 'en' : 'ta';
  }
  function langNote() {
    const strip = document.querySelector('.context-strip > span'); if (!strip) return;
    let n = strip.querySelector('.lang-note');
    if (state.lang === 'ta') { if (!n) { n = document.createElement('span'); n.className = 'lang-note'; strip.appendChild(n); } n.textContent = FRESH.ta.note; }
    else if (n) n.remove();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sre-lang]'); if (!b) return;
    e.stopPropagation();
    state.lang = state.lang === 'ta' ? 'en' : 'ta';
    decorate();
    toast(state.lang === 'ta' ? 'இப்போது தமிழில். பக்கத் தலைப்புகள் இந்த முன்னோட்டத்தில் ஆங்கிலத்தில்.' : 'Now in English.');
  }, true);

  // ── 2. freshness on every figure, and the honest unknown ──────────────────────────────────────────────────
  function freshness() {
    const t = FRESH[state.lang], mode = state.connection;
    document.querySelectorAll('#main .kpi').forEach((kpi, i) => {
      let f = kpi.querySelector('.kpi-fresh');
      if (!f) { f = document.createElement('div'); f.className = 'kpi-fresh'; kpi.appendChild(f); }
      f.classList.toggle('stale', mode !== 'online');
      f.textContent = mode === 'online' ? t.live : mode === 'offline' ? t.stale : t.conflict;
      // The last figure on the home page (stock availability) needs the cloud's count: offline, it is NOT KNOWN.
      const needsCloud = i === 3 && state.module === 'overview' && state.page === 'dashboard';
      const v = kpi.querySelector('.kpi-value'), sub = kpi.querySelector('.kpi-bottom > span');
      if (needsCloud && mode === 'offline') {
        if (v && v.dataset.sreValue === undefined) { v.dataset.sreValue = v.textContent; v.textContent = t.unknown; }
        if (sub && sub.dataset.sreSub === undefined) { sub.dataset.sreSub = sub.innerHTML; sub.textContent = t.why; }
        kpi.classList.add('is-unknown');
      } else if (kpi.classList.contains('is-unknown')) {
        if (v && v.dataset.sreValue !== undefined) { v.textContent = v.dataset.sreValue; delete v.dataset.sreValue; }
        if (sub && sub.dataset.sreSub !== undefined) { sub.innerHTML = sub.dataset.sreSub; delete sub.dataset.sreSub; }
        kpi.classList.remove('is-unknown');
      }
    });
  }

  function decorate() {
    document.documentElement.lang = state.lang;
    langToggle();
    translate(document.body);
    langNote();
    freshness();
  }
  // app.js ends every render() and every connection change with syncHeader(); decorating there covers both.
  const original = syncHeader;
  syncHeader = function () { original(); decorate(); };
  decorate();
})();
