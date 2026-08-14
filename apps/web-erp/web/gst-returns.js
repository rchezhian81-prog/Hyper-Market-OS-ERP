// GST returns — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/gst-returns-session.ts), attached as window.gstReturnsSession, built on packages/ui + the
// tested packages/finance GSTR-1 submission engine. This file only draws what the session hands it: every
// filing period, the ones needing attention first, each with a status that is never a bare colour (an icon +
// a word ride with it), the next step in plain language, and the portal reference once filed. Read-only —
// nothing here files a return. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'GST returns', lead: 'Sample filing periods. Connect the store computer to see your own returns.', langName: 'தமிழ்',
      attentionCount: 'need attention', allClear: 'Every return is settled — nothing needs attention.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'GST வருமானங்கள்', lead: 'மாதிரி தாக்கல் காலங்கள். உங்கள் சொந்த வருமானங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வருமானமும் தீர்க்கப்பட்டது.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (period, tone, icon, statusLabel, actionLabel, needsAttention, arn) => ({
    period, status: { tone, icon, label: statusLabel, announcement: `${period}: ${statusLabel}`, needsAttention },
    action: 'none', actionLabel, needsAttention, detail: '', actions: [], ...(arn ? { arn } : {}),
  });
  const rows = (l) => l === 'ta'
    ? [row('062026', 'error', '✕', 'போர்ட்டல் மறுத்தது', 'எண்களைச் சரிசெய்து மீண்டும் தாக்கல் செய்யவும்', true),
       row('052026', 'degraded', '◑', 'ஒப்புதல் — தாக்கல் செய்யத் தயார்', 'போர்ட்டலில் தாக்கல் செய்யவும்', false),
       row('042026', 'ok', '✓', 'தாக்கல் செய்யப்பட்டது', 'எதுவும் இல்லை — முடிந்தது', false, 'ARN-042026')]
    : [row('062026', 'error', '✕', 'Rejected by the portal', 'Correct the figures and file again', true),
       row('052026', 'degraded', '◑', 'Approved — ready to file', 'File it to the portal', false),
       row('042026', 'ok', '✓', 'Filed', 'Nothing — it is done', false, 'ARN-042026')];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false }, rows: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, nobodyNamed: false };
    },
  };
}

const real = window.gstReturnsSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = { en: { filterAll: 'Show all', filterAttention: 'Only the ones needing attention' }, ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்' } };
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const period = document.createElement('span'); period.className = 'period'; period.textContent = r.period;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(period, status);
  li.append(head);

  const action = document.createElement('div');
  action.className = 'action';
  const guidance = document.createElement('span');
  guidance.textContent = r.actionLabel;
  action.append(guidance);

  // The clickable governance buttons. The MODEL decides which rows offer one and whether it is enabled
  // (right role, maker ≠ checker for approve) — this only draws the button and, on click, hands the intent
  // back to the session, which enqueues an offline command. It never calls the portal from here. A stuck
  // return carries no actions, so it gets no button — a person handles it (hard rule #10).
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
      note.textContent = a.note;
      wrap.append(note);
    }
    action.append(wrap);
  }
  li.append(action);

  if (r.arn || r.preparedBy || r.approvedByName) {
    const who = document.createElement('div');
    who.className = 'who-line';
    if (r.arn) { const s = document.createElement('span'); s.className = 'arn'; s.textContent = r.arn; who.append(s); }
    if (r.preparedBy) { const s = document.createElement('span'); s.textContent = r.preparedBy; who.append(s); }
    if (r.approvedByName) { const s = document.createElement('span'); s.textContent = r.approvedByName; who.append(s); }
    li.append(who);
  }

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  return li;
}

/**
 * Ask the session to run a governance action. The session re-checks the guards (right role, maker ≠ checker)
 * and commits the command to the offline outbox — this file never touches the network (no fetch / XHR / portal
 * call). We supply the wall clock and repaint so the row shows its new "requested" state. Only the real session
 * can act; the sample stand-in offers no buttons.
 */
function runAction(a) {
  if (!real || typeof real.requestAction !== 'function') return;
  real.requestAction({ period: a.period, action: a.action, at: new Date().toISOString() });
  paint();
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.gstReturnsData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  el('attention-count').textContent = view.attentionCount === 0 ? t('allClear') : `${view.attentionCount} ${t('attentionCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.rows.filter((r) => r.needsAttention) : view.rows;
  el('rows').replaceChildren(...shown.map(rowNode));

  const state = el('state');
  if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();

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
