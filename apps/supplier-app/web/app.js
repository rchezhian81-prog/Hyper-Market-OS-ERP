// Supplier portal — the view layer (M24-FR-01, API-03, §35, P-03, P-04). Every rule lives in the TESTED session
// model (apps/supplier-app/src/supplier-portal-session.ts), attached as window.supplierPortalSession by the
// bundle, built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: what the
// supplier sent (waiting-on-us first, then processed) and its statement (the money we owe it, disputed shown
// separately) — each row a tone AND an icon AND a word, never colour alone. It is READ-ONLY: it changes nothing
// and issues no write verb. Refresh re-reads both feeds (GETs). Offline the screen keeps its view and the stale
// strip says the page is what it was last shown. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). Renders a
 *  calm all-clear so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Your account with SRE', langName: 'தமிழ்',
      lead: 'Sample supplier portal. Sign in to see your own account.',
      refresh: 'Refresh', asOfLabel: 'As of',
      sentHeading: 'What you have sent us', sentNone: 'You have not sent us anything yet.',
      statementHeading: 'Your statement',
      sampleData: 'Sample data — this is not your account.', staleShell: 'No connection. This page is what you were last shown, at',
    },
    ta: {
      title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
      lead: 'மாதிரி சப்ளையர் போர்ட்டல். உங்கள் கணக்கைப் பார்க்க உள்நுழையவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
      sentHeading: 'நீங்கள் அனுப்பியவை', sentNone: 'நீங்கள் இன்னும் எதையும் அனுப்பவில்லை.',
      statementHeading: 'உங்கள் அறிக்கை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      awaiting: [], processed: [], statement: null, statementInaccessible: false, awaitingCount: 0, notIdentified: false, anyAttention: false,
    }),
  };
}

let session = window.supplierPortalSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One submission row: kind headline, a state (icon+word, never colour alone), and language-neutral facts. */
function submissionNode(s) {
  const li = document.createElement('li');
  li.className = `row tone-${s.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = s.kindLabel;
  head.append(headline);

  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);

  li.append(head, state);

  const facts = document.createElement('div');
  facts.className = 'facts';
  const ref = document.createElement('span'); ref.textContent = s.submissionId;
  const when = document.createElement('span'); when.textContent = s.receivedAt;
  facts.append(ref, when);
  li.append(facts);
  return li;
}

/** The statement panel — the named figures and the closing balance, with its reconcile status. */
function paintStatement(view) {
  const panel = el('statement');
  const inaccessible = el('statement-inaccessible');
  if (view.statement === null) {
    panel.hidden = true;
    inaccessible.hidden = !view.statementInaccessible;
    if (view.statementInaccessible) inaccessible.textContent = t('notAccessible');
    return;
  }
  inaccessible.hidden = true;
  panel.hidden = false;
  const s = view.statement;
  panel.className = `statement tone-${s.status.tone}`;
  const figs = [
    [t('openingLabel'), s.opening],
    [t('invoicedLabel'), s.invoiced],
    [t('creditedLabel'), s.credited],
    [t('debitedLabel'), s.debited],
    [t('paidLabel'), s.paid],
    [t('closingLabel'), s.closing],
    [t('disputedLabel'), s.disputed],
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
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = s.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = s.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', s.status.announcement || s.status.label);
  panel.replaceChildren(state, grid);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.supplierData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('sent-heading').textContent = t('sentHeading');
  el('statement-heading').textContent = t('statementHeading');

  // A not-permitted screen (not a supplier login) has nothing to show: the state line stands in for everything.
  const notPermitted = view.screenState.tone === 'error' && view.awaiting.length === 0 && view.processed.length === 0 && view.statement === null && !view.statementInaccessible;
  const sections = ['sent-heading', 'awaiting', 'processed', 'sent-none', 'statement-heading', 'statement', 'statement-inaccessible'];
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

  // What you have sent us: waiting-on-us first, then processed; else the calm "none".
  el('awaiting').replaceChildren(...view.awaiting.map((s) => submissionNode(s)));
  el('processed').replaceChildren(...view.processed.map((s) => submissionNode(s)));
  const nothingSent = view.awaiting.length === 0 && view.processed.length === 0;
  el('awaiting').hidden = view.awaiting.length === 0;
  el('processed').hidden = view.processed.length === 0;
  el('sent-none').hidden = !nothingSent;
  el('sent-none').textContent = t('sentNone');

  paintStatement(view);
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.supplierPortalSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live feeds (GETs — read-only). Offline or refused, the screen keeps its current view; the stale strip
// already says the page is what it was last shown. Nothing is written.
async function refresh() {
  const api = window.supplierPortal;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
el('refresh').addEventListener('click', () => { void refresh(); });

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
    /* the portal still opens; it just will not be there without a network */
  });
}
