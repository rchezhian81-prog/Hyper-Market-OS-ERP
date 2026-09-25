// Data-protection officer's erasure console — the THIN CLIENT (M20-FR-04 / DPDP, owner decision).
//
// It holds no erasure logic. It reads the located PII for a verified request, and drives the two-person
// control: a checker approves, then a different maker executes. The backend runs the production
// @sre/customer engines and returns the outcome. In production that backend is the cloud privacy API; in the
// browser E2E it is a local Node server running the same engines.

const $ = (id) => document.getElementById(id);
const CUSTOMER = 'cust-1';

const setStatus = (el, text, kind = '') => { el.textContent = text; el.className = `status ${kind}`.trim(); };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}
async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  return res.json();
}

function renderPii(categories) {
  const rows = $('rows');
  rows.textContent = '';
  for (const c of categories) {
    const tr = document.createElement('tr');
    tr.dataset['category'] = c.category;
    const name = document.createElement('td'); name.textContent = c.category;
    const count = document.createElement('td'); count.textContent = String(c.recordCount);
    const st = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${c.state}`;
    pill.textContent = c.state;
    pill.dataset['state'] = c.state;
    st.appendChild(pill);
    tr.append(name, count, st);
    rows.appendChild(tr);
  }
}

async function refresh() {
  const data = await getJson(`/pii/${CUSTOMER}`);
  renderPii(data.categories ?? []);
}

function renderTombstone(t) {
  $('tomb-empty').hidden = true;
  $('tomb').hidden = false;
  $('t-erased').textContent = t.categoriesErased.length ? t.categoriesErased.join(', ') : '—';
  $('t-minimised').textContent = t.categoriesMinimised.length ? t.categoriesMinimised.join(', ') : '—';
  $('t-retained').textContent = t.categoriesRetained.length ? t.categoriesRetained.map((c) => c.category).join(', ') : '—';
  $('t-people').textContent = `${t.checker} → ${t.maker}`;
}

$('locate').addEventListener('click', () => { void refresh(); });

$('approve').addEventListener('click', async () => {
  const out = await post(`/approve`, { approver: $('actor').value.trim() });
  if (out.status === 200) setStatus($('status'), `Approved by ${$('actor').value.trim()}. Now a DIFFERENT person must execute.`, 'good');
  else setStatus($('status'), out.body.detail ?? 'Could not approve.', 'err');
});

$('execute').addEventListener('click', async () => {
  const out = await post(`/execute`, { maker: $('actor').value.trim() });
  if (out.status === 200) {
    setStatus($('status'), `Erasure carried out (${out.body.state}). ${out.body.notices.length} processor(s) notified.`, 'good');
    renderTombstone(out.body.tombstone);
    await refresh();
  } else if (out.body.code === 'checker_missing') {
    setStatus($('status'), 'A second, authorised officer must approve first — an erasure needs two people.', 'err');
  } else if (out.body.code === 'maker_is_checker') {
    setStatus($('status'), 'The person who approved cannot also run it. Change the acting-as id to a different officer.', 'err');
  } else {
    setStatus($('status'), out.body.detail ?? 'Could not execute.', 'err');
  }
});

$('restore').addEventListener('click', async () => {
  const out = await post(`/pii/${CUSTOMER}/marketing_profile`, { recordCount: 1 });
  if (out.status === 200 || out.status === 201) {
    setStatus($('restore-status'), 'Re-added (no erasure on record).', 'warn');
    await refresh();
  } else if (out.body.code === 'subject_was_erased') {
    setStatus($('restore-status'), 'Refused — this person was erased. Re-creating their data needs a new lawful basis, not a silent restore.', 'good');
  } else {
    setStatus($('restore-status'), out.body.detail ?? 'Refused.', 'err');
  }
});

void refresh();
