// Waste & write-off review — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/waste-review-session.ts), attached as window.wasteSession, built on packages/ui + the
// tested packages/waste loss-type vocabulary. This file only draws what the session hands it: the day's
// losses, the material ones (which needed a second approval) first, each with a status that is never a bare
// colour (an icon + a word ride with it), the value, and whether evidence is on file. Read-only — nothing
// here records a write-off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Waste & write-off', lead: 'Sample losses. Connect the store computer to see your own.', langName: 'தமிழ்',
      attentionCount: 'needed approval', allClear: 'No material losses — nothing needed a second approval.', totalLoss: 'Total loss today',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'கழிவு & நீக்கம்', lead: 'மாதிரி இழப்புகள். உங்கள் சொந்தவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.', langName: 'English',
      attentionCount: 'ஒப்புதல் தேவைப்பட்டது', allClear: 'பெரிய இழப்புகள் இல்லை.', totalLoss: 'இன்றைய மொத்த இழப்பு',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const row = (productId, tone, icon, statusLabel, quantity, value, needsAttention, evidenceLabel) => ({
    id: productId, productId, status: { tone, icon, label: statusLabel, announcement: `${productId}: ${statusLabel}`, needsAttention },
    needsAttention, quantity, value, neededApproval: needsAttention, hasEvidence: needsAttention, evidenceLabel,
  });
  const rows = (l) => l === 'ta'
    ? [row('அரிசி 5kg', 'error', '✖', 'சேதம்', '4', '₹2,400.00', true, 'ஆதாரம் உள்ளது'),
       row('பால்', 'degraded', '⌛', 'காலாவதி', '6', '₹300.00', false, 'ஆதாரம் இல்லை')]
    : [row('Rice 5kg', 'error', '✖', 'Damage', '4', '₹2,400.00', true, 'Evidence on file'),
       row('Milk', 'degraded', '⌛', 'Expired', '6', '₹300.00', false, 'No evidence')];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const r = rows(l);
      return { screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        rows: r, attentionCount: r.filter((x) => x.needsAttention).length, total: r.length, totalValue: '₹2,700.00', nobodyNamed: false };
    },
  };
}

const real = window.wasteSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = { en: { filterAll: 'Show all', filterAttention: 'Only the material ones' }, ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'பெரியவை மட்டும்' } };
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const prod = document.createElement('span'); prod.className = 'prod'; prod.textContent = r.productId;
  const val = document.createElement('span'); val.className = 'val'; val.textContent = r.value;
  head.append(prod, val);
  li.append(head);

  const status = document.createElement('div');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  li.append(status);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const q = document.createElement('span'); q.textContent = r.quantity; meta.append(q);
  if (r.raisedBy) { const b = document.createElement('span'); b.textContent = r.raisedBy; meta.append(b); }
  li.append(meta);

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (r.neededApproval) { const b = document.createElement('b'); b.className = 'warn'; b.textContent = t('neededApproval'); badges.append(b); }
  const ev = document.createElement('b'); ev.className = r.hasEvidence ? '' : 'muted'; ev.textContent = r.evidenceLabel; badges.append(ev);
  if (badges.childNodes.length > 0) li.append(badges);

  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.wasteData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  el('attention-count').textContent = view.attentionCount === 0 ? t('allClear') : `${view.attentionCount} ${t('attentionCount')}`;
  el('total').innerHTML = '';
  el('total').append(document.createTextNode(`${t('totalLoss')}: `));
  const b = document.createElement('b'); b.textContent = view.totalValue; el('total').append(b);

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
