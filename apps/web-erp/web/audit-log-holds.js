// Audit log — legal holds, what may be reviewed for deletion, and the evidence pack (W5 · M34-FR-01 · M34-FR-02 · hard
// rule #6). The session (apps/web-erp/src/legal-holds-session.ts, in the bundle as window.legalHolds) does every call and
// every rule; this script lays out three sections under the search, check and rebuild that audit-log.js shows. It reads the
// holds as it opens; placing, lifting, reading the plan and making a pack are explicit presses. Nothing here deletes
// anything. Every word added here has a Tamil twin; the page's language toggle (audit-log.js) changes both. Head office's
// own sentences (a refusal, an explanation) stay in English (OB-553). No prompt/confirm/alert; nothing on a timer.

const $ = (id) => document.getElementById(id);
const api = window.legalHolds ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, hold: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const when = (iso) => (api === null || iso === undefined ? (iso ?? '') : api.moment(iso));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let holds = null; let plan = null; let pack = null; let fileUrl = null;

function covers(h) {
  const parts = [];
  if (h.objectType !== undefined) parts.push(`${t('kindOf')} ${h.objectType}`);
  if (h.objectId !== undefined) parts.push(`${t('oneThing')} ${h.objectId}`);
  if (h.actorId !== undefined) parts.push(`${t('person')} ${h.actorId}`);
  if (h.from !== undefined) parts.push(`${t('fromDay')} ${session.dayOf(h.from)}`);
  // "until" is the shop's midnight AFTER the last day held — said back as that last day.
  if (h.until !== undefined) parts.push(`${t('untilDay')} ${session.dayOf(new Date(Date.parse(h.until) - 1).toISOString())}`);
  return parts.length === 0 ? t('everything') : parts.join(' · ');
}

function paintHolds() {
  $('hold-list').replaceChildren();
  if (holds === null) return;
  $('hold-list').append(...(holds.length === 0 ? [text('li', t('noHolds'), 'meta')] : holds.map((h) => {
    const li = document.createElement('li'); li.dataset.hold = h.holdId; li.dataset.state = h.liftedAt === undefined ? 'in-force' : 'lifted';
    li.className = h.liftedAt === undefined ? 'tone-degraded' : '';
    li.append(text('h4', `${h.liftedAt === undefined ? `⏸ ${t('inForce')}` : `✓ ${t('lifted')}`} — ${h.reason}`),
      text('p', `${t('covers')}: ${covers(h)}`, 'meta'), text('p', `${t('placedBy')} ${h.placedBy} · ${when(h.placedAt)}`, 'meta'));
    if (h.liftedAt !== undefined) li.append(text('p', `${t('liftedBy')} ${h.liftedBy ?? ''} · ${when(h.liftedAt)}`, 'meta'));
    else if (may.hold) {
      const acts = document.createElement('div'); acts.className = 'row-form';
      const why = document.createElement('input'); why.className = 'lift-why'; why.setAttribute('aria-label', t('liftWhy')); why.placeholder = t('liftWhy');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet lift-go'; b.textContent = t('liftGo');
      b.addEventListener('click', async () => {
        b.disabled = true;
        const out = await session.lift(h.holdId, why.value);
        $('holds-status').textContent = out.result === 'ok' ? t('liftedDone') : api.outcomeWords(lang(), out);
        if (out.result === 'ok') await loadHolds(); else b.disabled = false;
      });
      acts.append(why, b); li.append(acts);
    }
    return li;
  })));
}

function paintPlan() {
  $('plan-rows').replaceChildren();
  if (plan === null) return;
  $('plan-status').textContent = `${t('asOfDay')} ${plan.asOf}: ${plan.assessed} ${t('assessed')} · ${plan.held} ${t('held')} · ${plan.statutory} ${t('statutory')} · ${plan.noPolicy} ${t('noPolicy')} · ${plan.eligible.length} ${t('eligible')}`;
  $('plan-rows').append(...(plan.eligible.length === 0 ? [text('li', t('noneEligible'), 'meta')] : plan.eligible.map((d) => {
    const li = text('li', `#${d.sequence} · ${d.objectType} ${d.objectId} · ${when(d.at)} — ${d.explanation}`); li.dataset.sequence = String(d.sequence); return li;
  })));
}

function save() {
  if (pack === null) return;
  if (fileUrl !== null) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(new Blob([pack.file], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = fileUrl; a.download = pack.fileName; document.body.append(a); a.click(); a.remove();
}

function paintPack() {
  $('k-again').hidden = pack === null;
  if (pack === null) return;
  $('pack-status').textContent = `${pack.sourceIntact ? '✓' : '✕'} ${t('packMade')}: ${pack.from} → ${pack.until} · ${pack.records} ${t('records')} · ${pack.sourceIntact ? t('sealOk') : t('sealBroken')}`;
}

function paint() {
  if (api === null) return;
  for (const n of document.querySelectorAll('#holds [data-w], #plan [data-w], #pack [data-w]')) n.textContent = t(n.dataset.w);
  paintHolds(); paintPlan(); paintPack();
}

async function loadHolds() {
  const out = await session.holds();
  holds = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') $('holds-status').textContent = api.outcomeWords(lang(), out);
  paintHolds();
}

new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

if (api !== null && may.named && may.read) {
  for (const id of ['holds', 'plan', 'pack']) $(id).hidden = false;
  $('hold-form').hidden = !may.hold;
  if (!may.hold) $('holds-status').textContent = t('cannotHold');
  $('hold-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await session.place({ reason: $('h-reason').value, objectType: $('h-type').value, objectId: $('h-id').value, actorId: $('h-actor').value, fromDay: $('h-from').value, untilDay: $('h-until').value });
    $('holds-status').textContent = out.result === 'ok' ? t('placed') : api.outcomeWords(lang(), out);
    if (out.result === 'ok') { $('hold-form').reset(); await loadHolds(); }
  });
  $('p-go').addEventListener('click', async () => {
    $('plan-status').textContent = t('reading');
    const out = await session.plan();
    plan = out.result === 'ok' ? out.value : null;
    if (out.result !== 'ok') $('plan-status').textContent = api.outcomeWords(lang(), out);
    paintPlan();
  });
  $('pack-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pack-status').textContent = t('reading');
    const out = await session.pack($('k-from').value, $('k-until').value);
    pack = out.result === 'ok' ? out.value : null;
    if (out.result !== 'ok') $('pack-status').textContent = api.outcomeWords(lang(), out);
    paintPack();
    save();
  });
  $('k-again').addEventListener('click', save);
  paint();
  void loadHolds();
}
