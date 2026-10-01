// Products nobody can sell — the view layer (SP-8c-ii · F08 · P-08 · M03-FR-03 · M10-FR-04). Every rule and every word
// lives in the TESTED session model (apps/web-erp/src/unsellable-session.ts), attached as `window.unsellableSession`; this
// file renders what `session.view(lang)` hands over and decides nothing. Read-only: no write, no fetch, no timer, no dialog.
//
// Every group reads as a state — a tone AND an icon AND a word, never colour alone — and recall comes first: a safety block
// before a catalogue gap.

const el = (id) => document.getElementById(id);

const real = window.unsellableSession;

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  const words = {
    en: { title: 'Products nobody can sell', lead: 'Sample data — this is not your shop.', asOf: 'From the catalogue the store computer received', sellable: 'products the till can sell' },
    ta: { title: 'யாரும் விற்க முடியாத பொருட்கள்', lead: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', asOf: 'கடைக் கணினி பெற்ற பட்டியலின்படி', sellable: 'கல்லா விற்கக்கூடிய பொருட்கள்' },
  };
  return {
    text: (lang, key) => words[lang]?.[key] ?? words.en[key] ?? key,
    view: (lang) => ({
      screenState: { tone: 'idle', icon: '—', label: lang === 'ta' ? 'மாதிரித் தகவல்' : 'Sample data', announcement: '', needsAttention: false },
      asOf: null, count: 1, countLabel: lang === 'ta' ? 'யாரும் விற்க முடியாத பொருள் 1' : '1 product nobody can sell', sellableCount: 11,
      groups: [{
        reason: 'no_tax_rate', label: lang === 'ta' ? 'பட்டியலில் வரி விகிதம் இல்லை' : 'No tax rate on the catalogue', whatToDo: lang === 'ta' ? 'வரி வகுப்பு கொடுங்கள்.' : 'Give the product a tax class.',
        rows: [{ status: { tone: 'degraded', icon: '⚠', label: 'No tax rate', announcement: '', needsAttention: true }, productId: 'P-SAMPLE', name: lang === 'ta' ? 'மாதிரிப் பொருள்' : 'Sample product', reason: 'no_tax_rate', reasonLabel: '', whatToDo: '', detail: 'no tax rate on the catalogue' }],
      }],
      rows: [],
    }),
  };
}
const session = real ?? sampleSession();

let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const t = (key) => session.text(lang, key);

function paint() {
  const view = session.view(lang);
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.unsellableData?.storeId ?? '';
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('asof').textContent = view.asOf ? `${t('asOf')} · ${new Date(view.asOf).toLocaleString()}` : '';
  el('summary').textContent = view.count === 0 ? '' : view.sellableCount === null ? view.countLabel : `${view.countLabel} · ${view.sellableCount} ${t('sellable')}`;

  const state = el('state');
  state.hidden = false;
  state.className = `state tone-${view.screenState.tone}`;
  el('state-icon').textContent = view.screenState.icon;
  el('state-text').textContent = view.screenState.label;
  state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);

  el('groups').replaceChildren(...view.groups.map((g) => {
    const section = document.createElement('section');
    section.className = `group tone-${g.rows[0]?.status.tone ?? 'degraded'}`;
    section.dataset.reason = g.reason;
    const head = document.createElement('div'); head.className = 'head';
    const status = document.createElement('span'); status.className = 'status';
    status.setAttribute('aria-label', g.rows[0]?.status.announcement || g.label);
    const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = g.rows[0]?.status.icon ?? '⚠'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = g.label;
    status.append(icon, label);
    const n = document.createElement('span'); n.className = 'asof'; n.textContent = String(g.rows.length);
    head.append(status, n);
    const todo = document.createElement('p'); todo.className = 'todo';
    const todoHead = document.createElement('strong'); todoHead.textContent = `${t('whatToDo')}: `;
    todo.append(todoHead, document.createTextNode(g.whatToDo));
    const rows = document.createElement('ul'); rows.className = 'rows';
    rows.append(...g.rows.map((r) => {
      const li = document.createElement('li'); li.className = 'row'; li.dataset.productId = r.productId; li.dataset.reason = r.reason;
      const name = document.createElement('div'); name.className = 'name'; name.textContent = r.name;
      const id = document.createElement('span'); id.className = 'id'; id.textContent = r.productId; name.append(id);
      const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = `${t('record')}: ${r.detail}`;
      li.append(name, detail);
      return li;
    }));
    section.append(head, todo, rows);
    return section;
  }));
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paint();
});

el('sample').hidden = real !== undefined;
el('sample').textContent = real === undefined ? session.text(lang, 'lead') : '';
paint();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
