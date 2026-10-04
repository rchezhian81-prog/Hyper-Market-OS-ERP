#!/usr/bin/env node
/*
 * Isolated prototype logic verification. No browser engine or real DOM is used.
 * Run: node source/verify.cjs   (or node verify.cjs from source/).
 * Native form validation, DOM parsing, layout, accessibility, focus and real
 * browser interaction remain unverified by this script.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(__dirname, 'app.js');
const architecturePath = path.join(root, 'architecture.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'));
const cases = [];
const routeCounts = {};
let renderedPageCount = 0;
let checkedLinks = 0;

function environment(initialHash = '') {
  const nodes = new Map();
  const listeners = new Map();
  const history = [];
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        innerHTML: '', textContent: '', value: '', open: false,
        classList: {
          add(...names) { names.forEach(n => classes.add(n)); },
          remove(...names) { names.forEach(n => classes.delete(n)); },
          toggle(name, force) { const enabled = force ?? !classes.has(name); enabled ? classes.add(name) : classes.delete(name); return enabled; },
          contains(name) { return classes.has(name); }
        },
        showModal() { this.open = true; }, close() { this.open = false; },
        focus() {}, setSelectionRange() {}, removeAttribute() {},
        click() {}, addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 600 }; }
      });
    }
    return nodes.get(selector);
  }
  const sandbox = {
    ARCH: structuredClone(architecture),
    iconSvg: name => `<svg data-test-icon="${name}"></svg>`,
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      createElement: () => node('created-element'),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      }
    },
    location: { hash: initialHash },
    history: { replaceState(_state, _title, url) { history.push(url); } },
    window: { scrollTo() {} },
    FormData: class { constructor(form) { this.values = form.values; } [Symbol.iterator]() { return Object.entries(this.values)[Symbol.iterator](); } },
    setTimeout: () => 1,
    clearTimeout() {},
    console,
    Blob,
    URL: { createObjectURL: () => 'blob:isolated-preview-test', revokeObjectURL() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath });
  const evaluate = code => vm.runInContext(code, sandbox);
  const dispatch = (type, event) => {
    assert.ok(listeners.get(type)?.length, `Missing ${type} listener`);
    for (const listener of listeners.get(type)) listener(event);
  };
  const submit = (id, values, dataset = {}) => dispatch('submit', { preventDefault() {}, target: { id, values, dataset, reportValidity: () => true } });
  const click = (action, data = {}) => {
    const button = { dataset: { action, ...data } };
    dispatch('click', { target: { closest: selector => selector === '[data-action]' ? button : null } });
  };
  return { evaluate, node, submit, click, history, dispatch };
}
function check(name, fn) {
  try { const detail = fn(); cases.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); }
  catch (error) { cases.push({ name, status: 'failed', error: error.stack || String(error) }); }
}
function inspectLinks(html, label) {
  assert.ok(html.length > 20, `Empty render: ${label}`);
  assert.ok(!/\b(?:undefined|NaN)\b/.test(html), `Undefined or NaN text: ${label}`);
  for (const match of html.matchAll(/data-go="([^"]*)"/g)) {
    const [moduleId, pageId, extra] = match[1].split('/');
    const module = architecture.modules.find(m => m.id === moduleId);
    assert.ok(module, `Unknown module link ${match[1]} on ${label}`);
    assert.ok(!extra, `Malformed route ${match[1]} on ${label}`);
    if (pageId) assert.ok(module.pages.some(p => p.id === pageId), `Unknown page link ${match[1]} on ${label}`);
    checkedLinks++;
  }
}

check('Architecture contains 147 unique page destinations', () => {
  const routes = architecture.modules.flatMap(m => m.pages.map(p => `${m.id}/${p.id}`));
  assert.equal(routes.length, 147);
  assert.equal(new Set(routes).size, routes.length);
});
check('Owner renders all 147 pages and every module landing; emitted page links resolve', () => {
  const env = environment(); env.evaluate("state.role='owner'");
  for (const module of architecture.modules) {
    env.evaluate(`navigate(${JSON.stringify(module.id)})`);
    inspectLinks(env.node('#main').innerHTML, module.id + ' landing');
    for (const page of module.pages) {
      const route = `${module.id}/${page.id}`;
      env.evaluate(`navigate(${JSON.stringify(route)})`);
      assert.equal(env.evaluate('state.module+"/"+state.page'), route);
      inspectLinks(env.node('#main').innerHTML, route);
      inspectLinks(env.node('#nav').innerHTML, route + ' navigation');
      renderedPageCount++;
    }
  }
  assert.equal(renderedPageCount, 147);
});
check('Every allowed page renders for all seven roles; role homes are accessible', () => {
  const env = environment();
  for (const role of ['owner', 'manager', 'buyer', 'warehouse', 'floor', 'cashier', 'finance']) {
    env.dispatch('change', { target: { id: 'role', value: role } });
    const home = env.evaluate('state.module+"/"+state.page');
    assert.equal(home, ['owner', 'manager'].includes(role) ? 'overview/dashboard' : 'overview/my-work');
    inspectLinks(env.node('#main').innerHTML, `${role} home`);
    let count = 0;
    for (const module of architecture.modules) for (const page of module.pages) {
      if (role !== 'owner' && !(page.roles || module.roles || []).includes(role)) continue;
      const route = `${module.id}/${page.id}`;
      env.evaluate(`navigate(${JSON.stringify(route)})`);
      assert.equal(env.evaluate('state.module+"/"+state.page'), route, `${role}: ${route}`);
      inspectLinks(env.node('#main').innerHTML, `${role}: ${route}`);
      count++;
    }
    routeCounts[role] = count;
  }
  return routeCounts;
});
check('Restricted initial link and invalid route render safe home', () => {
  const env = environment('#admin/users-roles');
  assert.equal(env.evaluate('state.module+"/"+state.page'), 'overview/dashboard');
  inspectLinks(env.node('#main').innerHTML, 'restricted initial route');
  env.evaluate("state.role='cashier';navigate('admin/users-roles')");
  assert.equal(env.evaluate('state.module+"/"+state.page'), 'overview/my-work');
  env.evaluate("navigate('does-not-exist/missing')");
  assert.equal(env.evaluate('state.module+"/"+state.page'), 'overview/my-work');
});
check('Received is exact, Open retains partial receipts, and cash status groups match', () => {
  const env = environment();
  assert.ok(env.evaluate("state.filter='Received';filtered(PO).every(r=>r.status==='Received')"));
  assert.ok(env.evaluate("state.filter='Open';filtered(PO).some(r=>r.status==='Partially received')"));
  assert.equal(env.evaluate("state.filter='Short';filtered(CASH).length"), 1);
});
check('Purchase-order submit creates visible draft with decimal unit cost', () => {
  const env = environment(); env.evaluate("navigate('purchase/purchase-orders')");
  env.submit('record-form', { supplier: 'Preview supplier', product: 'Rice sample', quantity: '3', cost: '1.25', notes: 'Test draft' }, { form: 'create-po' });
  assert.equal(env.evaluate('PO[0].name'), 'Preview supplier');
  assert.equal(env.evaluate('PO[0].amount'), 3.75);
  assert.equal(env.evaluate('PO[0].status'), 'Draft');
  assert.ok(env.node('#main').innerHTML.includes('Preview supplier'));
  assert.ok(env.node('#main').innerHTML.includes('₹3.75'));
});
check('Prepending a new indent does not redirect the floor receipt; repeat receipt is blocked', () => {
  const env = environment(); env.evaluate("state.role='floor';navigate('floor/floor-indents')");
  env.submit('record-form', { supplier: 'Preview aisle', product: 'Soap sample', quantity: '8', cost: 'Demo record', notes: 'Shelf refill' }, { form: 'raise-indent' });
  const newId = env.evaluate('INDENTS[0].id');
  assert.equal(env.evaluate('INDENTS[0].name'), 'Preview aisle');
  env.evaluate("navigate('floor/floor-receiving')");
  env.click('floor-count');
  assert.ok(env.node('#modal-content').innerHTML.includes('IND-0247'));
  env.submit('floor-form', { units: '30', condition: 'Good condition', reason: 'Six units missing' });
  assert.equal(env.evaluate("INDENTS.find(r=>r.id==='IND-0247').received"), '30 units');
  assert.equal(env.evaluate(`INDENTS.find(r=>r.id===${JSON.stringify(newId)}).received`), '—');
  assert.ok(env.node('#main').innerHTML.includes('30 units counted'));
  env.submit('floor-form', { units: '36', condition: 'Good condition', reason: '' });
  assert.equal(env.evaluate("INDENTS.find(r=>r.id==='IND-0247').received"), '30 units');
});
check('Zero floor receipt is retained with a discrepancy reason', () => {
  const env = environment(); env.evaluate("state.role='floor';navigate('floor/floor-receiving')");
  env.submit('floor-form', { units: '0', condition: 'Good condition', reason: 'Nothing arrived' });
  assert.equal(env.evaluate("INDENTS.find(r=>r.id==='IND-0247').received"), '0 units');
  assert.ok(env.node('#main').innerHTML.includes('0 units counted'));
});
check('Receipt draft with textual reference never computes a NaN amount', () => {
  const env = environment(); env.evaluate("navigate('receiving/goods-receipts')");
  env.submit('record-form', { supplier: 'Preview supplier', product: 'Rice sample', quantity: '2', cost: 'Demo reference', notes: 'Receipt draft' }, { form: 'receive' });
  env.evaluate("showDetail('grn',GRN[0].id)");
  assert.ok(!env.node('#detail-content').innerHTML.includes('NaN'));
  assert.ok(env.node('#detail-content').innerHTML.includes('Preview draft · not sent'));
});
check('Page-specific generic draft is visible and remains a draft despite typed status', () => {
  const env = environment(); env.evaluate("navigate('orders/route-assignment');createForm('new-generic')");
  const form = env.node('#modal-content').innerHTML;
  assert.ok(form.includes('Driver') && form.includes('Device'));
  assert.ok(!form.includes('Product / item'));
  env.submit('generic-form', { 'field-0': 'Sample Run 900', 'field-1': 'Route 2', 'field-2': 'Demo driver', 'field-3': 'Demo phone', 'field-4': '3', 'field-5': 'Approved' });
  assert.ok(env.node('#main').innerHTML.includes('Sample Run 900'));
  assert.equal(env.evaluate("state.genericRecords['orders/route-assignment'][0].status"), 'Draft');
  assert.equal(env.evaluate("state.genericRecords['orders/route-assignment'][0].values['Assignment state']"), 'Draft');
});
check('POS underpayment preserves basket; valid payment clears basket and shows exact change', () => {
  const env = environment(); env.evaluate("state.role='cashier';navigate('sales/point-of-sale')");
  env.click('pos-add', { id: 'SKU-0012' });
  env.click('pos-add', { id: 'SKU-0012' });
  assert.equal(env.evaluate('state.basket[0].qty'), 2);
  env.click('pos-pay');
  env.submit('payment-form', { cash: '100' });
  assert.equal(env.evaluate('state.basket[0].qty'), 2);
  assert.ok(env.node('#payment-error').textContent.includes('less than'));
  env.submit('payment-form', { cash: '200' });
  assert.equal(env.evaluate('state.basket.length'), 0);
  assert.ok(env.node('#modal-content').innerHTML.includes('₹136.00'));
  assert.ok(env.node('#modal-content').innerHTML.includes('₹64.00'));
  assert.ok(env.node('#modal-content').innerHTML.includes('No real payment or ERP stock change'));
});
check('Numeric markup permits zero counts and paise amounts; absent money is a dash', () => {
  const env = environment();
  const cashField = env.evaluate("formField('Cash','cash','number','0')");
  assert.ok(cashField.includes('min="0"') && cashField.includes('step="0.01"'));
  const receiptField = env.evaluate("formField('Units','units','number','0',false,{min:0,step:1,max:36})");
  assert.ok(receiptField.includes('min="0"') && receiptField.includes('step="1"') && receiptField.includes('max="36"'));
  assert.equal(env.evaluate('money(undefined)'), '—');
});
check('Record note and selected customer are visibly retained within the session', () => {
  const env = environment(); env.evaluate("navigate('purchase/purchase-orders');showDetail('po','PO-1046')");
  env.submit('note-form', { note: 'Preview note: check delivery time.' });
  assert.ok(env.node('#detail-content').innerHTML.includes('Preview note: check delivery time.'));
  env.evaluate("navigate('sales/point-of-sale')");
  env.submit('customer-form', { name: 'Demo customer selected' });
  assert.ok(env.node('#main').innerHTML.includes('Demo customer selected'));
});

const failed = cases.filter(c => c.status === 'failed');
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  validationType: 'isolated JavaScript logic checks using a deliberately minimal DOM stub',
  browserValidated: false,
  scope: 'Design prototype only. No ERP backend, production system or real browser is tested.',
  limitations: [
    'No browser engine or real DOM parser was executed.',
    'CSS layout, visual appearance, responsive behaviour, accessibility and focus are not validated.',
    'FormData and reportValidity are stubbed; native browser validation is not exercised.',
    'Clicks and submissions invoke registered handlers with synthetic events; this does not prove real pointer or keyboard interaction.',
    'No persistence across page reloads, real payments, stock posting, API calls or authorization security is tested.'
  ],
  source: {
    appSha256: crypto.createHash('sha256').update(source).digest('hex'),
    architectureSha256: crypto.createHash('sha256').update(fs.readFileSync(architecturePath)).digest('hex')
  },
  totals: { passed: cases.length - failed.length, failed: failed.length, ownerPagesRendered: renderedPageCount, renderedRoutesByRole: routeCounts, emittedPageLinksChecked: checkedLinks },
  cases,
  result: failed.length ? 'failed' : 'passed'
};
fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, ...report.totals, browserValidated: false, output: path.join(root, 'verification.json') }, null, 2));
for (const failure of failed) console.error(failure.name + '\n' + failure.error);
process.exitCode = failed.length ? 1 : 0;
