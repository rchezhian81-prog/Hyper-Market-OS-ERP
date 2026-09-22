// Integration health — the view layer (M32-FR-04, API-11, P-03, P-08, hard rule #1). Every rule lives in the
// TESTED session model (apps/web-erp/src/integration-health-session.ts), attached as window.integrationHealthSession,
// built on packages/ui + packages/a11y. This file only DRAWS what the session hands it: the connections that
// have gone quiet or are failing (worst-first), then the ones working or switched off — each row a tone AND an
// icon AND a word, never colour alone — plus the reassurance that the till keeps trading regardless. It is
// READ-ONLY: it changes nothing and issues no write verb. Refresh re-reads the health picture (a GET). Offline
// the screen keeps its view and the stale strip says the page is what the box last told it. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It renders
 *  a calm all-clear so the screen is never blank offline. */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Integration health', langName: 'தமிழ்',
      lead: 'Sample integration health. Connect the store computer to see your own shop’s connections.',
      refresh: 'Refresh', asOfLabel: 'As of',
      attentionHeading: 'Needs a look', attentionNone: 'Every connection has worked recently — nothing has gone quiet.',
      calmHeading: 'Working / switched off',
      tillSafe: 'Your till keeps trading. No connection here can stop a sale — a connection being down is a queue to clear later, never a shop that cannot sell.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at',
    },
    ta: {
      title: 'இணைப்பு நலன்', langName: 'English',
      lead: 'மாதிரி இணைப்பு நலன். உங்கள் கடையின் இணைப்புகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
      attentionHeading: 'கவனிக்க வேண்டியவை', attentionNone: 'ஒவ்வொரு இணைப்பும் சமீபத்தில் வேலை செய்துள்ளது — எதுவும் அமைதியாகவில்லை.',
      calmHeading: 'வேலை செய்கிறது / அணைக்கப்பட்டது',
      tillSafe: 'உங்கள் பணப்பெட்டி தொடர்ந்து விற்பனை செய்யும். இங்குள்ள எந்த இணைப்பும் விற்பனையை நிறுத்த முடியாது.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    },
  };
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: () => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      attention: [], calm: [], attentionCount: 0, posUnaffected: true, nobodyNamed: false, anyException: false,
    }),
  };
}

let session = window.integrationHealthSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** One connection row: a headline (the presented status word), the state (icon+word, never colour alone), and
 *  language-neutral facts. */
function rowNode(a) {
  const li = document.createElement('li');
  li.className = `row tone-${a.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span');
  headline.className = 'headline';
  headline.textContent = a.adapterId;
  head.append(headline);

  const state = document.createElement('span');
  state.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = a.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = a.status.label;
  state.append(icon, slabel);
  state.setAttribute('aria-label', a.status.announcement || a.status.label);

  li.append(head, state);

  const facts = document.createElement('div');
  facts.className = 'facts';
  for (const [label, value] of [
    [t('categoryLabel'), a.category],
    [t('lastWorkedLabel'), a.lastWorked],
    [t('failuresLabel'), String(a.consecutiveFailures)],
  ]) {
    const span = document.createElement('span');
    span.textContent = `${label}: ${value}`;
    facts.append(span);
  }
  li.append(facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.integrationHealthData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('refresh').textContent = t('refresh');
  el('attention-heading').textContent = t('attentionHeading');
  el('calm-heading').textContent = t('calmHeading');

  // A not-permitted screen has nothing to show: the state line stands in for every section.
  const notPermitted = view.screenState.tone === 'error' && view.attention.length === 0 && view.calm.length === 0;
  const sections = ['till-safe', 'attention-heading', 'attention', 'attention-none', 'calm-heading', 'calm'];
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

  // The reassurance that matters most rides at the top: the till keeps trading regardless (hard rule #1).
  const tillSafe = el('till-safe');
  tillSafe.className = view.posUnaffected ? 'reassure' : 'reassure warn';
  el('till-safe-icon').textContent = view.posUnaffected ? '✓' : '⚠';
  el('till-safe-text').textContent = view.posUnaffected ? t('tillSafe') : t('tillWarn');

  // Needs a look (worst-first): rows when found, else the calm "none".
  el('attention').replaceChildren(...view.attention.map((a) => rowNode(a)));
  el('attention').hidden = view.attention.length === 0;
  el('attention-none').hidden = view.attention.length !== 0;
  el('attention-none').textContent = t('attentionNone');

  // Working / switched off — the calm remainder.
  el('calm').replaceChildren(...view.calm.map((a) => rowNode(a)));
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.integrationHealthSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live health picture (a GET — read-only). Offline or refused, the screen keeps its current view; the
// stale strip already says the page is what the box last told it. Nothing is written.
async function refresh() {
  const api = window.integrationHealth;
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
    /* the screen still opens; it just will not be there without a network */
  });
}
