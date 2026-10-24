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
const when = (iso) => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : '');
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
  el('relabel-rows').replaceChildren(...(read.tasks.length === 0 ? [text('li', w('none'), 'muted')] : read.tasks.map((r) => {
    const li = document.createElement('li'); li.className = `row tone-${r.done !== null ? 'ok' : r.dueNow ? 'degraded' : 'idle'}`; li.dataset.task = r.taskId; li.dataset.product = r.productId;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('strong', `${w('product')} ${r.productId} · ${w('newPrice')} ${rupees(r.priceMinor)}`), text('span', r.done !== null ? `✓ ${w('done')}` : r.dueNow ? `⚠ ${w('dueNow')}` : w('notYet'), 'state'));
    li.append(head, text('span', `${r.branchId} · ${w('place')}: ${r.locationId ?? w('notOnPlan')} · ${w('from')} ${when(r.dueAt)} · ${w(r.because)}`, 'facts'));
    // OB-358: who it is for — the department's floor champion, else the store manager (and why); the reader's own marked.
    const forWho = text('span', api.assigneeWords(lang(), r), 'facts for'); forWho.dataset.assignee = r.assignee ? r.assignee.to : 'none'; li.append(forWho);
    if (r.done !== null) li.append(text('span', `${w('done')} ${w('doneBy')} ${r.done.doneBy} · ${when(r.done.doneAt)} · ${rupees(r.done.shelfPriceMinor)}`, 'facts'));
    else if (session.may.close) {
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
    }
    return li;
  })));
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
