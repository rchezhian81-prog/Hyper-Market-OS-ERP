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
function paintOffice() {
  if (office === null || !office.session.may.read) { el('office').hidden = true; return; }
  el('office').hidden = false;
  for (const [id, key] of [['office-heading', 'officeH'], ['office-branch-l', 'branch'], ['office-asof-l', 'asOf'], ['office-read-text', 'read'], ['o-alerts-h', 'alertsH'], ['o-assets-h', 'assetsH'], ['o-equipment-h', 'equipmentH'], ['o-downtime-h', 'downtimeH'], ['o-energy-h', 'energyH'], ['o-incidents-h', 'incidentsH']]) el(id).textContent = w(key);
  el('office-parts').hidden = read === null;
  if (read === null) return;
  const alerts = [...read.health.critical, ...read.health.other];
  el('o-alerts').replaceChildren(...(alerts.length === 0 ? [li(`✓ ${w('noAlerts')}`, 'ok')] : alerts.map((a) => li(`${a.criticality === 'critical' ? '✕' : '⚠'} ${a.name} — ${w(a.kind)}${a.daysRemaining !== undefined ? ` · ${a.daysRemaining} ${w('daysLeft')}` : ''}${a.daysOverdue !== undefined ? ` · ${a.daysOverdue} ${w('daysOver')}` : ''}`, a.criticality === 'critical' ? 'error' : 'degraded', { asset: a.assetId, kind: a.kind }))));
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
    const out = await office.session.read(el('office-branch').value, el('office-asof').value);
    if (out.result === 'ok') { read = out.value; el('office-status').textContent = `${w('read')} · ${read.asAt}`; } else el('office-status').textContent = office.outcomeWords(lang(), out);
    paintOffice();
  });
}
el('lang').addEventListener('click', () => { paintReadings(); paintOffice(); });
paintReadings(); paintOffice();
void syncReadings();
setInterval(() => { void syncReadings(); }, 15_000);
