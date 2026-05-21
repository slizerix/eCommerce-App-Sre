import { config } from './config.js';

// Minimal Prometheus HTTP client. We expose three shapes to the LLM:
//   - instant query     -> /api/v1/query
//   - range query       -> /api/v1/query_range
//   - metric name list  -> /api/v1/label/__name__/values
//
// Results are reshaped into compact JSON so we don't burn the LLM's context
// budget on Prometheus' verbose envelope.

interface PromMatrix { metric: Record<string, string>; values: [number, string][] }
interface PromVector { metric: Record<string, string>; value: [number, string] }

export interface InstantResult {
  query: string;
  result_type: string;
  series: Array<{ labels: Record<string, string>; value: number; timestamp: number }>;
}

export interface RangeResult {
  query: string;
  start: number;
  end: number;
  step_seconds: number;
  series: Array<{ labels: Record<string, string>; points: Array<{ t: number; v: number }> }>;
  // Convenience: last value and max value per series — most investigations
  // only need the headline number, not the full curve.
  summaries: Array<{ labels: Record<string, string>; last: number | null; max: number | null; min: number | null; avg: number | null }>;
}

async function promFetch(path: string, params: URLSearchParams): Promise<any> {
  const url = `${config.prometheusUrl}${path}?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as any)?.status !== 'success') {
    const err = (body as any)?.error ?? `HTTP ${res.status}`;
    throw new Error(`prometheus query failed: ${err}`);
  }
  return (body as any).data;
}

export async function instantQuery(query: string, at?: number): Promise<InstantResult> {
  const params = new URLSearchParams({ query });
  if (at) params.set('time', String(at));
  const data = await promFetch('/api/v1/query', params);
  const result = (data?.result ?? []) as PromVector[];
  return {
    query,
    result_type: data?.resultType ?? 'vector',
    series: result.map((s) => ({
      labels: s.metric,
      value: parseFloat(s.value[1]),
      timestamp: s.value[0],
    })),
  };
}

export async function rangeQuery(
  query: string,
  lookbackMinutes: number,
  stepSeconds: number
): Promise<RangeResult> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - lookbackMinutes * 60;
  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(stepSeconds),
  });
  const data = await promFetch('/api/v1/query_range', params);
  const result = (data?.result ?? []) as PromMatrix[];
  const series = result.map((s) => ({
    labels: s.metric,
    points: s.values.map(([t, v]) => ({ t, v: parseFloat(v) })),
  }));
  const summaries = series.map((s) => {
    const vals = s.points.map((p) => p.v).filter((v) => Number.isFinite(v));
    if (vals.length === 0) {
      return { labels: s.labels, last: null, max: null, min: null, avg: null };
    }
    const last = vals[vals.length - 1] ?? null;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { labels: s.labels, last, max, min, avg };
  });
  return { query, start, end, step_seconds: stepSeconds, series, summaries };
}

export async function listMetricNames(prefix?: string): Promise<string[]> {
  const params = new URLSearchParams();
  const data = await promFetch('/api/v1/label/__name__/values', params);
  const names = (data ?? []) as string[];
  if (prefix) {
    const p = prefix.toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(p));
  }
  return names;
}
