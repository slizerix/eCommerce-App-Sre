# Metric & Log Catalog

This is the single source of truth for what the backend exposes, what each
signal means, what *normal* looks like, and what a change implies. The AI
observability service reads this file via the `get_metric_catalog` tool when
it needs context the system prompt's summary doesn't cover.

Everything in this catalog **must** be exposed in Prometheus or Elasticsearch
and reachable by the AI service. Catalog ↔ running system ↔ LLM runtime
context agree, or one of them is wrong.

---

## Conventions

- Counters end in `_total` (per Prometheus convention).
- Histograms expose `_bucket`, `_sum`, `_count` and use seconds for time.
- Labels are bounded enumerations. `route` uses the Express template, not
  the URL. `status_class` collapses to `2xx`/`3xx`/`4xx`/`5xx`. `error_code`
  is a closed enum, see below.
- No label ever takes a high-cardinality value (user id, order id, product
  id, raw URL). Those belong in logs.

---

## HTTP layer

### `http_requests_total`
- **Type:** counter, labels `route, method, status_class, error_code`.
- **Description:** Every HTTP request handled by the backend, after routing.
- **Why it matters:** This is the canonical traffic-and-errors series. Most
  investigations start here.
- **Normal:** With the load generator on, ~3 req/s split across the catalog
  routes. `error_code` is empty on 2xx and one of the closed-enum codes
  below on non-2xx.
- **Implications:**
  - A sustained jump in `status_class="5xx"` for any route is **ours** —
    something is throwing past `HttpError` (i.e. uncaught).
  - A jump in `4xx` is usually client-driven; check `error_code` to know
    which kind (`invalid_credentials` → auth attempts, `insufficient_stock`
    → inventory pressure).
  - `route="unmatched"` rising means somebody is hitting paths we don't
    serve — usually a frontend deploy mismatch.

### `http_request_duration_seconds`
- **Type:** histogram, labels `route, method, status_class`.
- **Description:** Time from middleware entry to response finish.
- **Buckets:** `5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s`.
- **Why it matters:** Per-route latency, which is what on-call actually feels.
- **Normal:** Catalog/cart/checkout p95 < 100ms. `/api/products/:id/related`
  p95 starts < 50ms and **climbs as orders accumulate** (intentional — the
  self-join is unindexed). `/api/payment` p95 ≈ 350-500ms (provider latency
  dominates).
- **Implications:**
  - `/api/payment` p95 climbing while `payment_duration_seconds` p95
    stays flat → bug in our handler. Otherwise it's the provider.
  - `/api/products/:id/related` p95 climbing past 500ms while everything
    else is flat → the slow self-join. Confirm with
    `db_query_duration_seconds{query="products_related"}`.
  - Generalised p95 rise across all routes → event loop or DB
    saturation. Check `nodejs_eventloop_lag_p99_seconds` and DB pool.

---

## Database layer

### `db_query_duration_seconds`
- **Type:** histogram, label `query` (named queries only).
- **Named queries:** `products_list`, `products_search`, `products_related`.
- **Description:** Wall-clock duration of the hand-picked queries we care
  about. Not every query — adding noise here defeats the purpose.
- **Normal:** `products_list` < 5ms. `products_search` < 20ms on 120 rows
  (degrades with row count — `LIKE '%...%'` is unindexed). `products_related`
  < 50ms on cold seed, climbs with `orders_status_transitions_total`.
- **Implications:**
  - p95 climbing on one named query but not the others → that query is the
    bottleneck. Pull example log lines with the matching route to see
    payload patterns.
  - All named queries climbing together → DB-side problem (lock, pool
    exhaustion, IO). Cross-check `db_pool_connections` and the MySQL-side
    metrics (`mysql_global_status_*`).

### `db_queries_total`
- **Type:** counter, labels `query`, `result` (`success` | `error`).
- **Description:** Outcome counter paired with `db_query_duration_seconds`.
  The histogram only records successful timings; this counter is how you
  see query-level failure rates.
- **Normal:** `result=success` dominates. Sporadic `result=error` during
  schema migrations or transient connection blips is fine.
- **Implications:**
  - Sustained `result=error` on a specific query with healthy MySQL-side
    metrics → application-level issue (bad input, missing index, schema
    mismatch).
  - `result=error` spiking together with `mysql_global_status_threads_connected`
    near `max_connections` → MySQL refusing connections; we're saturating
    the server, not the pool.

### `db_pool_connections`
- **Type:** gauge, label `state`
  (`acquired` | `free` | `queued` | `max`).
- **Description:** mysql2 pool saturation, sampled every 1s from the pool's
  internal arrays. `max` is the static ceiling (10), exposed so panels can
  show a reference line without templating.
- **Normal:** `acquired` ≤ 3 under steady ~3 RPS load; `free` makes up the
  rest; `queued` stays at 0. The total `acquired + free` grows lazily up to
  `max` as concurrent demand spikes.
- **Implications:**
  - `queued > 0` sustained → the app is waiting for connections. Adding more
    app workers won't help; either widen the pool, shorten queries, or
    accept the bottleneck. This is the most actionable DB-side signal.
  - `acquired` pinned at `max` with `queued` rising → classic pool
    exhaustion. Pair with `db_query_duration_seconds` p95 to see if it's
    long queries holding connections.

---

## MySQL server (from mysqld-exporter)

Scraped from a `prom/mysqld-exporter` sidecar talking to MySQL on port 3306.
Gives the "from MySQL's perspective" view that the app-side `db_*` metrics
can't see (other clients, internal threads, the exporter itself).

### `mysql_global_status_queries`
- **Type:** counter. Use `rate(...[1m])` for QPS.
- **Description:** Every statement MySQL executed, including those from the
  exporter and any external `mysql` shell.
- **Normal:** Our app-side `sum(rate(db_queries_total[1m]))` should be the
  vast majority. Background load adds ~1-3 QPS from the exporter itself.
- **Implications:** Mysql QPS climbing while our app-side QPS stays flat →
  something else is hitting the database (a runaway script, a forgotten
  shell, a misbehaving cron). Check `mysql_info_schema_processlist_*`.

### `mysql_global_status_threads_connected` / `_threads_running`
- **Type:** gauges.
- **Description:** Currently established connections, and the subset
  actively executing a query right now.
- **Normal:** `threads_connected` ≈ 12 (10 from our pool when full +
  exporter + a couple of admin). `threads_running` near 0 most of the time.
- **Implications:** `threads_connected` climbing past 12 → another client.
  `threads_running` sustained above ~3 → long-running queries piling up;
  cross-check `db_query_duration_seconds` and the processlist.

### `mysql_global_variables_max_connections`
- **Type:** gauge (constant, exposed for ratios).
- **Description:** MySQL's hard ceiling. Default 151 in MySQL 8.4.
- **Implications:** If we ever approach this we have a leak — our pool
  capping at 10 should make it impossible under correct operation.

### InnoDB buffer pool: hit rate
- **Expression:**
  `1 - rate(mysql_global_status_innodb_buffer_pool_reads[5m]) /
       rate(mysql_global_status_innodb_buffer_pool_read_requests[5m])`
- **Description:** Fraction of InnoDB reads served from memory rather than
  hitting disk. A demo with a small hot dataset should sit at >99%.
- **Implications:** A persistent dip below ~95% means working set has
  outgrown the buffer pool. Either reduce dataset, increase
  `innodb_buffer_pool_size`, or accept disk-bound reads.

---

## Payment provider

### `payment_duration_seconds`
- **Type:** histogram, label `provider`.
- **Description:** Latency of the outbound call to the payment provider
  only, **not** our HTTP handler.
- **Normal:** Uniform random in `[120ms, 450ms]` so p50 ≈ 280ms,
  p95 ≈ 430ms, p99 ≈ 445ms. p95 / p50 ratio stays close to 1.5×.
- **Implications:**
  - p95 above ~400ms sustained while `http_request_duration_seconds`
    for `/api/payment` matches it → provider is degrading independently of
    us. Tell the customer it's not them.
  - p95 climbing while `payment_attempts_total{result="failed"}` is also
    climbing → provider is brown-out: slow responses AND declines.

### `payment_attempts_total`
- **Type:** counter, labels `provider, result, decline_reason`.
- **`result` values:** `succeeded`, `failed`.
- **`decline_reason` values:** `""` (on success), `insufficient_funds`,
  `do_not_honor`.
- **Description:** Every payment attempt, tallied by outcome.
- **Normal:** Success rate ≥ 92% (default `PAYMENT_FAILURE_RATE=0.08`).
- **Implications:**
  - Success rate < 90% sustained → provider quality regression. Use
    `count_logs_by` on `decline_reason` to confirm the failure pattern.
  - A single decline reason dominating → specific failure mode (e.g. card
    network issue if `do_not_honor` spikes alone).

---

## Business funnel

### `signups_total`
- Counter, no labels. Successful signups. Cheap leading indicator of
  acquisition activity; not a reliability signal on its own.

### `logins_total`
- Counter, label `result` ∈ `{success, invalid_credentials}`.
- **Normal:** Mostly `success`. A burst of `invalid_credentials` with
  varied IP/email = credential stuffing; concentrated on one email = a user
  who forgot their password. Logs are the only way to tell them apart.

### `cart_adds_total`
- Counter, no labels.
- **Normal:** Tracks with browse traffic. If it falls to zero while
  `http_requests_total{route="/api/products"}` is unchanged, the cart
  endpoint is broken.

### `checkouts_created_total`
- Counter, label `result` ∈ `{created, empty_cart, insufficient_stock}`.
- **Normal:** `created` dominates. Spikes in `insufficient_stock` signal
  either a demand surge or stale stock numbers.

### `orders_status_transitions_total`
- Counter, label `status` ∈ `{pending_payment, paid, payment_failed}`.
- **Description:** One increment per order state transition into the given
  status.
- **Implications:** `paid` rate should equal
  `payment_attempts_total{result="succeeded"}` rate. Divergence means
  there's an order in a state the system doesn't recognise.

### `insufficient_stock_total`
- Counter, no labels.
- **Description:** Counts how often a checkout was blocked by stock
  shortage. A leading indicator: this rises **before** customer
  complaints arrive.

---

## Process & runtime

The default `prom-client` set is enabled. The ones worth knowing:

- **`nodejs_eventloop_lag_p99_seconds`** — anything sustained above
  `50ms` is dangerous. Above `200ms` means requests are queuing.
- **`process_resident_memory_bytes`** — slow growth without recovery on
  GC is a leak. Steady-state ~80-150 MiB is fine.
- **`process_cpu_seconds_total`** — rate gives core utilisation. A single
  Node process saturates at ~1 core.

---

## Log facets (Elasticsearch index `shop-logs-*`)

Every log line is JSON. Stable fields:

- **`@timestamp`** — ISO 8601, server time. Index time field.
- **`service.name`** — `backend` (or `loadgen`, `ai-service` if those ever log). Nested object so the field matches ES's default ECS template.
- **`level`** — `info | warn | error`. Use `level:(warn OR error)` to find
  problems quickly.
- **`request_id`** — opaque 12-char id, echoed in the `X-Request-Id`
  header. Pivot from any single line to the whole request.
- **`event`** — closed-enum event name. See below.
- **`route`** — Express route template (same value as the metric label).
- **`method`** — HTTP method.
- **`status`**, **`status_class`** — HTTP response status and class.
- **`duration_ms`** — request duration as an integer.
- **`user_id`** — set on authenticated requests only.
- **`error_code`** — closed-enum business error code (see below).

### Event names

- `http_request` — one per request, always.
- `http_error` — emitted alongside `http_request` when an `HttpError`
  bubbles up. Includes `error_code` and `message`.
- `unhandled_error` — an error not modeled as `HttpError`. Should be rare
  — every one is worth reading.
- `service.started` — backend boot.
- `auth.signup`, `auth.login` — successful auth events.
- `cart.item_added` — fields: `product_id`, `quantity`.
- `checkout.created` — fields: `order_id`, `total_cents`, `item_count`.
- `checkout.insufficient_stock` — fields: `product_id`, `requested`,
  `available`. Always paired with `error_code:insufficient_stock`.
- `payment.attempted`, `payment.succeeded`, `payment.declined` — fields:
  `order_id`, `amount_cents`, `provider`, `provider_latency_ms`,
  `decline_reason` (declined only).

### Error codes (closed enum, used as both metric label and log field)

`invalid_input`, `invalid_credentials`, `missing_token`, `invalid_token`,
`email_taken`, `not_found`, `product_not_found`, `order_not_found`,
`empty_cart`, `insufficient_stock`, `order_not_payable`,
`payment_declined`, `internal_error`.

Anything outside this set is normalised to `unknown` in the metric label
(but kept verbatim in logs).
