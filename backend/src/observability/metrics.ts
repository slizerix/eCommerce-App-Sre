import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

// Single registry for the process. Exposed via GET /metrics.
export const registry = new Registry();
registry.setDefaultLabels({ service: 'backend' });

// Default process metrics (event loop lag, GC, RSS, FDs, etc.) — cheap and
// useful enough to keep on.
collectDefaultMetrics({ register: registry });

// ── HTTP layer ─────────────────────────────────────────────────────────────
//
// Cardinality discipline:
//   - `route` uses the Express route template (e.g. `/api/products/:id`), not
//     the raw URL, so /api/products/42 and /api/products/43 share a series.
//   - `status_class` collapses 200/201/204 → "2xx", etc. Keeps panels readable
//     and series count bounded.
//   - `error_code` is set only on non-2xx and only from a closed enum of known
//     HttpError codes; unknown codes are mapped to "unknown".
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled, labeled by route template, method, status class, and error code.',
  labelNames: ['route', 'method', 'status_class', 'error_code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request handling latency in seconds.',
  labelNames: ['route', 'method', 'status_class'] as const,
  // Buckets tuned for an in-process API in front of MySQL: most calls land
  // under 50ms, payment is 120-450ms, the related-products self-join can
  // climb past 1s as order volume grows.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// ── Database layer ─────────────────────────────────────────────────────────
//
// `query_name` is a stable, hand-picked label per known query (e.g.
// `products_related`, `products_search`). We intentionally do NOT label by
// raw SQL text or by table name — only by the named queries we care about.
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of named database queries in seconds.',
  labelNames: ['query'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// ── Payment provider ───────────────────────────────────────────────────────
//
// Track the mock provider as if it were a real third party. Two key shapes:
//   - latency histogram → catches provider degradation (p95 climbing while our
//     own latency stays flat means it's them, not us).
//   - attempts counter with {result, decline_reason} → drives the conversion
//     funnel and decline-reason breakdown.
export const paymentDuration = new Histogram({
  name: 'payment_duration_seconds',
  help: 'Latency of the outbound call to the payment provider.',
  labelNames: ['provider'] as const,
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5],
  registers: [registry],
});

export const paymentAttempts = new Counter({
  name: 'payment_attempts_total',
  help: 'Payment attempts by result and decline reason.',
  labelNames: ['provider', 'result', 'decline_reason'] as const,
  registers: [registry],
});

// ── Business funnel ────────────────────────────────────────────────────────
//
// These counters together describe the user journey:
//   signups → logins → cart_adds → checkouts_created → payment_succeeded.
// Ratios between them are the funnel conversion. Each is intentionally
// low-cardinality.
export const signupsTotal = new Counter({
  name: 'signups_total',
  help: 'Successful account signups.',
  registers: [registry],
});

export const loginsTotal = new Counter({
  name: 'logins_total',
  help: 'Login attempts by result.',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const cartAddsTotal = new Counter({
  name: 'cart_adds_total',
  help: 'Items added to a cart.',
  registers: [registry],
});

export const checkoutsCreatedTotal = new Counter({
  name: 'checkouts_created_total',
  help: 'Checkout attempts by result. `result=created` means an order was successfully created.',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const ordersByStatus = new Counter({
  name: 'orders_status_transitions_total',
  help: 'Order state transitions, labeled by destination status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const insufficientStockTotal = new Counter({
  name: 'insufficient_stock_total',
  help: 'How often a cart/checkout was blocked by insufficient stock. A leading indicator of demand spikes or stale stock.',
  registers: [registry],
});

// ── Helpers ────────────────────────────────────────────────────────────────

const KNOWN_ERROR_CODES = new Set([
  'invalid_input',
  'invalid_credentials',
  'missing_token',
  'invalid_token',
  'email_taken',
  'not_found',
  'product_not_found',
  'order_not_found',
  'empty_cart',
  'insufficient_stock',
  'order_not_payable',
  'payment_declined',
  'internal_error',
]);

export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

export function normalizeErrorCode(code: string | undefined): string {
  if (!code) return '';
  return KNOWN_ERROR_CODES.has(code) ? code : 'unknown';
}

// Times a DB query and records into the histogram. Use sparingly — only on
// the queries you actually want a panel for. Random one-off queries should
// stay unlabeled.
export async function timeDbQuery<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const end = dbQueryDuration.startTimer({ query: name });
  try {
    return await fn();
  } finally {
    end();
  }
}
