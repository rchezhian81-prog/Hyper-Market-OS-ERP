// Which shops' CUSTOMER realms head office believes (OB-510 · ADR-0031 amended · ADR-0019 §4 · OB-19 · M20-FR-01).
//
// Each shop's customers sign in through its own customer realm at the self-hosted identity server (`sre-<shop>-customers`),
// beside — never inside — the shop's staff realm. Head office is told, in its settings, which customer realms there are and
// which ONE shop each signs for:
//
//   IDP_OIDC_CUSTOMER_REALMS   realm=tenant, comma-separated  (sre-store-customers=<tenant id>,…)
//
// A customer realm's issuer and keys are the first staff realm's (IDP_OIDC_ISSUER / IDP_OIDC_JWKS_URL) with only the realm's
// name changed — the same identity server. Its tokens are believed only for its own shop and only when they name a CUSTOMER
// (`customer-…`): a customer realm can never sign a member of staff in. Absent → no customer realm is believed (customer
// sign-in is off until an SMS provider is approved anyway, OB-222).

import { realmOf, type ShopRealm } from './shop-realms';
import { CUSTOMER_SUBJECT_PREFIX } from './keycloak-customer-signer';

export interface CustomerRealm extends ShopRealm {
  readonly tenantId: string;
  /** Only customers: the product id the token names must start with this. */
  readonly subjectPrefix: string;
}

const REALM_NAME = /^[a-z0-9][a-z0-9-]{1,48}-customers$/;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read the settings. `problems` lists, in the operator's words, everything that stops head office starting. */
export function customerRealmsFrom(env: Readonly<Record<string, string | undefined>>, staffRealms: readonly ShopRealm[] = []): { readonly realms: readonly CustomerRealm[]; readonly problems: readonly string[] } {
  const listed = env['IDP_OIDC_CUSTOMER_REALMS']?.trim() || undefined;
  if (listed === undefined) return { realms: [], problems: [] };
  const issuer = env['IDP_OIDC_ISSUER']?.trim();
  const jwks = env['IDP_OIDC_JWKS_URL']?.trim();
  const first = issuer === undefined || issuer === '' ? undefined : realmOf(issuer);
  if (issuer === undefined || jwks === undefined || jwks === '' || first === undefined) {
    return { realms: [], problems: ['IDP_OIDC_CUSTOMER_REALMS is set without the identity server (IDP_OIDC_ISSUER, IDP_OIDC_JWKS_URL).'] };
  }
  const problems: string[] = [];
  const realms: CustomerRealm[] = [];
  const staffNames = new Set(staffRealms.map((r) => r.realm));
  for (const entry of listed.split(',').map((e) => e.trim()).filter((e) => e !== '')) {
    const [realm = '', tenantId = ''] = entry.split('=').map((x) => x.trim());
    if (!REALM_NAME.test(realm) || !TENANT.test(tenantId)) {
      problems.push(`IDP_OIDC_CUSTOMER_REALMS entry "${entry}" is not realm=tenant (a realm name ending in "-customers"; a tenant UUID).`);
      continue;
    }
    if (staffNames.has(realm)) { problems.push(`The realm "${realm}" is named as a staff realm and a customer realm — they are separate realms.`); continue; }
    if (realms.some((r) => r.realm === realm)) { problems.push(`The customer realm "${realm}" is named twice.`); continue; }
    if (realms.some((r) => r.tenantId === tenantId)) { problems.push(`The shop ${tenantId} is given two customer realms — one shop, one customer realm.`); continue; }
    realms.push({
      realm, tenantId, subjectPrefix: CUSTOMER_SUBJECT_PREFIX,
      issuer: issuer.replace(`/realms/${first}`, `/realms/${realm}`), jwksUrl: jwks.replace(`/realms/${first}`, `/realms/${realm}`),
    });
  }
  return { realms, problems };
}
