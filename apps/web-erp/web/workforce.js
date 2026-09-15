// Workforce guidance inbox — the view layer (A10, API-13, M25-FR-02). Every rule lives in the TESTED session
// model (apps/web-erp/src/workforce-inbox-session.ts), attached as window.workforceInboxSession, built on
// packages/ui over the tested assessDailyTasks engine. This file only draws what the session hands it: the OPEN
// guidance to act on (each late task, why it needs attention, the recommended action, and — for a manager — a
// "set aside" button with a reason box), then the SET-ASIDE ones (each with who/why and a "bring back" button).
// Setting aside is a HUMAN decision that runs ONLY on an explicit click, never on load; on success the worklist
// is re-read (a GET) so the server-re-derived list moves the row. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Workforce', lead: 'Sample tasks. Connect the store computer to see the helper’s guidance for your own shop.', langName: 'தமிழ்',
      openHeading: 'Needs attention', dismissedHeading: 'Set aside', openCount: 'needing attention', dismissedCount: 'set aside',
      guidanceLabel: 'What to do', dismissedByLabel: 'Set aside by', reasonLabel: 'Reason', allClear: 'Nothing late — the day’s tasks are on track.',
      dismissBtn: 'Set aside', reopenBtn: 'Bring back', reasonPlaceholder: 'Why is this not being acted on now?',
      dismissRecorded: 'Set aside.', dismissRefused: 'Could not save — a short reason is needed.', dismissLostLink: 'No connection — not saved. Try again.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'பணியாளர்கள்', lead: 'மாதிரிப் பணிகள். உங்கள் சொந்தக் கடைக்கான வழிகாட்டுதலைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      openHeading: 'கவனம் தேவை', dismissedHeading: 'ஒதுக்கப்பட்டவை', openCount: 'கவனம் தேவை', dismissedCount: 'ஒதுக்கப்பட்டவை',
      guidanceLabel: 'என்ன செய்ய வேண்டும்', dismissedByLabel: 'ஒதுக்கியவர்', reasonLabel: 'காரணம்', allClear: 'தாமதம் எதுவும் இல்லை — இன்றைய பணிகள் சரியாக நடக்கின்றன.',
      dismissBtn: 'ஒதுக்கிவை', reopenBtn: 'மீண்டும் கொண்டுவா', reasonPlaceholder: 'இது ஏன் இப்போது செயல்படுத்தப்படவில்லை?',
      dismissRecorded: 'ஒதுக்கப்பட்டது.', dismissRefused: 'சேமிக்க முடியவில்லை — ஒரு சிறு காரணம் தேவை.', dismissLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const escalatedRow = (l) => ({
    findingId: 'sample-chiller', taskId: 'T-chiller', needsAttention: true,
    headline: l === 'ta' ? '"சில்லர் வெப்பநிலை சரிபார்ப்பு" முக்கியமானது, 40 நிமிடம் தாமதம்' : '"Chiller temperature check" is critical and 40 minutes overdue',
    detail: l === 'ta' ? 'முக்கியமான பணி நேரம் கடந்தது.' : 'A critical task is past its due time.',
    guidance: l === 'ta' ? 'கடமையிலுள்ள மேலாளரிடம் அனுப்பி இப்போதே செய்யுங்கள்.' : 'Escalate to the manager on duty and get it done now.',
    status: { tone: 'error', icon: '✕', label: l === 'ta' ? 'இப்போது அனுப்பு' : 'Escalate now', announcement: 'chiller', needsAttention: true },
  });
  const overdueRow = (l) => ({
    findingId: 'sample-sweep', taskId: 'T-sweep', needsAttention: true,
    headline: l === 'ta' ? '"நடைபாதைகளைப் பெருக்குதல்" 30 நிமிடம் தாமதம்' : '"Sweep the aisles" is 30 minutes overdue',
    detail: l === 'ta' ? 'முக்கியமல்லாத பணி தாமதமானது.' : 'A non-critical task is overdue.',
    guidance: l === 'ta' ? 'இதை முடிக்க ஒருவரை நியமியுங்கள்.' : 'Assign someone to complete this task.',
    status: { tone: 'degraded', icon: '⚠', label: l === 'ta' ? 'தாமதம்' : 'Overdue', announcement: 'sweep', needsAttention: true },
  });
  const dismissedRow = (l) => ({
    findingId: 'sample-float', taskId: 'T-float', needsAttention: false,
    headline: l === 'ta' ? '"கல்லாப் பணம் எண்ணுதல்" ஒதுக்கப்பட்டது' : 'Float count set aside', detail: '', guidance: '',
    dismissedBy: 'manager', dismissedReason: l === 'ta' ? 'மூடும் ஷிப்ட் தலைவருக்கு நியமிக்கப்பட்டது' : 'assigned to the closing shift lead',
    status: { tone: 'idle', icon: '✓', label: l === 'ta' ? 'ஒதுக்கப்பட்டது' : 'Set aside', announcement: 'set aside', needsAttention: false },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      agentActive: true, open: [escalatedRow(l), overdueRow(l)], dismissed: [dismissedRow(l)], openCount: 2, dismissedCount: 1, nobodyNamed: false, mayDismiss: true,
    }),
    dismiss: async () => 'lost_link',
    reopen: async () => 'lost_link',
    presentDismissResult: (l, outcome) => ({ tone: outcome === 'recorded' ? 'ok' : 'degraded', icon: outcome === 'recorded' ? '✓' : '⚠', label: '', announcement: '', needsAttention: outcome !== 'recorded' }),
  };
}

let session = window.workforceInboxSession ?? sampleSession();
const t = (key) => session.text(lang, key);

/** Run a manager action, show its result, and — on success — re-read the worklist so the row moves. */
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
  if (r.guidance) {
    const g = document.createElement('p'); g.className = 'guidance'; g.textContent = `${t('guidanceLabel')}: ${r.guidance}`; li.append(g);
  }
  if (r.dismissedReason) {
    const w = document.createElement('p'); w.className = 'why';
    w.textContent = `${t('dismissedByLabel')} ${r.dismissedBy ?? ''} — ${t('reasonLabel')}: ${r.dismissedReason}`;
    li.append(w);
  }

  // The manager's action. Only rendered for someone who holds the permission, and it runs ONLY on a click.
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
  el('whoami').textContent = window.workforceInboxData?.userId ?? '';
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

el('sample').hidden = window.workforceInboxSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live worklist (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.workforceInbox;
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
