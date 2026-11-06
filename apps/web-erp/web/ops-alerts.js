// Operational alerts (W3 · M35-FR-04) — the page over head office's alert lifecycle and alert rules. The session
// (apps/web-erp/src/ops-alerts-session.ts, in the bundle as window.opsAlerts) does every call and every rule; this page lays
// out what it is told. It reads as it opens; ticking an alert and changing who owns it are explicit presses. Every word this
// page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.opsAlerts ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false, acknowledge: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const when = (iso) => (api === null ? iso : api.moment(iso));
function field(id, words, control) { const l = document.createElement('label'); l.htmlFor = id; control.id = id; l.append(text('span', words), control); return l; }
function input(value, cls) { const i = document.createElement('input'); i.autocomplete = 'off'; i.value = value ?? ''; i.className = cls; return i; }

let mine = null; let all = null; let rules = null; let backups = null; let restore = null; let restoreWhy = '';

function alertItem(a, withAck) {
  const li = document.createElement('li'); li.dataset.alert = a.alertId; li.dataset.state = a.state;
  li.append(text('h4', `${a.state === 'open' || a.state === 'escalated' ? '⚠' : '✓'} ${a.component} — ${t(`lv_${a.level}`)} · ${t(`st_${a.state}`)}`),
    text('p', `${a.detail} · ${t('owner')} ${a.ownerName} (${a.ownerUserId}) · ${t('answerBy')} ${when(a.ackDueBy)}${a.escalatedTo === undefined ? '' : ` · ${t('escalatedTo')} ${a.escalatedTo}`}${a.acknowledgedBy === undefined ? '' : ` · ${t('seenBy')} ${a.acknowledgedBy}`}`, 'meta'));
  if (withAck && (may.acknowledge || may.manage) && (a.state === 'open' || a.state === 'escalated')) {
    const status = text('p', '', 'status'); status.setAttribute('role', 'status');
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t('ack');
    b.addEventListener('click', async () => {
      status.textContent = t('reading');
      const out = await session.acknowledge(a.alertId);
      status.textContent = out.result === 'ok' ? t('acked') : api.outcomeWords(lang, out);
      if (out.result === 'ok') void load();
    });
    li.append(b, status);
  }
  return li;
}

function paintAlerts() {
  $('mine').replaceChildren(); $('all').replaceChildren();
  if (mine !== null) $('mine').append(...(mine.length === 0 ? [text('li', t('noMine'), 'meta')] : mine.map((a) => alertItem(a, true))));
  if (all !== null) $('all').append(...(all.length === 0 ? [text('li', t('noAlerts'), 'meta')] : all.map((a) => alertItem(a, true))));
}

function paintRules() {
  $('rules').replaceChildren(); $('builtin').replaceChildren();
  if (rules === null) return;
  const own = rules.rules.filter((r) => !/^(built-in|notice):/.test(r.alertId));
  if (own.length === 0) $('rules').append(text('li', t('noRules'), 'meta'));
  for (const r of own) {
    const li = document.createElement('li'); li.dataset.rule = r.alertId;
    li.append(text('h4', `${r.component} — ${t(`lv_${r.firesAt}`)}`),
      text('p', `${t('owner')} ${r.ownerName} (${r.ownerUserId}) · ${r.ackWithinMinutes} min${r.escalatesToUserId === undefined ? '' : ` · ${t('escalatedTo')} ${r.escalatesToUserId}`}`, 'meta'));
    if (may.manage) {
      const form = document.createElement('form'); form.className = 'acts';
      const id = input(r.ownerUserId, 'o-owner'); const name = input(r.ownerName, 'o-name'); const minutes = input(String(r.ackWithinMinutes), 'o-minutes'); const esc = input(r.escalatesToUserId, 'o-escalates');
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'submit'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = t('save');
      const slug = r.alertId.replace(/[^A-Za-z0-9_-]/g, '_');
      form.append(field(`o-owner-${slug}`, t('ownerId'), id), field(`o-name-${slug}`, t('ownerName'), name), field(`o-min-${slug}`, t('ackMinutes'), minutes), field(`o-esc-${slug}`, t('escalatesTo'), esc), b, status);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        status.textContent = t('reading');
        const out = await session.setOwner(rules, r.alertId, { ownerUserId: id.value, ownerName: name.value, ackWithinMinutes: minutes.value, escalatesToUserId: esc.value });
        status.textContent = out.result === 'ok' ? `${t('saved')} ${out.value.version}.` : api.outcomeWords(lang, out);
        if (out.result === 'ok') void loadRules();
      });
      li.append(form);
    }
    $('rules').append(li);
  }
  for (const b of rules.builtIn) {
    const li = document.createElement('li'); li.dataset.builtin = b.alertId;
    li.append(text('p', `${b.alertId} · ${t(`bi_${b.state}`)} · ${b.words}`, 'meta'));
    $('builtin').append(li);
  }
  $('b-hours').value = String(Math.round(rules.backupMaxAgeSeconds / 3600));
}

// W4 · M35-FR-01: the backup and restore readings — what the backup job itself reported, and the latest restore rehearsal.
function paintReadings() {
  $('readings').replaceChildren();
  if (backups !== null) {
    const b = backups.latest;
    const newest = document.createElement('li'); newest.dataset.reading = 'newest';
    newest.append(text('h4', t('newestBackup')));
    if (b === null) newest.append(text('p', t('noBackup'), 'meta'));
    else {
      const good = b.ok && b.encrypted && b.offsite;
      newest.dataset.good = String(good);
      newest.append(text('p', `${good ? '✓' : '⚠'} ${b.backupId} · ${when(b.at)} · ${t(b.ok ? 'bk_completed' : 'bk_failed')} · ${t(b.encrypted ? 'bk_encrypted' : 'bk_unencrypted')} · ${t(b.offsite ? 'bk_offsite' : 'bk_onsite')}${b.sizeBytes === undefined ? '' : ` · ${b.sizeBytes} ${t('bytes')}`} · ${t('reportedBy')} ${b.recordedBy}`, 'meta'));
      if (b.checksum !== undefined) newest.append(text('p', b.checksum, 'meta'));
      if (b.detail !== undefined) newest.append(text('p', b.detail, 'meta'));
    }
    const lastGood = document.createElement('li'); lastGood.dataset.reading = 'good';
    lastGood.append(text('h4', t('newestGood')), text('p', backups.lastGoodAt === null ? t('noGood') : when(backups.lastGoodAt), 'meta'));
    $('readings').append(newest, lastGood);
    if (backups.reading !== null) {
      const r = document.createElement('li'); r.dataset.reading = 'health'; r.dataset.status = backups.reading.status;
      r.append(text('h4', `${t('backupReading')} — ${t(`lv_${backups.reading.status}`)}`), text('p', backups.reading.detail, 'meta'));
      $('readings').append(r);
    }
  }
  const rs = document.createElement('li'); rs.dataset.reading = 'restore';
  rs.append(text('h4', t('restoreH')));
  if (restore !== null) {
    rs.dataset.state = restore.state;
    rs.append(text('p', `${restore.state === 'passed' ? '✓' : '⚠'} ${t(`rs_${restore.state}`)}${restore.drilledAt === undefined ? '' : ` · ${when(restore.drilledAt)}`}${restore.drilledBy === undefined ? '' : ` · ${t('rehearsedBy')} ${restore.drilledBy}`}${restore.state === 'passed' && restore.passExpiresAt !== undefined ? ` · ${t('passUntil')} ${when(restore.passExpiresAt)}` : ''}`, 'meta'));
    if (restore.detail !== '') rs.append(text('p', restore.detail, 'meta'));
  } else if (restoreWhy !== '') rs.append(text('p', restoreWhy, 'meta'));
  if (backups !== null || restore !== null || restoreWhy !== '') $('readings').append(rs);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['mine-h', 'mineH'], ['all-h', 'allH'], ['readings-h', 'readingsH'], ['rules-h', 'rulesH'], ['builtin-h', 'builtInH'], ['add-h', 'addH'], ['n-component-l', 'component'], ['n-fires-l', 'firesAt'], ['n-owner-l', 'ownerId'], ['n-name-l', 'ownerName'], ['n-minutes-l', 'ackMinutes'], ['n-escalates-l', 'escalatesTo'], ['n-add-text', 'add'], ['backup-h', 'backupH'], ['b-hours-l', 'backupAge'], ['b-save-text', 'saveBackup']]) $(id).textContent = t(key);
  const sel = $('n-fires'); const was = sel.value;
  sel.replaceChildren(...(api?.levels ?? []).map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`lv_${v}`); return o; }));
  if (was !== '') sel.value = was;
  paintAlerts(); paintRules(); paintReadings();
}

async function loadReadings() {
  $('readings-status').textContent = t('reading');
  const [b, r] = await Promise.all([session.backups(), may.restore ? session.restore() : Promise.resolve(null)]);
  let why = '';
  if (b.result === 'ok') backups = b.value; else { backups = null; why = api.outcomeWords(lang, b); }
  if (r === null) { restore = null; restoreWhy = t('cannotRestore'); } else if (r.result === 'ok') { restore = r.value; restoreWhy = ''; } else { restore = null; restoreWhy = api.outcomeWords(lang, r); }
  $('readings-status').textContent = why;
  paintReadings();
}
async function loadRules() {
  $('rules-status').textContent = t('reading');
  const out = await session.rules();
  if (out.result === 'ok') { rules = out.value; $('rules-status').textContent = ''; } else { rules = null; $('rules-status').textContent = api.outcomeWords(lang, out); }
  paintRules();
}
async function load() {
  $('mine-status').textContent = t('reading'); $('all-status').textContent = t('reading');
  const [m, a] = await Promise.all([session.mine(), session.board()]);
  if (m.result === 'ok') { mine = m.value; $('mine-status').textContent = ''; } else { mine = null; $('mine-status').textContent = api.outcomeWords(lang, m); }
  if (a.result === 'ok') { all = a.value; $('all-status').textContent = ''; } else { all = null; $('all-status').textContent = api.outcomeWords(lang, a); }
  paintAlerts();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (rules === null) { $('add-status').textContent = t('readFirst'); return; }
  $('add-status').textContent = t('reading');
  const out = await session.addRule(rules, { component: $('n-component').value, firesAt: $('n-fires').value, ownerUserId: $('n-owner').value, ownerName: $('n-name').value, ackWithinMinutes: $('n-minutes').value, escalatesToUserId: $('n-escalates').value });
  $('add-status').textContent = out.result === 'ok' ? `${t('saved')} ${out.value.version}.` : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadRules();
});
$('backup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (rules === null) { $('backup-status').textContent = t('readFirst'); return; }
  $('backup-status').textContent = t('reading');
  const out = await session.setBackupAge(rules, $('b-hours').value);
  $('backup-status').textContent = out.result === 'ok' ? `${t('saved')} ${out.value.version}.` : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadRules();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('mine-s').hidden = false; $('all-s').hidden = false; $('readings-s').hidden = false; $('rules-s').hidden = false;
  if (may.manage) $('manage').hidden = false; else $('page-status').textContent = t('cannotManage');
  void load(); void loadRules(); void loadReadings();
}
