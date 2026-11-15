// OB-773 (owner, 15 Nov 2026, choice 3 B · audit C-8 · M03-FR-01/02/03 · §28 · ADR-0024 · hard rules 2, 5, 10): "The store
// manager may make changes, and you (the owner) approve them."
//
// Only the owner holds `catalogue.pack.publish`, the authority head office checks to save an item, give it a barcode and set
// a GST rate — so every pilot item fix waited on the owner. Now the store manager PROPOSES the change and the owner approves
// it; nothing changes until he does. Built on the existing two-person engine, inventing nothing:
//
//   1. The manager proposes (`POST /v1/catalogue/changes`, his own narrow word `catalogue.change.propose` — NOT the publish
//      authority). Head office records an approval request of kind `catalogue_change` through the engine's own route, with
//      EXACTLY the change (the body the catalogue route will receive, the version of the item he opened) and, worked out by
//      head office, what each field is now and what it would become. Nothing in the catalogue changes.
//   2. The owner sees it on his Approvals page with the before and after, and approves or refuses it with a reason, in his
//      own session (`POST /v1/approvals/requests/:requestId/decide`). The engine refuses the manager deciding his own, and
//      anyone without the publish authority (the kind's checker).
//   3. On the owner's approval, head office MAKES exactly that change at once, through the ordinary catalogue route, as the
//      owner's own act (the CR-01 step 6b pattern: found on the finished surface at that moment, so every wrapper and check
//      on the route still speaks — the GST/GS1 checks, the one-code-one-item rule, the Finance approval of a tax change, the
//      second person for an age-limited item). The approval is spent once; the outcome — made, or NOT made with the
//      route's own reason — is recorded once per request and sealed on the audit trail naming the approval, who proposed and
//      who approved. An item someone else saved after the manager opened it is NOT overwritten (hard rule 10): the change is
//      not made and the reason says so.
//   4. A refusal changes nothing; the engine keeps the owner's reason, and the audit trail records it.
//   5. OB-773 (3 B — the owner's answer to Q1, 15 Nov 2026): where the ordinary route ALSO needs Finance's approval (a
//      published item's HSN, OB-347; a change to an existing GST rate, M03 §28) or a second person's (an item made
//      age-limited or tobacco, OB-503), the owner's approval of the manager's proposal stands as that approval — the manager
//      asked, the owner who holds Finance's approval authority approved, so maker and checker are two different people,
//      which is what those rules protect. Narrowly: only while head office makes that very change, only when the proposer
//      is not the approver, and only when the approver holds the route's own checker permission (`catalogue.tax.approve`);
//      otherwise the route refuses as before. The change records which approval satisfied it, by whom, when
//      (`financeApproval`). The owner's direct edits are unchanged: they still need the second person.
//
// The owner keeps making these changes directly, as before. Publishing the store pack stays the owner's. No AI is involved
// (hard rule 5). Synthetic data only in tests (tests/integration/ob773-*.test.ts, tests/e2e/ob773-*.e2e.ts).

import { createHash } from 'node:crypto';
import { InMemoryEventStore, type EventStore, type PersistedEvent } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { ApiError, apiError, type Route, type RequestContext, type HandlerResult } from '../../kernel/src/index';
import { APPROVAL_KINDS, actionDetails, fingerprintOf, openApproval, whileMakingACatalogueChange, type ApprovalState } from '../../identity/src/approval-requests';
import { STREAM, streamName, approvalRequestsAdapter, productMasterAdapter, barcodeAdapter, taxClassAdapter } from './adapters';

export const CATALOGUE_CHANGE_KIND = 'catalogue_change';
/** The store manager's word: propose an item, barcode or GST change for the owner's approval. Never the publish authority. */
export const CATALOGUE_CHANGE_PROPOSE = 'catalogue.change.propose';

/** What a manager may propose, and the ONE ordinary catalogue route that makes each, once the owner approves. */
export const CATALOGUE_CHANGE_ROUTES = Object.freeze({
  product: Object.freeze({ method: 'POST', path: '/v1/catalogue/products/:productId/publish' }),
  product_safety: Object.freeze({ method: 'POST', path: '/v1/catalogue/products/:productId/safety' }),
  barcode: Object.freeze({ method: 'POST', path: '/v1/catalogue/products/:productId/barcodes/:code' }),
  tax_rate: Object.freeze({ method: 'POST', path: '/v1/catalogue/tax-classes/:hsnCode/rates/:effectiveFrom' }),
} as const);
export type CatalogueChange = keyof typeof CATALOGUE_CHANGE_ROUTES;

/** One field as it is now and as the change would make it — worked out by head office, shown to the owner. */
export interface FieldChange { readonly field: string; readonly before: string; readonly after: string }

/** The outcome of an approved change, recorded once per request. */
export interface CatalogueChangeOutcome {
  readonly requestId: string;
  readonly change: CatalogueChange | 'unknown';
  readonly applied: boolean;
  readonly proposedBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly route: string;
  readonly at: string;
  /**
   * OB-773 (3 B): when the ordinary route also needed Finance's (or a second person's) approval — a published item's HSN,
   * a change to an existing GST rate, an item made age-limited or tobacco — THIS approval stood as it: by whom, when, and
   * which approval the route recorded as spent.
   */
  readonly financeApproval?: { readonly satisfiedBy: string; readonly approvedBy: string; readonly approvedAt: string; readonly usedFor: string; readonly rule: string };
  /** Not applied: the route's (or head office's) code and words. */
  readonly code?: string;
  readonly reason?: string;
  readonly detail: string;
}

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 20);
const outcomesStream = (): string => streamName(STREAM.catalogue, 'change-outcomes');

/** Plain words for one value (a field's before or after) — never code where words will do. */
function words(field: string, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (field === 'mrpHistory' && Array.isArray(v)) {
    return v.map((m) => (isObj(m) && isObj(m['value']) ? `₹${(Number(m['value']['minor']) / 100).toFixed(2)} from ${String(m['effectiveFrom'] ?? '?')}` : JSON.stringify(m))).join('; ');
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length === 0 ? 'none' : v.join(', ');
  const text = JSON.stringify(v);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
/** Every field whose value differs between `before` and `after`, as words. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>, prefix = '', skip: ReadonlySet<string> = new Set()): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !skip.has(k)).sort();
  return keys.filter((k) => canonical(before[k]) !== canonical(after[k]))
    .map((k) => ({ field: `${prefix}${k}`, before: words(k, before[k]), after: words(k, after[k]) }));
}
/** Fields head office keeps on a product record that a proposal never carries. */
const NOT_PROPOSED: ReadonlySet<string> = new Set(['productId', 'tenantId', 'appContent', 'tobaccoWarning', 'mrpReplacements', 'labelFactsFollow']);

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction = 'Nothing was sent and nothing changed. Correct it and send again.'): ApiError =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

/** What the manager sent, read into the exact act: the route, its address, its body and the version he opened. */
interface Proposed {
  readonly change: CatalogueChange;
  readonly subjectRef: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly expectedVersion?: number;
}

function readProposal(b: Record<string, unknown>): Proposed {
  const change = b['change'];
  const version = b['expectedVersion'];
  const versionOk = typeof version === 'number' && Number.isInteger(version) && version >= 0;
  const productId = isStr(b['productId']) ? b['productId'].trim() : '';
  switch (change) {
    case 'product': {
      if (!ID.test(productId) || !isObj(b['product']) || !versionOk) {
        throw refuse(400, 'not_readable_as_a_catalogue_change', 'An item change names the item (productId), the whole item as it should be (product) and the version of it you opened (expectedVersion: 0 for a new item).');
      }
      return { change, subjectRef: `product:${productId}`, params: { productId }, body: { product: b['product'] }, expectedVersion: version as number };
    }
    case 'product_safety': {
      if (!ID.test(productId) || !isObj(b['safety']) || !versionOk || (version as number) < 1) {
        throw refuse(400, 'not_readable_as_a_catalogue_change', 'A label-facts change names the item (productId), its safety and label facts as one object (safety) and the version of the item you opened (expectedVersion).');
      }
      // The safety save's own body: the version opened and the reason travel with it (the route checks both).
      return { change, subjectRef: `product:${productId}`, params: { productId }, body: { expectedVersion: version, safety: b['safety'], reason: String(b['reason'] ?? '').trim() }, expectedVersion: version as number };
    }
    case 'barcode': {
      const code = isStr(b['code']) ? b['code'].trim() : '';
      if (!ID.test(productId) || !/^[A-Za-z0-9_.-]{1,64}$/.test(code) || !isStr(b['kind'])) {
        throw refuse(400, 'not_readable_as_a_catalogue_change', 'A barcode change names the item (productId), the code (code) and its kind (ean, gtin, upc, internal, case or embedded).');
      }
      return {
        change, subjectRef: `product:${productId}`, params: { productId, code },
        body: { kind: b['kind'].trim(), ...(isStr(b['level']) ? { level: b['level'].trim() } : {}) },
      };
    }
    case 'tax_rate': {
      const hsnCode = isStr(b['hsnCode']) ? b['hsnCode'].trim() : '';
      const effectiveFrom = isStr(b['effectiveFrom']) ? b['effectiveFrom'].trim() : '';
      const rateBps = b['rateBps'];
      if (!/^[0-9A-Za-z]{2,12}$/.test(hsnCode) || !DATE.test(effectiveFrom) || !(typeof rateBps === 'number' && Number.isInteger(rateBps) && rateBps >= 0)) {
        throw refuse(400, 'not_readable_as_a_catalogue_change', 'A GST change names the HSN class (hsnCode), the date it starts (effectiveFrom, YYYY-MM-DD) and the rate in basis points (rateBps, e.g. 500 for 5%).');
      }
      return { change, subjectRef: `hsn:${hsnCode}`, params: { hsnCode, effectiveFrom }, body: { rateBps } };
    }
    default:
      throw refuse(400, 'not_readable_as_a_catalogue_change', `A catalogue change is one of: ${Object.keys(CATALOGUE_CHANGE_ROUTES).join(', ')}.`);
  }
}

const routeWords = (change: CatalogueChange): string => `${CATALOGUE_CHANGE_ROUTES[change].method} ${CATALOGUE_CHANGE_ROUTES[change].path}`;

/** Find a route on the finished surface, or stop start-up: a control that silently wires nothing is what P-08 forbids. */
function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`OB-773 wiring cannot find ${method} ${path} — the owner's approval of a manager's change would silently not happen`);
  return at;
}

/**
 * Wire OB-773 onto the finished surface (one line in main.ts, after the identity routes are swapped in): the manager's
 * proposal route, and the engine's ask / inbox / decide routes taught about `catalogue_change`.
 */
export function catalogueChangeSurface(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: Recorder;
}): void {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  const approvals = approvalRequestsAdapter({ store, now });
  const products = productMasterAdapter({ store, now });
  const barcodes = barcodeAdapter({ store, now });
  const taxes = taxClassAdapter({ store, now });
  for (const r of Object.values(CATALOGUE_CHANGE_ROUTES)) indexOf(surface, r.method, r.path);

  const askAt = indexOf(surface, 'POST', '/v1/approvals/requests');
  const engineAsk = surface[askAt]!.handler; // the engine's own route: the maker check, the fingerprint, the record

  // ── what the change does to what head office holds now (the before/after the owner reads) ────────────────────────────
  const changesOf = async (tenantId: string, p: Proposed): Promise<{ readonly changes: readonly FieldChange[]; readonly name: string; readonly heldVersion?: number }> => {
    switch (p.change) {
      case 'product': {
        const current = await products.product(tenantId, p.params['productId']!);
        const heldVersion = Number(await products.productVersion?.(tenantId, p.params['productId']!) ?? 0);
        const before = Object.fromEntries(Object.entries(current ?? {}).filter(([k]) => !NOT_PROPOSED.has(k)));
        const after = Object.fromEntries(Object.entries(p.body['product'] as Record<string, unknown>).filter(([k]) => !NOT_PROPOSED.has(k)));
        return { changes: diff(before, after), name: String((p.body['product'] as Record<string, unknown>)['name'] ?? current?.name ?? p.params['productId']), heldVersion };
      }
      case 'product_safety': {
        const current = await products.product(tenantId, p.params['productId']!);
        const heldVersion = Number(await products.productVersion?.(tenantId, p.params['productId']!) ?? 0);
        return { changes: diff((current?.safety ?? {}) as Record<string, unknown>, p.body['safety'] as Record<string, unknown>, 'safety.'), name: current?.name ?? p.params['productId']!, heldVersion };
      }
      case 'barcode': {
        const productId = p.params['productId']!;
        const held = (await barcodes.all(tenantId)).filter((a) => a.productId === productId).map((a) => a.code);
        const current = await products.product(tenantId, productId);
        const level = isStr(p.body['level']) ? `, ${p.body['level']}` : '';
        return { changes: [{ field: 'barcodes', before: [...new Set(held)].join(', '), after: [...new Set([...held, p.params['code']!])].join(', ') }, { field: 'newBarcode', before: '', after: `${p.params['code']} (${String(p.body['kind'])}${level})` }], name: current?.name ?? productId };
      }
      case 'tax_rate': {
        const hsnCode = p.params['hsnCode']!;
        const from = p.params['effectiveFrom']!;
        const schedule = [...(await taxes.schedule(tenantId, hsnCode))].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        const inForce = schedule.filter((s) => s.effectiveFrom <= from).at(-1);
        const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
        return { changes: [{ field: 'gstRate', before: inForce === undefined ? '' : `${pct(inForce.rateBps)} from ${inForce.effectiveFrom}`, after: `${pct(p.body['rateBps'] as number)} from ${from}` }], name: `HSN ${hsnCode}` };
      }
    }
  };

  // ── 1. The manager proposes ──────────────────────────────────────────────────────────────────────────────────────────
  surface.push({
    api: 'API-02', method: 'POST', path: '/v1/catalogue/changes',
    permission: CATALOGUE_CHANGE_PROPOSE, idempotent: true,
    handler: async (ctx): Promise<HandlerResult> => {
      const b = isObj(ctx.body) ? ctx.body : {};
      const reason = isStr(b['reason']) ? b['reason'].trim() : '';
      const p = readProposal(b);
      if (reason === '') throw refuse(400, 'not_readable_as_a_catalogue_change', 'A reason is needed — the owner reads why before he approves.');
      const { changes, name, heldVersion } = await changesOf(ctx.tenantId, p);
      // Hard rule 10: a change made on an item someone has since saved would overwrite their work — refused now, by name.
      if (p.expectedVersion !== undefined && heldVersion !== undefined && heldVersion !== p.expectedVersion) {
        throw refuse(409, 'product_changed_meanwhile', `Someone saved this item after you opened it (you opened version ${p.expectedVersion}; head office now holds version ${heldVersion}). Nothing was sent.`, 'Reload the item and make your change again.');
      }
      if (changes.length === 0 && p.change !== 'barcode' && p.change !== 'tax_rate') {
        throw refuse(422, 'nothing_to_change', `This would change nothing on "${name}": it is already exactly this.`, 'Nothing was sent. Change something first.');
      }
      const summary = p.change === 'product' ? `Item change: ${name} (${p.params['productId']})`
        : p.change === 'product_safety' ? `Label facts change: ${name} (${p.params['productId']})`
          : p.change === 'barcode' ? `New barcode ${p.params['code']} for ${name} (${p.params['productId']})`
            : `GST rate of ${name}: ${changes[0]!.after}`;
      const details = {
        change: p.change, ...p.params, ...p.body,
        ...(p.expectedVersion === undefined ? {} : { expectedVersion: p.expectedVersion }),
        changes, route: routeWords(p.change),
        // OB-773 (3 B): the exact act as the ordinary route will read it (its body and the ids in its address) — what the
        // owner's approval may also stand for as Finance's approval (`standsInFor`), and nothing else.
        actionFingerprint: fingerprintOf(actionDetails(p.body, p.params)),
      };
      const asked = await engineAsk({
        ...ctx, body: { kind: CATALOGUE_CHANGE_KIND, subjectRef: p.subjectRef, details, valueMinor: null, summary, reason },
      });
      const request = asked.body as { requestId: string };
      await input.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: 'catalogue.change.propose', objectType: p.change === 'tax_rate' ? 'tax_class' : 'product', objectId: p.subjectRef.replace(/^(product|hsn):/, ''),
        at: now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: Object.fromEntries(changes.map((c) => [c.field, c.before])), after: Object.fromEntries(changes.map((c) => [c.field, c.after])),
        reason, approvalId: request.requestId, correlationId: `catalogue-change:${request.requestId}`,
      });
      return {
        status: 201,
        body: {
          ...(asked.body as Record<string, unknown>), nothingChangedYet: true,
          detail: 'Sent for the owner\'s approval. Nothing has changed yet: the change is made only when the owner approves it on his Approvals page (OB-773).',
        },
      };
    },
  });

  // ── 2. The engine's own ask: a catalogue change is asked only through the route above (it works out the before/after) ──
  surface[askAt] = {
    ...surface[askAt]!,
    handler: async (ctx) => {
      if (isObj(ctx.body) && ctx.body['kind'] === CATALOGUE_CHANGE_KIND) {
        throw refuse(422, 'use_the_catalogue_change_route', 'A change to an item, a barcode or a GST rate for the owner\'s approval is sent through POST /v1/catalogue/changes, which records exactly what it would change.');
      }
      return engineAsk(ctx);
    },
  };

  // ── 3. The outcome, recorded once per request ─────────────────────────────────────────────────────────────────────────
  const outcomes = async (tenantId: string): Promise<Map<string, CatalogueChangeOutcome>> => {
    const rows: PersistedEvent[] = [
      ...await store.readStream(tenantId, outcomesStream(), { type: 'CatalogueChangeApplied' }),
      ...await store.readStream(tenantId, outcomesStream(), { type: 'CatalogueChangeNotApplied' }),
    ];
    return new Map(rows.map((e) => { const o = e.event.payload as CatalogueChangeOutcome; return [o.requestId, o]; }));
  };
  const inFlight = new Map<string, Promise<CatalogueChangeOutcome>>();

  const makeIt = async (ctx: RequestContext, state: ApprovalState): Promise<CatalogueChangeOutcome> => {
    const r = state.request;
    const d = r.details as Record<string, unknown>;
    const change = (typeof d['change'] === 'string' && d['change'] in CATALOGUE_CHANGE_ROUTES ? d['change'] : 'unknown') as CatalogueChange | 'unknown';
    const at = now();
    const base = { requestId: r.requestId, change, proposedBy: r.requestedBy, approvedBy: ctx.userId, approvalId: r.requestId, at };
    const notMade = (route: string, code: string, reason: string): CatalogueChangeOutcome => ({
      ...base, applied: false, route, code, reason, detail: `Approved by ${ctx.userId}, but the change was NOT made: ${reason} Nothing in the catalogue changed; ${r.requestedBy} can propose it again.`,
    });
    if (change === 'unknown') return notMade('none', 'not_a_catalogue_change', 'The request does not say which catalogue change it is.');
    const target = CATALOGUE_CHANGE_ROUTES[change];
    const words = routeWords(change);
    // The approval must be exactly the request the owner approved (its kind, subject, details and maker), approved, unused and
    // in time — and the owner must still hold the publish authority (the kind's checker). It is spent ONCE: by the ordinary
    // route when that route also needs Finance's approval (OB-773 · 3 B), otherwise just after (`spendIfUnused`).
    try {
      await openApproval(approvals, {
        tenantId: ctx.tenantId, approvalId: r.requestId, kind: CATALOGUE_CHANGE_KIND, subjectRef: r.subjectRef, details: r.details,
        valueMinor: null, maker: r.requestedBy, usedBy: `catalogue-change:${r.requestId}`, now: at,
      });
    } catch (err) {
      if (err instanceof ApiError) return notMade(words, err.body.code, err.body.whatHappened);
      throw err;
    }
    const route = surface.find((x) => x.method === target.method && x.path === target.path);
    if (route === undefined) return notMade(words, 'route_not_wired', `${words} is not wired on head office.`);
    const checker = APPROVAL_KINDS[CATALOGUE_CHANGE_KIND]!.checkerPermission;
    if (route.permission !== checker) return notMade(words, 'route_needs_another_authority', `${words} needs ${route.permission}, not the authority that approved this.`);
    const params: Record<string, string> = {};
    for (const k of ['productId', 'code', 'hsnCode', 'effectiveFrom']) if (typeof d[k] === 'string') params[k] = d[k] as string;
    let body: Record<string, unknown>;
    if (change === 'product') {
      // Hard rule 10: an item someone saved after the manager opened it is never overwritten by his older copy.
      const held = Number(await products.productVersion?.(ctx.tenantId, params['productId']!) ?? 0);
      if (held !== d['expectedVersion']) {
        return notMade(words, 'product_changed_meanwhile', `Someone saved this item after ${r.requestedBy} opened it (version ${String(d['expectedVersion'])} then; version ${held} now), so his copy would have overwritten their change.`);
      }
      body = { product: d['product'] };
    } else if (change === 'product_safety') {
      body = { expectedVersion: d['expectedVersion'], safety: d['safety'], reason: d['reason'] };
    } else if (change === 'barcode') {
      body = { kind: d['kind'], ...(typeof d['level'] === 'string' ? { level: d['level'] } : {}) };
    } else {
      body = { rateBps: d['rateBps'] };
    }
    // The approval is offered to the route only where the route may need it as the second approval: a GST rate on a class
    // that already has one (the FIRST rate of a class is setting it up, and needs none); an item's own route asks for it
    // only when its HSN changes on sale or it newly becomes age-limited or tobacco. A barcode never needs one.
    const offer = change === 'barcode' ? false : change === 'tax_rate' ? (await taxes.schedule(ctx.tenantId, params['hsnCode']!)).length > 0 : true;
    // The owner's own act, in his own session, through the ordinary route and every check on it. The approval is named, so a
    // route that also needs Finance's approval (or a second person's) may take THIS one as it — only while head office is
    // making this very change (`whileMakingACatalogueChange`), and only on the engine's OB-773 terms (`takeApproval`).
    try {
      const res = await whileMakingACatalogueChange(r.requestId, async () => route.handler({
        ...ctx, params, query: {}, body: offer ? { ...body, approvalId: r.requestId } : body,
        idempotencyKey: `catalogue-change-${digest(`${ctx.tenantId}-${r.requestId}`)}`, traceId: ctx.traceId,
      }));
      if (res.status >= 300) {
        const e = (res.body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
        return notMade(words, e?.code ?? `status_${res.status}`, e?.whatHappened ?? `${words} answered ${res.status}.`);
      }
    } catch (err) {
      if (err instanceof ApiError) return notMade(words, err.body.code, err.body.whatHappened);
      return notMade(words, 'route_failed', `${words} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // OB-773 (3 B): did the route take this approval as Finance's (or the second person's)? Then that is said on the change.
    const after = await approvals.approvalState(ctx.tenantId, r.requestId);
    const usedFor = after?.usedBy;
    const financeApproval = usedFor === undefined || state.decision === undefined ? undefined : {
      satisfiedBy: r.requestId, approvedBy: state.decision.decidedBy, approvedAt: state.decision.decidedAt, usedFor,
      rule: `OB-773 (3 B): ${r.requestedBy} asked and ${state.decision.decidedBy}, who holds Finance's approval authority, approved — two different people, so approval ${r.requestId} also stands as the second approval this change needs.`,
    };
    return {
      ...base, applied: true, route: words, ...(financeApproval === undefined ? {} : { financeApproval }),
      detail: `Made on ${ctx.userId}'s approval (${r.requestId}), as ${r.requestedBy} proposed it.${financeApproval === undefined ? '' : ` That approval also stood as the second (Finance) approval it needed (${usedFor}).`}`,
    };
  };

  /** The approval is used once in every case: a change made, or one not made (it cannot be used for anything else later). */
  const spendIfUnused = async (tenantId: string, requestId: string, applied: boolean): Promise<void> => {
    const version = Number(await approvals.approvalVersion(tenantId, requestId));
    const s = await approvals.approvalState(tenantId, requestId);
    if (s === undefined || s.usedBy !== undefined) return;
    await approvals.spendApproval(tenantId, requestId, `catalogue-change:${requestId}${applied ? '' : ':not-made'}`, version);
  };

  const outcomeOf = async (ctx: RequestContext, state: ApprovalState): Promise<CatalogueChangeOutcome> => {
    const before = (await outcomes(ctx.tenantId)).get(state.request.requestId);
    if (before !== undefined) return before; // made (or refused) once already — never again
    if (state.usedBy !== undefined) {
      return {
        requestId: state.request.requestId, change: 'unknown', applied: false, proposedBy: state.request.requestedBy, approvedBy: ctx.userId,
        approvalId: state.request.requestId, route: 'none', at: now(), code: 'outcome_not_recorded',
        reason: 'The approval was already taken to make this change, but head office has no record of whether it was made.',
        detail: 'Look at the item to see whether the change is there; if not, it can be proposed again.',
      };
    }
    const outcome = await makeIt(ctx, state);
    if (outcome.code !== 'approval_already_used') await spendIfUnused(ctx.tenantId, state.request.requestId, outcome.applied);
    const d = state.request.details as Record<string, unknown>;
    const changes = Array.isArray(d['changes']) ? d['changes'] as FieldChange[] : [];
    const stored = await store.append(ctx.tenantId, outcomesStream(), makeEvent({
      id: `catalogue-change-outcome-${digest(`${ctx.tenantId}-${outcome.requestId}`)}`,
      type: outcome.applied ? 'CatalogueChangeApplied' : 'CatalogueChangeNotApplied', occurredAt: outcome.at,
      idempotencyKey: `catalogue-change-outcome-${ctx.tenantId}-${outcome.requestId}`, source: 'api/catalogue-change', payload: outcome,
    }));
    const recorded = stored.record.event.payload as CatalogueChangeOutcome;
    if (!stored.deduped) {
      await input.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: recorded.applied ? 'catalogue.change.apply' : 'catalogue.change.not_applied',
        objectType: recorded.change === 'tax_rate' ? 'tax_class' : 'product', objectId: state.request.subjectRef.replace(/^(product|hsn):/, ''),
        at: recorded.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: Object.fromEntries(changes.map((c) => [c.field, c.before])),
        after: recorded.applied ? {
          ...Object.fromEntries(changes.map((c) => [c.field, c.after])), proposedBy: recorded.proposedBy, approvedBy: recorded.approvedBy,
          ...(recorded.financeApproval === undefined ? {} : { financeApprovalSatisfiedBy: recorded.financeApproval.satisfiedBy, financeApprovedBy: recorded.financeApproval.approvedBy, financeApprovedAt: recorded.financeApproval.approvedAt }),
        } : { notMade: recorded.reason ?? '', proposedBy: recorded.proposedBy, approvedBy: recorded.approvedBy },
        reason: `${state.request.reason} (proposed by ${recorded.proposedBy}); approved by ${recorded.approvedBy}: ${state.decision?.reason ?? ''}`,
        approvalId: recorded.approvalId, correlationId: `catalogue-change:${recorded.requestId}`,
      });
    }
    return recorded;
  };

  // ── 4. The owner decides: on his approval the change is made at once; his refusal changes nothing ────────────────────
  const decideAt = indexOf(surface, 'POST', '/v1/approvals/requests/:requestId/decide');
  const engineDecide = surface[decideAt]!.handler;
  surface[decideAt] = {
    ...surface[decideAt]!,
    handler: async (ctx) => {
      const out = await engineDecide(ctx);
      const requestId = ctx.params['requestId'] ?? '';
      const state = await approvals.approvalState(ctx.tenantId, requestId);
      if (state?.request.kind !== CATALOGUE_CHANGE_KIND || state.decision === undefined || state.decision.decidedBy !== ctx.userId) return out;
      if (state.decision.decision === 'rejected') {
        if (out.status === 201) {
          await input.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'catalogue.change.refuse', objectType: state.request.subjectRef.startsWith('hsn:') ? 'tax_class' : 'product',
            objectId: state.request.subjectRef.replace(/^(product|hsn):/, ''), at: state.decision.decidedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: null, after: { refusedBy: ctx.userId, proposedBy: state.request.requestedBy }, reason: state.decision.reason,
            approvalId: requestId, correlationId: `catalogue-change:${requestId}`,
          });
        }
        return { ...out, body: { ...(out.body as Record<string, unknown>), catalogueChange: { applied: false, refused: true, detail: `Refused by ${ctx.userId}: ${state.decision.reason}. Nothing in the catalogue changed.` } } };
      }
      // One making at a time per request in this process; the outcome record holds it across processes and restarts.
      const key = `${ctx.tenantId}\u0000${requestId}`;
      let running = inFlight.get(key);
      if (running === undefined) {
        running = outcomeOf(ctx, state).finally(() => inFlight.delete(key));
        inFlight.set(key, running);
      }
      const outcome = await running;
      return { ...out, body: { ...(out.body as Record<string, unknown>), catalogueChange: outcome } };
    },
  };

  // ── 5. The inbox says, on each catalogue change, whether it was made (P-08) ──────────────────────────────────────────
  const listAt = indexOf(surface, 'GET', '/v1/approvals/requests');
  const engineList = surface[listAt]!.handler;
  surface[listAt] = {
    ...surface[listAt]!,
    handler: async (ctx) => {
      const out = await engineList(ctx);
      const body = out.body as { waitingForMe?: Record<string, unknown>[]; mine?: Record<string, unknown>[] } | undefined;
      if (body === undefined || !Array.isArray(body.mine) || !Array.isArray(body.waitingForMe)) return out;
      const all = [...body.mine, ...body.waitingForMe];
      if (!all.some((row) => row['kind'] === CATALOGUE_CHANGE_KIND)) return out;
      const known = await outcomes(ctx.tenantId);
      const add = (row: Record<string, unknown>): Record<string, unknown> => {
        const o = row['kind'] === CATALOGUE_CHANGE_KIND ? known.get(String(row['requestId'])) : undefined;
        return o === undefined ? row : { ...row, catalogueChange: o };
      };
      return { ...out, body: { ...body, waitingForMe: body.waitingForMe.map(add), mine: body.mine.map(add) } };
    },
  };
}
