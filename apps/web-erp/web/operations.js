// Operations recommendations inbox — the view layer (A06, API-13). Every rule lives in the TESTED session model
// (apps/web-erp/src/operations-inbox-session.ts), attached as window.operationsInboxSession, built on packages/ui
// over the tested recommendOperationsRunbooks engine. This file only draws what the session hands it: the OPEN
// recommendations to act on (each with the incident, its runbook steps, and — for an operator — a "set aside"
// button with a reason box), then the SET-ASIDE ones (each with who/why and a "bring back" button). Setting aside
// is a HUMAN decision that runs ONLY on an explicit click, never on load; on success the worklist is re-read (a
// GET) so the server-re-derived list moves the row. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Operations', lead: 'Sample recommendations. Connect the store computer to see the helper’s recommendations for your own shop.', langName: 'தமிழ்',
      openHeading: 'To act on', dismissedHeading: 'Set aside', openCount: 'to act on', dismissedCount: 'set aside',
      runbookLabel: 'Recommended steps', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason', allClear: 'Nothing to act on — the shop is running cleanly.',
      dismissBtn: 'Set aside', reopenBtn: 'Bring back', reasonPlaceholder: 'Why is this not being acted on?',
      dismissRecorded: 'Set aside.', dismissRefused: 'Could not save — a short reason is needed.', dismissLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'செயல்பாடுகள்', lead: 'மாதிரிப் பரிந்துரைகள். உங்கள் சொந்தக் கடைக்கான பரிந்துரைகளைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      openHeading: 'செயல்பட வேண்டியவை', dismissedHeading: 'ஒதுக்கப்பட்டவை', openCount: 'செயல்பட வேண்டியவை', dismissedCount: 'ஒதுக்கப்பட்டவை',
      runbookLabel: 'பரிந்துரைக்கப்பட்ட படிகள்', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்', allClear: 'செயல்பட எதுவும் இல்லை — கடை சுத்தமாக இயங்குகிறது.',
      dismissBtn: 'ஒதுக்கிவை', reopenBtn: 'மீண்டும் கொண்டுவா', reasonPlaceholder: 'இது ஏன் செயல்படுத்தப்படவில்லை?',
      dismissRecorded: 'ஒதுக்கப்பட்டது.', dismissRefused: 'சேமிக்க முடியவில்லை — ஒரு சிறு காரணம் தேவை.', dismissLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const openRow = (l) => ({
    findingId: 'sample-dead-letter', component: 'dead_letter', needsAttention: true,
    headline: l === 'ta' ? 'டெட்-லெட்டர் வரிசை பெருகுகிறது' : 'The dead-letter queue is growing',
    detail: l === 'ta' ? 'செய்திகள் நிற்கின்றன, வடியவில்லை.' : 'Messages are parking and not draining.',
    runbook: l === 'ta' ? 'டெட்-லெட்டர் வரிசையைத் திறந்து, மோசமான உருப்படியை ஒதுக்கி, மற்றவை வடிய விடுங்கள்.' : 'Open the dead-letter queue, park the poison item, let the rest drain.',
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'கவனம் தேவை' : 'Needs attention', announcement: 'dead_letter', needsAttention: true },
  });
  const downRow = (l) => ({
    findingId: 'sample-database', component: 'database', needsAttention: true,
    headline: l === 'ta' ? 'தரவுத்தளம் செயலிழந்தது' : 'The database is down',
    detail: l === 'ta' ? 'கடையின் மேக மூளையை அடைய முடியவில்லை.' : 'The shop’s cloud brain cannot be reached.',
    runbook: l === 'ta' ? 'இணைப்பையும் நற்சான்றுகளையும் சரிபார்க்கவும்; தேவைப்பட்டால் ஆதரவை அழைக்கவும்.' : 'Check the connection and credentials; call support if needed.',
    status: { tone: 'error', icon: '✕', label: l === 'ta' ? 'கவனம் தேவை' : 'Needs attention', announcement: 'database', needsAttention: true },
  });
  const dismissedRow = (l) => ({
    findingId: 'sample-sync', component: 'sync', needsAttention: false,
    headline: l === 'ta' ? 'ஒத்திசைவு பின்தங்கியது' : 'Sync was behind', detail: '', runbook: '',
    dismissedBy: 'manager', dismissedReason: l === 'ta' ? 'ஆன்-கால் ஆபரேட்டர் கவனிக்கிறார்' : 'the on-call operator is handling it',
    status: { tone: 'idle', icon: '✓', label: l === 'ta' ? 'ஒதுக்கப்பட்டது' : 'Set aside', announcement: 'set aside', needsAttention: false },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      agentActive: true, open: [downRow(l), openRow(l)], dismissed: [dismissedRow(l)], openCount: 2, dismissedCount: 1, nobodyNamed: false, mayDismiss: true,
    }),
    dismiss: async () => 'lost_link',
    reopen: async () => 'lost_link',
    presentDismissResult: (l, outcome) => ({ tone: outcome === 'recorded' ? 'ok' : 'degraded', icon: outcome === 'recorded' ? '✓' : '⚠', label: '', announcement: '', needsAttention: outcome !== 'recorded' }),
  };
}

let session = window.operationsInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** Run an operator action, show its result, and — on success — re-read the worklist so the row moves. */
async function act(run) {
  const outcome = await run();
  paintResult(session.presentDismissResult(lang, outcome));
  if (outcome === 'recorded') await refresh();
}

function rowNode(r, mayDismiss, isOpen) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.headline;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(headline, status);
  li.append(head);

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  if (r.runbook) {
    const rb = document.createElement('p'); rb.className = 'runbook'; rb.textContent = `${t('runbookLabel')}: ${r.runbook}`; li.append(rb);
  }
  if (r.dismissedReason) {
    const w = document.createElement('p'); w.className = 'why';
    w.textContent = `${t('dismissedByLabel')} ${r.dismissedBy ?? ''} — ${t('reasonLabel')}: ${r.dismissedReason}`;
    li.append(w);
  }

  // The operator's action. Only rendered for someone who holds the permission, and it runs ONLY on a click.
  if (mayDismiss && isOpen) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const reason = document.createElement('input'); reason.type = 'text'; reason.className = 'reason';
    reason.setAttribute('aria-label', t('reasonPlaceholder')); reason.placeholder = t('reasonPlaceholder');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'act dismiss'; btn.textContent = t('dismissBtn');
    btn.addEventListener('click', () => act(() => session.dismiss(r.findingId, reason.value)));
    actions.append(reason, btn);
    li.append(actions);
  } else if (mayDismiss && !isOpen) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'act reopen'; btn.textContent = t('reopenBtn');
    btn.addEventListener('click', () => act(() => session.reopen(r.findingId)));
    actions.append(btn);
    li.append(actions);
  }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.operationsInboxData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('open-count').textContent = view.openCount === 0
    ? (view.dismissedCount === 0 && view.agentActive ? t('allClear') : '')
    : `${view.openCount} ${t('openCount')}`;
  el('dismissed-count').textContent = view.dismissedCount === 0 ? '' : `${view.dismissedCount} ${t('dismissedCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('open-heading').hidden = view.open.length === 0;
  el('open-heading').textContent = t('openHeading');
  el('rows').replaceChildren(...view.open.map((r) => rowNode(r, view.mayDismiss, true)));

  el('dismissed-heading').hidden = view.dismissed.length === 0;
  el('dismissed-heading').textContent = t('dismissedHeading');
  el('dismissed-rows').replaceChildren(...view.dismissed.map((r) => rowNode(r, view.mayDismiss, false)));

  const state = el('state');
  if (view.open.length === 0 && view.dismissed.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.operationsInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.operationsInbox;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
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
