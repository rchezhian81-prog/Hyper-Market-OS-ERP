// OB-288 customer & delivery follow-ups (owner decisions in writing, 24 Oct 2026) — head office's wiring for:
//
//   • OB-351 · M17-FR-02 — the referral programme: a code per customer, a claim per referred customer, the owner's two
//     rewards ("not set" until he enters them), and each reward given as the loyalty register's own `ReferralRewarded`
//     fact (so the liability register, payout and posting carry it unchanged);
//   • OB-350 · R8-3 — scan-and-go: the basket the customer's phone built, held by head office under a short code for a till
//     lane to recall (the till re-prices it; the phone is never trusted).
//
// Every register here is append-only on its own stream (hard rules #2/#6). Entry point registered from main.ts:
// `customerFollowupsRoutes`.

import { createHash, randomInt } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import type { PlacedOrder, OrderTransition } from '../../orders/src/index';
import { STREAM, streamName, catalogueAdapter } from './adapters';
import {
  referralProgrammeRoutes, claimIdOf, type ReferralProgrammeDeps, type ReferralRewardSetting, type ReferralCode, type ReferralClaim, type ReferralGrant,
} from '../../customer/src/referral-programme';
import { scanAndGoRoutes, type ScanAndGoDeps, type PhoneBasket, type PhoneBasketRecall } from '../../orders/src/storefront-scan-and-go';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface CustomerFollowupsInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly signer: CatalogueDeps['signer'];
  readonly recordAudit?: Recorder;
}

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const S = {
  rewards: streamName(STREAM.loyalty, 'referral-rewards'),
  codeOf: (customerRef: string) => streamName(STREAM.loyalty, 'referral-code-of', digest(customerRef)),
  code: (code: string) => streamName(STREAM.loyalty, 'referral-code', code),
  claim: (claimId: string) => streamName(STREAM.loyalty, 'referral-claim', claimId),
  claims: streamName(STREAM.loyalty, 'referral-claims'),
  /** The loyalty referral register the liability, payout and posting read (services/customer/src/offer-liability.ts). */
  rewarded: streamName(STREAM.loyalty, 'referrals'),
  basket: (code: string) => streamName(STREAM.orders, 'scan-and-go', code),
  basketsOf: (customerRef: string) => streamName(STREAM.orders, 'scan-and-go-of', digest(customerRef)),
};
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const event = (type: string, key: string, tenantId: string, occurredAt: string, payload: unknown) => {
  const d = digest(key);
  return makeEvent({ id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/customer-followups', payload: payload as Record<string, unknown> });
};

/** Everything the follow-up routes read, from one event store. Exported for the tests. */
export function customerFollowupsDeps(input: { readonly store: EventStore; readonly now: () => string; readonly signer: CatalogueDeps['signer']; readonly recordAudit?: Recorder }) {
  const { store, now } = input;
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };

  // ── OB-351: the referral programme ──────────────────────────────────────────────────────────────────────────────
  /** When an online order of this customer reached the door: the order's own transition, or the driver's step. */
  const deliveredAt = async (t: string, orderId: string): Promise<string | undefined> => {
    const times: string[] = [];
    for (const tr of await payloads<OrderTransition>(store, t, streamName(STREAM.orders, orderId), 'OrderTransitioned')) if (tr.to === 'delivered') times.push(tr.at);
    for (const e of await store.readStream(t, streamName(STREAM.delivery, 'fulfilment', orderId))) {
      const p = e.event.payload as { to?: unknown; at?: unknown };
      if ((p.to === 'delivered' || p.to === 'partially_delivered') && typeof p.at === 'string') times.push(p.at);
    }
    return times.sort()[0];
  };
  const referrals: ReferralProgrammeDeps = {
    now, ...audit,
    rewardHistory: (t) => payloads<ReferralRewardSetting>(store, t, S.rewards, 'ReferralRewardsSet'),
    recordReward: async (t, s) => { await store.append(t, S.rewards, event('ReferralRewardsSet', `${s.setBy}|${s.setAt}|${s.referrerRewardMinor}|${s.referredRewardMinor}`, t, s.setAt, s)); },
    codeOf: async (t, customerRef) => (await payloads<ReferralCode>(store, t, S.codeOf(customerRef), 'ReferralCodeIssued'))[0],
    codeOwner: async (t, code) => (await payloads<ReferralCode>(store, t, S.code(code), 'ReferralCodeIssued'))[0],
    recordCode: async (t, c) => {
      // Keyed on the customer (the first code stands) and on the code (one owner per code).
      await store.appendBatch(t, [
        { stream: S.codeOf(c.customerRef), event: event('ReferralCodeIssued', `of|${c.customerRef}`, t, c.issuedAt, c) },
        { stream: S.code(c.code), event: event('ReferralCodeIssued', `code|${c.code}`, t, c.issuedAt, c) },
      ]);
    },
    claimOf: async (t, referredRef) => (await payloads<ReferralClaim>(store, t, S.claim(claimIdOf(referredRef)), 'ReferralClaimed'))[0],
    claims: async (t) => {
      const seen = new Set<string>();
      const out: ReferralClaim[] = [];
      for (const c of await payloads<ReferralClaim>(store, t, S.claims, 'ReferralClaimed')) if (!seen.has(c.claimId)) { seen.add(c.claimId); out.push(c); }
      return out;
    },
    recordClaim: async (t, c) => {
      await store.appendBatch(t, [
        { stream: S.claim(c.claimId), event: event('ReferralClaimed', `claim|${c.claimId}`, t, c.claimedAt, c) },
        { stream: S.claims, event: event('ReferralClaimed', `index|${c.claimId}`, t, c.claimedAt, c) },
      ]);
    },
    firstDelivered: async (t, customerRef) => {
      let first: { orderId: string; deliveredAt: string } | undefined;
      for (const o of await payloads<PlacedOrder>(store, t, streamName(STREAM.orders, 'customer', customerRef), 'OrderPlaced')) {
        if (o.fulfilment === 'pickup') continue;
        const at = await deliveredAt(t, o.orderId);
        if (at !== undefined && (first === undefined || at < first.deliveredAt)) first = { orderId: o.orderId, deliveredAt: at };
      }
      return first;
    },
    grantsFor: async (t, claimId) => (await payloads<ReferralGrant>(store, t, S.rewarded, 'ReferralRewarded')).filter((g) => g.claimId === claimId),
    recordGrant: async (t, g) => {
      // The loyalty register's own fact and key (one reward per referralId — services/api/src/adapters.ts couponAdapter).
      await store.append(t, S.rewarded, makeEvent({
        id: `referral-${g.referralId}-programme`, type: 'ReferralRewarded', occurredAt: g.at,
        idempotencyKey: `referral-${t}-${g.referralId}`, source: 'api/customer-followups', payload: g as unknown as Record<string, unknown>,
      }));
    },
    randomInt: (max) => randomInt(max),
  };

  // ── OB-350: scan-and-go — the phone's basket held for a till lane ────────────────────────────────────────────────
  const catalogue = catalogueAdapter({ store, signer: input.signer, now });
  const scanAndGo: ScanAndGoDeps = {
    now, ...audit,
    pack: async (t) => {
      const p = await catalogue.currentPack(t);
      return p === undefined ? undefined : {
        version: p.snapshot.version,
        products: p.snapshot.products.filter((x) => x.status === 'active' || x.status === 'clearance').map((x) => ({ productId: x.productId, name: x.name, baseUom: x.baseUom, unitPriceMinor: x.unitPriceMinor })),
        barcodes: p.snapshot.barcodes.map((c) => ({ code: c.code, productId: c.productId, kind: c.kind })),
      };
    },
    basket: async (t, code) => (await payloads<PhoneBasket>(store, t, S.basket(code), 'PhoneBasketHeld'))[0],
    recalls: (t, code) => payloads<PhoneBasketRecall>(store, t, S.basket(code), 'PhoneBasketRecalled'),
    basketsOf: (t, customerRef) => payloads<PhoneBasket>(store, t, S.basketsOf(customerRef), 'PhoneBasketHeld'),
    recordBasket: async (t, b) => {
      await store.appendBatch(t, [
        { stream: S.basket(b.code), event: event('PhoneBasketHeld', `basket|${b.code}`, t, b.heldAt, b) },
        { stream: S.basketsOf(b.customerRef), event: event('PhoneBasketHeld', `of|${b.code}`, t, b.heldAt, b) },
      ]);
    },
    // A recall is a CLAIM, once per basket: keyed on the code, so a second lane's recall is the same record (it names the first).
    recordRecall: async (t, r) => { await store.append(t, S.basket(r.code), event('PhoneBasketRecalled', `recall|${r.code}`, t, r.at, r)); },
    randomInt: (max) => randomInt(max),
  };

  return { referrals, scanAndGo };
}

/** The follow-up routes. A bare composition (no store) is given an in-memory one, so the route table is the same. */
export function customerFollowupsRoutes(input: CustomerFollowupsInput): readonly Route[] {
  const d = customerFollowupsDeps({ ...input, store: input.store ?? new InMemoryEventStore() });
  return [...referralProgrammeRoutes(d.referrals), ...scanAndGoRoutes(d.scanAndGo)];
}
