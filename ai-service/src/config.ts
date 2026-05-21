export const config = {
  port: parseInt(process.env['PORT'] ?? '8088', 10),
  openai: {
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
  },
  prometheusUrl: (process.env['PROMETHEUS_URL'] ?? 'http://prometheus:9090').replace(/\/+$/, ''),
  elasticsearchUrl: (process.env['ELASTICSEARCH_URL'] ?? 'http://elasticsearch:9200').replace(/\/+$/, ''),
  logIndexPattern: process.env['LOG_INDEX_PATTERN'] ?? 'shop-logs-*',
  maxToolIterations: parseInt(process.env['MAX_TOOL_ITERATIONS'] ?? '8', 10),
  blueprintDir: process.env['BLUEPRINT_DIR'] ?? '/blueprint',
} as const;
