import { CoreError } from '@amineeded/core';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

const STATUS: Record<CoreError['code'], number> = {
  not_found: 404,
  validation: 400,
  forbidden: 409,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof CoreError) {
      res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    // body-parser errors (invalid JSON, too large) carry a status.
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'bad_request', message: (err as Error).message });
      return;
    }
    logger.error({ err }, 'unhandled request error');
    res.status(500).json({ error: 'internal', message: 'internal error' });
  };
}
