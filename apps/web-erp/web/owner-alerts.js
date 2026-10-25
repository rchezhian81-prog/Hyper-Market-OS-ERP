// Owner alerts and scheduled reports — the page over head office's five owner exception-alert thresholds, the day's
// exceptions and the owner's scheduled reports and exports (OB-288 lane 4 · P2 · M29-FR-03/04). The session
// (apps/web-erp/src/owner-alerts-session.ts, in the bundle as window.ownerAlerts) does every call; this page lays out what
// it is told. A threshold not set says so in words. Every word has a Tamil twin; every button carries an icon.

const $ = (id) => document.getElementById(id);
const api = window.ownerAlerts ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, manage: false, schedulesRead: false, schedule: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
function field(labelWords, cls) { const l = document.createElement('label'); l.append(text('span', labelWords)); const i = document.createElement('input'); i.autocomplete = 'off'; i.className = cls; l.append(i); return l; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let thresholds = null; let today = null; let schedules = null;

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
  paintThresholds(); paintToday(); paintSchedules();
}

async function loadThresholds() { const o = await session.readThresholds(); if (o.result === 'ok') thresholds = o.value; else say('t-status', o); paintThresholds(); }
async function loadToday() { const o = await session.readToday(); if (o.result === 'ok') today = o.value; else say('d-status', o); paintToday(); }
async function loadSchedules() { const o = await session.readSchedules(); if (o.result === 'ok') schedules = o.value; else say('s-status', o); paintSchedules(); }
async function reload() { await loadThresholds(); await loadToday(); }

for (const [id, name] of [['d-check', 'refresh-cw'], ['s-save', 'calendar-clock'], ['s-run', 'send']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
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
