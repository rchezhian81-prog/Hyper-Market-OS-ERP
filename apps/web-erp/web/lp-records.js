// Investigations — "From the shop's own records" (M15-FR-02 · M15-FR-03 · OB-301). The session
// (apps/web-erp/src/lp-signals-session.ts, in the bundle as window.lpSignals) reads head office on a click: the fraud
// signals over the stored coupons, points, cash on delivery and supplier bills (each traced to its records), the staff
// purchases that arrived judged by the till's own rule, and the bank accounts shared between suppliers and staff. Nothing
// is read on open; nothing is blocked from here. It follows the page's language toggle; every button has its icon.

const $ = (id) => document.getElementById(id);
const api = window.lpSignals ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
let last = null;

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);

function row(tone, head, facts, detail) {
  const li = document.createElement('li');
  li.className = `row tone-${tone}`;
  const h = document.createElement('div'); h.className = 'head';
  h.append(text('span', head, 'headline'));
  li.append(h);
  if (facts.length > 0) { const f = document.createElement('div'); f.className = 'facts'; for (const x of facts) f.append(text('span', x)); li.append(f); }
  if (detail) li.append(text('div', detail, 'detail'));
  return li;
}

function paintResult() {
  if (last === null) return;
  const v = last;
  $('rec-signals-h').textContent = t('signals');
  $('rec-sources').textContent = v.signals.sources.map((s) => api.sourceWords(lang(), s)).join(' · ');
  const sig = $('rec-signals'); sig.replaceChildren();
  if (v.signals.signals.length === 0) sig.append(row('ok', t('none'), [], ''));
  for (const s of v.signals.signals) {
    const li = row(s.confidence === 'strong' ? 'error' : s.confidence === 'probable' ? 'degraded' : 'idle', `${t(`k_${s.kind}`)} — ${s.subjectRef}`,
      [`${t(s.confidence)}`, `${t('value')}: ${api.rupees(s.valueMinor)}`, `${t('evidence')}: ${s.evidenceRefs.join(', ')}`, s.reconciles ? `✓ ${t('reconciles')}` : `⚠ ${t('notTraced')} ${s.unmatchedEvidence.join(', ')}`], s.detail);
    li.dataset.signal = s.signalId;
    sig.append(li);
  }
  $('rec-staff-h').textContent = t('staff');
  const p = api.policyWords(lang(), v.staff.policy);
  $('rec-policy').textContent = `${p.cap} · ${p.desk}`;
  const staff = $('rec-staff'); staff.replaceChildren();
  if (v.staff.bills.length === 0) staff.append(row('ok', t('staffNone'), [], ''));
  for (const b of v.staff.bills) {
    const li = row(b.allowed ? 'ok' : 'error', `${b.allowed ? '✓' : '✕'} ${b.receiptNumber} — ${b.employeeId}`, [b.allowed ? t('allowed') : t('refused'), `${b.laneId} · ${b.cashierId}`, api.rupees(b.totalMinor), ...b.refusals.map((r) => t(`r_${r}`))], b.allowed ? '' : b.words[lang()]);
    li.dataset.sale = b.saleId;
    staff.append(li);
  }
  $('rec-bank-h').textContent = t('bank');
  $('rec-bank-note').textContent = `${v.bank.employeesFolded} ${t('employeesFolded')}`;
  const bank = $('rec-bank'); bank.replaceChildren();
  if (v.bank.flags.length === 0) bank.append(row('ok', t('bankNone'), [], ''));
  for (const f of v.bank.flags) {
    bank.append(row('error', `⚠ ${f.accountRef}`, f.holders.map((h) => `${h.holderType === 'employee' ? t('employeeH') : t('supplierH')}: ${h.holderId}`), t('blocked')));
  }
  $('rec-result').hidden = false;
}

function paint() {
  $('rec-heading').textContent = t('heading');
  $('rec-lead').textContent = t('lead');
  $('rec-from-label').textContent = t('from');
  $('rec-to-label').textContent = t('to');
  const btn = $('rec-read');
  btn.replaceChildren(); const i = icon('search'); if (i !== null) btn.append(i); btn.append(text('span', t('read')));
  if (session !== null && !session.may.read) { $('rec-status').textContent = session.may.named ? t('cannotRead') : t('nobody'); btn.disabled = true; }
  paintResult();
}

if (api !== null && session !== null && session.may.named) {
  $('rec').hidden = false;
  $('rec-read').addEventListener('click', async () => {
    $('rec-status').textContent = '';
    const out = await session.read({ from: $('rec-from').value, to: $('rec-to').value });
    if (out.result !== 'ok') {
      $('rec-status').textContent = out.result === 'refused' ? `${t('refusedW')} ${out.whatHappened}` : out.result === 'invalid' ? t(out.why) : t('unreachable');
      return;
    }
    last = out.value;
    paintResult();
  });
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  paint();
}
