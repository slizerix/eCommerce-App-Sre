import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      routeTemplate?: string;
    }
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

// Capture the route template at the moment the handler runs. We need this
// because when an error bubbles up to the app-level error middleware,
// Express has popped req.baseUrl back to "" — so the metrics middleware
// would otherwise see the wrong route on error responses.
export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.routeTemplate && req.route?.path) {
      req.routeTemplate = `${req.baseUrl}${req.route.path}`;
    }
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
