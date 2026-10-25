// Trial switches and shop account (OB-288 P4 · R8-9 · OB-316 · M36-FR-01 · OB-321 · C8 · C9 · OB-324) — the page over head
// office's routes. The session (apps/web-erp/src/rollout-session.ts, in the bundle as window.rollout) does every call; this
// page lays out what it is told. Every word has a Tamil twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.rollout ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, change: false, meter: false, watch: false, consent: false, closure: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let board = null; let meter = null; let watch = null; let history = null; let closure = null;

const placeWords = (row) => (row.laneId === null || row.laneId === undefined ? `${row.branchId} · ${t('wholeBranch')}` : `${row.branchId} · ${t('lane')} ${row.laneId}`);
const placeOf = (row) => ({ branchId: row.branchId, ...(row.laneId === null || row.laneId === undefined ? {} : { laneId: row.laneId }) });

function paintBoard() {
  const body = $('board-rows'); body.replaceChildren();
  if (board === null) return;
  if (board.switches.length === 0) { const tr = document.createElement('tr'); const td = text('td', t('boardNone')); td.colSpan = 7; tr.append(td); body.append(tr); }
  for (const r of board.switches) {
    const tr = document.createElement('tr'); tr.dataset.key = r.key; tr.dataset.place = placeWords(r);
    const state = text('td', r.enabled ? t('on') : t('off')); state.dataset.state = String(r.enabled);
    tr.append(text('td', r.key), text('td', placeWords(r)), state, text('td', `v${r.version}`), text('td', r.reason), text('td', r.approvedBy === null ? r.changedBy : `${r.changedBy} · ${r.approvedBy}`));
    const cell = document.createElement('td');
    const h = button(t('history'), 'history', 'quiet'); h.dataset.act = 'history';
    h.addEventListener('click', async () => { const o = await session.history(r.key, placeOf(r)); if (o.result === 'ok') { history = { key: r.key, place: placeOf(r), versions: o.value.versions }; paintHistory(); } else say('b-status', o); });
    cell.append(h); tr.append(cell); body.append(tr);
  }
}
function paintHistory() {
  const ul = $('history-rows'); ul.replaceChildren();
  if (history === null) return;
  for (const v of [...history.versions].reverse()) {
    const li = document.createElement('li'); li.dataset.version = String(v.version);
    li.append(text('strong', `${history.key} · ${placeWords({ branchId: history.place.branchId, laneId: history.place.laneId ?? null })} · v${v.version} · ${v.enabled ? t('on') : t('off')}`));
    li.append(text('span', `${v.reason} · ${v.changedBy}${v.rolledBackFrom === undefined ? '' : ` · ${t('restored')} v${v.rolledBackFrom}`}`, 'meta'));
    const lab = document.createElement('label'); lab.append(text('span', t('backWhy'))); const why = document.createElement('input'); why.className = 'back-why'; lab.append(why);
    const b = button(t('back'), 'rotate-ccw', 'quiet'); b.dataset.act = 'back';
    b.addEventListener('click', async () => {
      const out = await session.rollback(history.key, history.place, v.version, why.value, $('ch-approval').value);
      say('b-status', out);
      if (out.result === 'ok') { await loadBoard(); const o = await session.history(history.key, history.place); if (o.result === 'ok') { history = { ...history, versions: o.value.versions }; paintHistory(); } }
    });
    li.append(lab, b); ul.append(li);
  }
}
function figure(label, value) { const d = document.createElement('div'); d.className = 'figure'; d.append(text('span', label, 'meta'), text('strong', value)); return d; }
function paintMeter() {
  const box = $('meter-figures'); box.replaceChildren();
  if (meter === null) return;
  const n = meter.now;
  box.append(figure(t('stores'), n === null ? '—' : String(n.stores)), figure(t('lanes'), n === null ? '—' : String(n.lanes)), figure(t('people'), n === null ? '—' : String(n.users)),
    figure(t('aiSpend'), n === null ? '—' : api.rupees(n.aiSpendMinor)), figure(t('price'), t('notSet')));
  box.lastChild.dataset.price = meter.price.words;
  const m = meter.monthRecorded;
  $('meter-month').textContent = m.recorded ? `${t('peaks')} ${t('stores')} ${m.peakStores} · ${t('lanes')} ${m.peakLanes} · ${t('people')} ${m.peakUsers}` : t('monthNotRecorded');
  $('meter-info').textContent = t('infoOnly');
}
function paintWatch() {
  const box = $('watch-figures'); box.replaceChildren();
  if (watch === null) return;
  box.append(figure(t('threshold'), watch.threshold.set ? String(watch.threshold.principals) : t('notSet')), figure(t('volume'), String(watch.volume.principals)));
  $('watch-said').textContent = watch.crossed === null ? t('neverAlerts') : watch.crossed ? t('crossed') : t('below');
  $('watch-said').dataset.crossed = String(watch.crossed);
}
// OB-367: the closure screen — read only. Everything is sealed until the CA or the lawyer writes the retention schedule.
function paintClosure() {
  const box = $('closure-figures'); box.replaceChildren();
  if (closure === null) return;
  const e = closure.latestExport;
  box.append(figure(t('closureState'), closure.state === 'closed' ? t('closed') : t('active')),
    figure(t('exportTaken'), e === null ? t('noExport') : `${e.exportId} · ${e.complete ? t('complete') : t('notComplete')}`),
    figure(t('schedule'), closure.sealed.retentionSchedule.state === 'set' ? closure.sealed.retentionSchedule.words : t('notSet')));
  box.lastChild.dataset.schedule = closure.sealed.retentionSchedule.state;
  $('closure-sealed').textContent = `🔒 ${lang === 'ta' ? closure.sealed.ta : closure.sealed.en}`;
  $('closure-sealed').dataset.sealed = String(closure.sealed.everythingSealed);
  const law = $('closure-law'); law.replaceChildren();
  for (const r of closure.wouldRetain) law.append(text('li', `${r.what} — ${r.untilDate === 'indefinitely' || r.untilDate.startsWith('9999') ? t('indefinitely') : `${t('until')} ${r.untilDate}`}`));
  $('closure-blockers').textContent = closure.blockers.length === 0 ? '' : `${t('closureBlockers')} ${closure.blockers.join(' · ')}`;
  $('closure-who').textContent = t('whoCloses');
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['board-h', 'boardH'], ['rule', 'rule'], ['c-switch', 'colSwitch'], ['c-place', 'colPlace'], ['c-state', 'colState'], ['c-version', 'colVersion'], ['c-why', 'colWhy'], ['c-who', 'colWho'],
    ['change-h', 'changeH'], ['ch-key-l', 'key'], ['ch-branch-l', 'branch'], ['ch-lane-l', 'laneOpt'], ['ch-state-l', 'state'], ['ch-on', 'on'], ['ch-off', 'off'], ['ch-reason-l', 'reason'], ['ch-approval-l', 'approvalId'],
    ['ch-preview-text', 'preview'], ['ch-save-text', 'save'], ['meter-h', 'meterH'], ['watch-h', 'watchH'], ['consent-h', 'consentH'], ['cs-download-text', 'download'], ['cs-file-l', 'importFile'], ['cs-import-text', 'bringIn'], ['closure-h', 'closureH'], ['closure-sealed-h', 'sealedH'], ['closure-law-h', 'lawKeeps']]) $(id).textContent = t(key);
  paintBoard(); paintHistory(); paintMeter(); paintWatch(); paintClosure();
}
const change = () => ({ key: $('ch-key').value, branchId: $('ch-branch').value, laneId: $('ch-lane').value, enabled: $('ch-state').value === 'on', reason: $('ch-reason').value, approvalId: $('ch-approval').value });
async function loadBoard() { const o = await session.board(); if (o.result === 'ok') board = o.value; else say('b-status', o); paintBoard(); }
async function loadMeter() { const o = await session.meter(); if (o.result === 'ok') meter = o.value; else say('m-status', o); paintMeter(); }
async function loadWatch() { const o = await session.watch(); if (o.result === 'ok') watch = o.value; else say('w-status', o); paintWatch(); }
async function loadClosure() { const o = await session.closure(); if (o.result === 'ok') closure = o.value; else say('cl-status', o); paintClosure(); }

for (const [id, name] of [['ch-preview', 'search'], ['ch-save', 'check'], ['cs-download', 'files'], ['cs-import', 'upload']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.open) $('page-status').textContent = t('cannotRead');
else {
  $('board').hidden = false; void loadBoard();
  if (may.change) {
    $('change').hidden = false;
    $('ch-preview').addEventListener('click', async () => {
      const out = await session.preview(change());
      if (out.result !== 'ok') { say('ch-status', out); return; }
      const p = out.value;
      $('ch-said').textContent = `${t('previewSays')} ${p.current === null ? t('notSet') : p.current ? t('on') : t('off')} ${t('becomes')} ${p.proposed ? t('on') : t('off')}. ${t('lanesChange')} ${p.lanesThatChange.length === 0 ? t('none') : p.lanesThatChange.join(', ')}. ${p.highImpact ? t('needsOwner') : t('noOwner')}`;
      $('ch-said').dataset.highImpact = String(p.highImpact);
      $('ch-status').textContent = '';
    });
    $('ch-save').addEventListener('click', async () => { const out = await session.save(change()); say('ch-status', out); if (out.result === 'ok') await loadBoard(); });
  }
  if (may.meter) { $('meter').hidden = false; void loadMeter(); }
  if (may.watch) { $('watch').hidden = false; void loadWatch(); }
  if (may.closure) { $('closure').hidden = false; void loadClosure(); }
  if (may.consent) {
    $('consent').hidden = false;
    $('cs-download').addEventListener('click', async () => {
      const out = await session.exportConsent();
      if (out.result !== 'ok') { say('cs-status', out); return; }
      const blob = new Blob([JSON.stringify(out.value, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `consent-record-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
      $('cs-status').textContent = `${t('downloaded')} ${out.value.counts.records} ${t('records')}`;
    });
    $('cs-import').addEventListener('click', async () => {
      const f = $('cs-file').files?.[0];
      const out = await session.importConsent(f ? await f.text() : null);
      if (out.result !== 'ok') { say('cs-status', out); return; }
      $('cs-status').textContent = `${out.value.applied} ${t('applied')} · ${out.value.exceptions.length} ${t('exceptions')} · ${out.value.alreadyImported + out.value.alreadyReflected} ${t('alreadyThere')}`;
    });
  }
}
