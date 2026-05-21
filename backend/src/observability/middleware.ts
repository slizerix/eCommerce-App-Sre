import type { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { baseLogger, type Logger } from './logger.js';
import {
  httpRequestDuration,
  httpRequestsTotal,
  normalizeErrorCode,
  statusClass,
} from './metrics.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
      errorCode?: string;
    }
  }
}

// Generate or accept an inbound request id. Logged on every line for that
// request and echoed back in the X-Request-Id header — gives the AI service
// (and humans) a way to pivot from a single log line to the whole request.
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  const id = inbound && inbound.length <= 64 ? inbound : nanoid(12);
  req.requestId = id;
  res.setHeader('x-request-id', id);
  req.log = baseLogger.child({ request_id: id });
  next();
}

// Captures HTTP timing + emits one structured log line per request on
// response finish. Route template is captured after the route has matched.
export function httpMetricsAndLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const durationMs = Math.round(durationNs / 1e6);

    // Prefer the route template captured by asyncHandler at match time
    // (still correct on the error path, where req.baseUrl has been popped).
    // Fall back to computing it here for routes that don't use asyncHandler
    // (just the inline ones in index.ts), and to "unmatched" for everything
    // else so we don't blow up cardinality with arbitrary URLs.
    const computed = req.route?.path ? `${req.baseUrl}${req.route.path}` : '';
    const routeTemplate = req.routeTemplate
      || computed
      || (req.path === '/metrics' || req.path === '/healthz' ? req.path : 'unmatched');

    const sClass = statusClass(res.statusCode);
    const errCode = normalizeErrorCode(req.errorCode);

    httpRequestsTotal.inc({
      route: routeTemplate,
      method: req.method,
      status_class: sClass,
      error_code: errCode,
    });
    httpRequestDuration.observe(
      { route: routeTemplate, method: req.method, status_class: sClass },
      durationSec
    );

    // One log line per request, JSON, with stable field names.
    (req.log ?? baseLogger).info(
      {
        event: 'http_request',
        method: req.method,
        route: routeTemplate,
        path: req.path,
        status: res.statusCode,
        status_class: sClass,
        duration_ms: durationMs,
        user_id: req.user?.id,
        error_code: req.errorCode,
      },
      'http_request'
    );
  });

  next();
}
