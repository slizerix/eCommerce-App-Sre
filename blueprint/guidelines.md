# Observability Guidelines & Procedures

This file is the contract between code, dashboards, and the AI service.
It exists so that anyone (or any LLM) adding instrumentation produces
something that fits the rest of the system instead of inventing a new
shape.

The AI service loads this file via `get_runbook`. Procedures here are not
descriptive — they're prescriptive. Follow them.

---

## Conventions

### Logs

- **Format:** JSON, one object per line, written to stdout. Filebeat tails
  the container log and ships to Elasticsearch index `shop-logs-*`.
- **Required fields on every line:** `@timestamp`, `level`, `service`,
  `request_id` (HTTP-context lines), `event`.
- **HTTP request lines** add: `method`, `route`, `path`, `status`,
  `status_class`, `duration_ms`, `user_id?`, `error_code?`.
- **Business event lines** add an `event` of the form `<domain>.<verb>`
  (e.g. `payment.declined`, `cart.item_added`) plus event-specific fields.
- **Field naming is stable.** `order_id` not `orderId`, `amount_cents`
  not `amount`, `provider_latency_ms` not `latency`. The AI service
  searches on these names; renaming a field breaks investigations.

### Metrics

- Counters end in `_total`. Histograms expose `_bucket`, `_sum`, `_count`
  in seconds.
- **Cardinality discipline:** never label by `user_id`, `order_id`,
  `product_id`, raw URL, or any other unbounded value. Use labels only
  for closed enums. Per-entity detail goes in logs.
- **Route labels** use Express route templates (`/api/products/:id`),
  not URLs. The HTTP middleware captures this from `req.route?.path`.
- **Error code labels** use the closed enum defined in `catalog.md`.
  Unknown codes normalise to `"unknown"` so a new branch can't silently
  blow up cardinality.
- **Buckets:** pick by domain knowledge of expected latency. For an
  endpoint that sometimes calls a 120-450ms provider, include 0.1, 0.25,
  0.5, 1, 2 — without them p95 is meaningless.

### Dashboards

- Two dashboards, both provisioned from files in
  `observability/grafana/dashboards/`:
  - **User Journey** — the funnel (signups → logins → cart → checkout →
    payments), payment outcomes, payment latency, checkout failure modes.
  - **System Health** — RPS, p95 latency, error rate, top error codes,
    DB query p95, process metrics, recent error logs.
- Every panel has a `description` field that explains what to look for —
  not what the panel shows. The AI service quotes these.
- No kitchen-sink panels. If a panel doesn't answer a question the
  on-call would actually ask, delete it.

### Error surfacing

- Errors flow through `HttpError` in `backend/src/util.ts`. The error
  middleware in `index.ts` does three things on catch:
  1. Sets `req.errorCode` so the metrics middleware can attach the label.
  2. Emits a `http_error` log line at `warn` level with `error_code`.
  3. Responds JSON `{ error, message }`.
- Anything that bypasses `HttpError` becomes `internal_error` (5xx,
  `event:unhandled_error`). Every one of those is a bug.

---

## Procedures

### Add a new metric

1. Pick the type. Counter for "how often", histogram for "how long".
   Never a gauge unless the value is a level reading (size, count of
   in-flight things).
2. Add it in `backend/src/observability/metrics.ts`. Register it on
   the shared `registry`. Choose **bounded** label names only.
3. Use it at the right layer:
   - HTTP-shaped → in middleware, after the route matches.
   - Domain event → in the route handler, after the side-effect succeeds.
   - DB-shaped → wrap with `timeDbQuery('<query_name>', () => ...)`.
4. Add an entry to `catalog.md`. Include: one-line description, why it
   matters, what normal looks like, what a change implies.
5. Add or extend a Grafana panel that uses it (see below).

### Emit a searchable log

1. Use `req.log` (per-request child logger with `request_id` pre-attached)
   from inside a route handler, or `baseLogger` from background code.
2. **First argument is the structured object**, second argument is the
   human message — pino convention. Don't string-interpolate fields into
   the message; put them in the object so they're searchable.
3. Pick an `event` name shaped `<domain>.<verb>` and add it to the
   catalog's event list. If an event already exists for that situation,
   reuse it.
4. Use field names from the catalog vocabulary. New field? Add it to the
   catalog **before** emitting it in code.

### Add a Grafana panel

1. Edit the right dashboard JSON in `observability/grafana/dashboards/`.
   Grafana reloads it within 10 seconds (provisioning `updateIntervalSeconds`).
2. Always set `description` — that's what humans (and the AI) read first.
3. Use the same datasource `uid` as the rest of the dashboard
   (`prometheus` or `elasticsearch`).
4. Pick the right viz:
   - timeseries for rates/latencies over time,
   - stat for "is this number ok right now",
   - table for top-N enumerations,
   - logs panel for ES queries.
5. Tag the dashboard `shop` so it can be filtered later.

---

## Common PromQL patterns

| Symptom | Query |
|---|---|
| Overall RPS | `sum(rate(http_requests_total[1m]))` |
| RPS by route | `sum by (route) (rate(http_requests_total[1m]))` |
| 5xx rate per route | `sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))` |
| Error ratio per route | `sum by (route) (rate(http_requests_total{status_class=~"4xx\|5xx"}[5m])) / sum by (route) (rate(http_requests_total[5m]))` |
| p95 latency per route | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))` |
| p95 latency for one route | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/api/payment"}[5m])))` |
| Payment provider p95 | `histogram_quantile(0.95, sum by (le) (rate(payment_duration_seconds_bucket[5m])))` |
| Payment success rate | `sum(rate(payment_attempts_total{result="succeeded"}[5m])) / clamp_min(sum(rate(payment_attempts_total[5m])), 0.0001)` |
| Top error codes (5m) | `topk(5, sum by (error_code) (increase(http_requests_total{error_code!=""}[5m])))` |
| DB query p95 by name | `histogram_quantile(0.95, sum by (le, query) (rate(db_query_duration_seconds_bucket[5m])))` |
| Event loop lag | `nodejs_eventloop_lag_p99_seconds` |

---

## Triage loop (the procedure the AI follows)

Every investigation walks this loop. The AI service is told to follow it
in the system prompt; humans should too.

```
  SYMPTOM    ── restate the question as a measurable, time-bounded symptom
     │         ("payments feel slow last 15 min" not "things are bad").
     ▼
  METRIC     ── query the metric that names the symptom. If you don't
     │         know its name, list_metric_names with a substring filter.
     ▼
  NARROW     ── if anomalous, split by the most informative label
     │         (route, status_class, decline_reason, query, ...) to find
     ▼         which slice is driving it.
  LOGS       ── search ES for the events behind the slice. Match on
     │         event, route, error_code; pull request_id from one
     ▼         representative hit if you need the full request context.
  HYPOTHESIS ── state in one sentence what you think is happening.
     │         Distinguish us-vs-them (our service, the DB, the provider).
     ▼
  CONFIRM    ── find one more piece of evidence that picks your
                hypothesis over the most likely alternative. If the
                metric and log agree, you're done. If they disagree,
                trust the logs and rewrite the hypothesis.
```

### Worked example

**Question:** "Why is checkout slow right now?"

1. SYMPTOM: `/api/payment` p95 over the last 15 minutes.
2. METRIC: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/api/payment"}[5m])))`
   → 1.2s (catalog says normal ≤ 500ms).
3. NARROW: is it our handler or the provider?
   - `histogram_quantile(0.95, sum by (le) (rate(payment_duration_seconds_bucket[5m])))` → 1.15s.
   - Difference ≈ 50ms; the provider is the entire excess.
4. LOGS: `event:payment.declined OR event:payment.succeeded` in the last 15m,
   inspect `provider_latency_ms`. Confirmed: distribution shifted upward.
5. HYPOTHESIS: "Payment provider latency regressed; our handler is fine."
6. CONFIRM: `db_query_duration_seconds` p95 across all named queries is
   flat — rules out DB-side amplification.

### Output discipline (for both humans and AI)

- Lead with the cause, not the number.
- Quote the numbers you saw, with units.
- Name the boundary: "us" vs "the database" vs "the provider".
- Weak: "checkout p95 is 800ms."
- Strong: "checkout p95 is 800ms, driven entirely by the payment step
  (`payment_duration_seconds` p95 = 1.2s); `db_query_duration_seconds`
  is flat at ~6ms — it's the provider, not us."

---

## What's *not* in scope (intentional)

- **Tracing.** No OpenTelemetry, no Jaeger. The `request_id` field in
  logs serves the pivot need at this size.
- **Alerting.** No alertmanager rules. Out of scope for a 3-hour
  assignment; thresholds are documented in the catalog so a future
  alert layer can wire them up.
- **Authentication on /metrics.** It's on the same port as the API and
  contains no sensitive labels — cardinality discipline is the security
  posture.
- **Log retention policies.** Single daily index, no ILM. Fine for the
  assignment; production would obviously need a rollover policy.
