// Category rules — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/category-policy-session.ts), attached as window.categoryPolicySession, built on
// packages/ui + packages/product. This file only draws what the session hands it: the categories, the ones
// needing attention first, each with a status that is never a bare colour (an icon + a word ride with it),
// the rule summary and the controls/flags. Read-only — nothing here changes a rule. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Category rules', lead: 'Sample rules. Connect the store computer to see your own categories.', langName: 'தமிழ்',
      attentionCount: 'need attention', allClear: 'Every category’s rules are in force and clear.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'வகை விதிகள்', lead: 'மாதிரி விதிகள். உங்கள் சொந்த வகைகளைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'கவனம் தேவை', allClear: 'ஒவ்வொரு வகையின் விதிகளும் நடைமுறையில் உள்ளன.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (categoryId, tone, icon, statusLabel, controls, needsAttention) => ({
    categoryId, status: { tone, icon, label: statusLabel, announcement: `${categoryId}: ${statusLabel}`, needsAttention },
    needsAttention, inForce: true, summary: { trace: '—', quantity: '—', valuation: '—' }, controls, flags: [], detail: '',
  });
  const rows = (l) => l === 'ta'
    ? [row('தங்கம்', 'degraded', '⚠', 'கட்டுப்படுத்தப்பட்டது', ['அணைக்கப்பட்டது'], true), row('மளிகை', 'ok', '✓', 'நடைமுறையில்', ['சிறப்புக் கட்டுப்பாடுகள் இல்லை'], false)]
    : [row('gold', 'degraded', '⚠', 'Controlled — needs setup', ['Shipped OFF'], true), row('grocery', 'ok', '✓', 'In force', ['No special controls'], false)];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false }, categories: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, nobodyNamed: false };
    },
  };
}

const real = window.categoryPolicySession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = { en: { filterAll: 'Show all', filterAttention: 'Only the ones needing attention' }, ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்' } };
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

function rowNode(c) {
  const li = document.createElement('li');
  li.className = `row tone-${c.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const cat = document.createElement('span'); cat.className = 'cat'; cat.textContent = c.categoryId;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = c.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = c.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', c.status.announcement || c.status.label);
  head.append(cat, status);
  li.append(head);

  if (c.summary) {
    const sum = document.createElement('div');
    sum.className = 'summary-line';
    for (const v of [c.summary.trace, c.summary.quantity, c.summary.valuation]) {
      const s = document.createElement('span'); s.textContent = v; sum.append(s);
    }
    li.append(sum);
  }

  const badges = document.createElement('div');
  badges.className = 'badges';
  for (const ctrl of c.controls) { const b = document.createElement('b'); b.textContent = ctrl; badges.append(b); }
  for (const flag of c.flags) { const b = document.createElement('b'); b.className = 'flag'; b.textContent = flag; badges.append(b); }
  if (badges.childNodes.length > 0) li.append(badges);

  if (c.detail) { const d = document.createElement('p'); d.className = 'detail'; d.textContent = c.detail; li.append(d); }
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.categoryPolicyData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  el('attention-count').textContent = view.attentionCount === 0 ? t('allClear') : `${view.attentionCount} ${t('attentionCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.categories.filter((c) => c.needsAttention) : view.categories;
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
