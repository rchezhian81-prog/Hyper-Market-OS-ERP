import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEVICE_ITEM_STATES, RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { SHELF_COUNT_REFUSALS } from '../../packages/merchandising/src/index';
import { MERCHANDISING_GAPS } from '../../apps/web-erp/src/browser-entry';
import { SHELF_COUNTED } from '../../apps/web-erp/src/merchandising-session';
import { EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';

// The merchandising screen (SP-8c-ii · F08 · M04-FR-02/03 · WF-06 · §31 · P-01 · P-03 · P-08) counts a shelf BLIND and
// turns the refill tasks into ONE indent for the back store. Until SP-8c-ii both saves changed the page and nothing else
// (audit finding F08). These are static checks on the shipped view + shell — that it reads from the tested session (never
// re-deciding), that its writes go through the session onto the DURABLE device queue (the SAME queue as the Floor indents
// screen), only on an explicit click, that it says the five shared device states in words in both languages, that every
// refusal and gap has words in both languages, and that the relay is nudged after every save and when the page comes back
// — never on a timer. They cannot prove the screen is good — a merchandiser with a real shop does that — only that the
// decisions made deliberately are still there.

const RAW = readFileSync('apps/web-erp/web/merchandising.js', 'utf8');
const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // comments discuss on purpose
const HTML = readFileSync('apps/web-erp/web/merchandising.html', 'utf8');
const ROOT = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');

/** The `const NAME = {` … `};` block of the view, so a map can be checked key by key. */
const block = (name: string): string => {
  const from = VIEW.indexOf(`const ${name} = {`);
  expect(from, `${name} is not on the screen`).toBeGreaterThan(-1);
  return VIEW.slice(from, VIEW.indexOf('\n};', from));
};
const saysBoth = (map: string, key: string): void => {
  const line = block(map).split('\n').find((l) => l.trim().startsWith(`${key}: {`));
  expect(line, `"${key}" has no words on the screen (${map})`).toBeDefined();
  // Each entry is either one line `{ en: '…', ta: '…' }` or an `en:` / `ta:` pair on the following lines.
  const entry = block(map).slice(block(map).indexOf(`${key}: {`));
  const end = entry.indexOf('\n  },') === -1 ? entry.length : entry.indexOf('\n  },');
  const text = entry.slice(0, Math.max(end, entry.indexOf('}') + 1));
  expect(text, `"${key}" has no English (${map})`).toMatch(/\ben: '/);
  expect(text, `"${key}" has no Tamil (${map})`).toMatch(/\bta: '/);
};

describe('the merchandising screen is offered in both languages', () => {
  it('every word the screen names has English and Tamil', () => {
    const en = VIEW.slice(VIEW.indexOf('  en: {'), VIEW.indexOf('  ta: {'));
    const ta = VIEW.slice(VIEW.indexOf('  ta: {'), VIEW.indexOf('\n};'));
    const keys = [...en.matchAll(/^\s+([a-zA-Z]+): '/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(40);
    for (const key of keys) expect(ta, `no Tamil for ${key}`).toMatch(new RegExp(`\\b${key}: '`));
    for (const key of ['savedCounts', 'savedCountsLead', 'countKeptHere', 'countOnPage', 'raiseRefill', 'refillRaised', 'refillAlready', 'savedRefills', 'savedRefillsLead']) expect(keys).toContain(key);
  });

  it('says each of the five SHARED device states in words, in both languages — the same states as the manager\'s, the buyer\'s and the indents screens', () => {
    for (const state of DEVICE_ITEM_STATES) saysBoth('STATE_WORDS', state);
    expect(VIEW).toMatch(/words\(STATE_WORDS, w\.state\)/);
  });

  it('has words in both languages for every count refusal the engine can give, every refill refusal the session can give, and every gap the box can leave', () => {
    for (const refusal of SHELF_COUNT_REFUSALS) saysBoth('COUNT_REFUSAL_WORDS', refusal);
    for (const refusal of ['no_indent_link', 'nothing_to_fill', 'not_permitted', 'nobody_named', 'no_places', 'no_lines', 'bad_line', 'duplicate_product']) saysBoth('REFILL_REFUSAL_WORDS', refusal);
    for (const gap of MERCHANDISING_GAPS) saysBoth('GAP_WORDS', gap);
  });
});

describe('the view renders from the tested session and re-decides nothing', () => {
  it('reads window.merchandisingSession and never a figure of its own: the count, the check, the refills all come from the session', () => {
    expect(VIEW).toMatch(/window\.merchandisingSession/);
    expect(VIEW).toMatch(/session\.count\(/);
    expect(VIEW).toMatch(/session\.check\(\)/);
    expect(VIEW).toMatch(/session\.refills\(\)/);
    expect(VIEW).toMatch(/session\.savedCounts\(\)/);
  });

  it('issues NO write of its own — the count and the ask go onto the queue through the session; never a fetch, never storage, never a POST in the view', () => {
    expect(VIEW.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) ?? []).toEqual([]);
    expect(VIEW).not.toMatch(/\bfetch\(/);
    expect(VIEW).not.toMatch(/localStorage/);
    expect(VIEW).toMatch(/session\.raiseRefill\(\)/);
  });

  it('the writes run only on an explicit click — never on load, never on a timer', () => {
    expect(VIEW).toMatch(/el\('save-count'\)\.addEventListener\('click'/);
    expect(VIEW).toMatch(/el\('raise-refill'\)\.addEventListener\('click'/);
    expect(VIEW).toMatch(/el\('drop-item'\)\.addEventListener\('click'/);
    expect(VIEW).not.toMatch(/setInterval\(/);
    expect(VIEW).not.toMatch(/setTimeout\(/);
  });

  it('nudges the shared relay after every save and whenever the page comes back (online · focus · pageshow · visible) — the queue, not this file, is the record', () => {
    expect(VIEW).toMatch(/window\.merchandisingRelay/);
    expect(VIEW).toMatch(/relay\.syncNow\(\)/);
    expect((VIEW.match(/void syncToBox\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(VIEW).toMatch(/\['online', 'focus', 'pageshow'\]/);
    expect(VIEW).toMatch(/visibilitychange/);
  });

  it('never asks its questions with a browser dialog, and shows every refusal through the maps — the view invents no wording', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
    expect(VIEW).toMatch(/words\(COUNT_REFUSAL_WORDS, outcome\.refusal\)/);
    expect(VIEW).toMatch(/words\(REFILL_REFUSAL_WORDS, outcome\.refusal\)/);
    expect(VIEW).toMatch(/words\(NO_PLAN_WORDS, check\.why\)/);
  });

  it('the counting field shows NOTHING about what the facing should hold — no expected, capacity or planned figure reaches the count form', () => {
    const countView = VIEW.slice(VIEW.indexOf('function renderCount()'), VIEW.indexOf('function renderRefill()'));
    expect(countView).not.toMatch(/expected|capacity|planned/i);
  });

  it('the refill button is hidden until the session says this reader may raise, and says "already asked" instead of asking twice', () => {
    expect(HTML).toMatch(/<button id="raise-refill" class="primary wide" type="button" hidden>/);
    expect(VIEW).toMatch(/el\('raise-refill'\)\.hidden = !refills\.canRaise/);
    expect(VIEW).toMatch(/el\('raise-refill'\)\.disabled = refills\.alreadySaved/);
    expect(HTML).toMatch(/<ul class="saved" id="saved-counts"/);
    expect(HTML).toMatch(/<ul class="saved" id="saved-refills"/);
  });
});

describe('the composition root: one queue, one relay, one record (SP-8c-ii)', () => {
  it('boots the merchandising screen over the SAME durable queue the Floor indents screen opens for the store, and raises the refill indent through the Indents session', () => {
    expect(ROOT).toMatch(/openIndentsOutbox\(merchandisingData\.storeId \?\? 'store-1'\)/);
    expect(ROOT).toMatch(/refillIndentPortOf\(refillIndents\)/);
    expect(ROOT).toMatch(/openQueueRelay\(browserWindow\.laneWriteBase, merchandisingOutbox/);
    // Nobody named is nobody — the screen never counts in a made-up name.
    expect(ROOT).toMatch(/userId: data\.userId \?\? '',/);
    expect(ROOT).not.toMatch(/userId: data\.userId \?\? 'merchandiser'/);
  });

  it('the count\'s event type is on the box\'s allow-list as the ERP surface and has ONE cloud route — the synced shelf-count route that re-verifies the counter', () => {
    expect(RELAYABLE_DEVICE_EVENTS[SHELF_COUNTED]?.surfaces).toEqual(['manager']);
    expect(EVENT_ROUTES[SHELF_COUNTED]).toBe('/v1/merchandising/shelf-counts/:countId/synced');
  });
});
