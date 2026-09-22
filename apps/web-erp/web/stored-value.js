// Stored-value oversight — the view layer (M17-FR-03/04, API-06, P-03, P-04, hard rule #10). Every rule lives
// in the TESTED session model (apps/web-erp/src/stored-value-session.ts), attached as window.storedValueSession,
// built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: cards given away twice
// (settled loss), the liability vs the books (a signed gap), and cards draining fast (a watch) — each row a
// tone AND an icon AND a word, never colour alone. It is READ-ONLY: it changes nothing and issues no write verb.
// Refresh re-reads the velocity watch (a GET); a customer reference looks up that household's double-spends
// (a GET); a posted figure reconciles the liability (a GET). Offline the screen keeps its view and the stale
// strip says the page is what the box last told it. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders
 *  a calm all-clear so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Stored-value oversight', langName: 'தமிழ்',
      lead: 'Sample stored-value oversight. Connect the store computer to see your own shop’s figures.',
      refresh: 'Refresh', asOfLabel: 'As of', reconcileBtn: 'Reconcile', lookupBtn: 'Look up',
      postedFigureLabel: 'Liability posted in the books (₹)', ownerRefLabel: 'Customer reference',
      lossHeading: 'Given away twice', lossNone: 'No cross-channel double-spends — nothing given away twice.',
      gapHeading: 'Liability vs the books', gapNeedsPosted: 'Enter the liability the books currently carry to reconcile the cards against it — nothing is assumed.',
      watchHeading: 'Draining fast', watchNone: 'No cards draining unusually fast.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at',
    },
    ta: {
      title: 'சேமிப்பு-மதிப்பு கண்காணிப்பு', langName: 'English',
      lead: 'மாதிரி சேமிப்பு-மதிப்பு கண்காணிப்பு. உங்கள் கடையின் எண்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்', reconcileBtn: 'சரிபார்', lookupBtn: 'தேடு',
      postedFigureLabel: 'கணக்கில் பதிந்த கடன் (₹)', ownerRefLabel: 'வாடிக்கையாளர் குறிப்பு',
      lossHeading: 'இருமுறை கொடுக்கப்பட்டது', lossNone: 'சேனல்கள் இடையே இரட்டைச் செலவு இல்லை — இருமுறை எதுவும் கொடுக்கப்படவில்லை.',
      gapHeading: 'கடன் vs கணக்கு', gapNeedsPosted: 'அட்டைகளை ஒப்பிட, கணக்கில் தற்போது உள்ள கடன் தொகையை உள்ளிடவும் — எதுவும் ஊகிக்கப்படாது.',
      watchHeading: 'விரைவாகக் குறைகிறது', watchNone: 'வழக்கத்திற்கு மாறாக விரைவாகக் குறையும் அட்டைகள் இல்லை.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      liability: null, doubleSpends: [], velocity: [],
      doubleSpendCount: 0, velocityCount: 0, totalOverspent: '₹0.00', totalOverspentMinor: 0,
      nobodyNamed: false, anyException: false,
    }),
  };
}

let session = window.storedValueSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One exception row: a headline (the presented status word), the state (icon+word, never colour alone), and
 *  language-neutral facts. `factNodes` builds the specifics for the feed. */
function rowNode(status, factNodes) {
  const li = document.createElement('li');
  li.className = `row tone-${status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = status.label;
  head.append(headline);

  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const slabel = document.createElement('span'); slabel.textContent = status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', status.announcement || status.label);

  li.append(head, state);

  const facts = document.createElement('div');
  facts.className = 'facts';
  for (const [label, value] of factNodes) {
    const span = document.createElement('span');
    span.textContent = `${label}: ${value}`;
    facts.append(span);
  }
  if (facts.childElementCount > 0) li.append(facts);
  return li;
}

function lossNode(d) {
  return rowNode(d.status, [
    [t('instrumentLabel'), d.instrumentId],
    [t('ownerLabel'), d.ownerRef],
    [t('overspentLabel'), d.overspent],
    [t('channelsLabel'), d.channels.join(', ')],
  ]);
}

function watchNode(v) {
  return rowNode(v.status, [
    [t('instrumentLabel'), v.instrumentId],
    [t('countLabel'), String(v.count)],
    [t('valueLabel'), v.value],
    [t('windowLabel'), String(v.windowMinutes)],
  ]);
}

/** The liability reconciliation panel — the outstanding/posted figures and the SIGNED gap, with its status. */
function paintGap(liability) {
  const panel = el('gap-panel');
  const needs = el('gap-needs');
  if (liability === null) {
    panel.hidden = true;
    needs.hidden = false;
    needs.textContent = t('gapNeedsPosted');
    return;
  }
  needs.hidden = true;
  panel.hidden = false;
  panel.className = `gap tone-${liability.status.tone}`;
  const figs = [
    [t('outstandingLabel'), liability.outstanding],
    [t('postedLabel'), liability.posted],
    [t('differenceLabel'), liability.difference],
    [t('issuedLabel'), liability.issued],
    [t('redeemedLabel'), liability.redeemed],
    [t('expiredLabel'), liability.expired],
  ];
  const grid = document.createElement('div');
  grid.className = 'figs';
  for (const [label, value] of figs) {
    const fig = document.createElement('div'); fig.className = 'fig';
    const l = document.createElement('span'); l.className = 'f-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'f-value'; v.textContent = value;
    fig.append(l, v); grid.append(fig);
  }
  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = liability.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = liability.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', liability.status.announcement || liability.status.label);
  panel.replaceChildren(state, grid);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.storedValueData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('loss-heading').textContent = t('lossHeading');
  el('gap-heading').textContent = t('gapHeading');
  el('watch-heading').textContent = t('watchHeading');
  el('owner-label-text').textContent = t('ownerRefLabel');
  el('posted-label-text').textContent = t('postedFigureLabel');
  el('lookup-btn').textContent = t('lookupBtn');
  el('reconcile-btn').textContent = t('reconcileBtn');

  // A not-permitted screen has nothing to show: the state line stands in for every section.
  const notPermitted = view.screenState.tone === 'error' && view.doubleSpends.length === 0 && view.velocity.length === 0 && view.liability === null;
  const sections = ['loss-heading', 'lookup-form', 'losses', 'loss-none', 'gap-heading', 'reconcile-form', 'gap-panel', 'gap-needs', 'watch-heading', 'watch', 'watch-none'];
  const state = el('state');
  if (notPermitted) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
    for (const id of sections) el(id).hidden = true;
    return;
  }
  state.hidden = true;
  for (const id of sections) el(id).hidden = false;

  // Losses (per-customer double-spends): rows when found, else the calm "none".
  el('losses').replaceChildren(...view.doubleSpends.map((d) => lossNode(d)));
  el('losses').hidden = view.doubleSpends.length === 0;
  el('loss-none').hidden = view.doubleSpends.length !== 0;
  el('loss-none').textContent = t('lossNone');

  // Liability reconciliation.
  paintGap(view.liability);

  // Velocity watch (store-wide).
  el('watch').replaceChildren(...view.velocity.map((v) => watchNode(v)));
  el('watch').hidden = view.velocity.length === 0;
  el('watch-none').hidden = view.velocity.length !== 0;
  el('watch-none').textContent = t('watchNone');
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.storedValueSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live figures (GETs — read-only). Offline or refused, the screen keeps its current view; the stale
// strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.storedValue;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });

el('lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const api = window.storedValue;
  const ownerRef = el('owner-ref').value.trim();
  if (!api || typeof api.lookup !== 'function' || ownerRef === '') return;
  void api.lookup(ownerRef).then((data) => { if (data) { session = api.present(data); paint(); } });
});

el('reconcile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const api = window.storedValue;
  const raw = el('posted-figure').value.trim();
  if (!api || typeof api.reconcile !== 'function' || !/^\d+$/.test(raw)) return;
  void api.reconcile(Number(raw)).then((data) => { if (data) { session = api.present(data); paint(); } });
});

refresh();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
