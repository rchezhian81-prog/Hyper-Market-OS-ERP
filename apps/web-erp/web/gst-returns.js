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
    en: { title: 'GST returns', lead: 'Sample filing periods. Connect the store computer to see your own returns.', langName: 'தமிழ்', tcsLine: 'TCS (section 52): not applicable: own goods only',
      attentionCount: 'need attention', allClear: 'Every return is settled — nothing needs attention.',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'GST வருமானங்கள்', tcsLine: 'TCS (பிரிவு 52): பொருந்தாது: கடையின் சொந்தப் பொருட்கள் மட்டும்', lead: 'மாதிரி தாக்கல் காலங்கள். உங்கள் சொந்த வருமானங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வருமானமும் தீர்க்கப்பட்டது.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
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
const VIEW_WORDS = {
  en: { filterAll: 'Show all', filterAttention: 'Only the ones needing attention',
    colPeriod: 'Month', colStatus: 'Where it stands', colAction: 'What to do next', colWho: 'Reference and people' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்',
    colPeriod: 'மாதம்', colStatus: 'நிலை', colAction: 'அடுத்து செய்ய வேண்டியது', colWho: 'குறிப்பும் நபர்களும்' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

/** OB-205: a shape from the one icon set (sre-icons.js), or null when the set is not loaded. */
const lineIcon = (name, size) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
/** A tone's shape, with the session's glyph only if the set is missing. */
function toneMark(holder, tone, glyph) {
  const mark = window.sreIcon && typeof window.sreIcon.forTone === 'function' ? lineIcon(window.sreIcon.forTone(tone), 16) : null;
  if (mark) holder.replaceChildren(mark); else holder.textContent = glyph ?? '';
}

/** One filing period: the month, where it stands (a chip — shape + word), the next step with its button, and the
 *  portal reference and the people — each in its own column under the register's captions. */
function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const period = document.createElement('span'); period.className = 'period'; period.textContent = r.period;
  const status = document.createElement('span');
  status.className = 'status sre-chip';
  status.dataset.tone = r.status.tone;
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); toneMark(icon, r.status.tone, r.status.icon);
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  li.append(period, status);

  const action = document.createElement('div');
  action.className = 'action';
  const guidance = document.createElement('span');
  guidance.textContent = r.actionLabel;
  action.append(guidance);

  // The governance acts. The MODEL decides which rows offer one and whether it is enabled (right role, maker ≠ checker,
  // a live list, nothing already on its way) — this only draws the button (with the reason or evidence fields an act
  // needs) and, on click, hands the intent to the session, which sends it to head office ONCE. It never calls the
  // portal. A rejected or in-flight return carries no act (hard rule #10).
  for (const a of r.actions ?? []) {
    const wrap = document.createElement('div');
    wrap.className = 'do';
    wrap.dataset.act = a.action;
    const fields = {};
    const input = (key, labelKey) => {
      const label = document.createElement('label'); label.className = 'do-field';
      const span = document.createElement('span'); span.textContent = t(labelKey);
      const box = document.createElement('input'); box.autocomplete = 'off'; box.name = key; box.disabled = !a.enabled;
      label.append(span, box); wrap.append(label); fields[key] = box;
    };
    if (a.needs === 'reason') input('reason', 'reasonLabel');
    // OB-683: the ARN the GST portal showed when the person uploaded the approved return by hand.
    if (a.needs === 'arn') input('arn', 'arnRequired');
    if (a.needs === 'evidence') {
      const label = document.createElement('label'); label.className = 'do-field';
      const span = document.createElement('span'); span.textContent = t('resolvedLabel');
      const pick = document.createElement('select'); pick.name = 'resolvedState'; pick.disabled = !a.enabled;
      for (const [value, key] of [['', 'resolvedLabel'], ['filed', 'resolvedFiled'], ['failed', 'resolvedFailed']]) {
        const o = document.createElement('option'); o.value = value; o.textContent = value === '' ? '—' : t(key); pick.append(o);
      }
      label.append(span, pick); wrap.append(label); fields.resolvedState = pick;
      input('note', 'evidenceLabel');
      input('arn', 'arnOptional');
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'do-btn sre-btn';
    btn.textContent = a.label;
    btn.disabled = !a.enabled; whyDisabled(btn, a.enabled ? '' : 'role');
    btn.addEventListener('click', () => runAction(a, fields, btn));
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

  // The reference column is always there, so the columns line up; it is empty only when the box knows no one yet.
  const who = document.createElement('div');
  who.className = 'who-line';
  if (r.arn) { const s = document.createElement('span'); s.className = 'arn'; s.textContent = r.arn; who.append(s); }
  if (r.preparedBy) { const s = document.createElement('span'); s.textContent = r.preparedBy; who.append(s); }
  if (r.approvedByName) { const s = document.createElement('span'); s.textContent = r.approvedByName; who.append(s); }
  li.append(who);
  // OB-683: a return filed by hand on the portal says so, with the ARN and the name of the person who recorded it.
  if (r.filedByHand) { const p = document.createElement('p'); p.className = 'filed-by-hand'; p.dataset.arn = r.filedByHand.arn; p.textContent = r.filedByHand.line; li.append(p); }

  if (r.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = r.detail; li.append(d); }
  return li;
}

/** The answer to the last act, in the reader's language (head office's own sentence when it refused). */
function tellResult(result) {
  const line = el('act-result');
  line.hidden = false;
  line.className = `answer-line tone-${result.ok ? 'ok' : 'error'}`;
  line.textContent = real.resultWords(lang, result);
}

/**
 * Ask the session to run a governance act. The session re-checks the guards (right role, maker ≠ checker, a live list,
 * a reason or evidence typed) and sends it to head office once — this file never touches the network itself. Only the
 * real session can act; the sample stand-in offers no buttons.
 */
async function runAction(a, fields, btn) {
  if (!real || typeof real.act !== 'function') return;
  btn.disabled = true;
  const value = (k) => (fields[k] === undefined ? undefined : fields[k].value);
  const result = await real.act({ period: a.period, action: a.action, reason: value('reason'), resolvedState: value('resolvedState') || undefined, note: value('note'), arn: value('arn') });
  tellResult(result);
  paint();
}

/** The maker prepares a month for approval (head office records its own digest of the month's figures). */
async function prepare(event) {
  event.preventDefault();
  if (!real || typeof real.prepare !== 'function') return;
  el('prepare-btn').disabled = true;
  const result = await real.prepare(el('prepare-period').value);
  el('prepare-btn').disabled = false;
  tellResult(result);
  paint();
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  // OB-205: the page's one heading (the header line) speaks the reader's language too.
  el('who').firstChild.textContent = `${t('title')} `;
  el('lead').textContent = t('lead');
  // R4 Lane 2 · A26 · OB-211: the shop sells its own goods only, so no TCS under CGST s.52 arises — said in the reader's language.
  if (el('tcs-line')) el('tcs-line').textContent = t('tcsLine');
  el('whoami').textContent = window.gstReturnsData?.userId ?? '';
  el('lang').textContent = t('langName');
  const filterWords = document.createElement('span');
  filterWords.textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  const filterMark = lineIcon(attentionOnly ? 'list' : 'triangle-alert', 18);
  el('filter').replaceChildren(...(filterMark ? [filterMark] : []), filterWords);
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');
  el('col-period').textContent = vw('colPeriod');
  el('col-status').textContent = vw('colStatus');
  el('col-action').textContent = vw('colAction');
  el('col-who').textContent = vw('colWho');

  // The summary: the count large with its words (read in the same order), the shape of the day's state beside it.
  const count = el('attention-count');
  count.className = 'count attention sre-with-icon';
  el('summary').dataset.tone = view.attentionCount === 0 ? 'ok' : 'degraded';
  const countMark = lineIcon(view.attentionCount === 0 ? 'circle-check' : 'triangle-alert', 22);
  if (view.attentionCount === 0) {
    const words = document.createElement('span'); words.textContent = t('allClear');
    count.replaceChildren(...(countMark ? [countMark] : []), words);
  } else {
    const n = document.createElement('b'); n.className = 'n'; n.textContent = String(view.attentionCount);
    const words = document.createElement('span'); words.textContent = t('attentionCount');
    count.replaceChildren(...(countMark ? [countMark] : []), n, document.createTextNode(' '), words);
  }

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  // W5: where the list came from, said in words — live from head office, or the box's last copy (never acted on).
  const live = el('live-line');
  const liveWords = view.source === 'box' ? [t('fromBox'), view.liveProblem ?? ''].join(' ').trim() : view.liveProblem ?? '';
  live.hidden = real === undefined || liveWords === '';
  live.textContent = liveWords;
  live.dataset.source = view.source ?? 'none';
  const unsent = el('unsent-line');
  unsent.hidden = view.unsentEarlier === undefined;
  unsent.textContent = view.unsentEarlier ?? '';
  // The maker's form: prepare a month for approval — offered to whoever head office lets prepare (OB-192: not the CA).
  el('prepare').hidden = !view.mayPrepare;
  el('prepare-label').textContent = t('periodLabel');
  el('prepare-btn').textContent = t('btnPrepare');

  const shown = attentionOnly ? view.rows.filter((r) => r.needsAttention) : view.rows;
  el('rows').replaceChildren(...shown.map(rowNode));

  const state = el('state');
  el('register').hidden = shown.length === 0;
  if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    toneMark(el('state-icon'), view.screenState.tone, view.screenState.icon);
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
el('prepare').addEventListener('submit', (event) => { void prepare(event); });
if (window.sreShopDay !== undefined && el('prepare-period').value === '') {
  const ym = window.sreShopDay.lastMonth(); // the shop's own calendar (OB-606), never this browser's zone
  el('prepare-period').value = `${ym.slice(5, 7)}${ym.slice(0, 4)}`;
}
paint();
// W5: the filing list is read live from head office (the session asks; this file never fetches itself).
if (real !== undefined && typeof real.load === 'function') void real.load().then(paint);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
