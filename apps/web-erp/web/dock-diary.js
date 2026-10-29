// Dock diary (M07-FR-01 · WF-04 · QG-02) — the page over head office's own dock diary. The session
// (apps/web-erp/src/dock-diary-session.ts, in the bundle as window.dockDiary) does every call; this page lays out what it
// is told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button carries an icon.

const $ = (id) => document.getElementById(id);
const api = window.dockDiary ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, book: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
// OB-607: a slot's day and time are the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const hhmm = (iso) => window.sreShopDay?.dateTimeOf(iso) || iso;
let day = null;

const ACTS = { arrived: ['arrived', 'truck'], completed: ['completed', 'check'], no_show: ['noShow', 'x'], cancelled: ['cancel', 'rotate-ccw'] };

function paintDay() {
  const ul = $('day-rows'); ul.replaceChildren();
  const late = $('late-rows'); late.replaceChildren();
  $('late-h').hidden = day === null;
  if (day === null) return;
  if (day.bookings.length === 0) ul.append(text('li', `○ ${t('none')}`));
  const lateIds = new Set(day.late.map((l) => l.slotId));
  for (const b of day.bookings) {
    const li = document.createElement('li'); li.dataset.slot = b.slotId; li.dataset.status = b.status;
    if (lateIds.has(b.slotId)) li.className = 'attention';
    const state = lateIds.has(b.slotId) ? `⚠ ${t('late')}` : t(`s_${b.status}`);
    li.append(text('strong', `${t('door')} ${b.dockId} · ${hhmm(b.startsAt)} – ${hhmm(b.endsAt)} · ${state}`));
    li.append(text('span', [b.supplierId === undefined ? '' : `${t('supplier')}: ${b.supplierId}`, (b.poIds ?? []).length === 0 ? '' : (b.poIds ?? []).join(', '), `${t('bookedBy')} ${b.bookedBy}`].filter((x) => x !== '').join(' · '), 'meta'));
    const last = b.history[b.history.length - 1];
    if (last !== undefined && last.reason !== undefined) li.append(text('span', last.reason, 'meta'));
    if (may.book) {
      const acts = document.createElement('div'); acts.className = 'acts';
      for (const next of api.next[b.status]) {
        const [key, ic] = ACTS[next];
        const btn = button(t(key), ic, next === 'arrived' || next === 'completed' ? '' : 'quiet'); btn.dataset.act = next;
        btn.addEventListener('click', async () => {
          const out = await session.setStatus(b.slotId, next, $('d-reason').value);
          say('d-status', out);
          if (out.result === 'ok') await showDay();
        });
        acts.append(btn);
      }
      if (acts.childElementCount > 0) li.append(acts);
    }
    ul.append(li);
  }
  if (day.late.length === 0) late.append(text('li', `✓ ${t('noneLate')}`));
  for (const l of day.late) { const li = text('li', `⚠ ${t('door')} ${l.dockId} · ${l.supplierId ?? '—'} · ${hhmm(l.endedAt)}`); li.dataset.late = l.slotId; late.append(li); }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['day-h', 'title'], ['d-store-l', 'store'], ['d-date-l', 'date'], ['d-show-text', 'show'], ['d-reason-l', 'reason'], ['late-h', 'lateH'],
    ['book-h', 'bookH'], ['b-store-l', 'store'], ['b-door-l', 'door'], ['b-from-l', 'from'], ['b-until-l', 'until'], ['b-supplier-l', 'supplier'], ['b-orders-l', 'orders'], ['b-book-text', 'book']]) $(id).textContent = t(key);
  $('day-h').textContent = t('dayH');
  paintDay();
}
async function showDay() {
  const out = await session.day($('d-store').value, $('d-date').value);
  if (out.result !== 'ok') { day = null; say('d-status', out); paintDay(); return; }
  day = out.value; $('d-status').textContent = ''; paintDay();
}

for (const [id, name] of [['d-show', 'search'], ['b-book', 'calendar']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('day').hidden = false;
  $('d-show').addEventListener('click', () => { void showDay(); });
  if (may.book) {
    $('book').hidden = false;
    $('b-book').addEventListener('click', async () => {
      const out = await session.book({ storeId: $('b-store').value, dockId: $('b-door').value, startsAt: $('b-from').value, endsAt: $('b-until').value, supplierId: $('b-supplier').value, poIds: $('b-orders').value });
      say('b-status', out);
      if (out.result === 'ok' && $('d-store').value.trim() !== '') await showDay();
    });
  }
}
