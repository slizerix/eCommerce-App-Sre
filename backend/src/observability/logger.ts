import pino from 'pino';

// One pino logger per process. Output goes to stdout as line-delimited JSON
// so that Filebeat (or anything tailing the container log) can ship it to
// Elasticsearch without an intermediate parser.
//
// Convention (enforced by usage, not by types):
//   - Every log line has: `time`, `level`, `service`, `env`.
//   - HTTP request lines add: `event:"http_request"`, `request_id`, `method`,
//     `route`, `status`, `status_class`, `duration_ms`, `user_id?`, `error_code?`.
//   - Business events add: `event:"<domain>.<verb>"` (e.g. `payment.declined`)
//     plus event-specific fields. Keep field names stable; the AI service
//     searches on them.
// We use ECS-compatible nested field names where ES's default ECS index
// template already declares a mapping (e.g. `service.name` is a keyword
// inside the `service` object). Sending `service: "backend"` as a string
// makes ES reject the doc with `object mapping for [service] tried to parse
// field [service] as object`, which is exactly the mapping conflict ECS
// causes here. Using the nested form sidesteps the conflict cleanly.
export const baseLogger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: { name: 'backend' },
    env: process.env['NODE_ENV'] ?? 'development',
  },
  formatters: {
    // Emit `level: "info"` instead of `level: 30` so log consumers can
    // filter by name without a numeric mapping.
    level(label) {
      return { level: label };
    },
  },
  // Pino's default timestamp field is `time`. Use `@timestamp` so it lines
  // up with Filebeat's expected event time field — no double timestamps.
  timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
});

export type Logger = pino.Logger;
