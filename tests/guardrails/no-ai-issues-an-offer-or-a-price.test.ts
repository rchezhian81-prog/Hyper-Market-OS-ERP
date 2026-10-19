import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { offerProposalRoutes } from '../../services/customer/src/offer-proposals';
import { basketAffinityRoutes } from '../../services/reporting/src/basket-affinity';

/**
 * R4 Lane 3 guardrails — every "nothing does this by itself" claim of D-22, D-23, D-24 and EA-07 held with a check
 * (signed OB-227; hard rule #5; OB-220; OB-222):
 *   • D-22 "A person approves each batch before any is issued … No AI issues or commits an offer."
 *   • D-23 "Suggestions … are drafts; a promotion made from one goes through the existing promotion approval."
 *   • D-24 "The weather feed is built as a switched-off link, and nothing is sent or fetched while switched off."
 *   • EA-07 "Nothing is sent while switched off."
 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const code = (path: string): string => strip(readFileSync(path, 'utf8'));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });

const LANE_FILES = [
  'packages/loyalty/src/next-best-offer.ts', 'services/customer/src/offer-proposals.ts', 'services/customer/src/offer-liability.ts',
  'packages/reporting/src/basket-affinity.ts', 'services/reporting/src/basket-affinity.ts',
  'packages/calendar/src/demand-events.ts', 'services/inventory/src/demand-events.ts', 'services/customer/src/customer-overview.ts',
];

describe('no AI issues an offer or a price (D-22 · D-23 · hard rule #5)', () => {
  it('the offer, affinity and calendar code reaches no model, no gateway and no AI agent', () => {
    for (const f of LANE_FILES) {
      const src = code(f);
      for (const forbidden of ['services/ai/', 'packages/ai/', 'model-gateway', 'modelGateway', 'ModelTransport', 'drafting-legs']) expect(src, `${f} → ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('only the APPROVE route issues an offer — the draft route has no way to', () => {
    const src = code('services/customer/src/offer-proposals.ts');
    expect(src.split('deps.issueCoupon(').length - 1).toBe(1);
    const approveAt = src.indexOf("path: '/v1/loyalty/offer-batches/:batchId/approve'");
    const rejectAt = src.indexOf("path: '/v1/loyalty/offer-batches/:batchId/reject'");
    const issueAt = src.indexOf('deps.issueCoupon(');
    expect(issueAt).toBeGreaterThan(approveAt);
    expect(issueAt).toBeLessThan(rejectAt);
    const draftBlock = src.slice(src.indexOf("path: '/v1/loyalty/offer-batches/:batchId'"), approveAt);
    for (const bypass of ['issueCoupon', 'override', 'autoApprove', 'force']) expect(draftBlock, bypass).not.toContain(bypass);
    const routes = offerProposalRoutes({} as never);
    expect(routes.find((r) => r.path === '/v1/loyalty/offer-batches/:batchId/approve')?.permission).toBe('loyalty.offer.approve');
    expect(routes.find((r) => r.path === '/v1/loyalty/offer-batches/:batchId')?.permission).toBe('loyalty.offer.draft');
  });

  it('only the owner holds the approval; no machine role holds any offer, coupon-issue, price or promotion code', () => {
    const holders = (perm: string): string[] => ROLE_CATALOGUE.filter((r) => r.permissions.includes(perm)).map((r) => r.id).sort();
    expect(holders('loyalty.offer.approve')).toEqual([OWNER_ROLE_ID]);
    const machines = ['store_computer', 'message_provider_relay', 'backup_job'];
    for (const role of ROLE_CATALOGUE.filter((r) => machines.includes(r.id))) {
      for (const p of role.permissions) expect(p, `${role.id} holds ${p}`).not.toMatch(/^(loyalty\.offer|loyalty\.coupon\.issue|loyalty\.referral|price\.change|promotion\.launch|inventory\.demand-event)/);
    }
  });

  it('the AI service never names an offer, coupon, promotion or price-change route', () => {
    for (const f of walk('services/ai/src')) {
      const src = code(f);
      for (const route of ['/v1/loyalty/offer', '/v1/loyalty/coupons', '/v1/promotions', '/v1/prices/', 'issueCoupon', 'offer-batches']) expect(src, `${f} → ${route}`).not.toContain(route);
    }
  });

  it('the bought-together read is one GET with no write port; a promotion from it is a draft sent by a person', () => {
    const routes = basketAffinityRoutes({} as never);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/reporting/basket-affinity']);
    const src = code('services/reporting/src/basket-affinity.ts');
    for (const forbidden of ['.append(', 'recordDefined', 'recordStatus', 'fetch(', '/launch', '/activate']) expect(src, forbidden).not.toContain(forbidden);
  });
});

describe('switched-off links stay off in production (D-24 · OB-220; EA-07 · OB-222)', () => {
  it('production wires only the switched-off weather link; nothing in the composition hands in another', () => {
    const adapters = code('services/api/src/r4-insight-adapters.ts');
    expect(adapters).toContain('WEATHER_FEED_SWITCHED_OFF');
    for (const root of ['services/api/src/main.ts', 'services/api/src/start.ts']) {
      const src = code(root);
      expect(src, root).not.toMatch(/weather\s*:/);
      expect(src, root).not.toMatch(/switchedOn\s*:\s*true/);
    }
    // The provider is asked ONLY when switched on.
    const cal = code('packages/calendar/src/demand-events.ts');
    const at = cal.indexOf('export async function weatherSignals');
    const block = cal.slice(at);
    expect(block.indexOf('if (!port.switchedOn) return')).toBeGreaterThan(0);
    expect(block.indexOf('if (!port.switchedOn) return')).toBeLessThan(block.indexOf('port.fetch('));
    expect(code('services/inventory/src/demand-events.ts')).not.toContain('.fetch(');
  });

  it('the brief\'s sending link is never set by the production start-up: only a provider handed in by a test can set it', () => {
    const main = code('services/api/src/main.ts');
    expect(main.match(/briefSendingLink:/g) ?? []).toHaveLength(1); // the pass-through from `providers`, nothing else
    expect(main).toContain('providers.briefSendingLink === undefined ? {} : { briefSendingLink: providers.briefSendingLink }');
    expect(code('services/api/src/start.ts')).not.toContain('briefSendingLink');
    // Without the link, the pass prepares and stops before any queue or transport.
    const brief = code('services/reporting/src/scheduled-brief.ts');
    const pass = brief.slice(brief.indexOf('export async function runBriefPass'));
    expect(pass.indexOf('if (!sendingOn(deps))')).toBeGreaterThan(0);
    expect(pass.indexOf('if (!sendingOn(deps))')).toBeLessThan(pass.indexOf('deps.outbox.enqueue('));
    expect(pass.indexOf('if (!sendingOn(deps))')).toBeLessThan(pass.indexOf('deps.transport.send('));
  });
});
