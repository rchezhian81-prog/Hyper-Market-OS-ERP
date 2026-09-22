// Manager checklists — the view layer (M25-FR-02, API-11). Every rule lives in the TESTED session model
// (apps/web-erp/src/checklist-session.ts), attached as window.checklistSession, built on packages/ui over the
// cloud's tested assessChecklist fold. This file only draws what the session hands it: the day's checklists
// (worst first, each with its items, the blocking one flagged, and how it stands), and a "Sign and submit"
// button per checklist a manager may sign. Signing is a HUMAN decision that runs ONLY on an explicit click,
// never on load; on success the worklist is re-read (a GET) so the checklist re-reads with its new state. No
// prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Checklists', langName: 'தமிழ்',
      lead: 'Sample checklists. Connect the store computer to see the day\'s lists for your own shop.',
      listHeading: 'To sign off', toWorkCount: 'to sign off', allDone: 'Every checklist is signed and nothing blocking is outstanding.',
      notKnown: 'This store computer has not been told the day\'s checklists yet, so it cannot say what is outstanding.',
      kindOpening: 'Opening', kindClosing: 'Closing', kindHandover: 'Handover',
      itemsLabel: 'Items', blockingWord: 'Blocking', outstandingLabel: 'Still outstanding', signedByLabel: 'Signed by', unsignedWord: 'Not signed',
      blockedWord: 'Blocked', incompleteWord: 'Carried', completeWord: 'Done',
      submitHeading: 'Sign off a checklist', whichLabel: 'Which checklist', signSubmitBtn: 'Sign and submit', tickHint: 'Tick the items you have verified, then sign.',
      noneToSign: 'Nothing here to sign — every checklist is complete.',
      submitRecorded: 'Signed and recorded.', submitRefused: 'Could not record — a blocking item is still outstanding, or you do not have permission to sign the checklist.', submitLostLink: 'No connection — not saved. Try again.',
      scrReady: 'Showing the day\'s checklists', scrEmpty: 'Every checklist is signed and nothing blocking is outstanding.',
      stateNotPermitted: 'You do not have permission to see the checklists.', noManage: 'You can see the checklists, but signing one needs manager permission.',
      nobodyNamed: 'This store computer has not been told who is using this screen.',
      staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    },
    ta: {
      title: 'சரிபார்ப்புப் பட்டியல்கள்', langName: 'English',
      lead: 'மாதிரி பட்டியல்கள். உங்கள் கடையின் அன்றைய பட்டியல்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'கையொப்பமிட வேண்டியவை', toWorkCount: 'கையொப்பமிட', allDone: 'ஒவ்வொரு பட்டியலும் கையொப்பமிடப்பட்டு, தடையான எதுவும் நிலுவையில் இல்லை.',
      notKnown: 'அன்றைய சரிபார்ப்புப் பட்டியல்கள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.',
      kindOpening: 'திறப்பு', kindClosing: 'மூடல்', kindHandover: 'ஒப்படைப்பு',
      itemsLabel: 'உருப்படிகள்', blockingWord: 'தடையானது', outstandingLabel: 'இன்னும் நிலுவையில்', signedByLabel: 'கையொப்பமிட்டவர்', unsignedWord: 'கையொப்பமிடப்படவில்லை',
      blockedWord: 'தடைபட்டது', incompleteWord: 'எடுத்துச் செல்லப்பட்டது', completeWord: 'முடிந்தது',
      submitHeading: 'ஒரு பட்டியலைக் கையொப்பமிடு', whichLabel: 'எந்தப் பட்டியல்', signSubmitBtn: 'கையொப்பமிட்டு சமர்ப்பி', tickHint: 'நீங்கள் சரிபார்த்த உருப்படிகளைக் குறியிடவும், பிறகு கையொப்பமிடவும்.',
      noneToSign: 'கையொப்பமிட எதுவும் இல்லை — ஒவ்வொரு பட்டியலும் முழுமையானது.',
      submitRecorded: 'கையொப்பமிடப்பட்டு பதிவு செய்யப்பட்டது.', submitRefused: 'பதிவு செய்ய முடியவில்லை — ஒரு தடையான உருப்படி இன்னும் நிலுவையில் உள்ளது, அல்லது அனுமதி இல்லை.', submitLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      scrReady: 'அன்றைய சரிபார்ப்புப் பட்டியல்களைக் காட்டுகிறது', scrEmpty: 'ஒவ்வொரு பட்டியலும் கையொப்பமிடப்பட்டு, தடையான எதுவும் நிலுவையில் இல்லை.',
      stateNotPermitted: 'சரிபார்ப்புப் பட்டியல்களைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.', noManage: 'பட்டியல்களைப் பார்க்கலாம், ஆனால் கையொப்பமிட மேலாளர் அனுமதி தேவை.',
      nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    },
  };
  const sampleList = (l) => ({
    checklistId: 'C-close', kind: 'closing', kindLabel: l === 'ta' ? 'மூடல்' : 'Closing',
    outcome: 'blocked_item', complete: false, signedBy: null,
    items: [
      { itemId: 'safe', description: l === 'ta' ? 'பணப்பெட்டியைப் பூட்டு' : 'lock the safe', blocking: true, done: false },
      { itemId: 'lights', description: l === 'ta' ? 'விளக்குகளை அணை' : 'switch off the lights', blocking: false, done: true },
    ],
    outstanding: [{ itemId: 'safe', description: l === 'ta' ? 'பணப்பெட்டியைப் பூட்டு' : 'lock the safe', blocking: true, done: false }],
    detail: l === 'ta' ? 'கடை நடத்த முடியாத 1 உருப்படி: பணப்பெட்டியைப் பூட்டு' : '1 item the shop cannot run without: lock the safe',
    severityWord: l === 'ta' ? 'தடைபட்டது' : 'Blocked',
    status: { tone: 'error', icon: '✕', label: (l === 'ta' ? 'தடைபட்டது' : 'Blocked') + ' · ' + (l === 'ta' ? 'மூடல்' : 'Closing'), announcement: 'blocked', needsAttention: true },
    needsAttention: true,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'error', icon: '✕', label: '', announcement: '', needsAttention: true },
      checklists: [sampleList(l)], toWorkCount: 1, nobodyNamed: false, mayManage: true,
    }),
    submit: async () => 'lost_link',
    presentSubmitResult: (l, result) => ({ tone: result === 'recorded' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'recorded' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'recorded' }),
  };
}

let session = window.checklistSession ?? sampleSession();
const t = (key) => session.text(lang, key);
let canSignNow = false;

function rowNode(c) {
  const li = document.createElement('li');
  li.className = `row tone-${c.status.tone}`;
  li.dataset.checklistId = c.checklistId;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = c.kindLabel;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = c.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = c.severityWord;
  status.append(icon, slabel);
  status.setAttribute('aria-label', c.status.announcement || c.status.label);
  head.append(headline, status);

  const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = c.detail;

  const items = document.createElement('ul'); items.className = 'items';
  for (const it of c.items) {
    const row = document.createElement('li');
    if (it.done) row.className = 'done';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.itemId = it.itemId;
    box.checked = it.done;
    box.disabled = it.done || !canSignNow; // a shift's tick is not un-done here; a non-manager cannot tick
    box.setAttribute('aria-label', it.description);
    const label = document.createElement('span'); label.textContent = it.description;
    row.append(box, label);
    if (it.blocking) { const b = document.createElement('span'); b.className = 'blk'; b.textContent = t('blockingWord'); row.append(b); }
    items.append(row);
  }

  li.append(head, detail, items);

  if (c.signedBy) {
    const sb = document.createElement('div'); sb.className = 'signedby'; sb.textContent = `${t('signedByLabel')}: ${c.signedBy}`;
    li.append(sb);
  }

  // The sign button — only for a manager, and only while there is something to sign (not already complete).
  if (canSignNow && !c.complete) {
    const btn = document.createElement('button');
    btn.className = 'act sign';
    btn.type = 'button';
    btn.dataset.checklistId = c.checklistId;
    btn.textContent = t('signSubmitBtn');
    li.append(btn);
  }
  return li;
}

function paint() {
  const view = session.view(lang);
  canSignNow = view.mayManage && !view.nobodyNamed;

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.checklistData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('work-count').textContent = view.toWorkCount === 0 ? t('allDone') : `${view.toWorkCount} ${t('toWorkCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('list-heading').hidden = view.checklists.length === 0;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...view.checklists.map((c) => rowNode(c)));

  const state = el('state');
  if (view.checklists.length === 0 || view.toWorkCount === 0) {
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

// The manager's sign-off — a HUMAN write that runs ONLY on this explicit click, never on load. Delegated from
// the list so there is one handler; on success the worklist is re-read (a GET) so the checklist re-reads with its
// new state. The server enforces the blocking-item rule and §28; the screen never fakes it.
el('rows').addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest('button.sign') : null;
  if (!btn) return;
  const card = btn.closest('li.row');
  if (!card) return;
  const checklistId = card.dataset.checklistId;
  const doneItemIds = Array.from(card.querySelectorAll('input[type=checkbox]'))
    .filter((b) => b.checked && !b.disabled)
    .map((b) => b.dataset.itemId);
  void (async () => {
    const result = await session.submit(checklistId, doneItemIds, true);
    paintResult(session.presentSubmitResult(lang, result));
    if (result === 'recorded') { await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.checklistSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live checklist worklist (a GET — read-only). Offline or refused, the screen keeps its current view and
// the stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.checklist;
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
