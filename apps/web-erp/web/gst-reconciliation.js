// GST reconciliation — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/gst-reconciliation-session.ts), attached as window.gstReconciliationSession and built on
// packages/ui. This file only draws what the session hands it: the queue, the ones needing attention first,
// each with a status that is never a bare colour (an icon and a word ride with it), what to do in plain
// language, and whether this person may do it. Nothing here changes a document. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

// ── A stand-in with the same surface as the bundled session, so the shell always opens (and says so). ──
// Only used when the box injected no queue; announced by the sample banner. The REAL copy + rules are in the
// bundled model — this is demo data, deliberately tiny.
function sampleSession() {
  const CHROME = {
    en: { title: 'GST reconciliation', lead: 'Sample queue. Connect the store computer to see your own documents.', langName: 'தமிழ்',
      attentionCount: 'need attention', allClear: 'Everything is settled — nothing needs attention.',
      filterAll: 'Show all', filterAttention: 'Only the ones needing attention', sampleData: 'Sample data — this is not your shop.',
      staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'GST சரிபார்ப்பு', lead: 'மாதிரி வரிசை. உங்கள் சொந்த ஆவணங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'கவனம் தேவை', allClear: 'அனைத்தும் தீர்க்கப்பட்டன — எதற்கும் கவனம் தேவையில்லை.',
      filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (documentLabel, id, num, tone, icon, statusLabel, actionLabel, needsAttention, mismatchNote) => ({
    documentLabel, id, number: num, status: { tone, icon, label: statusLabel, announcement: statusLabel, needsAttention },
    actionLabel, needsAttention, permitted: true, detail: '', actions: [], ...(mismatchNote ? { mismatchNote } : {}),
  });
  const rows = (l) => l === 'ta'
    ? [row('மின்-வழிச்சீட்டு', 'MV-2001', '—', 'degraded', '?', 'தெரியவில்லை', 'போர்ட்டலைப் பின்தொடரவும்', true),
       row('மின்-விலைப்பட்டியல்', 'INV-1007', '3a1f…', 'error', '≠', 'போர்ட்டல் முரண்படுகிறது', 'ஒருவர் விசாரிக்க வேண்டும்', true, 'முதலில் விசாரிக்கவும்.'),
       row('மின்-விலைப்பட்டியல்', 'INV-1006', '9c2b…', 'ok', '✓', 'பதிவு செய்யப்பட்டது', 'எதுவும் இல்லை — முடிந்தது', false)]
    : [row('E-way bill', 'MV-2001', 'no number yet', 'degraded', '?', 'Unknown — the portal did not answer', 'Chase up the portal', true),
       row('E-invoice', 'INV-1007', '3a1f…', 'error', '≠', 'Portal disagrees', 'A person must investigate', true, 'Do not re-issue — investigate first.'),
       row('E-invoice', 'INV-1006', '9c2b…', 'ok', '✓', 'Registered', 'Nothing — it is done', false)];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        rows: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, mayAct: true, nobodyNamed: false };
    },
  };
}

const real = window.gstReconciliationSession;
const session = real ?? sampleSession();
// Extra chrome words the view owns (filter button, may-act chip) — the queue's own copy is in the model.
const VIEW_WORDS = {
  en: { filterAll: 'Show all', filterAttention: 'Only the ones needing attention', mayAct: 'You can do this' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்', mayAct: 'நீங்கள் இதைச் செய்யலாம்' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;
let attentionOnly = false;

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const doc = document.createElement('span');
  doc.className = 'doc';
  doc.textContent = `${r.documentLabel} · ${r.id}`;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = r.number;
  head.append(doc, num);

  const status = document.createElement('div');
  status.className = 'status';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = r.status.icon;               // the shape
  const slabel = document.createElement('span');
  slabel.textContent = r.status.label;            // the word — never colour alone
  status.append(icon, slabel);
  // The screen-reader announcement, separate from the glanceable label.
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const action = document.createElement('div');
  action.className = 'action';
  const act = document.createElement('span');
  act.textContent = r.actionLabel;
  action.append(act);
  if (r.permissionNote) {
    const chip = document.createElement('span');
    chip.className = 'permit';
    chip.textContent = r.permissionNote;          // "Needs the GST-portal role"
    action.append(chip);
  } else if (r.permitted && r.action !== 'none' && r.action !== 'wait') {
    const chip = document.createElement('span');
    chip.className = 'permit ok';
    chip.textContent = vw('mayAct');
    action.append(chip);
  }

  // The clickable portal actions. The MODEL decides which rows offer one and whether it is enabled — this
  // only draws the button and, on click, hands the intent back to the session (which enqueues an offline
  // command; it never calls the portal from here). A mismatch/error row carries no actions, so it gets no
  // button — a person handles it (hard rule #10).
  for (const a of r.actions ?? []) {
    const wrap = document.createElement('div');
    wrap.className = 'do';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'do-btn';
    btn.textContent = a.label;
    btn.disabled = !a.enabled;
    btn.addEventListener('click', () => runAction(a));
    wrap.append(btn);
    if (a.note) {
      const note = document.createElement('span');
      note.className = 'do-note';
      note.textContent = a.note;                  // "Requested — will be sent…" / "Needs the GST-portal role"
      wrap.append(note);
    }
    action.append(wrap);
  }

  li.append(head, status, action);
  if (r.mismatchNote) {
    const mm = document.createElement('p');
    mm.className = 'mismatch';
    mm.textContent = r.mismatchNote;
    li.append(mm);
  }
  if (r.detail) {
    const d = document.createElement('p');
    d.className = 'detail';
    d.textContent = r.detail;
    li.append(d);
  }
  return li;
}

/**
 * Ask the session to run a portal action. The session re-checks the guards and commits the command to the
 * offline outbox — this file never touches the network (no fetch / XHR / portal call). We supply the wall
 * clock and repaint so the row shows its new "requested" state. Only the real session can act; the sample
 * stand-in offers no buttons.
 */
function runAction(a) {
  if (!real || typeof real.requestAction !== 'function') return;
  real.requestAction({ documentType: a.documentType, id: a.id, action: a.action, at: new Date().toISOString() });
  paint();
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = session.text(lang, 'title');
  el('lead').textContent = session.text(lang, 'lead');
  el('whoami').textContent = window.gstReconciliationData?.userId ?? '';
  el('lang').textContent = session.text(lang, 'langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  el('attention-count').textContent = view.attentionCount === 0
    ? session.text(lang, 'allClear')
    : `${view.attentionCount} ${session.text(lang, 'attentionCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? session.text(lang, 'nobodyNamed') : '';

  const shown = attentionOnly ? view.rows.filter((r) => r.needsAttention) : view.rows;
  const list = el('rows');
  list.replaceChildren(...shown.map(rowNode));

  const state = el('state');
  if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label || session.text(lang, 'stateEmpty');
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paint();
  paintStale();
});
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });

// ── Boot ────────────────────────────────────────────────────────────────────
el('sample').hidden = real !== undefined;
el('sample').textContent = session.text(lang, 'sampleData');
paint();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${session.text(lang, 'staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
// Repaint the stale strip in the newly chosen language too (the strip carries its own copy).
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
