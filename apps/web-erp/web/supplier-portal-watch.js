// Supplier submissions · "A supplier's papers and statement" and "Portal logins trying other suppliers' data" (W5 ·
// M24-FR-02/03/04). Every rule and word lives in the TESTED session (apps/web-erp/src/supplier-portal-watch-session.ts,
// window.supplierPortalWatch); this file draws head office's answers. Reads only — every read is a click; the day starts at
// the shop's own date. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.supplierPortalWatch ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const node = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
function say(text, result = '') { $('sp-status').textContent = text; $('sp-status').dataset.result = result; }

let shown = null; let probing = null;

function paint() {
  for (const [id, k] of [['sp-h', 'spH'], ['sp-lead', 'spLede'], ['sp-partner-l', 'partner'], ['sp-asof-l', 'asOf'], ['sp-papers-text', 'papers'], ['sp-statement-text', 'statement'], ['sp-probe-h', 'probeH'], ['sp-probe-text', 'probeShow']]) $(id).textContent = w(k);
  const rows = $('sp-rows'); rows.replaceChildren();
  if (shown !== null && shown.kind === 'papers') {
    const c = shown.value;
    rows.append(node('li', { textContent: c.compliant ? w('compliant') : w('notCompliant', { kinds: c.blocking.join(', ') }) }));
    for (const d of c.documents) { const li = node('li', { textContent: `${d.kind}: ${w(`d_${d.state}`)}${d.validUntil ? ` (${d.validUntil})` : ''} — ${d.detail}` }); li.dataset.doc = d.kind; li.dataset.state = d.state; rows.append(li); }
  } else if (shown !== null && shown.kind === 'statement') {
    const s = shown.value; const r = api.rupees;
    if (!s.accessible) rows.append(node('li', { textContent: w('notShared') }));
    else {
      const fig = (k, v) => { const li = node('li', { textContent: `${w(k)}: ${r(v)}` }); li.dataset.fig = k; return li; };
      rows.append(fig('opening', s.openingMinor), fig('invoiced', s.invoicedMinor), fig('debited', s.debitedMinor), fig('credited', s.creditedMinor), fig('paid', s.paidMinor), fig('closing', s.closingMinor), fig('disputed', s.disputedMinor),
        node('li', { textContent: s.reconciles ? w('addsUp') : w('doesNotAddUp') }));
      if (s.lines.length === 0) rows.append(node('li', { textContent: w('noLines') }));
      for (const l of s.lines) rows.append(node('li', { className: 'meta', textContent: `${l.date} · ${l.kind} ${l.documentRef} · ${r(l.amountMinor)} · ${l.status}` }));
    }
  }
  const pr = $('sp-probe-rows'); pr.replaceChildren();
  if (probing !== null) {
    pr.append(node('li', { className: 'meta', textContent: w(probing.builtIn === false ? 'threshold' : 'thresholdBuiltIn', { threshold: probing.threshold }) }));
    if (probing.probing.length === 0) pr.append(node('li', { textContent: w('noProbing', { threshold: probing.threshold }) }));
    for (const p of probing.probing) { const li = node('li', { textContent: `${w('probeRow', { user: p.userId, partner: p.partnerId, attempts: p.attempts })} — ${p.detail}` }); li.dataset.probe = p.userId; pr.append(li); }
  }
}

async function run(button, kind, work) {
  button.disabled = true;
  try {
    const out = await work();
    if (out.result !== 'ok') { if (kind === 'probe') probing = null; else shown = null; paint(); say(api.outcomeWords(lang(), out), 'err'); return; }
    if (kind === 'probe') probing = out.value; else shown = { kind, value: out.value };
    say('', 'ok'); paint();
  } finally { button.disabled = false; }
}

if (api !== null && may.read) {
  $('sp').hidden = false;
  $('sp-asof').value = api.today();
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('sp-papers').addEventListener('click', () => run($('sp-papers'), 'papers', () => session.compliance($('sp-partner').value, $('sp-asof').value)));
  $('sp-statement').addEventListener('click', () => run($('sp-statement'), 'statement', () => session.statement($('sp-partner').value)));
  $('sp-probe').addEventListener('click', () => run($('sp-probe'), 'probe', () => session.probing()));
}
