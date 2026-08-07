# Data dictionary — Identity & Platform (M01–M02, M32–M35)

- **Roadmap:** §5 M01/M02/M32–M35, §28 (separation of duties), §29. **API-01 / API-11.**
- See `README.md` for the standard columns, types and markers (⊕ ⟳ 🔒). The backbone every
  other domain hangs on: legal entities, hierarchy, users/roles, versioned config, audit,
  platform ops.

## Organizational hierarchy (M01-FR-01)

The hierarchy is **Tenant → Company → Branch/Store → Warehouse/Department**. `tenant` is the
top isolation boundary of the commercial multi-tenant product (ADR-0003).

### Tenant — a retail business (a customer of the product); top isolation boundary
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `name` | text | | the retail business |
| `status` | enum{active,suspended,closed} | | (ADR-0003; `packages/tenant`) |
| `plan` | text null | | subscription plan (M36; future SaaS) |

_Every other entity carries `tenant_id`. Optional modules/departments are per-tenant
**entitlements** and settings are **per-tenant config** (`packages/tenant`, `packages/config`).
SRE Hyper Market is tenant #1._

### Company — legal entity within a tenant, root of accounting scope
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `legal_name` | text | UQ | ⟳ AVR-01 |
| `status` | enum{draft,active,inactive} | | activation is owner-approved |

### GstRegistration
| `gstin` | text | UQ | format-validated (M01-FR-01); ⟳ AVR-01 |
| `state_code` | text | | |
| `legal_name` | text | | |

_Belongs to Company; a Branch references exactly one._

### Branch (Store)
| `name` | text | | ⟳ AVR-02 |
| `gst_registration_id` | uuid | FK | required before activation |
| `type` | enum{store,warehouse_site} | | |
| `trading_status` | enum{setup,open,temp_closed,closed} | | M01-FR-04 |
| `timezone` | text | | presentation tz (stored times are UTC) |

### Warehouse
| `branch_id` | uuid | FK | |
| `name` | text | | |
| `kind` | enum{back_room,cold,bonded,general} | | |

### Department
| `store_id` | uuid | FK | belongs to exactly one store |
| `name` | text | | ⟳ AVR-02 |

## Users, roles, approvals (M01/M02, §28)

### User 🔒
| `username` | text | UQ | **individual — no shared logins** (#4) |
| `full_name` | text | 🔒 | |
| `auth_subject` | text | UQ | OIDC subject (IdP-backed; no local password store) |
| `status` | enum{active,suspended,left} | | joiner-mover-leaver (M02-FR-04) |

_Enforced by `shared-login.test.ts` — no generic/default accounts._

### Role / Permission / UserRole
- **Role** — `name` (UQ per company), `description`; least privilege.
- **Permission** — `code` (UQ), e.g. `pos.sale.create`, `price.change.approve`.
- **RolePermission** — Role ↔ Permission (many-to-many).
- **UserRole** — `user_id`, `role_id`, `branch_id null` (scope of the grant).

### ApprovalRequest (M02 — maker-checker)
| `subject_type` | text | | price change, adjustment, PO, config… |
| `subject_ref` | uuid | | the record awaiting approval |
| `requested_by` | uuid | FK User | the **maker** |
| `decided_by` | uuid null | FK User | the **checker** — must differ from the maker |
| `decision` | enum{pending,approved,rejected} | | |
| `value_minor` + `currency` | bigint | | value-threshold routing (M02-FR-03) |
| `reason` | text | | |

_Rule: maker ≠ checker (§28); routed by scope/value._

## Configuration & documents (M01-FR-02/03)

### ConfigVersion ⊕ (append-only version history)
| `key` | text | | config item |
| `value` | jsonb | | |
| `version` | int | | new immutable version per change |
| `effective_at` | timestamptz | | effective-dated |
| `status` | enum{draft,approved,active,superseded,rolled_back} | | |
| `reason` | text | | |

_Rollback = a **new** version restoring a prior one (append-only, M01-FR-03); high-impact
flags need owner approval._

### FeatureFlag
| `key` | text | UQ | |
| `enabled` | bool | | |
| `high_impact` | bool | | payments/pricing/offline limits → owner approval |

_(change history via ConfigVersion)_

### NumberSeries
| `doc_type` | enum{receipt,invoice,po,grn,statement} | | |
| `scope` | enum{company,branch,lane} | | |
| `next_value` | bigint | | **gap-free, unique per doc type** |
| `reserved_ranges` | jsonb | | **per-lane offline ranges** (M01-FR-02) |

### DocumentTemplate ⊕ (versioned)
| `doc_type` | enum | | |
| `version` | int | | never overwritten — old documents keep their layout |
| `body` | jsonb | | layout |
| `effective_at` | timestamptz | | |

## Audit & platform operations (M34 / M33 / M32 / M35)

### AuditEvent ⊕ 🔒
| `actor_id` | uuid | | **who** |
| `action` | text | | **what** |
| `entity_type` / `entity_ref` | text/uuid | | **where** |
| `before` / `after` | jsonb | 🔒 | immutable before/after (M34-FR-01) |
| `occurred_at` | timestamptz | | **when** |

_Immutable; **never deleted** (#6); legal hold & retention._

### SupportAccessGrant (M33)
| `grantee_id` | uuid | FK User | support user |
| `scope` | jsonb | | least privilege |
| `expires_at` | timestamptz | | **time-bound, auto-expiring** |
| `reason` | text | | |

_Fully audited; no standing "god-mode"._

### Device / Terminal (M33)
| `branch_id` | uuid | FK | |
| `kind` | enum{pos_lane,handheld,kiosk,printer,scale,drawer} | | |
| `identifier` | text | UQ | |
| `app_version` | text | | version control |
| `status` | enum{active,retired} | | |

### IntegrationJob (M32) & DeadLetterItem ⊕ (M32/M23)
- **IntegrationJob** — `connector` (Tally/payment/GST/WhatsApp/logistics), `status`
  enum{queued,running,retrying,failed,done}, `attempts int`.
- **DeadLetterItem ⊕** — `source_ref`, `reason`, `payload jsonb`, `resolved_at null` —
  **visible, never deleted** (#6).

### BackupRun (M35)
| `kind` | enum{full,incremental} | | |
| `started_at` / `finished_at` | timestamptz | | |
| `location` | text | | **off-site** |
| `encrypted` | bool | | |
| `restore_tested_at` | timestamptz null | | **restore tests** (M35) |

_(HealthMetric / sync-lag telemetry is operational observability, not business master
data — captured by M35 tooling, not modelled here.)_

## Offline & retention
- Hierarchy, calendar and config are **read offline** from the signed cache (M01); a
  structural change is cloud-approved and published.
- Audit, dead-letter and config history are retained per policy and **never deleted** (#6).
