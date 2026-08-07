// The shared foundation every domain service (API-01…API-13) sits on.
//
// Cross-cutting rules live here once: versioned paths, default-deny permissions, mandatory
// idempotency on writes, the three-part error, tenant isolation and the no-card-data rule.
// A service supplies its routes and its domain logic; it does not re-implement any of this.

export {
  ApiError, apiError, unauthenticated, forbidden, idempotencyKeyMissing, idempotencyKeyReused,
  notFound,
  type SavedState, type ApiErrorBody, type ErrorRefusal,
} from './errors';

export {
  Router, buildRouter, isWrite, WRITE_METHODS,
  type Method, type ApiId, type RequestContext, type HandlerResult, type Handler,
  type Route, type RouteRefusal, type RegisterResult, type Matched,
} from './router';

export {
  handle, scanOutbound, looksLikeACardNumber, hashRequest, stableStringify,
  MemoryIdempotencyStore,
  type Principal, type HttpRequest, type HttpResponse, type Authenticator,
  type StoredResult, type IdempotencyStore, type AuditSink, type KernelOptions,
  type OutboundFinding, type RequestObservation,
} from './pipeline';

export {
  structuredLogger, combineObservers, RequestMetrics,
  type Observer, type MetricsSnapshot, type RouteMetric,
} from './observability';

export {
  loadConfig, probes, CLOUD_API_CONFIG, STORE_EDGE_CONFIG,
  type ConfigProblem, type ConfigFinding, type ConfigResult, type Spec, type Probes,
  type ProbeState,
} from './config';

export {
  startHttpServer,
  type ServerOptions, type RunningServer,
} from './http-server';
export * from './idempotency-store';
export * from './audit-sink';
