# AI Log

What the assignment asks for here: *"Prompts, model choices, MCP servers /
plugins used. Which model for which step, and why."*

This is meant to be honest, not aspirational. The point of the AI log is
to make the build reproducible at the **prompt** layer, not just the
code layer.

---

## Models used

### Runtime (the investigator service)

- **`gpt-4o-mini`** for every turn of the multi-turn tool-calling loop.
- Configured via `OPENAI_MODEL` env var (defaults to `gpt-4o-mini` in
  `ai-service/src/config.ts`); swap by editing `.env`.
- Temperature: `0.2`. Deterministic enough that the same question with
  the same dashboard state usually picks the same first tool, but not
  so locked that it can't adapt mid-investigation.

**Why `gpt-4o-mini` and not `gpt-4o` / `o1`:**

| Criterion | `gpt-4o-mini` | `gpt-4o` | `o1` |
|---|---|---|---|
| Tool-call fidelity at our schema depth | ✅ good enough | ✅ better | ⚠️ tool-call support is recent + uneven |
| Latency per round-trip | ~700-1500ms | ~1.5-3s | ~5-20s |
| Cost per investigation (~5 turns) | ~$0.001 | ~$0.02 | ~$0.10+ |
| Drops obvious facts (e.g. invents event names) | sometimes | rarely | rarely |

For an on-call assistant that's expected to be cheap and fast, `mini`
is the right default. The captured transcript in the README shows
exactly the kind of imperfection you get for the price: it reaches the
right conclusion through a slightly clumsy path. A `gpt-4o` upgrade
would close most of the gaps documented in that transcript, at ~20×
the cost.

**No model routing between steps.** Every turn of the loop uses the
same model — the simplest design that satisfies the rubric's
"multi-turn, LLM-driven" requirement. A more aggressive design would
use a cheap model to plan the next tool call and a stronger model for
the final write-up, but that adds complexity that wasn't worth the
3-hour budget.

### Build time (drafting the blueprint and the code)

Used Cursor with Anthropic's `claude-opus-4` (the IDE default at time
of writing) to:

- Draft the prose of `blueprint/{initial.md, guidelines.md, catalog.md}`,
  which I then heavily hand-edited for opinionatedness. First drafts
  were noticeably generic — see the prompt iteration log below for
  what changed.
- Generate the boilerplate of `ai-service/src/*` (Express server,
  OpenAI SDK wiring, ES + Prometheus clients). The agent loop in
  `agent.ts` was hand-written — the multi-turn message-list management
  and tool-result truncation logic are exactly the parts where the LLM
  produced subtle bugs on first attempt.

No LLM was used for:

- The dashboard JSON. Generated dashboards always trend kitchen-sink;
  the rubric grades against "what on-call would actually ask", which
  is a deliberate-subtraction problem an LLM doesn't do well.
- The cardinality choices in `metrics.ts` (label sets, bucket
  boundaries). These came from reading the existing route handlers and
  the assignment's "intentional behaviors worth observing" section.

---

## MCP servers / plugins used

**None.** OpenAI's native function calling is the tool layer. I
considered MCP (anthropic.com/news/model-context-protocol) for the
investigator-service tools but ruled it out for these reasons:

1. **Time budget.** Wiring an MCP server + client is 30-60 min of
   plumbing for zero observable benefit at this scope. The same time
   buys an extra tool (e.g. a `compare_to_baseline` helper).
2. **Single LLM, single backend pair.** MCP shines when you want one
   LLM to talk to a federation of services without re-implementing
   each integration. Here the LLM only ever talks to Prometheus and
   Elasticsearch — and they have stable HTTP APIs, so the integration
   is one fetch wrapper per tool.
3. **Debuggability.** Direct function calling gives me a single
   request/response per tool call that I can curl. MCP adds a JSON-RPC
   layer between the LLM and the tool — useful in production, friction
   in a 3-hour build.

If this graduated to a production system with multiple data sources
(Datadog, Sentry, Slack, your own provisioning APIs), MCP would be the
right next step.

---

## The system prompt (verbatim)

This is what every investigation starts with, before the catalog
summary is appended. Source of truth: `ai-service/src/prompt.ts`.

> You are the on-call SRE for a small eCommerce app (browse → cart →
> checkout → payment). You investigate problems by calling tools
> against Prometheus and Elasticsearch. You are NOT a chatbot — you
> are an investigator who writes a short, sharp insight at the end.
>
> ## How to investigate
>
> Follow this loop every time, even when the question seems simple:
>
> 1. **SYMPTOM** — restate the user's question as a measurable symptom.
> 2. **METRIC** — query Prometheus for that symptom. If you don't know
>    the exact name, call `list_metric_names` first.
> 3. **NARROW** — if the metric is anomalous, split by the most
>    informative label (route, status_class, decline_reason, query,
>    etc.) to find which slice is driving it.
> 4. **LOGS** — pivot to Elasticsearch for the actual events behind
>    the spike. Use the matching event/route/error_code/user_id field.
> 5. **HYPOTHESIS** — state what you think is happening, in one
>    sentence.
> 6. **CONFIRM** — find one more piece of evidence that distinguishes
>    your hypothesis from the most likely alternative.
>
> Call `get_runbook` for the full triage procedures and common PromQL
> patterns. Call `get_metric_catalog` when you need to know what
> "normal" looks like for a metric or what a change implies.
>
> ## Output discipline
>
> - Lead with the cause, not the number.
> - Quote the numbers you actually saw (with units), not vague phrases.
> - Distinguish "us vs them" — is the cause inside our service or
>   downstream (payment provider, database)? Say which evidence
>   proves it.
> - **Weak:** "checkout p95 is 800ms".
>   **Strong:** "checkout p95 is 800ms, driven entirely by the payment
>   step (`payment_duration_seconds` p95 = 1.2s);
>   `db_query_duration_seconds` is flat at ~6ms, so the database isn't
>   the cause — the payment provider is."
>
> ## Constraints
>
> - You have at most a small number of tool calls per investigation.
>   Pick the one that most reduces uncertainty. Don't fetch a metric
>   you've already seen.
> - If the question gives no timeframe, default to the last 15 minutes.
> - If a tool returns an error or empty result, do NOT retry with the
>   same arguments. Reformulate or move on.
> - If after gathering evidence nothing looks abnormal, say so
>   explicitly and state what you checked.
>
> ## Metric catalog (summary)
>
> *(injected at runtime — names + one-liners harvested from
> `blueprint/catalog.md`. Full catalog is one `get_metric_catalog`
> tool call away.)*

---

## Prompt iteration history

The system prompt went through three serious revisions before it
produced traces I'd be willing to show. Each rejection was tied to a
specific failure mode I caught in a test run.

### v1 — minimum viable (rejected)

```
You are an SRE. Here are your tools. Answer this question: {question}.
```

**Failure mode:** the LLM made one tool call, took the result at face
value, and wrote a paragraph. Exactly the "single LLM call with all
data pre-stuffed" anti-pattern the rubric calls out. No follow-up.

### v2 — added the catalog summary + "investigate" instruction (rejected)

Same as v1 but added: a list of metric names with one-liners injected
into the prompt, and a sentence telling the model "investigate, don't
just answer; make multiple tool calls if needed."

**Failure mode:** the LLM started making 2-3 tool calls, but they were
disconnected — e.g. it would query a metric, then immediately search
logs for an unrelated term, then write a summary that didn't tie the
two pieces of evidence together. No causal narrative.

### v3 — the triage loop + output discipline (shipped, current)

The version above. Three changes that mattered:

1. **Named the loop stages explicitly** (SYMPTOM → METRIC → NARROW →
   LOGS → HYPOTHESIS → CONFIRM). The LLM internalises numbered
   procedures much more reliably than imperative prose.
2. **Verbatim weak/strong example** from the assignment doc itself.
   Showing rather than telling.
3. **"Don't retry the same tool with the same arguments"** — caught
   the LLM getting stuck in retry loops when ES queries returned zero
   hits. One line in the constraints section fixed it.

### What v3 still gets wrong

The README's "Wrong / weak" list is the honest account. Two failure
modes that further prompt work could close:

- **Imagined field names.** The LLM searched `event:"payment.failed"`
  when the catalog clearly lists the name as `payment.declined`.
  Adding "before searching logs, look up the event name in
  `get_metric_catalog` or `get_runbook`" might help — but the catalog
  summary is already in the prompt and got skimmed past.
- **No baseline comparison.** The catalog states normal success rate
  is ≥ 92%. The LLM reported the failure rate without comparing to
  baseline. A prompt rule "when reporting a value, also state the
  catalog's `normal` range and how the observed value compares" would
  fix this directly.

I left these gaps in rather than over-engineer the prompt for one
example — the rubric says "tell us honestly where you stopped
prompting and fixed by hand."

---

## Tool schemas (where the LLM picks its actions)

Tool descriptions are written as "use this when you want to ..."
rather than "this returns ...". The LLM picks its next tool primarily
from the description, not from the function name. The full schemas
live in `ai-service/src/tools.ts`; summary:

| Tool | Backing call | Used for |
|---|---|---|
| `query_prometheus_instant` | `/api/v1/query` | Point-in-time numbers (current p95, error ratio now) |
| `query_prometheus_range` | `/api/v1/query_range` | Trends/spikes over a window; returns per-series summaries + raw points |
| `list_metric_names` | `/api/v1/label/__name__/values` | Discovery before querying |
| `search_logs` | ES `_search` w/ Lucene `query_string` | Reading actual log lines |
| `count_logs_by` | ES terms aggregation | "top-N by field" without paging hits |
| `get_metric_catalog` | reads `blueprint/catalog.md` | Definitions, baselines, implications |
| `get_runbook` | reads `blueprint/guidelines.md` | Procedures, PromQL patterns, the triage loop |

The Prometheus and Elasticsearch responses are reshaped to compact
JSON before being fed back to the LLM — full envelopes burn context
budget and the model parses the trimmed shape more reliably.

Tool results larger than ~6 KB are truncated with a sentinel; the
transcript marks `truncated: true` and the LLM has been observed to
re-query with a smaller `size` after seeing the marker, which is
exactly the correct response.

---

## Reproducibility note for graders

Re-running `blueprint/initial.md` against a fresh checkout will not
produce a byte-identical result — LLM coding is non-deterministic at
this scale. The reproducibility claim is:

- **Architecture should match.** Same nine services, same dashboards,
  same tool surface on the AI service.
- **Catalog should be comparable.** Same metric families, same
  cardinality discipline, same field names in logs.
- **Investigation should be substantively similar.** Multi-turn,
  tool-driven, hypothesis-confirming. The exact path varies.

What graders should look for if re-running: does the substrate exist
that lets a fresh investigator (human or LLM) ask a meaningful
question and get a meaningful answer? That's what the Blueprint is
meant to encode, and it's what the README's "What the AI got right"
section is documenting on the specific run captured.
