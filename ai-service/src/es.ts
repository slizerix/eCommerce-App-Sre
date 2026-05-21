import { config } from './config.js';

// Minimal Elasticsearch client over fetch. Two operations:
//   - search_logs: free-form query_string + lookback window + size cap
//   - count_logs_by: terms aggregation over a single field
//
// The shape returned to the LLM is intentionally narrow — _source fields only,
// plus a small aggregation envelope. ES's full response shape is too verbose
// to dump into a tool result.

export interface SearchLogsResult {
  query: string;
  lookback_minutes: number;
  total: number;
  hits: Array<{ '@timestamp': string; [k: string]: unknown }>;
}

export interface CountByResult {
  query: string;
  field: string;
  lookback_minutes: number;
  buckets: Array<{ key: string; count: number }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function lookbackIso(lookbackMinutes: number): string {
  return new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
}

async function esRequest(path: string, body: unknown): Promise<any> {
  const url = `${config.elasticsearchUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = (data as any)?.error?.reason ?? (data as any)?.error ?? `HTTP ${res.status}`;
    throw new Error(`elasticsearch request failed: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  }
  return data;
}

export async function searchLogs(
  query: string,
  lookbackMinutes: number,
  size: number = 25,
  fields?: string[]
): Promise<SearchLogsResult> {
  const body: Record<string, unknown> = {
    size: Math.max(1, Math.min(size, 100)),
    sort: [{ '@timestamp': 'desc' }],
    query: {
      bool: {
        must: query ? [{ query_string: { query, default_operator: 'AND' } }] : [{ match_all: {} }],
        filter: [{ range: { '@timestamp': { gte: lookbackIso(lookbackMinutes), lte: nowIso() } } }],
      },
    },
  };
  if (fields && fields.length > 0) {
    body['_source'] = { includes: fields };
  }
  const data = await esRequest(`/${config.logIndexPattern}/_search`, body);
  const total = data?.hits?.total?.value ?? data?.hits?.total ?? 0;
  const hits = (data?.hits?.hits ?? []).map((h: any) => h._source ?? {});
  return { query, lookback_minutes: lookbackMinutes, total, hits };
}

export async function countLogsBy(
  field: string,
  query: string,
  lookbackMinutes: number,
  size: number = 10
): Promise<CountByResult> {
  // ES terms aggregations need a `.keyword` subfield for text fields.
  // Heuristic: append `.keyword` unless the caller already specified one or
  // the field is a known numeric/keyword field. The user can always pass
  // the explicit form (e.g. "level.keyword") to skip this.
  const aggField = field.includes('.') ? field : `${field}.keyword`;
  const body: Record<string, unknown> = {
    size: 0,
    query: {
      bool: {
        must: query ? [{ query_string: { query, default_operator: 'AND' } }] : [{ match_all: {} }],
        filter: [{ range: { '@timestamp': { gte: lookbackIso(lookbackMinutes), lte: nowIso() } } }],
      },
    },
    aggs: { by_field: { terms: { field: aggField, size: Math.max(1, Math.min(size, 50)) } } },
  };
  const data = await esRequest(`/${config.logIndexPattern}/_search`, body);
  const buckets = (data?.aggregations?.by_field?.buckets ?? []).map((b: any) => ({
    key: String(b.key),
    count: b.doc_count as number,
  }));
  return { query, field: aggField, lookback_minutes: lookbackMinutes, buckets };
}
