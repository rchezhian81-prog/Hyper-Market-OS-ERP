// GST returns — the head-office part of the page (R3 lane 1: A15 · A16 · A14 · A19 · A18 · A21). Reads, live from head
// office, the month's GSTR-3B reconciled to the till (GET /v1/finance/gstr3b/:period), the GST controls
// (GET /v1/finance/gst/controls, GET /v1/finance/e-invoice/reporting-guard), the filing calendar
// (GET /v1/finance/filing-calendar) and the annual return (GET /v1/finance/gstr9/:fy, GET /v1/finance/gstr9c/:fy). Two
// acts, each head office's to allow or refuse: LOCK GSTR-3B to the filed GSTR-1 (POST …/gstr3b/:period/lock) and RECORD
// AN AMENDMENT of a filed month (POST …/gstr3b/:period/amendments/:id). The page never computes a figure: it shows what
// head office answered, and a figure head office does not know (input credit not yet reconciled) is said, never a zero.
// No prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    hoTitle: 'This month\'s GST, from head office',
    hoLead: 'GSTR-3B is worked out from the till\'s banked sales less returns — never typed in. Once GSTR-1 is filed it is locked to it; a sale that reaches head office later is corrected by an amendment in the next month.',
    controlsHeading: 'Controls', periodLabel: 'Month (MMYYYY)', show: 'Show',
    rcm: 'Reverse charge', guard: '30-day e-invoice guard', window: 'Warning before the 3-year bar',
    on: 'ON', off: 'SWITCHED OFF', notSet: 'NOT SET', days: 'days', ownerDecision: 'owner\'s decision',
    basis_provisional_gstr1_not_filed: 'Provisional — GSTR-1 for this month is not filed yet',
    basis_gstr1_filed_not_yet_locked: 'GSTR-1 is filed — lock GSTR-3B to it',
    basis_locked_to_filed_gstr1: 'Locked to the filed GSTR-1 — it cannot be changed',
    f31a: '3.1(a) outward taxable value', f31aTax: '3.1(a) tax (CGST + SGST + IGST)', f31c: '3.1(c) nil-rated / exempt', f31d: '3.1(d) reverse charge — paid in cash',
    f4a3: '4(A)(3) ITC on reverse charge (paid)', f4a5: '4(A)(5) all other ITC', tillNet: 'The till: banked sales less returns', notKnown: 'NOT KNOWN — not yet reconciled',
    lock: 'Lock GSTR-3B to the filed GSTR-1', amend: 'Record an amendment', amendReason: 'Why (the reason for the amendment)', needReason: 'Write the reason for the amendment first.',
    diffHeading: 'Differences from the till', excHeading: 'Needs a person', noDiff: 'GSTR-3B equals the till and GSTR-1, to the paisa.', noExc: 'Nothing needs a person.',
    explained: 'explained', open: 'OPEN',
    d_documents_not_from_till: 'Outward documents not from the till', d_amendment_from_earlier_period: 'Amendment from the previous month',
    d_changed_after_gstr1_filed: 'Banked after GSTR-1 was filed — not yet amended', d_carried_by_amendment: 'Carried to the next month by an amendment',
    d_sold_not_on_return: 'Sold but NOT on the return', d_unexplained: 'Unexplained',
    calHeading: 'Filing calendar', calNone: 'Nothing is overdue.', due: 'Due', bar: 'Barred after', daysOver: 'day(s) overdue', daysLeft: 'day(s) to the bar',
    w_filed: 'Filed', w_period_not_ended: 'Month not ended', w_not_due_yet: 'Not due yet', w_overdue: 'OVERDUE', w_near_time_bar: 'NEAR THE 3-YEAR BAR', w_time_barred: 'TIME-BARRED — can never be filed',
    notJudged: 'The owner has not set how many days before the 3-year bar to be warned, so "near the bar" is not judged yet.',
    annualHeading: 'Annual return', g9: 'GSTR-9', g9c: 'GSTR-9C', complete: 'complete — all twelve months filed', incomplete: 'INCOMPLETE — months missing', openDiffs: 'difference(s) without a reason', noOpen: 'every difference has a reason',
    locked: 'Locked', amended: 'Amendment recorded — declared in', refused: 'Not done', unreachable: 'Head office could not be reached. Nothing was changed — try again.',
    cannotRead: 'This could not be read from head office. Nothing here is current.', badPeriod: 'Write the month as MMYYYY, e.g. 052026.',
    periodHelp: 'Six digits: the month, then the year — for example 052026.',
  },
  ta: {
    hoTitle: 'இந்த மாத GST, தலைமை அலுவலகத்திலிருந்து',
    hoLead: 'GSTR-3B கல்லாவில் வங்கியில் செலுத்திய விற்பனையிலிருந்து திருப்பியவை கழித்துக் கணக்கிடப்படுகிறது — தட்டச்சு செய்யப்படுவதில்லை. GSTR-1 தாக்கல் ஆனதும் அதனுடன் பூட்டப்படும்; பின்னர் வரும் விற்பனை அடுத்த மாதத் திருத்தமாகச் சரிசெய்யப்படும்.',
    controlsHeading: 'கட்டுப்பாடுகள்', periodLabel: 'மாதம் (MMYYYY)', show: 'காட்டு',
    rcm: 'தலைகீழ் வரி (RCM)', guard: '30 நாள் மின்-விலைப்பட்டியல் காவல்', window: '3 ஆண்டு தடைக்கு முன் எச்சரிக்கை',
    on: 'இயக்கத்தில்', off: 'நிறுத்தப்பட்டுள்ளது', notSet: 'அமைக்கப்படவில்லை', days: 'நாள்', ownerDecision: 'உரிமையாளர் முடிவு',
    basis_provisional_gstr1_not_filed: 'தற்காலிகம் — இந்த மாத GSTR-1 இன்னும் தாக்கல் ஆகவில்லை',
    basis_gstr1_filed_not_yet_locked: 'GSTR-1 தாக்கல் ஆனது — GSTR-3B-ஐ அதனுடன் பூட்டவும்',
    basis_locked_to_filed_gstr1: 'தாக்கல் ஆன GSTR-1 உடன் பூட்டப்பட்டது — மாற்ற முடியாது',
    f31a: '3.1(a) வெளிச்செல்லும் வரிக்குரிய மதிப்பு', f31aTax: '3.1(a) வரி (CGST + SGST + IGST)', f31c: '3.1(c) பூஜ்ய வரி / விலக்கு', f31d: '3.1(d) தலைகீழ் வரி — பணமாகச் செலுத்தப்படும்',
    f4a3: '4(A)(3) தலைகீழ் வரி உள்ளீட்டு வரவு (செலுத்தியது)', f4a5: '4(A)(5) மற்ற உள்ளீட்டு வரவு', tillNet: 'கல்லா: விற்பனை கழித்தல் திருப்பியவை', notKnown: 'தெரியவில்லை — இன்னும் சரிபார்க்கப்படவில்லை',
    lock: 'GSTR-3B-ஐ தாக்கல் ஆன GSTR-1 உடன் பூட்டு', amend: 'திருத்தத்தைப் பதிவு செய்', amendReason: 'ஏன் (திருத்தத்திற்கான காரணம்)', needReason: 'முதலில் திருத்தத்திற்கான காரணத்தை எழுதுங்கள்.',
    diffHeading: 'கல்லாவுடன் வேறுபாடுகள்', excHeading: 'ஒருவர் பார்க்க வேண்டியவை', noDiff: 'GSTR-3B கல்லாவுக்கும் GSTR-1-க்கும் பைசா வரை சமம்.', noExc: 'யாரும் பார்க்க வேண்டியதில்லை.',
    explained: 'விளக்கப்பட்டது', open: 'திறந்தது',
    d_documents_not_from_till: 'கல்லாவிலிருந்து வராத ஆவணங்கள்', d_amendment_from_earlier_period: 'முந்தைய மாதத் திருத்தம்',
    d_changed_after_gstr1_filed: 'GSTR-1 தாக்கலுக்குப் பின் வந்தது — இன்னும் திருத்தப்படவில்லை', d_carried_by_amendment: 'திருத்தத்தால் அடுத்த மாதத்திற்குக் கொண்டு செல்லப்பட்டது',
    d_sold_not_on_return: 'விற்றது ஆனால் வருமானத்தில் இல்லை', d_unexplained: 'விளக்கமில்லை',
    calHeading: 'தாக்கல் நாட்காட்டி', calNone: 'எதுவும் தாமதமில்லை.', due: 'கடைசி நாள்', bar: 'இதற்குப் பின் தடை', daysOver: 'நாள்(கள்) தாமதம்', daysLeft: 'நாள்(கள்) தடைக்கு',
    w_filed: 'தாக்கல் ஆனது', w_period_not_ended: 'மாதம் முடியவில்லை', w_not_due_yet: 'இன்னும் கெடு வரவில்லை', w_overdue: 'தாமதம்', w_near_time_bar: '3 ஆண்டு தடைக்கு அருகில்', w_time_barred: 'காலாவதி — இனி தாக்கல் செய்ய முடியாது',
    notJudged: '3 ஆண்டு தடைக்கு எத்தனை நாள் முன் எச்சரிக்க வேண்டும் என்று உரிமையாளர் அமைக்கவில்லை; ஆகவே "தடைக்கு அருகில்" இன்னும் கணிக்கப்படவில்லை.',
    annualHeading: 'ஆண்டு வருமானம்', g9: 'GSTR-9', g9c: 'GSTR-9C', complete: 'முழுமை — பன்னிரண்டு மாதமும் தாக்கல்', incomplete: 'முழுமையில்லை — மாதங்கள் விடுபட்டுள்ளன', openDiffs: 'காரணமில்லாத வேறுபாடு(கள்)', noOpen: 'ஒவ்வொரு வேறுபாட்டிற்கும் காரணம் உள்ளது',
    locked: 'பூட்டப்பட்டது', amended: 'திருத்தம் பதிவானது — அறிவிக்கப்படும் மாதம்', refused: 'செய்யப்படவில்லை', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாறவில்லை — மீண்டும் முயலவும்.',
    cannotRead: 'இதைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.', badPeriod: 'மாதத்தை MMYYYY ஆக எழுதுங்கள், எ.கா. 052026.',
    periodHelp: 'ஆறு இலக்கங்கள்: மாதம், பிறகு ஆண்டு — எ.கா. 052026.',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;
const held = new Set(window.gstReturnsData?.permissions ?? []);
const may = (p) => held.has(p);

/** ₹ from paise, Indian grouping — a figure for reading, never for sums. */
const rupees = (minor) => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const taxOf = (h) => h.cgstMinor + h.sgstMinor + h.igstMinor;
/** The shop's last month, MMYYYY, from the browser's own calendar (the default to show — head office decides the rest). */
function lastMonth() {
  const d = new Date();
  const m = d.getMonth() === 0 ? 12 : d.getMonth();
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
  return `${String(m).padStart(2, '0')}${y}`;
}
const fyOf = (fp) => { const m = Number(fp.slice(0, 2)); const y = Number(fp.slice(2)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

let period = lastMonth();
let controls = null;
let guardState = null;
let g3b = null;
let calendar = null;
let annual = null;
let readFailed = false;
/** One key per act while head office's answer is lost — a retry is the same act, never two. */
const pendingKeys = new Map();

async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function tell(ok, text) {
  const r = el('ho-result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

async function post(key, path, body, done) {
  const k = pendingKeys.get(key) ?? `gst-${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingKeys.set(key, k);
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': k }, body: JSON.stringify(body) });
    const answer = await res.json().catch(() => ({}));
    pendingKeys.delete(key);
    if (res.ok) tell(true, done(answer));
    else tell(false, `${t('refused')}: ${answer?.error?.whatHappened ?? res.status} ${answer?.error?.nextSafeAction ?? ''}`.trim());
  } catch {
    tell(false, t('unreachable'));
  }
  await refresh();
}

/** OB-205: a shape from the one icon set (sre-icons.js), or null when the set is not loaded — the words carry the meaning. */
const lineIcon = (name, size) => (window.sreIcon && typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
const toneIcon = (tone, size) => (window.sreIcon && typeof window.sreIcon.forTone === 'function' ? lineIcon(window.sreIcon.forTone(tone), size) : null);
/** Words with a shape in front, in one holder; the words stay its whole text. */
function shaped(holder, mark, words) {
  const text = document.createElement('span'); text.textContent = words;
  holder.replaceChildren(...(mark ? [mark] : []), text);
}

function fact(list, label, word, tone) {
  const li = document.createElement('li');
  li.className = `tone-${tone}`;
  const mark = toneIcon(tone, 18);
  if (mark) li.append(mark);
  const l = document.createElement('span'); l.textContent = `${label}:`;
  const w = document.createElement('span'); w.className = 'word'; w.textContent = word;
  li.append(l, w);
  list.append(li);
  return li;
}

function paintControls() {
  const list = el('controls');
  list.replaceChildren();
  if (controls === null) return;
  const rc = fact(list, t('rcm'), controls.controls.reverseCharge.value ? t('on') : t('off'), controls.controls.reverseCharge.value ? 'ok' : 'idle');
  rc.dataset.control = 'reverse-charge'; rc.title = controls.said.reverseCharge;
  const on = guardState?.switchedOn ?? controls.controls.einvoice30DayGuard.value;
  const g = fact(list, t('guard'), on ? t('on') : t('off'), on ? 'ok' : 'idle');
  g.dataset.control = 'einvoice-30-day-guard'; g.title = guardState?.said ?? controls.said.einvoice30DayGuard;
  // OB-191: 180 days is the owner's decided value until he changes it — said with the decision, never "not set".
  const tb = controls.controls.timeBarWarningDays;
  const n = tb.value ?? null;
  const said = n === null ? t('notSet') : tb.decision ? `${n} ${t('days')} (${t('ownerDecision')} ${tb.decision})` : `${n} ${t('days')}`;
  const w = fact(list, t('window'), said, n === null ? 'degraded' : 'ok');
  w.dataset.control = 'time-bar-warning-days'; w.title = controls.said.timeBarWarningDays;
}

function figure(dl, label, value, key, notKnown = false) {
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value; dd.dataset.figure = key;
  // OB-205: a figure head office does not know wears the "not known" shape beside its words — never a zero.
  if (notKnown) { dd.className = 'unknown sre-with-icon'; const mark = lineIcon('circle-help', 16); if (mark) dd.prepend(mark); }
  dl.append(dt, dd);
}

/** One line of head office's answer. OB-205: the state is a chip — the tone's shape and its word (`icon` names a
 *  clearer shape where the tone's own would mislead); a line whose words are all in its title wears the shape there. */
function row(list, head, word, tone, facts, data, icon) {
  const li = document.createElement('li');
  li.className = `row tone-${tone}`;
  for (const [k, v] of Object.entries(data)) li.dataset[k] = v;
  const h = document.createElement('div'); h.className = 'head';
  const a = document.createElement('span'); a.className = 'headline';
  const mark = icon ? lineIcon(icon, 18) : toneIcon(tone, 18);
  if (word === '') shaped(a, mark, head); else a.textContent = head;
  h.append(a);
  if (word !== '') {
    const s = document.createElement('span');
    s.className = 'state sre-chip';
    s.dataset.tone = tone;
    shaped(s, icon ? lineIcon(icon, 16) : toneIcon(tone, 16), word);
    h.append(s);
  }
  li.append(h);
  if (facts.length > 0) {
    const f = document.createElement('div'); f.className = 'facts';
    for (const x of facts) { const sp = document.createElement('span'); sp.textContent = x; f.append(sp); }
    li.append(f);
  }
  list.append(li);
}

function paintG3b() {
  const box = el('g3b');
  box.hidden = g3b === null;
  if (g3b === null) return;
  // OB-205: where GSTR-3B stands, with its shape: provisional waits, filed-not-locked needs the lock, locked is fixed.
  const basisShape = { provisional_gstr1_not_filed: 'clock', gstr1_filed_not_yet_locked: 'triangle-alert', locked_to_filed_gstr1: 'lock' }[g3b.basis] ?? 'circle-help';
  shaped(el('basis'), lineIcon(basisShape, 18), t(`basis_${g3b.basis}`));
  el('basis').dataset.basis = g3b.basis;
  const dl = el('figures');
  dl.replaceChildren();
  figure(dl, t('f31a'), rupees(g3b.table31.a.taxableMinor), '31a-taxable');
  figure(dl, t('f31aTax'), rupees(taxOf(g3b.table31.a)), '31a-tax');
  figure(dl, t('f31c'), rupees(g3b.table31.c.taxableMinor), '31c');
  figure(dl, t('f31d'), rupees(taxOf(g3b.table31.d)), '31d');
  figure(dl, t('f4a3'), rupees(taxOf(g3b.table4.a3ReverseCharge)), '4a3');
  const a5Known = g3b.table4.a5AllOther.status === 'reconciled';
  figure(dl, t('f4a5'), a5Known ? rupees(g3b.table4.a5AllOther.cgstMinor + g3b.table4.a5AllOther.sgstMinor + g3b.table4.a5AllOther.igstMinor) : t('notKnown'), '4a5', !a5Known);
  figure(dl, t('tillNet'), rupees(g3b.reconciliation.salesLedger.netGrossMinor), 'till-net');

  const actions = el('g3b-actions');
  actions.replaceChildren();
  if (g3b.basis === 'gstr1_filed_not_yet_locked' && may('finance.gstr.generate')) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'act'; b.id = 'lock'; b.textContent = t('lock');
    b.addEventListener('click', () => { b.disabled = true; void post(`lock-${period}`, `/v1/finance/gstr3b/${period}/lock`, {}, () => `${t('locked')}: ${period}`); });
    actions.append(b);
  }
  const late = g3b.reconciliation.differences.some((d) => d.code === 'changed_after_gstr1_filed');
  if (late && may('finance.gstr.generate')) {
    const form = document.createElement('form');
    form.className = 'g3b-actions';
    const label = document.createElement('label');
    const span = document.createElement('span'); span.textContent = t('amendReason');
    const input = document.createElement('input'); input.id = 'amend-reason'; input.autocomplete = 'off';
    label.append(span, input);
    const b = document.createElement('button'); b.type = 'submit'; b.className = 'act'; b.id = 'amend'; b.textContent = t('amend');
    form.append(label, b);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = input.value.trim();
      if (reason === '') { tell(false, t('needReason')); return; }
      b.disabled = true;
      const id = `AM-${period}-${Date.now().toString(36)}`;
      void post(`amend-${period}`, `/v1/finance/gstr3b/${period}/amendments/${id}`, { reason }, (a) => `${t('amended')} ${a?.amendment?.intoPeriod ?? ''}`);
    });
    actions.append(form);
  }

  el('diff-heading').textContent = t('diffHeading');
  const diffs = el('differences');
  diffs.replaceChildren();
  if (g3b.reconciliation.differences.length === 0) row(diffs, t('noDiff'), '', 'ok', [], { code: 'none' });
  for (const d of g3b.reconciliation.differences) {
    row(diffs, t(`d_${d.code}`), `${d.explained ? t('explained') : t('open')} · ${rupees(d.grossMinor)}`, d.explained ? 'ok' : 'error', [d.detail], { code: d.code, explained: String(d.explained) });
  }
  el('exc-heading').textContent = t('excHeading');
  const exc = el('exceptions');
  exc.replaceChildren();
  if (g3b.exceptions.length === 0) row(exc, t('noExc'), '', 'ok', [], { code: 'none' });
  for (const e of g3b.exceptions) row(exc, e.detail, '', 'degraded', [], { code: e.code });
}

function paintCalendar() {
  el('cal-heading').textContent = t('calHeading');
  const list = el('calendar');
  list.replaceChildren();
  if (calendar === null) { el('cal-summary').textContent = ''; return; }
  el('cal-summary').textContent = calendar.nearBarNotJudged ? t('notJudged') : '';
  const urgent = calendar.entries.filter((e) => e.warning === 'time_barred' || e.warning === 'near_time_bar' || e.warning === 'overdue' || e.warning === 'not_due_yet');
  if (urgent.length === 0) row(list, t('calNone'), '', 'ok', [], { warning: 'none' });
  for (const e of urgent.slice(0, 24)) {
    const tone = e.warning === 'time_barred' || e.warning === 'near_time_bar' ? 'error' : e.warning === 'overdue' ? 'degraded' : 'idle';
    const facts = [`${t('due')}: ${e.dueDate}`, `${t('bar')}: ${e.timeBarDate}`];
    if (e.daysOverdue !== undefined) facts.push(`${e.daysOverdue} ${t('daysOver')}`);
    if (e.daysToTimeBar !== undefined && e.warning !== 'time_barred') facts.push(`${e.daysToTimeBar} ${t('daysLeft')}`);
    row(list, `${e.type} ${e.period}`, t(`w_${e.warning}`), tone, facts, { type: e.type, period: e.period, warning: e.warning }, tone === 'idle' ? 'calendar-clock' : undefined);
  }
}

function paintAnnual() {
  el('annual-heading').textContent = annual === null ? t('annualHeading') : `${t('annualHeading')} ${annual.fy}`;
  const list = el('annual');
  list.replaceChildren();
  if (annual === null) return;
  row(list, t('g9'), annual.g9.complete ? t('complete') : t('incomplete'), annual.g9.complete ? 'ok' : 'degraded',
    [`${t('due')}: ${annual.g9.dueDate}`, ...annual.g9.missing.slice(0, 6).map((m) => `${m.period}: ${m.reason.replace(/_/g, ' ')}`)], { return: 'GSTR9' });
  row(list, t('g9c'), annual.g9c.open === 0 ? t('noOpen') : `${annual.g9c.open} ${t('openDiffs')}`, annual.g9c.open === 0 ? 'ok' : 'degraded',
    [`${t('due')}: ${annual.g9c.dueDate}`], { return: 'GSTR9C' });
}

function paint() {
  el('ho-title').textContent = t('hoTitle');
  el('ho-lead').textContent = t('hoLead');
  el('controls-heading').textContent = t('controlsHeading');
  el('period-label').textContent = t('periodLabel');
  el('show').textContent = t('show');
  const state = el('ho-state');
  state.hidden = !readFailed;
  if (readFailed) shaped(state, lineIcon('circle-help', 20), t('cannotRead')); else state.textContent = '';
  el('period-help').textContent = el('period').getAttribute('aria-invalid') === 'true' ? t('badPeriod') : t('periodHelp');
  paintControls();
  paintG3b();
  paintCalendar();
  paintAnnual();
}

async function refresh() {
  try {
    controls = await get('/v1/finance/gst/controls');
    guardState = await get('/v1/finance/e-invoice/reporting-guard');
    g3b = await get(`/v1/finance/gstr3b/${period}`);
    calendar = await get('/v1/finance/filing-calendar');
    const fy = fyOf(period);
    const [g9, g9c] = await Promise.all([get(`/v1/finance/gstr9/${fy}`), get(`/v1/finance/gstr9c/${fy}`)]);
    annual = { fy, g9, g9c };
    readFailed = false;
  } catch {
    readFailed = true;
    controls = null; guardState = null; g3b = null; calendar = null; annual = null;
  }
  paint();
}

el('period').value = period;
el('pick').addEventListener('submit', (event) => {
  event.preventDefault();
  const v = el('period').value.trim();
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(v)) {
    // OB-205: said beside the field too — what is wrong and how to write it — and the field is marked.
    el('period').setAttribute('aria-invalid', 'true');
    el('period-help').dataset.tone = 'error';
    el('period-help').textContent = t('badPeriod');
    tell(false, t('badPeriod'));
    return;
  }
  el('period').removeAttribute('aria-invalid');
  delete el('period-help').dataset.tone;
  el('period-help').textContent = t('periodHelp');
  period = v;
  el('ho-result').hidden = true;
  void refresh();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; paint(); });
paint();
void refresh();
