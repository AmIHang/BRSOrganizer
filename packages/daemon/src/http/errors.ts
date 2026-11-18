import { CoreError, TfsRequestError } from '@brsorganizer/core';
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
    // Errors from Azure DevOps (e.g. a branch policy blocking the merge) or from the TFS/script
    // plumbing, or from OTMA (login, unexpected answer): the message is meant for the user and
    // contains no secrets.
    if (
      err instanceof TfsRequestError ||
      (err instanceof Error && /^(Azure DevOps|PR scripts|OTMA)/.test(err.message))
    ) {
      res.status(502).json({ error: 'upstream', message: (err as Error).message });
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
