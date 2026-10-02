// One error type for the whole API. Services throw these; the Fastify error handler renders
// them. It exists so a client branches on a code rather than on message text, and so a raw
// gateway detail (which can name an internal ref or an upstream payload) never reaches a
// trader's screen (hard rule 7).

import type { ApiErrorCode } from '@nt/shared';

export class AppError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    public readonly status: number,
    message: string,
    /** Operator-facing context for the log line only. Never serialized into the response. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const invalidRequest = (message: string, detail?: string): AppError =>
  new AppError('invalid_request', 400, message, detail);

export const unauthorized = (message = 'a valid session token is required', detail?: string): AppError =>
  new AppError('unauthorized', 401, message, detail);

export const forbidden = (message = 'not yours to read', detail?: string): AppError =>
  new AppError('forbidden', 403, message, detail);

export const notFound = (message = 'not found', detail?: string): AppError =>
  new AppError('not_found', 404, message, detail);

export const conflict = (code: ApiErrorCode, message: string, detail?: string): AppError =>
  new AppError(code, 409, message, detail);

/**
 * D13c: a transient gateway refusal is the client's retry cue, not a failure of the request,
 * so it is a 503 with the same Idempotency-Key rather than a 4xx.
 */
export const gatewayTransient = (message: string, detail?: string): AppError =>
  new AppError('gateway_transient', 503, message, detail);

/** D13c: we stopped acting and are checking what really happened. The trader waits, not retries. */
export const gatewayUnavailable = (message: string, detail?: string): AppError =>
  new AppError('gateway_unavailable', 503, message, detail);
