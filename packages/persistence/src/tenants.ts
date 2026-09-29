// The register of provisioned tenants (ADR-0003 · §35 · M36 · GAP-DATA-02, the `tenants` FK half).
//
// Since migration 0013 every uuid-keyed tenant table references `tenants`, so a write for a tenant nobody
// provisioned is refused by the database itself. Registration is an explicit act at the moments a tenant
// comes into being — the genesis owner at boot, the `tenant:bootstrap` tool — recorded with who did it.
// The store surfaces the database's refusal as `TenantNotRegisteredError`, which the API turns into
// 403 `tenant_not_registered`: a token for a tenant that does not exist cannot create one.

/** Thrown by a SQL store when a write names a tenant the register does not hold. */
export class TenantNotRegisteredError extends Error {
  constructor(public readonly tenantId: string) {
    super(`tenant "${tenantId}" is not registered: no rows may be written for a tenant nobody provisioned (db/migrations/0013)`);
    this.name = 'TenantNotRegisteredError';
  }
}

/** PostgreSQL's foreign-key violation, when the failing constraint is one of the `*_tenant_fk` keys. */
export function isTenantFkViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | undefined;
  return e !== undefined && e !== null && e.code === '23503' && typeof e.constraint === 'string' && e.constraint.endsWith('_tenant_fk');
}
