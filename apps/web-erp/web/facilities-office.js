// The facilities page's office parts (M26-FR-01/02/04) — drawn beside the maintenance list (facilities.js). The
// sessions (apps/web-erp/src/facilities-office-session.ts) are in the bundle as window.facilitiesOffice (the office
// read, head office's) and window.equipmentReadingQueue (the manual readings, saved here and carried by the store
// computer). This file only draws what they say. The office read changes nothing. Every word has a Tamil twin.

const el = (id) => document.getElementById(id);
const office = window.facilitiesOffice ?? null;
const rq = window.equipmentReadingQueue ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (office !== null ? office.words(lang(), k) : rq !== null ? rq.text(lang(), k) : k);
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function li(words, tone, data) { const n = document.createElement('li'); n.className = `row tone-${tone}`; n.append(text('span', words, 'headline')); for (const [k, v] of Object.entries(data ?? {})) n.dataset[k] = v; return n; }

// ── Manual readings, through the store computer ──
function field(words, control) { const l = document.createElement('label'); l.append(text('span', words), control); return l; }
function paintReadings() {
  if (rq === null) { el('eq').hidden = true; return; }
  const v = rq.view(lang());
  el('eq').hidden = false;
  el('eq-heading').textContent = w('readingH'); el('eq-lead').textContent = w('readingLead'); el('eq-asof').textContent = v.asAtWords;
  el('eq-rows').replaceChildren(...v.rows.map((row) => {
    const item = document.createElement('li'); item.className = 'row tone-idle'; item.dataset.asset = row.assetId;
    item.append(text('span', `${row.name} (${row.assetId})`, 'headline'), text('span', `${row.rangeWords} · ${row.lastWords}`, 'saved'));
    for (const s of row.saved) { const d = text('div', s.words, 'saved'); d.dataset.state = s.state; item.append(d); if (s.reason) item.append(text('div', s.reason, 'exc')); }
    if (rq.canRecord) {
      const form = document.createElement('form');
      const reading = document.createElement('input'); reading.className = 'eq-reading'; reading.inputMode = 'decimal'; reading.autocomplete = 'off';
      const source = document.createElement('select'); source.className = 'eq-source';
      for (const k of ['manual_probe', 'log_sheet']) { const o = document.createElement('option'); o.value = k; o.textContent = w(k); source.append(o); }
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'eq-save'; const i = icon('thermometer'); if (i !== null) save.append(i); save.append(text('span', w('save')));
      form.append(field(w('temperature'), reading), field(w('source'), source), save);
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const out = rq.record(lang(), { assetId: row.assetId, reading: reading.value, source: source.value });
        el('eq-result').hidden = false; el('eq-result-icon').textContent = out.ok ? '✓' : '✕'; el('eq-result-text').textContent = out.ok ? w('stSavedHere') : out.words;
        paintReadings(); void syncReadings();
      });
      item.append(form);
    }
    return item;
  }));
}
async function syncReadings() {
  const relay = window.equipmentReadingRelay;
  if (!relay) return;
  try { await relay.syncNow(); } catch { /* kept on this device; the next pass tries again */ }
  paintReadings();
}

// ── The office read, from head office ──
let read = null;
const rupees = (m) => (office === null ? String(m) : office.rupees(m));
const deg = (t) => (office === null ? String(t) : office.degrees(t));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = el(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = el(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : (el(id)?.value ?? ''));

// U2 · G5 (UI/UX gap audit): the signed-in person's own store is filled in from the store computer (`sreOffice.me`) —
// the id stays what the page sends, the store's NAME is said beside it, and a person who may hold more than one store can
// still change it. Off the box, or before the chrome has loaded, nothing is filled in.
function ownStore(inputId) {
  const me = window.sreOffice?.me?.() ?? null;
  const input = el(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; input.after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${w('yourStore')}`;
}
function paintOffice() {
  repaintShopDates();

  ownStore('office-branch');
  if (office === null || !office.session.may.read) { el('office').hidden = true; return; }
  el('office').hidden = false;
  for (const [id, key] of [['office-heading', 'officeH'], ['office-branch-l', 'branch'], ['office-asof-l', 'asOf'], ['office-read-text', 'read'], ['o-alerts-h', 'alertsH'], ['o-assets-h', 'assetsH'], ['o-equipment-h', 'equipmentH'], ['o-downtime-h', 'downtimeH'], ['o-energy-h', 'energyH'], ['o-incidents-h', 'incidentsH']]) { const n = el(id); if (n) n.textContent = w(key); }
  el('office-parts').hidden = read === null;
  if (read === null) return;
  const alerts = [...read.health.critical, ...read.health.other];
  // Round 4d (M26-FR-01): a spare part below the level wanted is a warning beside the asset alerts
  const lowSpares = (office.lowSpareLines?.(lang(), read) ?? []).map((s) => li(`⚠ ${s.words}`, 'degraded', { spare: s.sparePartId }));
  el('o-alerts').replaceChildren(...lowSpares, ...(alerts.length === 0 && lowSpares.length === 0 ? [li(`✓ ${w('noAlerts')}`, 'ok')] : alerts.map((a) => li(`${a.criticality === 'critical' ? '✕' : '⚠'} ${a.name} — ${w(a.kind)}${a.daysRemaining !== undefined ? ` · ${a.daysRemaining} ${w('daysLeft')}` : ''}${a.daysOverdue !== undefined ? ` · ${a.daysOverdue} ${w('daysOver')}` : ''}`, a.criticality === 'critical' ? 'error' : 'degraded', { asset: a.assetId, kind: a.kind }))));
  el('o-assets').replaceChildren(...(read.assets.length === 0 ? [li(w('none'), 'idle')] : read.assets.map((a) => li(`${a.name} (${a.assetId}) · ${w(a.criticality)} · ${w('warranty')} ${a.warrantyUntil ?? w('notRecorded')} · ${w('amc')} ${a.amcUntil ?? w('notRecorded')} · ${w('lastService')} ${a.lastServicedOn ?? w('never')}`, 'idle', { asset: a.assetId }))));
  el('o-equipment').replaceChildren(...(read.equipment.length === 0 ? [li(w('none'), 'idle')] : read.equipment.map((e) => {
    const st = e.assessment.state;
    return li(`${st === 'within_range' ? '✓' : st === 'drifting' ? '⚠' : '✕'} ${e.name} — ${w(st)} · ${w('range')} ${deg(e.range.minTenthsC)} – ${deg(e.range.maxTenthsC)} · ${w('last')} ${e.lastReading === null ? w('never') : `${deg(e.lastReading.tenthsC)} ${e.lastReading.at}`}${e.assessment.minutesOutOfRange > 0 ? ` · ${e.assessment.minutesOutOfRange} ${w('minutesOut')}` : ''}`, st === 'within_range' ? 'ok' : st === 'drifting' ? 'degraded' : 'error', { asset: e.assetId, state: st });
  })));
  el('o-downtime').replaceChildren(...(read.downtime.length === 0 ? [li(w('none'), 'idle')] : read.downtime.map((d) => li(`${d.name}: ${d.events} ${w('events')} · ${d.totalMinutes} ${w('minutes')} · ${d.unreportedMinutes} ${w('unreported')}${d.stillDown ? ` · ✕ ${w('stillDown')}` : ''}`, d.stillDown ? 'error' : 'idle', { asset: d.assetId }))));
  const e = read.energy;
  el('o-energy').textContent = `${e.kilowattHours} ${w('kwh')} · ${w('cost')} ${rupees(e.costMinor)} · ${w('estimated')} ${e.estimatedShareBps === 'not_meaningful' ? w('notMeaningful') : `${(e.estimatedShareBps / 100).toFixed(1)}%`} · ${w('perDay')} ${e.perDayCostMinor === 'not_meaningful' ? w('notMeaningful') : rupees(e.perDayCostMinor)}`;
  el('o-incidents').replaceChildren(...(read.incidents.length === 0 ? [li(w('none'), 'idle')] : read.incidents.map((i) => li(`${i.open ? `⚠ ${w('open')}` : `✓ ${w('closed')}`} · ${i.kind} · ${i.severity} · ${i.occurredAt} · ${i.description} · ${w('evidence')} ${i.evidence}`, i.open ? 'degraded' : 'ok', { incident: i.incidentId }))));
}
if (office !== null && office.session.may.read) {
  const i = icon('search'); if (i !== null) el('office-read').prepend(i);
  if (office.storeId) el('office-branch').value = office.storeId;
  el('office-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = await office.session.read(el('office-branch').value, dateOf('office-asof'));
    if (out.result === 'ok') { read = out.value; el('office-status').textContent = `${w('read')} · ${read.asAt}`; } else el('office-status').textContent = office.outcomeWords(lang(), out);
    paintOffice();
  });
}
el('lang').addEventListener('click', () => { paintReadings(); paintOffice(); });
paintReadings(); paintOffice();
void syncReadings();
setInterval(() => { void syncReadings(); }, 15_000);
// the chrome (and `sreOffice.me`) loads after this script: fill the store in once it is there
document.addEventListener('sre:chrome', () => { if (office !== null) shopDate('office-asof', { en: office.words('en', 'asOf'), ta: office.words('ta', 'asOf') }); paintOffice(); }, { once: true });
