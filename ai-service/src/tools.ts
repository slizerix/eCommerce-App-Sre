import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { instantQuery, listMetricNames, rangeQuery } from './prom.js';
import { countLogsBy, searchLogs } from './es.js';
import { getCatalog, getGuidelines } from './catalog.js';

// Tool schemas exposed to the LLM. Descriptions matter — the LLM picks the
// next tool primarily from the description, so they're written as "use this
// when you want to ..." rather than "this returns ...".

export const toolSchemas: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'query_prometheus_instant',
      description:
        'Run a PromQL instant query against Prometheus. Use for single-point-in-time numbers like current p95, error ratio right now, total count over 5m. Returns one value per matching series.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'PromQL expression, e.g. `histogram_quantile(0.95, sum by (le,route) (rate(http_request_duration_seconds_bucket[5m])))`.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_prometheus_range',
      description:
        'Run a PromQL range query. Use when you need to see how a metric evolved over a window (trends, spikes, recoveries). Returns per-series summaries (last, min, max, avg) plus raw points.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'PromQL expression.' },
          lookback_minutes: { type: 'number', description: 'How far back to query, in minutes. Default 15.', default: 15 },
          step_seconds: { type: 'number', description: 'Resolution in seconds. Default 30.', default: 30 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_metric_names',
      description:
        'List metric names available in Prometheus, optionally filtered by substring. Use to discover what is actually being exposed before constructing a PromQL query.',
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional case-insensitive substring filter.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_logs',
      description:
        'Search structured backend logs in Elasticsearch via Lucene query_string syntax. Use to read actual log lines after a metric points you at a symptom — e.g. `event:"payment.declined"`, `level:error AND route:/api/checkout`, `error_code:insufficient_stock`. Hits are returned newest-first.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Lucene query_string. Empty string matches everything.' },
          lookback_minutes: { type: 'number', description: 'How far back to search, in minutes. Default 15.', default: 15 },
          size: { type: 'number', description: 'Max hits to return (1-100). Default 25.', default: 25 },
          fields: { type: 'array', items: { type: 'string' }, description: 'Optional list of _source fields to include. Use to trim noise.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_logs_by',
      description:
        'Aggregate log counts by a single field. Use to ask "what are the top decline_reasons in the last 15 minutes?" or "which error_codes are dominating?" without paging through hits.',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Field name. Keyword sub-field is added automatically unless one is specified (e.g. `error_code` → `error_code.keyword`).' },
          query: { type: 'string', description: 'Lucene filter to apply before aggregation. Empty string aggregates over everything.' },
          lookback_minutes: { type: 'number', description: 'How far back to aggregate, in minutes. Default 15.', default: 15 },
          size: { type: 'number', description: 'Max buckets (1-50). Default 10.', default: 10 },
        },
        required: ['field', 'query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_metric_catalog',
      description:
        'Return the full metric catalog (markdown). Use when you need to know what a metric means, what normal looks like, or what a change implies. Cheaper than guessing.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_runbook',
      description:
        'Return the investigation guidelines (markdown), including the triage loop and common PromQL patterns. Use when you need a procedure, not a metric definition.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

export type ToolName =
  | 'query_prometheus_instant'
  | 'query_prometheus_range'
  | 'list_metric_names'
  | 'search_logs'
  | 'count_logs_by'
  | 'get_metric_catalog'
  | 'get_runbook';

export async function runTool(name: string, argsJson: string): Promise<unknown> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch (err) {
    return { error: 'invalid_arguments_json', detail: (err as Error).message };
  }

  try {
    switch (name as ToolName) {
      case 'query_prometheus_instant':
        return await instantQuery(args.query);
      case 'query_prometheus_range':
        return await rangeQuery(args.query, args.lookback_minutes ?? 15, args.step_seconds ?? 30);
      case 'list_metric_names':
        return { names: await listMetricNames(args.prefix) };
      case 'search_logs':
        return await searchLogs(args.query ?? '', args.lookback_minutes ?? 15, args.size ?? 25, args.fields);
      case 'count_logs_by':
        return await countLogsBy(args.field, args.query ?? '', args.lookback_minutes ?? 15, args.size ?? 10);
      case 'get_metric_catalog':
        return { catalog_markdown: await getCatalog() };
      case 'get_runbook':
        return { runbook_markdown: await getGuidelines() };
      default:
        return { error: 'unknown_tool', tool: name };
    }
  } catch (err) {
    return { error: 'tool_execution_failed', tool: name, detail: (err as Error).message };
  }
}
