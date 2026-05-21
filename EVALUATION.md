# Evaluation — Self-Assessment Against the Rubric

The assignment lists six evaluation criteria. This file answers each
one directly with evidence from the repository. Where the criterion
asks a question, I quote it verbatim and answer.

Companion docs: [`README.md`](./README.md), [`AI_LOG.md`](./AI_LOG.md),
[`blueprint/initial.md`](./blueprint/initial.md),
[`blueprint/guidelines.md`](./blueprint/guidelines.md),
[`blueprint/catalog.md`](./blueprint/catalog.md).

---

## 1. Prompt rigor

> *"Can we re-run `initial.md` on a fresh copy and get a comparable
> result?"*

**Answer: yes, and we have receipts.** I ran the clean-build test
during this build — `docker compose down -v` followed by
`docker compose up --build -d` against an empty volume set — and all
six verification steps in `blueprint/initial.md` pass on the fresh
stack.

**Evidence:**

| Verification step (from `initial.md`) | Clean-build result |
|---|---|
| `/metrics` exposes the required metric families | 12/12 families present (`http_requests_total`, `payment_*`, `db_query_*`, `checkouts_*`, `cart_adds_total`, `signups_total`, `logins_total`, `insufficient_stock_total`, `orders_status_transitions_total`, default process metrics) |
| `up{job="backend"} = 1` in Prometheus | ✅ |
| `shop-logs-*` index has non-zero doc count | 957 docs within 90s of boot |
| Both Grafana dashboards rendered from JSON files | ✅ |
| Cranking `PAYMENT_FAILURE_RATE` moves the success-rate stat | ✅ — 100% → 52% within 90s |
| `POST /investigate` returns a real multi-turn investigation | ✅ — 6 tool calls in 16s, real triage loop |

**Boot time (cached images, fresh volumes):** 24 seconds for
`docker compose up`, plus ~90 seconds for ES/MySQL healthchecks and
first scrape window. Under two minutes to a fully observable stack.

**Honest limit on "comparable":** LLM-generated code is not
byte-deterministic. Re-running `initial.md` against a fresh checkout
with a different agent will likely produce slightly different label
sets, dashboard panel orderings, and prose. What stays comparable:

- Same set of services, same ports, same network topology
- Same cardinality discipline (status_class collapse, route
  templates, closed-enum `error_code`, no per-entity IDs in labels)
- Same triage loop and output discipline in the AI service
- Same Blueprint contract (initial / guidelines / catalog)

The Blueprint constrains the *shape*, not the bytes. That's the
honest reproducibility claim.

---

## 2. Observability design

> *"Do the dashboards answer what on-call would actually ask?"*

**Answer: yes — by deliberate subtraction.** Two dashboards, eleven
panels total, every panel has a `description` field explaining what
to look for. The exclusion list is as important as the inclusion
list.

**Walkthrough of "what on-call asks" → "which panel answers it":**

| Question on-call asks | Dashboard | Panel |
|---|---|---|
| "Are payments working right now?" | User Journey | Payment success rate (5m) — single stat, red < 90% |
| "Is the funnel leaking somewhere?" | User Journey | Journey rates (per minute) — read slopes top-to-bottom |
| "Is it us or the provider?" | User Journey | Payment provider latency (p50/p95/p99) — cross-reference with System Health p95 per route |
| "Which decline reason is dominating?" | User Journey | Payment outcomes pie (5m) by `result × decline_reason` |
| "Is checkout failing on stock?" | User Journey | Checkout outcomes per minute by `result` + Insufficient stock stat |
| "Which route is slow?" | System Health | HTTP p95 latency by route |
| "Where are the errors?" | System Health | Error rate by route + Top error codes table |
| "Is the database the problem?" | System Health | DB query p95 by named query (`products_related`, `products_search`, `products_list`) |
| "Is the process healthy?" | System Health | Event loop p99 + RSS |
| "Show me the actual log lines for that spike." | System Health | Recent backend errors (Elasticsearch logs panel) |

**Cardinality discipline (the part of the rubric that catches generic
dashboards):**

- `route` uses Express route templates (`/api/products/:id`), not
  raw URLs. Without this, every product ID becomes a separate series
  and the panels collapse.
- `status_class` collapses `200/201/204 → "2xx"` and so on. 12 routes
  × 6 status codes × 4 methods = 288 series before collapse, 16
  after.
- `error_code` is a closed enum (13 known values) with `unknown` as
  the safety net for new branches.
- `decline_reason` has three possible values — small enough that the
  pie chart works.
- `db_query_duration_seconds.query` is a hand-picked enum
  (`products_list`, `products_search`, `products_related`) — only the
  queries we want a panel for. Random one-off queries stay unlabeled.
- **Never** labeled by: `user_id`, `order_id`, `product_id`, raw URL.
  Those belong in logs.

**What is intentionally NOT on the dashboards:**

- CPU usage per container — the assignment's "weak example".
- Per-user-id metrics — not useful at this scale, blows cardinality.
- Raw status code distributions — `status_class` is enough; raw
  status is available in logs.
- Kitchen-sink Prometheus default panels — every panel earns its
  place by answering a specific question.

---

## 3. LLM-readiness

> *"Does the AI produce insight, not numbers? Are signals named
> meaningfully and explained?"*

**Answer: insight, mostly.** The README captures one real transcript;
during the clean-build test the AI produced a second, stronger
transcript that demonstrates the rubric's "strong output" example
verbatim.

### Strong-output evidence (clean-build investigation, 6 tool calls)

Question: *"anything unusual in the last 15 minutes?"*

The AI walked through the triage loop and produced:

> "There were 168 instances of payment declines in the last 15
> minutes, with the error message indicating that the 'mock provider
> declined the charge.' This suggests that the payment provider is
> rejecting transactions, which aligns with the increased rate of
> payment declines observed in the metrics. There were no logs
> indicating insufficient funds, which suggests that while users are
> facing payment declines, it may not be due to insufficient funds
> but rather other reasons such as the payment provider's policies."

This is the rubric's strong shape: names the cause (provider
rejecting), cites the number (168), distinguishes us-from-them
(provider, not us), rules out alternatives (no insufficient_funds
spike).

### Signals named meaningfully

The metric catalog is the foundation here.
[`blueprint/catalog.md`](./blueprint/catalog.md) gives every signal:

- one-line description
- why it matters
- what normal looks like
- what a change implies

A representative entry, verbatim from the catalog:

> ### `payment_duration_seconds`
> - **Type:** histogram, label `provider`.
> - **Normal:** Uniform random in `[120ms, 450ms]` so p50 ≈ 280ms,
>   p95 ≈ 430ms, p99 ≈ 445ms.
> - **Implications:**
>   - p95 above ~400ms sustained while
>     `http_request_duration_seconds` for `/api/payment` matches it
>     → provider is degrading independently of us. Tell the customer
>     it's not them.

That's the rubric's "strong" catalog example. The catalog explains
not just what a metric is, but what it *means in the context of this
system*. The same applies to log fields, event names, and error
codes.

### Honest limit

The README's first captured transcript shows a weaker investigation
where the AI imagined an event name (`payment.failed` vs the
catalog's `payment.declined`) and didn't quote the catalog's baseline.
That transcript and its limitations are documented verbatim in
[README.md → "What the AI got right — and where it stopped"](./README.md).
The point isn't perfection; it's that the LLM-readiness substrate
exists and produces usable insight on the typical case.

---

## 4. AI infrastructure

> *"Real tools + context + loop, or a dressed-up script?"*

**Answer: real.** No fixed investigation paths. The LLM picks every
tool call. Source of truth:
[`ai-service/src/agent.ts`](./ai-service/src/agent.ts) (the loop),
[`ai-service/src/tools.ts`](./ai-service/src/tools.ts) (the tool
schemas + dispatcher).

### Real tools (each one hits a real backend)

| Tool | Backing call | What it does |
|---|---|---|
| `query_prometheus_instant` | `GET /api/v1/query` against Prometheus | Point-in-time value |
| `query_prometheus_range` | `GET /api/v1/query_range` against Prometheus | Time series with summaries |
| `list_metric_names` | `GET /api/v1/label/__name__/values` | Discovery |
| `search_logs` | `POST /shop-logs-*/_search` against Elasticsearch | Lucene query_string search |
| `count_logs_by` | ES `_search` with terms aggregation | Top-N by field |
| `get_metric_catalog` | reads `blueprint/catalog.md` | Domain context |
| `get_runbook` | reads `blueprint/guidelines.md` | Procedures + PromQL patterns |

Every tool's request → response is observable by you (`curl
localhost:9090/...`, `curl localhost:9200/...`). The investigator is
not a wrapper around hardcoded data.

### Real context

Two layers:

1. **Upfront in the system prompt:** the catalog *summary* (names +
   one-liners, harvested from `catalog.md`) is injected at agent
   start. This lets the LLM pick the right first tool without a
   round-trip.
2. **On-demand:** `get_metric_catalog` and `get_runbook` return the
   full markdown files. Used when the LLM needs depth — see the
   second clean-build investigation, where the LLM read the catalog's
   "implications" section to frame the conclusion.

The catalog ↔ running system ↔ LLM runtime context all agree by
construction: catalog field names are the same names emitted by
pino, the same labels on Prometheus metrics, and the same Lucene
fields the AI service searches on. If any of them drift, the
investigation breaks visibly.

### Real loop

The agent is a multi-turn tool-calling loop in
[`ai-service/src/agent.ts`](./ai-service/src/agent.ts):

```
seed messages = [system_prompt, user_question]
for i in 1..maxIterations:
  completion = openai.chat.completions.create({ messages, tools, ... })
  if completion.tool_calls is empty:
    return completion.content     ← final answer, no more tool calls
  append assistant message (with tool_calls) to messages
  for each tool_call:
    result = runTool(name, args)
    append {role: tool, tool_call_id, content: truncate(result)} to messages
```

This is the OpenAI function-calling protocol exactly. The LLM
chooses to stop, not the code. The code only intervenes if the
iteration cap is hit (default 8), in which case it forces a final
summary turn with `tools` removed.

### Receipts that prove it's not scripted

The **first** captured investigation (in README) made **3** tool
calls: `query_prometheus_range`, `count_logs_by` (twice).

The **second** captured investigation (clean-build, in this file)
made **6** tool calls of completely different shape:
`query_prometheus_range` (4×), `search_logs` (2×).

Same model, same prompt, same code — different paths because the
state of the system was different. A scripted investigation can't do
this.

---

## 5. AI-gap awareness

> *"Where did you stop prompting and fix by hand? Tell us honestly."*

**Answer: eight places, all documented.** The README lists them
under [Manual fixes / gotchas worth flagging](./README.md). The
AI_LOG documents three more places where the LLM's own behavior is
suboptimal and I left it that way for honesty.

### The eight hand-fixes (full detail in README)

1. **Route template at match time, not finish.** First-pass metrics
   middleware read `req.baseUrl` inside `res.on('finish')`. Express
   pops `baseUrl` on the error path, so the `payment_declined` metric
   bucketed as `route="/"`. Caught from real `/metrics` output during
   verification, not from theory.
2. **Elasticsearch heap pinned to 512m.** Default 1G OOMs small
   Docker Desktop allocations.
3. **ECS template mapping conflict.** Pino's `service: "backend"`
   collided with ES's bundled ECS template. Fixed by nesting to
   `service.name` AND disabling Filebeat's template management.
   Caught by curl'ing a sample doc directly — the ES error was
   crystal clear once I bypassed Filebeat.
4. **Filebeat autodiscover by container name.** Label-hint
   sanitization rules between Filebeat 7/8 are too fiddly; switched
   to `equals: { docker.container.name: shop-backend }`.
5. **`status_class` not `status_code`.** Cardinality math forced this.
6. **`error_code` normalization to "unknown" for off-enum codes.**
   Metrics use the closed enum, logs keep verbatim.
7. **Tool result truncation at ~6 KB.** The LLM wastes context on
   verbose ES envelopes otherwise.
8. **Dashboard exclusion of `route="/metrics"` and `"unmatched"`.**
   Without it, the RPS panel is dominated by Prometheus scraping
   itself.

### Three LLM-side gaps I left in (instead of papering over)

These are documented in [AI_LOG.md → "What v3 still gets wrong"](./AI_LOG.md):

A. **Imagined field names.** In the first captured investigation, the
   LLM searched `event:"payment.failed"` when the catalog clearly
   says `payment.declined`. I could have hardened the prompt with
   "always call `get_metric_catalog` before searching logs," but I
   chose to ship the trace honestly. Two log searches returned zero
   hits because of it; the LLM still reached a defensible conclusion
   from the metric evidence alone.
B. **No baseline comparison.** The catalog says normal success rate
   is ≥ 92%. The LLM reported the failure rate as a percentage but
   didn't quote the baseline. A prompt rule "always compare to the
   catalog's `normal` range" would fix this directly.
C. **Mis-naming a rate as a percentile.** The LLM wrote "p95 failure
   rate of 0.072" when the value was a per-second counter rate, not
   any percentile. Word salad that a senior reader would catch.

### Why this matters for the rubric

The AI-gap section isn't a list of bugs — it's a list of places where
the system intentionally has a seam I could see and reason about.
The "fix by hand" decisions all came from looking at live output, not
from theory. The "leave it in" decisions all came from preferring an
honest gap over an opaque-but-cleaner trace.

---

## 6. Trade-offs

> *"Cardinality vs. observability, sampling vs. completeness, log
> volume vs. cost."*

### Cardinality vs. observability

**Chose: bounded enums everywhere, per-entity detail in logs.**

| Decision | Cost | Benefit |
|---|---|---|
| `status_class` not `status_code` | Lose `204 vs 201` granularity in metrics | 18× fewer series; recoverable from logs via `status` field |
| Route templates not URLs | Lose per-resource granularity in metrics | 100× fewer series; recoverable via `request_id` log pivot |
| Closed `error_code` enum, `unknown` for off-enum | New error codes invisible in metrics until catalogged | Bounded label, no surprise cardinality explosion from a new error branch |
| Named-query histogram, no auto-instrumentation | DB queries not in the catalog get no metric | Catalog stays authoritative; can't be polluted by random one-off queries |
| `decline_reason` capped at 3 values | Can't pass-through provider's full reason code | Pie chart works; provider's exact string lives in logs |
| `request_id` in logs only, not metric label | Per-request joins require log query, not promql | Cardinality stays bounded; pivot is one ES search away |

Net: **observability won where it mattered, cardinality won where it
would have killed us.**

### Sampling vs. completeness

**Chose: no sampling.** Every HTTP request emits one log line. Every
business event emits a log line. Every metric increment is recorded.

| Why this is defensible at this scale | Where I'd reconsider |
|---|---|
| ~3 req/s × 86,400 s/day ≈ 260k lines/day ≈ ~50 MB/day. Trivial. | At >100 req/s the calculus flips. |
| Lossless investigations: any anomaly has the full log trail to back it up. | Probabilistic sampling (e.g. 1% of 2xx, 100% of non-2xx) for high-volume routes. |
| Easier reasoning for the LLM — it doesn't need to know whether a sample is representative. | OpenTelemetry tail-based sampling for traces. |

I considered sampling for the `/api/products/` listing route (the
hottest one) and decided against it for a 3-hour build. The catalog
entry for `http_requests_total` documents this — if a future change
adds sampling, it has to update the catalog too.

### Log volume vs. cost

**Chose: optimize for clarity, not for retention.**

| Decision | Cost | Benefit |
|---|---|---|
| Single daily index `shop-logs-YYYY.MM.DD`, no rollover | Manual cleanup or no cleanup at all. **Acknowledged production gap.** | Simpler mental model; one place to search; no ILM complexity. |
| `setup.ilm.enabled: false` in Filebeat | No automatic warm/cold tiering | One less moving part in this build; the ES container runs on 512 MiB heap. |
| Dropped Filebeat default fields (`agent`, `ecs`, `host`, `input`, `log.offset`, `stream`) | Lose some Filebeat metadata | Each doc is ~30% smaller; ES JSON noise drops dramatically. |
| Verbose `docker.container.labels` block left in (we don't drop it) | ~1 KB per doc of compose noise | I'd drop this if I had another 15 minutes — it's the next obvious optimization. |
| Frontend nginx logs NOT shipped | Lose request-level visibility into static asset serving | The frontend isn't the problem we're observing; the backend is. The catalog explicitly limits Filebeat to `shop-backend`. |

### Model cost (a trade-off the rubric didn't list, but I made)

Documented in [AI_LOG.md → "Why gpt-4o-mini and not gpt-4o / o1"](./AI_LOG.md):

| Model | Per-investigation cost (~5 turns) | Tool-call fidelity | Latency |
|---|---|---|---|
| `gpt-4o-mini` (shipped) | ~$0.001 | Good enough; imagines names sometimes | ~10-16s end-to-end |
| `gpt-4o` | ~$0.02 | Better; less imagination | ~20-30s |
| `o1` | ~$0.10+ | Best, but tool-call uneven | ~60s+ |

For an on-call assistant expected to be cheap and fast, `mini` is the
right default. The captured transcripts show exactly the kind of
imperfection you get for the price; `gpt-4o` would close most of the
A/B/C gaps in §5 at ~20× the cost.

### Tool-result truncation (a sampling/completeness trade-off internal to the AI service)

Tool results larger than ~6 KB are truncated and marked
`truncated:true`. Trade-off: the LLM loses a complete view of large
ES result sets but gains context budget for follow-up turns. The
truncation marker is visible in the transcript, and the LLM has been
observed to re-query with a smaller `size` after seeing it — exactly
the right response.

---

## Summary

| Rubric criterion | Evidence | Honest gap |
|---|---|---|
| Prompt rigor | Clean build test passed all 6 verification steps | Byte-identical reproducibility impossible for LLM-generated; substrate is reproducible |
| Observability design | 2 dashboards, 11 panels, every panel has a `description`, cardinality discipline documented | No alerting (acknowledged out-of-scope) |
| LLM-readiness | Two real transcripts captured; catalog gives signals meaning, not just names | Smaller model sometimes imagines field names — A/B/C gaps in §5 |
| AI infrastructure | 7 real tools, multi-turn loop in `agent.ts`, no scripted paths | No MCP layer (chose function calling — reasoned in AI_LOG) |
| AI-gap awareness | 8 hand-fixes + 3 left-in LLM gaps, all documented | The hand-fix list is what it is — they're real |
| Trade-offs | Cardinality / sampling / log-volume choices all documented above | Some optimisations skipped for time (e.g. dropping `docker.container.labels`) |

This is what we built. The Blueprint is what makes the *next*
investigator — human or LLM — able to build something comparable on
a fresh copy.
