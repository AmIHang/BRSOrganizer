export type CoreErrorCode = 'not_found' | 'validation' | 'forbidden';

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

export class NotFoundError extends CoreError {
  constructor(message: string) {
    super('not_found', message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends CoreError {
  constructor(message: string) {
    super('validation', message);
    this.name = 'ValidationError';
  }
}

/** The operation is valid input but not allowed on this item (e.g. editing a synced PR). */
export class ForbiddenOperationError extends CoreError {
  constructor(message: string) {
    super('forbidden', message);
    this.name = 'ForbiddenOperationError';
  }
}
