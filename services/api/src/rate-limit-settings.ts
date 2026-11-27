// Head office's three request allowances — audit 27 Nov 2026 item 3 (OB-916) · FND-03 / GAP-SEC-04 · SEC-06.
//
// Per ADDRESS (before anything else), per SHOP for its staff and store computers, and per SHOP for its customers. Each is
// a token bucket read from the settings in services/kernel/src/config.ts (with defaults). This file only reads them and
// refuses a combination that would bring the old fault back: a shop allowance smaller than one address's lets one caller
// spend the whole shop's.

import type { Principal, TokenBucketConfig } from '../../kernel/src/index';
import { CUSTOMER_SUBJECT_PREFIX } from '../../identity/src/keycloak-customer-signer';

export interface RateLimitSettings {
  readonly perAddress: TokenBucketConfig;
  readonly perShop: TokenBucketConfig;
  readonly customersPerShop: TokenBucketConfig;
}

/** The three allowances from the checked settings, or why they would let one caller spend a shop's allowance. */
export function rateLimitSettingsOf(settings: Readonly<Record<string, string>>): { readonly ok: true; readonly value: RateLimitSettings } | { readonly ok: false; readonly detail: string } {
  const bucket = (prefix: string): TokenBucketConfig => ({ capacity: Number(settings[`${prefix}_BURST`]), refillPerSecond: Number(settings[`${prefix}_PER_SECOND`]) });
  const value: RateLimitSettings = {
    perAddress: bucket('RATE_LIMIT_PER_ADDRESS'),
    perShop: bucket('RATE_LIMIT_PER_SHOP'),
    customersPerShop: bucket('RATE_LIMIT_CUSTOMERS_PER_SHOP'),
  };
  const small = ([['RATE_LIMIT_PER_SHOP', value.perShop], ['RATE_LIMIT_CUSTOMERS_PER_SHOP', value.customersPerShop]] as const)
    .filter(([, b]) => b.capacity < value.perAddress.capacity || b.refillPerSecond < value.perAddress.refillPerSecond)
    .map(([k]) => k);
  if (small.length > 0) {
    return {
      ok: false,
      detail: `${small.join(' and ')} must be at least RATE_LIMIT_PER_ADDRESS (burst and per second): a shop's allowance smaller than one address's lets one caller spend the whole shop's (audit 27 Nov 2026 item 3).`,
    };
  }
  return { ok: true, value };
}

/** A customer of a shop (the customer realm's people, `customer-…`), read from the SIGNED principal — never the request. */
export function isCustomerCaller(principal: Principal): boolean {
  return principal.userId.startsWith(CUSTOMER_SUBJECT_PREFIX);
}
