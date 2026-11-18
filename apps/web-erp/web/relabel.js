// The relabel tasks on the Store tasks page (D11-FR-03) — drawn under the task board (store-tasks.js). The session
// (apps/web-erp/src/relabel-session.ts, in the bundle as window.relabel) does every call; this file lays out what it is
// told. Closing a task is an explicit click with the price the new label shows and the photo reference; head office
// refuses a label showing another price and the task stays open. Every word has a Tamil twin; buttons carry an icon.

const el = (id) => document.getElementById(id);
const api = window.relabel ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (api === null ? k : api.words(lang(), k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const rupees = (m) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');
let read = null;
// OB-358: on the My tasks page the section reads only the tasks that go to me (data-scope="mine").
const mine = () => el('relabel')?.dataset.scope === 'mine';
const mayRead = () => session !== null && (mine() ? session.may.readMine : session.may.read);

function field(words, control) { const l = document.createElement('label'); l.append(text('span', words), control); return l; }
function paint() {
  if (!mayRead()) { el('relabel').hidden = true; return; }
  el('relabel').hidden = false;
  el('relabel-h').textContent = w(mine() ? 'relabelMineH' : 'relabelH'); el('relabel-lead').textContent = w('relabelLead');
  if (read === null) return;
  el('relabel-open').textContent = `${read.open} ${w('open')}`;
  // D-026: the first price load is ONE grouped item with its count — its labels are to check, not a flood of "due now".
  const isFirst = (r) => r.firstLabel === true && r.done === null && (r.replacedBy === undefined || r.replacedBy === null);
  const first = read.tasks.filter(isFirst);
  const rest = read.tasks.filter((r) => !isFirst(r));
  const items = rest.map(rowOf);
  if (first.length > 0) {
    const group = document.createElement('li'); group.className = 'row tone-idle first-load'; group.dataset.firstLoad = String(first.length);
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('strong', w('firstLoadH')), text('span', `${first.length} ${w('firstLoadCount')}`, 'state'));
    const more = document.createElement('details'); more.append(text('summary', w('firstLoadShow')));
    const inner = document.createElement('ul'); inner.className = 'rows'; inner.replaceChildren(...first.map(rowOf)); more.append(inner);
    group.append(head, text('span', w('firstLoadLead'), 'facts'), more);
    items.push(group);
  }
  el('relabel-rows').replaceChildren(...(read.tasks.length === 0 ? [text('li', w('none'), 'muted')] : items));
}
function rowOf(r) {
  // D-026: a task a newer price in force has replaced is shown as such, settled — no label to print at its old price.
  const replaced = r.done === null && r.replacedBy !== undefined && r.replacedBy !== null ? r.replacedBy : null;
  const li = document.createElement('li'); li.className = `row tone-${r.done !== null || replaced !== null ? 'ok' : r.dueNow ? 'degraded' : 'idle'}`; li.dataset.task = r.taskId; li.dataset.product = r.productId;
  if (replaced !== null) li.dataset.replaced = replaced.taskId;
  const head = document.createElement('div'); head.className = 'head';
  const item = typeof api.itemWords === 'function' ? api.itemWords(lang(), r) : `${w('product')} ${r.productId}`;
  head.append(text('strong', `${item} · ${w('newPrice')} ${rupees(r.priceMinor)}`), text('span', r.done !== null ? `✓ ${w('done')}` : replaced !== null ? `${w('replaced')} ${rupees(replaced.priceMinor)}` : r.dueNow ? `⚠ ${w('dueNow')}` : r.waitingForTills === true ? w('waitingForTills') : r.firstLabel === true ? w('firstLabel') : w('notYet'), 'state'));
  li.append(head, text('span', `${r.branchId} · ${w('place')}: ${r.locationId ?? w('notOnPlan')} · ${w('from')} ${when(r.dueAt)} · ${w(r.because)}`, 'facts'));
  // OB-358: who it is for — the department's floor champion, else the store manager (and why); the reader's own marked.
  const forWho = text('span', api.assigneeWords(lang(), r), 'facts for'); forWho.dataset.assignee = r.assignee ? r.assignee.to : 'none'; li.append(forWho);
  if (r.done !== null) li.append(text('span', `${w('done')} ${w('doneBy')} ${r.done.doneBy} · ${when(r.done.doneAt)} · ${rupees(r.done.shelfPriceMinor)}`, 'facts'));
  else if (replaced !== null) li.append(text('span', `${w('replacedNoLabel')} ${w('from')} ${when(replaced.dueAt)}`, 'facts replaced'));
  else if (session.may.close && r.mayClose === true) { // OB-370: the assignee, or a store manager of this store
    const form = document.createElement('form');
    const price = document.createElement('input'); price.inputMode = 'decimal'; price.autocomplete = 'off'; price.className = 'rl-price';
    const photo = document.createElement('input'); photo.autocomplete = 'off'; photo.className = 'rl-photo';
    const b = document.createElement('button'); b.type = 'submit'; const i = icon('tag'); if (i !== null) b.append(i); b.append(text('span', w('close')));
    form.append(field(w('labelPrice'), price), field(w('photo'), photo), b);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = await session.close(r.taskId, price.value, photo.value);
      el('relabel-status').className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
      el('relabel-status').textContent = api.outcomeWords(lang(), out);
      if (out.result === 'ok') await load();
    });
    li.append(form);
  } else if (session.may.close) li.append(text('span', `🔒 ${w('notYoursToClose')}`, 'facts not-yours'));
  return li;
}
async function load() {
  if (!mayRead()) return;
  const o = await (mine() ? session.mine() : session.tasks());
  if (o.result === 'ok') read = o.value; else el('relabel-status').textContent = api.outcomeWords(lang(), o);
  paint();
}
el('lang').addEventListener('click', () => { paint(); });
paint();
void load();
