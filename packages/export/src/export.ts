// Domain export (M30-FR-02 / NFR-12 / OD-09) — the promise that **your data is
// yours**. There must be **no proprietary-only route to retrieve business data**, so
// every authorised domain exports to an open, documented format (CSV + a JSON
// schema) that any spreadsheet or another system can read.
//
// Three controls make the export safe rather than a data leak:
//   • PERMISSION — default-deny via the same RBAC engine that guards every action;
//     a user without the domain's export permission gets nothing (P-04);
//   • SCOPE — rows outside the user's branch scope are filtered out, so a manager
//     cannot export another branch's data (§28);
//   • CLASSIFICATION — a column marked sensitive (PII / payment) is REDACTED unless
//     the user additionally holds the sensitive-export permission (PRV). It is
//     redacted, not silently dropped, so the shape of the file never lies.
//
// Every export returns an audit record (who / what / when / how many rows), because
// exports are logged (M30-FR-02). Pure and deterministic — no clock, no I/O.

import { AccessDeniedError, type AccessControl, type Permission } from '../../rbac/src/rbac';

export interface ExportColumn {
  readonly name: string;
  /** Documented type for the emitted schema — an open, self-describing format. */
  readonly type: 'text' | 'integer' | 'money_minor' | 'date' | 'enum';
  /** PII or payment data: redacted unless the user may export sensitive data (PRV). */
  readonly sensitive?: boolean;
  readonly description?: string;
}

export interface ExportSpec {
  readonly domain: string;
  readonly columns: readonly ExportColumn[];
  /** Permission required to export this domain at all. */
  readonly requires: Permission;
  /** Column carrying the row's branch, used to enforce scope. */
  readonly branchColumn?: string;
}

export interface ExportContext {
  readonly userId: string;
  /** The branch being exported; null = a company-wide export. */
  readonly branchId: string | null;
  /** ISO-8601 UTC, injected — the export has no clock. */
  readonly at: string;
}

/** The permission that additionally allows sensitive (PII/payment) columns. */
export const EXPORT_SENSITIVE: Permission = 'export.sensitive';

/** What was exported — logged for the audit trail (M30-FR-02). */
export interface ExportAudit {
  readonly userId: string;
  readonly domain: string;
  readonly branchId: string | null;
  readonly at: string;
  readonly rowCount: number;
  /** Columns that were redacted for this user, so the log is honest. */
  readonly redactedColumns: readonly string[];
}

export interface ExportResult {
  /** The data in CSV — openly readable, no proprietary route required (NFR-12). */
  readonly csv: string;
  /** The machine-readable schema shipped alongside, so the file is self-describing. */
  readonly schema: {
    readonly domain: string;
    readonly columns: readonly { readonly name: string; readonly type: string; readonly description?: string }[];
  };
  readonly audit: ExportAudit;
}

/** The marker written in place of a sensitive value the user may not see. */
export const REDACTED = '[redacted]';

/** Quote a CSV cell only when it needs it, escaping embedded quotes (RFC 4180). */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Export a domain's rows for a user. Throws `AccessDeniedError` when the user may
 * not export this domain; filters rows outside their branch scope; redacts sensitive
 * columns unless they hold `export.sensitive`. Returns the CSV, its schema, and the
 * audit record to log.
 */
export function exportDomain(
  spec: ExportSpec,
  rows: readonly Readonly<Record<string, string>>[],
  access: AccessControl,
  context: ExportContext,
): ExportResult {
  const query = { userId: context.userId, permission: spec.requires, branchId: context.branchId };
  if (!access.can(query)) {
    // Default-deny: the same check that guards the action guards its export.
    throw new AccessDeniedError(query);
  }

  const maySeeSensitive = access.can({
    userId: context.userId,
    permission: EXPORT_SENSITIVE,
    branchId: context.branchId,
  });
  const redactedColumns = maySeeSensitive
    ? []
    : spec.columns.filter((c) => c.sensitive).map((c) => c.name);

  // Scope: a branch export never includes another branch's rows.
  const scoped =
    spec.branchColumn !== undefined && context.branchId !== null
      ? rows.filter((r) => r[spec.branchColumn!] === context.branchId)
      : rows;

  const header = spec.columns.map((c) => csvCell(c.name)).join(',');
  const body = scoped.map((row) =>
    spec.columns
      .map((column) => {
        const raw = row[column.name] ?? '';
        // Redacted, not dropped — the file's shape never lies about what exists.
        return csvCell(column.sensitive && !maySeeSensitive ? REDACTED : raw);
      })
      .join(','),
  );

  return {
    csv: [header, ...body].join('\n') + '\n',
    schema: {
      domain: spec.domain,
      columns: spec.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.description !== undefined ? { description: c.description } : {}),
      })),
    },
    audit: {
      userId: context.userId,
      domain: spec.domain,
      branchId: context.branchId,
      at: context.at,
      rowCount: scoped.length,
      redactedColumns,
    },
  };
}
