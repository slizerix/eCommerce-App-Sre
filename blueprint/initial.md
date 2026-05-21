# initial.md — Bootstrap Prompt

> Run this prompt against a fresh, **uninstrumented** copy of the eCommerce
> app (Node 20 + Express backend, React + Vite frontend, MySQL, single
> `docker-compose.yml`). At the end you must have: instrumented backend,
> Prometheus + Elasticsearch + Filebeat + Grafana, an AI investigator
> service, and the Blueprint files this prompt refers to.

You are a senior SRE building the foundation layer that lets an LLM
investigate a running system. The application is provided. Do **not**
spend time polishing it — every minute on the app is a minute not spent
on the observability layer, which is what matters.

---

## Inputs you can rely on

- `backend/` — Node 20 + Express + TypeScript + mysql2. Routes:
  `/api/auth/{signup,login,logout}`, `/api/products[?search=&category=&sort=]`,
  `/api/products/:id`, `/api/products/:id/related` (deliberately slow
  unindexed self-join), `/api/cart`, `/api/cart/items`,
  `/api/checkout`, `/api/checkout/:orderId`, `/api/payment`
  (mock provider, 120-450ms latency, ~8% failure controllable via
  `PAYMENT_FAILURE_RATE`), `/api/orders`, `/healthz`.
- `frontend/` — React + Vite, walks browse → cart → checkout → payment.
- `docker-compose.yml` — services: `mysql`, `backend`, `frontend`.
- `blueprint/guidelines.md` — log/metric/dashboard conventions and the
  triage loop. **Read before instrumenting.**
- `blueprint/catalog.md` — the metric catalog. **Read before naming any
  metric or log field.** Every signal you add must end up here.

If guidelines.md or catalog.md is missing, write them first using the
schemas described in this prompt.

---

## What you must produce

A `docker compose up --build` that brings up:

1. **Instrumented backend** exposing `GET /metrics` (Prometheus) and
   writing JSON logs to stdout (one object per line).
2. **Prometheus** scraping the backend every 10 seconds.
3. **Elasticsearch** (single-node, 512 MiB heap, security disabled —
   it's local) on port 9200.
4. **Filebeat** tailing container logs (Docker autodiscover, opt-in via
   `co.elastic.logs/enabled=true` label) and shipping JSON-decoded events
   to `shop-logs-*`.
5. **Grafana** with provisioned datasources and **two** dashboards:
   *User Journey* and *System Health*. Files only — no clickops.
6. **AI investigator service** on port 8088 with `POST /investigate
   { question }` and a CLI wrapper. OpenAI tool-calling, multi-turn loop,
   tools listed below.
7. **Loadgen container** generating synthetic traffic so dashboards have
   something to show on first boot.

Plus the Blueprint files (this file + guidelines.md + catalog.md) and
an updated README.

---

## Instrumentation plan (backend)

Add a `backend/src/observability/` folder with three files:

- `logger.ts` — pino, JSON to stdout, ISO timestamps, base fields
  `service` and `env`. No pretty-printing in production.
- `metrics.ts` — single `prom-client` Registry with default process
  metrics on. Define exactly the metrics enumerated in `catalog.md`:
  `http_requests_total`, `http_request_duration_seconds`,
  `db_query_duration_seconds`, `payment_duration_seconds`,
  `payment_attempts_total`, `signups_total`, `logins_total`,
  `cart_adds_total`, `checkouts_created_total`,
  `orders_status_transitions_total`, `insufficient_stock_total`.
  Export a `timeDbQuery(name, fn)` helper.
- `middleware.ts` — two middlewares: `requestContext` (generate
  `request_id` with nanoid, child logger on `req.log`, set
  `x-request-id` response header) and `httpMetricsAndLog` (capture
  `route` from `req.route?.path` after match, observe duration, emit
  one `http_request` log line on `res.finish`).

Wire them in `index.ts` **before** the routes. Mount `/metrics` after.
The error middleware must set `req.errorCode` so the metric label
matches the log field.

In each route, emit business events:

| File | Event | Counter |
|---|---|---|
| `routes/auth.ts` | `auth.signup`, `auth.login` (success only) | `signups_total`, `logins_total{result}` |
| `routes/cart.ts` | `cart.item_added` | `cart_adds_total` |
| `routes/checkout.ts` | `checkout.created`, `checkout.insufficient_stock` | `checkouts_created_total{result}`, `insufficient_stock_total`, `orders_status_transitions_total{status}` |
| `routes/payment.ts` | `payment.attempted`, `payment.succeeded`, `payment.declined` | `payment_attempts_total{provider,result,decline_reason}`, `payment_duration_seconds{provider}`, `orders_status_transitions_total{status}` |
| `routes/products.ts` | — | wrap `products_list`, `products_search`, `products_related` with `timeDbQuery` |

**Cardinality rule:** no `user_id` / `order_id` / `product_id` ever
appears as a metric label. Those go in logs.

**Decline reason rule:** `decline_reason` is a closed enum
`{"", "insufficient_funds", "do_not_honor"}`. Don't accept provider
strings verbatim.

---

## Observability stack plan

Create `observability/` with:

- `prometheus/prometheus.yml` — 10s scrape interval, `backend:4000`
  target with label `service=backend`, `cluster=shop-local`, `env=dev`.
  6h tsdb retention.
- `filebeat/filebeat.yml` — Docker autodiscover, opt-in via label
  `co.elastic.logs/enabled=true`. JSON keys under root.
  Daily index `shop-logs-%{+yyyy.MM.dd}`. Replicas 0, 1 shard.
- `grafana/provisioning/datasources/datasources.yml` — Prometheus
  (`uid: prometheus`, default) and Elasticsearch
  (`uid: elasticsearch`, index `shop-logs-*`, time field `@timestamp`,
  log message field `msg`, log level field `level`).
- `grafana/provisioning/dashboards/dashboards.yml` — file provider
  pointing at `/var/lib/grafana/dashboards`, 10s reload.
- `grafana/dashboards/user-journey.json` and `system-health.json` — see
  guidelines.md for required panels. **Every panel needs a `description`
  field that explains what to look for.**

In `docker-compose.yml`, add the services above plus an `ai-service`
container and a `loadgen` container. Add a label
`co.elastic.logs/enabled=true` and `co.elastic.logs/json.keys_under_root=true`
on the backend so Filebeat picks it up.

---

## AI service plan

Stack: Node + TypeScript + `express` + `openai`. Run on port 8088.
Mount `./blueprint` read-only at `/blueprint`.

Required tools (OpenAI function-calling schemas):

1. `query_prometheus_instant({ query })` — wraps `/api/v1/query`.
2. `query_prometheus_range({ query, lookback_minutes, step_seconds })` —
   wraps `/api/v1/query_range`. Return per-series summaries (last, min,
   max, avg) **plus** raw points; the LLM uses summaries 90% of the time.
3. `list_metric_names({ prefix? })` — wraps
   `/api/v1/label/__name__/values`. Substring filter client-side.
4. `search_logs({ query, lookback_minutes, size?, fields? })` — ES
   `_search` with Lucene `query_string`, time-bounded by `@timestamp`,
   sort `desc`. Return `_source` only, no envelope.
5. `count_logs_by({ field, query, lookback_minutes, size? })` — ES
   terms aggregation. Auto-append `.keyword` unless caller specifies.
6. `get_metric_catalog()` — returns `blueprint/catalog.md` verbatim.
7. `get_runbook()` — returns `blueprint/guidelines.md` verbatim.

Multi-turn loop:
- Build a system prompt that includes a **summary** of the catalog (just
  metric names and one-liners) so the LLM has the index in-context. Full
  catalog is one tool call away.
- Embed the **triage loop** in the system prompt (SYMPTOM → METRIC →
  NARROW → LOGS → HYPOTHESIS → CONFIRM).
- Embed the **output discipline** including the weak/strong example
  from guidelines.md.
- Cap iterations (default 8). On cap, force a tool-free summary turn so
  the answer is always written.
- Truncate large tool results before feeding back (≈ 6KB per result).
- Return `{ answer, transcript, iterations, model, finish_reason }`.

CLI wrapper posts to the same HTTP endpoint; prints transcript then the
final insight.

---

## Verification — the AI must do these before declaring done

1. `curl -s localhost:4000/metrics | head` → metric families visible,
   including `http_requests_total`, `payment_duration_seconds`,
   `db_query_duration_seconds`.
2. `curl -s 'localhost:9090/api/v1/query?query=up{job="backend"}'`
   returns `value: "1"`.
3. `curl -s localhost:9200/_cat/indices?v` shows a `shop-logs-*` index
   with a non-zero `docs.count`.
4. Grafana at `localhost:3000` (anonymous Viewer enabled) shows both
   dashboards, panels render, the logs panel has hits.
5. Crank failures: `PAYMENT_FAILURE_RATE=0.5 docker compose up -d backend`
   then watch the payment success-rate stat drop within 30s.
6. `curl -s -X POST localhost:8088/investigate -H 'content-type:
   application/json' -d '{"question":"anything unusual in the last 15
   minutes?"}'` returns a real investigation (≥ 2 tool calls) with an
   insight that names the slice driving the anomaly.

If any of these fail, fix and re-run. Don't claim done until all six
pass on a freshly built stack.

---

## Constraints

- **Time:** target ~3 hours total. Spend it on instrumentation depth,
  catalog quality, AI loop quality. Do not refactor the app.
- **Cardinality:** any new metric label must be a bounded enum. If you
  can't list every possible value on one line, it's a log field, not a
  label.
- **No `console.log` after instrumentation lands.** Use `req.log` /
  `baseLogger`. The error middleware logs `http_error` / `unhandled_error`.
- **No clickops in Grafana.** Dashboards exist in JSON files in the repo;
  Grafana picks them up via provisioning.
- **Honesty:** in the README, list every manual fix you had to make and
  why. The AI-gap section is graded.

---

## Deliverables checklist

- [ ] Backend instrumented per the plan above, no lints.
- [ ] `docker compose up --build` brings up nine services healthy.
- [ ] Both dashboards render with real data within 60 seconds of boot.
- [ ] AI service answers an investigation question with ≥ 2 tool calls
      and an insight written in the catalog's style.
- [ ] `blueprint/{initial.md, guidelines.md, catalog.md}` exist and
      agree with the running system.
- [ ] README has: how to run, dashboard walkthrough, one sample AI run
      with its transcript, manual-fix log, AI-prompt log.
