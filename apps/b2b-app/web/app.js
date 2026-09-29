// Business-customer portal — the view layer (M22-FR-04, API-09, §35, P-03, P-04, P-08). Every rule lives in the
// TESTED session model (apps/b2b-app/src/b2b-portal-session.ts), attached as window.b2bPortalSession by the
// bundle, built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: the customer's
// credit account, its invoices (each a tone AND an icon AND a word — settled / open / overdue / in dispute),
// its statement aged from the due dates, and the documents issued to it. A feed the login may not see is said so
// — never a zero. It is READ-ONLY: it changes nothing and issues no write verb. Refresh re-reads the four feeds
// (GETs). Offline the screen keeps its view and the stale strip says the page is what it was last shown. No
// prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Your account with SRE', langName: 'தமிழ்',
      lead: 'Sample business-customer portal. Sign in to see your own account.',
      refresh: 'Refresh', asOfLabel: 'As of',
      accountHeading: 'Your credit account', invoicesHeading: 'Your invoices', statementHeading: 'Your statement', documentsHeading: 'Documents issued to you',
      invoicesNone: 'No invoices on your account.', documentsNone: 'No documents issued yet.', statementNone: 'No invoices have been recorded on your account, so there is no statement to age.',
      noTerms: 'No credit terms have been set for your account — purchases are settled as they are made.',
      sampleData: 'Sample data — this is not your account.', staleShell: 'No connection. This page is what you were last shown, at',
    },
    ta: {
      title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
      lead: 'மாதிரி வணிக வாடிக்கையாளர் போர்ட்டல். உங்கள் கணக்கைப் பார்க்க உள்நுழையவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
      accountHeading: 'உங்கள் கடன் கணக்கு', invoicesHeading: 'உங்கள் விலைப்பட்டியல்கள்', statementHeading: 'உங்கள் அறிக்கை', documentsHeading: 'உங்களுக்கு வழங்கிய ஆவணங்கள்',
      invoicesNone: 'உங்கள் கணக்கில் விலைப்பட்டியல்கள் இல்லை.', documentsNone: 'இன்னும் ஆவணங்கள் வழங்கப்படவில்லை.', statementNone: 'உங்கள் கணக்கில் விலைப்பட்டியல்கள் பதிவு செய்யப்படவில்லை, எனவே வயதிட அறிக்கை இல்லை.',
      noTerms: 'உங்கள் கணக்கிற்குக் கடன் நிபந்தனைகள் அமைக்கப்படவில்லை — வாங்கும்போதே செலுத்தப்படுகிறது.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.', staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      account: null, noTerms: true, invoices: [], statement: null, documents: [],
      feeds: { account: 'shown', invoices: 'empty', statement: 'empty', documents: 'empty' }, feedNotes: {},
      overdueCount: 0, disputedCount: 0, notIdentified: false, anyAttention: false,
    }),
  };
}

let session = window.b2bPortalSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function statusNode(status) {
  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const slabel = document.createElement('span'); slabel.textContent = status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', status.announcement || status.label);
  return state;
}

function figsNode(figs) {
  const grid = document.createElement('div');
  grid.className = 'figs';
  for (const [label, value] of figs) {
    if (value === null) continue;
    const fig = document.createElement('div'); fig.className = 'fig';
    const l = document.createElement('span'); l.className = 'f-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'f-value'; v.textContent = value;
    fig.append(l, v); grid.append(fig);
  }
  return grid;
}

/** One invoice row: number + open amount, a state (icon+word, never colour alone), and the dates and money. */
function invoiceNode(i) {
  const li = document.createElement('li');
  li.className = `row tone-${i.status.tone}`;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = i.number;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = `${t('openLabel')}: ${i.open}`;
  head.append(headline, value);
  const facts = document.createElement('div'); facts.className = 'facts';
  const issued = document.createElement('span'); issued.textContent = `${t('issuedLabel')}: ${i.issuedOn}`;
  const due = document.createElement('span'); due.textContent = `${t('dueLabel')}: ${i.dueOn}`;
  const billed = document.createElement('span'); billed.textContent = `${t('billedLabel')}: ${i.billed}`;
  const settled = document.createElement('span'); settled.textContent = `${t('settledLabel')}: ${i.settled}`;
  facts.append(issued, due, billed, settled);
  if (i.disputeReason !== null) { const r = document.createElement('span'); r.textContent = i.disputeReason; facts.append(r); }
  li.append(head, statusNode(i.status), facts);
  return li;
}

/** One document row: kind + number + amount, and where it came from. */
function documentNode(d) {
  const li = document.createElement('li');
  li.className = 'row tone-idle';
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${d.kindLabel} ${d.number}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = d.amount;
  head.append(headline, value);
  const facts = document.createElement('div'); facts.className = 'facts';
  if (d.validUntil !== null) { const v = document.createElement('span'); v.textContent = `${t('validUntilLabel')}: ${d.validUntil}`; facts.append(v); }
  if (d.derivedFrom !== null) { const f = document.createElement('span'); f.textContent = `${t('fromLabel')}: ${d.derivedFrom}`; facts.append(f); }
  li.append(head, facts);
  return li;
}

/** A feed's note line — the refusal / unreadable / empty words — or nothing when the feed is shown. */
function paintNote(id, feedState, note, emptyKey) {
  const p = el(id);
  if (feedState === 'shown') { p.hidden = true; return; }
  p.hidden = false;
  p.className = feedState === 'no_grant' || feedState === 'unavailable' ? 'note' : 'muted';
  p.textContent = note ?? t(emptyKey);
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.b2bData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('account-heading').textContent = t('accountHeading');
  el('invoices-heading').textContent = t('invoicesHeading');
  el('statement-heading').textContent = t('statementHeading');
  el('documents-heading').textContent = t('documentsHeading');

  // A not-permitted screen (not a business-customer login) has nothing to show: the state line stands in for everything.
  const notPermitted = view.screenState.tone === 'error';
  const sections = ['account-heading', 'account', 'account-note', 'invoices-heading', 'invoices', 'invoices-note', 'statement-heading', 'statement', 'statement-note', 'documents-heading', 'documents', 'documents-note'];
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

  // The credit account — the terms and what is owed; "no terms" is a plain fact, never a zero balance.
  const account = el('account');
  if (view.account !== null) {
    account.hidden = false;
    account.className = `panel tone-${view.account.status.tone}`;
    account.replaceChildren(statusNode(view.account.status), figsNode([
      [t('creditLimitLabel'), view.account.creditLimit],
      [t('outstandingLabel'), view.account.outstanding],
      [t('availableLabel'), view.account.available],
    ]));
    el('account-note').hidden = true;
  } else {
    account.hidden = true;
    paintNote('account-note', view.noTerms ? 'empty' : view.feeds.account, view.feedNotes.account, 'noTerms');
  }

  // Invoices — earliest due first, as the cloud ordered them.
  el('invoices').replaceChildren(...view.invoices.map((i) => invoiceNode(i)));
  el('invoices').hidden = view.invoices.length === 0;
  paintNote('invoices-note', view.feeds.invoices, view.feedNotes.invoices, 'invoicesNone');

  // The statement — aged from the due dates; a refused statement is a permission answer, never a zero.
  const statement = el('statement');
  if (view.statement !== null) {
    statement.hidden = false;
    statement.className = `panel tone-${view.statement.status.tone}`;
    statement.replaceChildren(
      statusNode(view.statement.status),
      figsNode([[t('totalOutstandingLabel'), view.statement.totalOutstanding], [t('overdueLabel'), view.statement.overdue], [t('disputedLabel'), view.statement.disputed]]),
      figsNode(view.statement.buckets.map((b) => [b.label, b.amount])),
    );
  } else {
    statement.hidden = true;
  }
  paintNote('statement-note', view.feeds.statement, view.feedNotes.statement, 'statementNone');

  // Documents issued to the customer.
  el('documents').replaceChildren(...view.documents.map((d) => documentNode(d)));
  el('documents').hidden = view.documents.length === 0;
  paintNote('documents-note', view.feeds.documents, view.feedNotes.documents, 'documentsNone');
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.b2bPortalSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live feeds (GETs — read-only). Offline or refused, the screen keeps its current view; the stale strip
// already says the page is what it was last shown. Nothing is written.
async function refresh() {
  const api = window.b2bPortal;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) {
    session = api.present(data);
    el('asof').textContent = `${t('asOfLabel')} ${new Date(data.asAt).toLocaleString()}`;
    paint();
  }
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
