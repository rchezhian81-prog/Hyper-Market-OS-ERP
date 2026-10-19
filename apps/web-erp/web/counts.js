// Stock-count review — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/counts-session.ts), attached as window.countsSession, built on packages/ui + the tested
// packages/counts reconciliation. This file only draws what the session hands it: the day's reconciled blind
// counts, the material variances (which needed a second approval) first, each with a status that is never a
// bare colour (an icon + a word ride with it), the direction and value at variance, and the counted vs system
// quantities. Read-only — nothing here reconciles a count. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Stock counts', lead: 'Sample counts. Connect the store computer to see your own.', langName: 'தமிழ்',
      attentionCount: 'needed approval', allClear: 'No material variances — nothing needed a second approval.', totalVariance: 'Value at variance today',
      // OB-205: the sample once showed the bare key "neededApproval"; it carries the session's own words now.
      neededApproval: 'Needed approval', approvedByLabel: 'Approved by', counterLabel: 'Counted by', valueNotKnown: 'Value not known',
      sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'சரக்கு எண்ணிக்கை', lead: 'மாதிரி எண்ணிக்கைகள். உங்கள் சொந்தவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய வேறுபாடுகள் இல்லை.', totalVariance: 'இன்று வேறுபட்ட மதிப்பு',
      neededApproval: 'ஒப்புதல் தேவைப்பட்டது', approvedByLabel: 'ஒப்புதல் அளித்தவர்', counterLabel: 'எண்ணியவர்', valueNotKnown: 'மதிப்பு தெரியவில்லை',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const row = (productId, tone, icon, statusLabel, variance, value, counted, expected, needsAttention) => ({
    id: productId, productId, status: { tone, icon, label: statusLabel, announcement: `${productId}: ${statusLabel}`, needsAttention },
    needsAttention, variance, value, counted, expected, neededApproval: needsAttention,
  });
  const rows = (l) => l === 'ta'
    ? [row('அரிசி 5kg', 'error', '▼', 'குறைவு', '-4 ea', '₹2,400.00', '16 ea', '20 ea', true),
       row('பால்', 'degraded', '▲', 'அதிகம்', '+2 ea', '₹120.00', '14 ea', '12 ea', false)]
    : [row('Rice 5kg', 'error', '▼', 'Short', '-4 ea', '₹2,400.00', '16 ea', '20 ea', true),
       row('Milk', 'degraded', '▲', 'Over', '+2 ea', '₹120.00', '14 ea', '12 ea', false)];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        rows: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, totalValue: '₹2,520.00', nobodyNamed: false };
    },
  };
}

const real = window.countsSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = {
  en: { filterAll: 'Show all', filterAttention: 'Only the material ones', counted: 'Counted', system: 'System',
    colProd: 'Product', colStatus: 'Where it stands', colVariance: 'Difference', colValue: 'Value' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'பெரியவை மட்டும்', counted: 'எண்ணப்பட்டது', system: 'கணினி',
    colProd: 'பொருள்', colStatus: 'நிலை', colVariance: 'வேறுபாடு', colValue: 'மதிப்பு' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

/** OB-205: a shape from the one icon set (sre-icons.js), or null when the set is not loaded. */
const lineIcon = (name, size) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
/** A tone's shape, with the session's glyph only if the set is missing. */
function toneMark(holder, tone, glyph) {
  const mark = window.sreIcon && typeof window.sreIcon.forTone === 'function' ? lineIcon(window.sreIcon.forTone(tone), 16) : null;
  if (mark) holder.replaceChildren(mark); else holder.textContent = glyph ?? '';
}
/** A cell's own word for a screen reader (and, on a phone, for the eye) — the register's caption, kept with the figure. */
function captioned(className, caption, value) {
  const cell = document.createElement('span'); cell.className = className;
  const cap = document.createElement('span'); cap.className = 'sr-cap'; cap.textContent = `${caption} `;
  cell.append(cap, document.createTextNode(value));
  return cell;
}

/** One count: product, where it stands (a chip — shape + word), counted and system quantities, the difference and its
 *  value — each in its own column, right-aligned in tabular figures. A count without a value says "Value not known". */
function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const prod = document.createElement('span'); prod.className = 'prod'; prod.textContent = r.productId;

  const status = document.createElement('span');
  status.className = 'status sre-chip';
  status.dataset.tone = r.status.tone;
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); toneMark(icon, r.status.tone, r.status.icon);
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const notKnown = r.value === t('valueNotKnown');
  const val = document.createElement('span');
  val.className = notKnown ? 'val unknown' : 'val';
  const mark = notKnown ? lineIcon('circle-help', 16) : null;
  if (mark) val.append(mark);
  val.append(document.createTextNode(r.value));

  li.append(prod, status,
    captioned('q', vw('counted'), r.counted),
    captioned('q', vw('system'), r.expected),
    captioned('q var', vw('colVariance'), r.variance),
    val);

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (r.neededApproval) { const b = document.createElement('b'); b.className = 'warn'; b.textContent = t('neededApproval'); meta.append(b); }
  if (r.approvedBy) { const b = document.createElement('b'); b.className = 'muted'; b.textContent = `${t('approvedByLabel')}: ${r.approvedBy}`; meta.append(b); }
  if (r.counterId) { const b = document.createElement('span'); b.textContent = `${t('counterLabel')}: ${r.counterId}`; meta.append(b); }
  if (meta.childNodes.length > 0) li.append(meta);

  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  // OB-205: the page's one heading (the header line) speaks the reader's language too.
  el('who').firstChild.textContent = `${t('title')} `;
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.countsData?.userId ?? '';
  el('lang').textContent = t('langName');
  const filterWords = document.createElement('span');
  filterWords.textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  const filterMark = lineIcon(attentionOnly ? 'list' : 'triangle-alert', 18);
  el('filter').replaceChildren(...(filterMark ? [filterMark] : []), filterWords);
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');
  el('col-prod').textContent = vw('colProd');
  el('col-status').textContent = vw('colStatus');
  el('col-counted').textContent = vw('counted');
  el('col-system').textContent = vw('system');
  el('col-variance').textContent = vw('colVariance');
  el('col-value').textContent = vw('colValue');

  // The summary panel: the figure large, its words under it (the words still read in the same order).
  const count = el('attention-count');
  el('attention-stat').dataset.tone = view.attentionCount === 0 ? 'ok' : 'error';
  if (view.attentionCount === 0) {
    count.className = 'count clear sre-with-icon';
    const ok = lineIcon('circle-check', 20);
    const words = document.createElement('span'); words.textContent = t('allClear');
    count.replaceChildren(...(ok ? [ok] : []), words);
  } else {
    count.className = 'count attention';
    const n = document.createElement('b'); n.className = 'n'; n.textContent = String(view.attentionCount);
    const l = document.createElement('span'); l.className = 'l'; l.textContent = t('attentionCount');
    count.replaceChildren(n, document.createTextNode(' '), l);
  }
  const label = document.createElement('span'); label.className = 'l'; label.textContent = t('totalVariance');
  const colon = document.createElement('span'); colon.className = 'sr-only'; colon.textContent = ': ';
  const b = document.createElement('b'); b.className = 'n'; b.textContent = view.totalValue;
  el('total').replaceChildren(label, colon, b);

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

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
paint();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
