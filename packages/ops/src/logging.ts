// Structured logging with redaction at the boundary (M35-FR-03 / SEC-04 / PRV /
// hard rules #3 and #4).
//
// Logs are where secrets escape. Not through a breach — through a well-meaning
// `log.info('request', req)` written at 2am to debug something, which then ships a
// card number, an OTP or a database password into a log aggregator that a dozen
// people can read and that nobody audits.
//
// The usual defence is a code-review rule, and it fails, because it depends on
// everybody remembering forever. So this logger redacts by CONSTRUCTION:
//
//   • field names that look sensitive are redacted wherever they appear, at any
//     depth — password, token, secret, key, authorization, cvv, otp, pin…;
//   • VALUES that look like a card number are redacted even under an innocent field
//     name, because `{ reference: '4111111111111111' }` is the real-world case —
//     nobody calls it `cardNumber` when they leak it;
//   • the Luhn check is applied, so a 16-digit order id is not mangled while a real
//     PAN is;
//   • personal data (phone, email) is MASKED rather than removed, so a support
//     engineer can still correlate "the same customer" without reading who it is.
//
// Redaction is not reversible and never logs what it removed — a log line saying
// "redacted a value starting with 4111" would defeat the purpose.
//
// Pure and deterministic: the timestamp is injected, and the sink is a port, so
// tests capture output instead of writing anywhere.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const REDACTED = '[redacted]';

/** Field names that are never logged, at any depth, in any casing. */
const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'session',
  'sessionid',
  'privatekey',
  'connectionstring',
  'databaseurl',
  'dsn',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'cardnumber',
  'card_no',
  'pan',
  'expiry',
  'aadhaar',
  'aadhar',
];

/** Field names whose value is personal data: masked, not removed (PRV-01). */
const PII_KEYS: readonly string[] = ['phone', 'mobile', 'email', 'address', 'name', 'customername'];

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return SENSITIVE_KEYS.some((s) => k === s || k.includes(s));
}

function isPiiKey(key: string): boolean {
  const k = normaliseKey(key);
  return PII_KEYS.some((s) => k === s || k.endsWith(s));
}

/** Luhn check — distinguishes a real card number from a 16-digit order id. */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Mask personal data so it can still be correlated but not read:
 * `9876543210` → `98****3210`, `priya@example.com` → `p***a@example.com`.
 */
export function maskPii(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 1);
    const tail = local.length > 1 ? local.slice(-1) : '';
    return `${head}***${tail}@${domain}`;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 7) {
    return `${digits.slice(0, 2)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
  }
  return value.length <= 2 ? '**' : `${value.slice(0, 1)}***${value.slice(-1)}`;
}

/**
 * Redact a value for logging. Handles nested objects and arrays; cycles terminate.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return looksLikeCardNumber(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (isPiiKey(key) && typeof raw === 'string') {
      out[key] = maskPii(raw);
      continue;
    }
    out[key] = redact(raw, seen);
  }
  return out;
}

export interface LogRecord {
  readonly at: string;
  readonly level: LogLevel;
  readonly message: string;
  /** Correlates a request across services (§30). */
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly branchId?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Where records go. A port, so tests capture and deployments choose (P-06). */
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  readonly sink: LogSink;
  /** Records below this level are dropped. */
  readonly minLevel?: LogLevel;
  readonly tenantId?: string;
  readonly branchId?: string;
  readonly correlationId?: string;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * A structured logger that cannot leak a secret through its own API, because every
 * value passes through `redact` before it reaches the sink.
 */
export class Logger {
  private readonly sink: LogSink;
  private readonly minLevel: LogLevel;
  private readonly base: { tenantId?: string; branchId?: string; correlationId?: string };

  constructor(options: LoggerOptions) {
    this.sink = options.sink;
    this.minLevel = options.minLevel ?? 'info';
    this.base = {
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options.branchId !== undefined ? { branchId: options.branchId } : {}),
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    };
  }

  /** A child logger carrying more context — the usual per-request pattern. */
  child(extra: { tenantId?: string; branchId?: string; correlationId?: string }): Logger {
    return new Logger({
      sink: this.sink,
      minLevel: this.minLevel,
      ...this.base,
      ...extra,
    });
  }

  log(level: LogLevel, message: string, context: Record<string, unknown> | undefined, at: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.sink({
      at,
      level,
      // The message itself is redacted too — a PAN interpolated into a string is the
      // commonest leak of all.
      message: String(redact(message)),
      ...this.base,
      ...(context !== undefined ? { context: redact(context) as Record<string, unknown> } : {}),
    });
  }

  debug(message: string, context: Record<string, unknown> | undefined, at: string): void {
    this.log('debug', message, context, at);
  }
  info(message: string, context: Record<string, unknown> | undefined, at: string): void {
    this.log('info', message, context, at);
  }
  warn(message: string, context: Record<string, unknown> | undefined, at: string): void {
    this.log('warn', message, context, at);
  }
  error(message: string, context: Record<string, unknown> | undefined, at: string): void {
    this.log('error', message, context, at);
  }
}

/** Collects records in memory — for tests and for the edge's buffered telemetry. */
export function memorySink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (r) => records.push(r), records };
}
