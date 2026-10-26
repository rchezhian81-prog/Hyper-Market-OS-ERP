// Owner alerts and scheduled reports — the page over head office's six owner exception-alert thresholds (OB-365 adds failed till sign-ins), the day's
// exceptions and the owner's scheduled reports and exports (OB-288 lane 4 · P2 · M29-FR-03/04). The session
// (apps/web-erp/src/owner-alerts-session.ts, in the bundle as window.ownerAlerts) does every call; this page lays out what
// it is told. A threshold not set says so in words. Every word has a Tamil twin; every button carries an icon.

const $ = (id) => document.getElementById(id);
const api = window.ownerAlerts ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, manage: false, schedulesRead: false, schedule: false, floorRead: false, floorManage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
function field(labelWords, cls) { const l = document.createElement('label'); l.append(text('span', labelWords)); const i = document.createElement('input'); i.autocomplete = 'off'; i.className = cls; l.append(i); return l; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let thresholds = null; let today = null; let schedules = null; let floor = null;
const fillIn = (words, values) => Object.entries(values).reduce((w, [k, v]) => w.split(`{${k}}`).join(String(v)), words);

// OB-375 · OB-378: the kiosk hours and the watch numbers in force — the owner's written decision until he enters another.
function paintFloor() {
  if (floor === null) return;
  const from = (row) => (row.source === 'owner_decision' ? fillIn(t('fromDecision'), { decision: row.decision, date: row.decidedOn }) : fillIn(t('fromEntry'), { by: row.setBy ?? '', at: (row.setAt ?? '').slice(0, 10) }));
  const kiosk = floor.settings.find((r) => r.setting === 'kiosk_stale_after');
  const watch = floor.settings.find((r) => r.setting === 'self_checkout_watch');
  if (kiosk) {
    $('kiosk-now').textContent = fillIn(t('kioskNow'), { hours: Math.round((kiosk.value / 60) * 100) / 100, minutes: kiosk.value });
    $('kiosk-from').textContent = from(kiosk);
    $('kiosk-from').dataset.source = kiosk.source;
  }
  if (watch) {
    $('watch-now').textContent = fillIn(t('watchNow'), { pct: watch.value.auditRateBps / 100, above: (watch.value.auditAboveMinor / 100).toLocaleString('en-IN'), loose: watch.value.looseProducePatternCount, voids: watch.value.voidPatternCount });
    $('watch-from').textContent = from(watch);
    $('watch-from').dataset.source = watch.source;
  }
}
async function loadFloor() { const o = await session.readFloorSettings(); if (o.result === 'ok') floor = o.value; else say('f-status', o); paintFloor(); }

function paintThresholds() {
  const ul = $('t-rows'); ul.replaceChildren();
  if (thresholds === null) return;
  for (const row of thresholds.thresholds) {
    const li = document.createElement('li'); li.dataset.kind = row.kind; li.dataset.state = row.state;
    li.append(text('strong', t(row.kind)));
    if (row.state === 'not_set') li.append(text('span', t('notSet'), 'notset'));
    else li.append(text('span', `${t('setTo')} ${api.shownValue(row.kind, row.value)} · ${t('setBy')} ${row.setBy ?? ''}`, 'meta'));
    if (row.state === 'set' && !row.canFire && row.whyNot) li.append(text('span', `⚠ ${row.whyNot}`, 'meta'));
    if (may.manage) {
      const form = document.createElement('div'); form.className = 'row-form';
      const value = field(t(row.kind), 'threshold-value'); form.append(value);
      const save = button(t('save'), 'check', undefined); save.dataset.act = 'save';
      save.addEventListener('click', async () => { const out = await session.setThreshold(row.kind, value.querySelector('input').value); say('t-status', out); if (out.result === 'ok') await reload(); });
      form.append(save);
      if (row.state === 'set') {
        const why = field(t('clearWhy'), 'clear-why'); form.append(why);
        const off = button(t('clear'), 'x', 'quiet'); off.dataset.act = 'clear';
        off.addEventListener('click', async () => { const out = await session.clearThreshold(row.kind, why.querySelector('input').value); say('t-status', out); if (out.result === 'ok') await reload(); });
        form.append(off);
      }
      li.append(form);
    }
    ul.append(li);
  }
}

function paintToday() {
  const ul = $('d-rows'); ul.replaceChildren(); const al = $('d-alerts'); al.replaceChildren();
  if (today === null) return;
  $('today-h').textContent = `${t('todayH')} — ${today.tradingDay}`;
  for (const k of today.kinds) {
    const li = document.createElement('li'); li.dataset.kind = k.kind;
    li.append(text('strong', t(k.kind)));
    li.append(text('span', k.threshold === 'not_set' ? t('notSet') : k.events === null ? `${t('recorded')}: ${t('notKnown')}` : `${t('recorded')}: ${k.events} · ${k.alerts} ${t('alerts')}`, k.threshold === 'not_set' ? 'notset' : 'meta'));
    ul.append(li);
  }
  if (today.alerts.length === 0) al.append(text('li', t('noAlerts')));
  for (const a of today.alerts) {
    const li = document.createElement('li'); li.dataset.alert = a.inboxId;
    li.append(text('strong', `⚠ ${a.headline}`));
    li.append(text('span', a.inOwnersInbox ? `✓ ${t('inInbox')}` : t('notInInbox'), 'meta'));
    al.append(li);
  }
}

function paintSchedules() {
  const ul = $('s-rows'); ul.replaceChildren();
  if (schedules === null) return;
  if (schedules.schedules.length === 0) ul.append(text('li', t('noSchedules')));
  for (const s of schedules.schedules) {
    const li = document.createElement('li'); li.dataset.schedule = s.schedule.scheduleId;
    const hhmm = `${String(s.schedule.dueAt[0]).padStart(2, '0')}:${String(s.schedule.dueAt[1]).padStart(2, '0')}`;
    li.append(text('strong', `${s.schedule.scheduleId} — ${s.schedule.kind === 'report' ? t('kindReport') : t('kindExport')} ${s.schedule.target} · ${hhmm}${s.schedule.status === 'stopped' ? ` (${t('stopped')})` : ''}`));
    li.append(text('span', s.lastRun === null ? `${t('lastRun')}: ${t('never')}` : `${t('lastRun')}: ${s.lastRun.tradingDay} · ${s.runs} ${t('runs')} · ${s.lastRun.sending === 'switched_off' ? t('sendingOff') : t('prepared')}`, 'meta'));
    if (s.lastRun !== null) for (const line of s.lastRun.lines.slice(0, 4)) li.append(text('span', line, 'meta'));
    if (may.schedule && s.schedule.status === 'active') {
      const form = document.createElement('div'); form.className = 'row-form';
      const why = field(t('stopWhy'), 'stop-why'); form.append(why);
      const stop = button(t('stop'), 'x', 'quiet'); stop.dataset.act = 'stop';
      stop.addEventListener('click', async () => { const out = await session.stopSchedule(s.schedule.scheduleId, why.querySelector('input').value); say('s-status', out); if (out.result === 'ok') await loadSchedules(); });
      form.append(stop); li.append(form);
    }
    ul.append(li);
  }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['thresholds-h', 'thresholdsH'], ['today-h', 'todayH'], ['schedules-h', 'schedulesH'], ['d-check-text', 'checkNow'], ['s-id-l', 'scheduleId'], ['s-kind-l', 'kind'], ['s-kind-report', 'kindReport'], ['s-kind-export', 'kindExport'], ['s-target-l', 'target'], ['s-time-l', 'time'], ['s-lang-l', 'language'], ['s-save-text', 'saveSchedule'], ['s-run-text', 'runNow']]) $(id).textContent = t(key);
  for (const [id, key] of [['floor-h', 'floorH'], ['floor-lead', 'floorLead'], ['kiosk-h', 'kioskH'], ['kiosk-l', 'kioskL'], ['kiosk-save-text', 'saveKiosk'], ['watch-h', 'watchH'], ['watch-pct-l', 'watchPct'], ['watch-above-l', 'watchAbove'], ['watch-loose-l', 'watchLoose'], ['watch-voids-l', 'watchVoids'], ['watch-save-text', 'saveWatch']]) $(id).textContent = t(key);
  paintThresholds(); paintToday(); paintSchedules(); paintFloor();
}

async function loadThresholds() { const o = await session.readThresholds(); if (o.result === 'ok') thresholds = o.value; else say('t-status', o); paintThresholds(); }
async function loadToday() { const o = await session.readToday(); if (o.result === 'ok') today = o.value; else say('d-status', o); paintToday(); }
async function loadSchedules() { const o = await session.readSchedules(); if (o.result === 'ok') schedules = o.value; else say('s-status', o); paintSchedules(); }
async function reload() { await loadThresholds(); await loadToday(); }

for (const [id, name] of [['d-check', 'refresh-cw'], ['s-save', 'calendar-clock'], ['s-run', 'send'], ['kiosk-save', 'check'], ['watch-save', 'check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) { $('page-status').textContent = t('nobody'); }
else if (!may.open) { $('page-status').textContent = t('cannotRead'); }
else {
  $('thresholds').hidden = false; $('today').hidden = false;
  void reload();
  if (may.manage) {
    $('d-check').hidden = false;
    $('d-check').addEventListener('click', async () => { const out = await session.checkNow(); if (out.result === 'ok') $('d-status').textContent = `${t('raised')} ${out.value.raised}`; else say('d-status', out); await loadToday(); });
  }
  if (may.floorRead) {
    $('floor').hidden = false; void loadFloor();
    if (may.floorManage) {
      $('kiosk-form').hidden = false; $('watch-form').hidden = false;
      $('kiosk-save').addEventListener('click', async () => { const out = await session.setKioskHours($('kiosk-hours').value); say('f-status', out); if (out.result === 'ok') await loadFloor(); });
      $('watch-save').addEventListener('click', async () => {
        const out = await session.setWatch({ pct: $('watch-pct').value, aboveRupees: $('watch-above').value, loose: $('watch-loose').value, voids: $('watch-voids').value });
        say('f-status', out); if (out.result === 'ok') await loadFloor();
      });
    }
  }
  if (may.schedulesRead) {
    $('schedules').hidden = false; void loadSchedules();
    if (may.schedule) {
      $('s-form').hidden = false; $('s-save').hidden = false; $('s-run').hidden = false;
      $('s-save').addEventListener('click', async () => {
        const out = await session.saveSchedule({ scheduleId: $('s-id').value, kind: $('s-kind').value, target: $('s-target').value, time: $('s-time').value, language: $('s-lang').value });
        say('s-status', out); if (out.result === 'ok') await loadSchedules();
      });
      $('s-run').addEventListener('click', async () => { const out = await session.runNow(); if (out.result === 'ok') $('s-status').textContent = `${t('prepared')}: ${out.value.prepared}`; else say('s-status', out); await loadSchedules(); });
    }
  }
}

// ── FG-4 · M04-FR-04 / M06-FR-03: contracts ending (window.contractExpiry does every call). The window is "not set" until
//    the owner enters it; a contract that has already ended is raised to him whatever it says. ──
const ce = window.contractExpiry ?? null;
let ceRead = null;
function paintContracts() {
  if (ce === null) return;
  const cw = (k) => ce.words(lang, k);
  for (const [id, key] of [['contracts-h', 'ceH'], ['contracts-lead', 'ceLead'], ['contracts-days-l', 'days'], ['contracts-save-text', 'save'], ['contracts-why-l', 'clearWhy'], ['contracts-clear-text', 'clear']]) $(id).textContent = cw(key);
  { const i = icon('calendar-clock'); if (i !== null) $('contracts-h').prepend(i, ' '); }
  const ul = $('contracts-rows'); ul.replaceChildren();
  if (ceRead === null) return;
  const win = $('contracts-window'); win.textContent = ce.windowWords(lang, ceRead.warningDays); win.dataset.state = ceRead.warningDays.state;
  if (ceRead.due.length === 0) ul.append(text('li', cw('dueNone')));
  for (const d of ceRead.due) { const li = text('li', `${d.step === 'expired' ? '⚠ ' : ''}${ce.dueWords(lang, d)}`); li.dataset.alert = d.alertId; ul.append(li); }
}
async function loadContracts() { const o = await ce.session.read(); if (o.result === 'ok') ceRead = o.value; else $('contracts-status').textContent = ce.outcomeWords(lang, o); paintContracts(); }
if (ce !== null && ce.session.may.read) {
  $('contracts').hidden = false;
  for (const [id, name] of [['contracts-save', 'check'], ['contracts-clear', 'x']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
  if (ce.session.may.manage) {
    $('contracts-form').hidden = false;
    $('contracts-save').addEventListener('click', async () => { const o = await ce.session.setDays($('contracts-days').value); $('contracts-status').textContent = ce.outcomeWords(lang, o); if (o.result === 'ok') await loadContracts(); });
    $('contracts-clear').addEventListener('click', async () => { const o = await ce.session.clear($('contracts-why').value); $('contracts-status').textContent = ce.outcomeWords(lang, o); if (o.result === 'ok') await loadContracts(); });
  }
  $('lang').addEventListener('click', () => { paintContracts(); });
  paintContracts();
  void loadContracts();
}
