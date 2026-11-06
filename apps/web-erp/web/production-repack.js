// Repack a batch (Round 4d · M11-FR-03) — the Production page's repack form. The session
// (apps/web-erp/src/production-repack-session.ts, in the bundle as window.productionRepack) does the call and every rule;
// this draws the form in the shared office fields (window.sreOffice) and says what head office answered. Shown only to a
// person who may commit production. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.productionRepack ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const v = (id) => $(id)?.value ?? '';

function build() {
  const o = window.sreOffice ?? null;
  if (o === null || session === null || !session.may.repack) return;
  $('repack').hidden = false;
  $('repack-h').textContent = t('repackH'); $('repack-lead').textContent = t('repackLead'); $('repack-go-text').textContent = t('repack');
  const kept = new Map([...$('repack-fields').querySelectorAll('input, select')].map((i) => [i.id, i.value]));
  $('repack-fields').replaceChildren(
    // the departments the store computer last heard switched on; when it was never told, the department is typed (head office checks it)
    api.departments.length > 0 ? o.field({ id: 'rp-department', label: both('department'), type: 'select', required: true, options: api.departments.map((d) => ({ value: d, label: d })) })
      : o.field({ id: 'rp-department', label: both('department'), required: true }),
    o.field({ id: 'rp-product', label: both('product'), required: true }),
    o.field({ id: 'rp-location', label: both('location'), required: true, value: api.locationId ?? '' }),
    o.field({ id: 'rp-source', label: both('sourceBatch'), required: true }),
    o.field({ id: 'rp-new', label: both('newBatch'), required: true }),
    o.field({ id: 'rp-qty', label: both('qty'), required: true, inputmode: 'decimal' }),
    o.field({ id: 'rp-uom', label: both('uom'), type: 'select', options: api.uoms.map((u) => ({ value: u, label: both(`u_${u}`) })) }),
  );
  for (const [id, value] of kept) if ($(id) && value !== '') $(id).value = value;
}

$('repack-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const o = window.sreOffice ?? null;
  if (o !== null && !o.check($('repack-form'))) return;
  $('repack-status').textContent = t('saving');
  const out = await session.repack({ departmentId: v('rp-department'), productId: v('rp-product'), locationId: v('rp-location'), sourceBatchId: v('rp-source'), newBatchId: v('rp-new'), qty: v('rp-qty'), uom: v('rp-uom') });
  $('repack-status').textContent = out.result === 'ok' ? `${t('repacked')} ${out.value.expiresAt}; ${t('awaiting')}` : api.outcomeWords(lang(), out);
});
document.addEventListener('sre:chrome', build);
new MutationObserver(build).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
build();
