import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initSchema } from './db.js';
import { HttpError } from './util.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import cartRouter from './routes/cart.js';
import checkoutRouter from './routes/checkout.js';
import paymentRouter from './routes/payment.js';
import ordersRouter from './routes/orders.js';
import { baseLogger } from './observability/logger.js';
import { registry } from './observability/metrics.js';
import { httpMetricsAndLog, requestContext } from './observability/middleware.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestContext);
app.use(httpMetricsAndLog);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Prometheus scrape target. Intentionally unauthenticated and on the same
// port as the API — keeps the local stack one-port, and there's nothing
// sensitive in the metrics (cardinality is disciplined upstream).
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/cart', cartRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/orders', ordersRouter);

app.use((req: Request, res: Response) => {
  req.errorCode = 'not_found';
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    req.errorCode = err.code;
    (req.log ?? baseLogger).warn(
      {
        event: 'http_error',
        status: err.status,
        error_code: err.code,
        message: err.message,
        route: req.routeTemplate ?? req.path,
        method: req.method,
      },
      err.code
    );
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  req.errorCode = 'internal_error';
  (req.log ?? baseLogger).error(
    {
      event: 'unhandled_error',
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      route: req.routeTemplate ?? req.path,
      method: req.method,
    },
    'unhandled_error'
  );
  res.status(500).json({ error: 'internal_error' });
});

(async () => {
  await initSchema();
  app.listen(config.port, () => {
    baseLogger.info({ event: 'service.started', port: config.port }, 'backend listening');
  });
})();
