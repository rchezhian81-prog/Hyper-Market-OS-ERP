import { describe, it, expect } from 'vitest';
import {
  checkRestriction,
  resolveRestriction,
  decideOverride,
  overrideAudit,
  laneHealth,
  lanesNeedingAttention,
  SelfOverrideError,
  MissingOverrideReasonError,
  type OverrideRequest,
  type Peripheral,
  type RestrictedItem,
  type SupervisorAuthority,
} from '../../apps/pos/src/lane-guards';
import { money } from '../../packages/contracts/src/money';

// M12-FR-04 — three lane controls that all fail the same way if they are advisory:
// the age prompt that does not block, the override a cashier can give themselves,
// and the lane that looks fine while it is offline.

const INR = 'INR' as const;
const AT = '2026-08-03T18:30:00Z';

const BEER: RestrictedItem = {
  productId: 'beer-650',
  name: 'Beer 650ml',
  kind: 'age',
  minimumAge: 21,
};

describe('age and restricted prompts — a prompt that blocks (acceptance)', () => {
  it('blocks an age-restricted item until the question is answered', () => {
    const prompt = checkRestriction(BEER, {});
    expect(prompt.outcome).toBe('prompt_required');
    expect(prompt.question).toContain('Is the customer 21 or over?');

    // Unanswered: it does not go into the basket. "Warned and sold" is the outcome
    // this exists to prevent.
    expect(resolveRestriction(prompt, undefined)).toEqual({
      allowed: false,
      reason: 'the prompt has not been answered',
    });
  });

  it('refuses the sale when age was checked and failed', () => {
    const prompt = checkRestriction(BEER, {});
    const refused = resolveRestriction(prompt, { productId: BEER.productId, ageVerified: false });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('the sale must be refused');
  });

  it('allows it once the cashier confirms identification passed', () => {
    const prompt = checkRestriction(BEER, {});
    expect(resolveRestriction(prompt, { productId: BEER.productId, ageVerified: true })).toEqual({
      allowed: true,
      reason: 'checked at the till',
    });
  });

  it('blocks a licensed item outside its permitted hours', () => {
    const item: RestrictedItem = {
      productId: 'whisky',
      name: 'Whisky 750ml',
      kind: 'licence_hours',
      sellableFrom: '10:00',
      sellableUntil: '22:00',
    };
    const late = checkRestriction(item, { localTime: '22:30' });
    expect(late.outcome).toBe('blocked');
    expect(resolveRestriction(late, undefined).reason).toContain('the licence allows 10:00 to 22:00');

    const inHours = checkRestriction(item, { localTime: '11:00' });
    expect(resolveRestriction(inHours, undefined)).toEqual({ allowed: true, reason: '' });
  });

  it('needs a supervisor to go past a per-customer quantity limit', () => {
    const item: RestrictedItem = {
      productId: 'formula',
      name: 'Infant formula',
      kind: 'quantity_limit',
      maxPerBasket: 2,
    };
    expect(checkRestriction(item, { alreadyInBasket: 1 }).outcome).toBe('allowed');

    const over = checkRestriction(item, { alreadyInBasket: 2 });
    expect(over.needsSupervisor).toBe(true);
    expect(resolveRestriction(over, { productId: 'formula', ageVerified: true }).allowed).toBe(false);
    expect(
      resolveRestriction(over, {
        productId: 'formula',
        override: {
          overrideId: 'o1',
          kind: 'restricted_item',
          cashierId: 'c1',
          supervisorId: 'sup-1',
          decision: 'approved',
          reason: 'regular customer, two households',
          at: AT,
          detail: '',
        },
      }),
    ).toEqual({ allowed: true, reason: 'approved by sup-1' });
  });
});

describe('supervisor overrides — never one you can give yourself (§28)', () => {
  const SUPERVISOR: SupervisorAuthority = {
    supervisorId: 'sup-1',
    allows: ['line_void', 'discount', 'restricted_item'],
    limitMinor: 50_000, // ₹500.00
    escalatesTo: 'manager-1',
  };

  function request(over: Partial<OverrideRequest> = {}): OverrideRequest {
    return {
      overrideId: 'o1',
      kind: 'discount',
      cashierId: 'cashier-1',
      laneId: 'lane-3',
      value: money(20_000, INR),
      reason: 'damaged packaging, agreed with customer',
      at: AT,
      ...over,
    };
  }

  it('approves within the supervisor’s authority and records who approved it', () => {
    const decision = decideOverride(request(), SUPERVISOR);
    expect(decision.decision).toBe('approved');
    expect(decision.supervisorId).toBe('sup-1');
    expect(overrideAudit(request(), decision)).toEqual({
      overrideId: 'o1',
      kind: 'discount',
      laneId: 'lane-3',
      cashierId: 'cashier-1',
      supervisorId: 'sup-1',
      decision: 'approved',
      reason: 'damaged packaging, agreed with customer',
      valueMinor: 20_000,
      at: AT,
    });
  });

  it('refuses an override the cashier tries to give themselves', () => {
    expect(() => decideOverride(request(), { ...SUPERVISOR, supervisorId: 'cashier-1' })).toThrow(
      SelfOverrideError,
    );
  });

  it('refuses an override with no reason — "manager approved" explains nothing later', () => {
    expect(() => decideOverride(request({ reason: '  ' }), SUPERVISOR)).toThrow(
      MissingOverrideReasonError,
    );
  });

  it('escalates beyond the limit rather than failing silently', () => {
    const big = decideOverride(request({ value: money(120_000, INR) }), SUPERVISOR);
    expect(big.decision).toBe('escalated');
    expect(big.escalatedTo).toBe('manager-1');
    expect(big.detail).toContain('sent to manager-1');
  });

  it('says plainly when there is nobody above to escalate to', () => {
    const stuck = decideOverride(request({ value: money(120_000, INR) }), {
      ...SUPERVISOR,
      escalatesTo: undefined,
    });
    expect(stuck.decision).toBe('escalated');
    expect(stuck.detail).toContain('nobody above them configured');
  });

  it('refuses a kind of override this supervisor may not approve at all', () => {
    const refused = decideOverride(request({ kind: 'refund' }), SUPERVISOR);
    expect(refused.decision).toBe('refused');
    expect(refused.detail).toContain('may not approve a refund');
  });
});

describe('lane health — the lane never lies about its state (§27.1, P-08)', () => {
  const OK: Peripheral[] = [
    { kind: 'scanner', state: 'ok' },
    { kind: 'printer', state: 'ok' },
  ];

  it('shows a healthy lane as online with nothing to do', () => {
    const health = laneHealth({ laneId: 'lane-1', connection: 'online', unsentCount: 0, peripherals: OK });
    expect(health.state).toBe('online');
    expect(health.actions).toEqual([]);
    expect(health.message).toBe('Online. Everything up to date.');
  });

  it('shows offline clearly, with the unsent count — and keeps trading (acceptance)', () => {
    const health = laneHealth({ laneId: 'lane-2', connection: 'offline', unsentCount: 37, peripherals: OK });
    expect(health.state).toBe('offline');
    expect(health.unsentCount).toBe(37);
    // Hard rule #1: offline is not a stop.
    expect(health.canTrade).toBe(true);
    expect(health.message).toContain('Offline — still selling. 37 sale(s) waiting to send.');
    expect(health.actions).toContain('37 sale(s) still to reach the cloud — do not close this lane yet');
  });

  it('flags a failed peripheral without stopping the lane', () => {
    const health = laneHealth({
      laneId: 'lane-3',
      connection: 'online',
      unsentCount: 0,
      peripherals: [
        { kind: 'scanner', state: 'failed', detail: 'no response' },
        { kind: 'printer', state: 'degraded', detail: 'paper low' },
      ],
    });
    expect(health.state).toBe('degraded');
    expect(health.canTrade).toBe(true);
    expect(health.message).toContain('Scanner down — key items in by code.');
    expect(health.actions[0]).toContain('scanner has failed — no response');
    expect(health.actions[1]).toContain('paper low');
  });

  it('says when the prices on the lane are old enough to be wrong', () => {
    const health = laneHealth({
      laneId: 'lane-4',
      connection: 'online',
      unsentCount: 0,
      peripherals: OK,
      catalogueAgeMinutes: 480,
      staleCatalogueMinutes: 240,
    });
    expect(health.state).toBe('degraded');
    expect(health.actions[0]).toContain('prices are 480 minutes old');
  });

  it('lists the lanes a manager should look at now, worst first', () => {
    const lanes = [
      laneHealth({ laneId: 'a', connection: 'online', unsentCount: 0, peripherals: OK }),
      laneHealth({ laneId: 'b', connection: 'offline', unsentCount: 12, peripherals: OK }),
      laneHealth({ laneId: 'c', connection: 'online', unsentCount: 3, peripherals: OK }),
      laneHealth({
        laneId: 'd',
        connection: 'online',
        unsentCount: 0,
        peripherals: [{ kind: 'printer', state: 'failed' }],
      }),
    ];
    expect(lanesNeedingAttention(lanes).map((l) => l.laneId)).toEqual(['b', 'd', 'c']);
  });
});
