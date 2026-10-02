// One place decides how bytes become a validated request, so no route invents its own idea of
// what a body is.
//
// Two deliberate choices:
//  * the JSON parser returns the *string*, not an object. A provider's signature covers the exact
//    bytes it sent, and a reparsed object is a different document (hard rule 4, D13f).
//  * every body is then validated by a Zod schema from @nt/shared. The product schemas live there
//    because the mobile client is the other half of the contract (hard rule 8).

import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { WebhookInput } from '../gateways/types';
import { AppError, invalidRequest } from '../modules/errors';

/** Keeps the request bytes intact for signature verification. */
export const rawJsonParser = (_request: FastifyRequest, rawBody: string, done: (error: Error | null, body?: string) => void): void =>
  done(null, rawBody);

/** Parse, then validate. A failure here is the client's to fix, so it is a 400 with a code. */
export function parseJsonBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  if (typeof body !== 'string') throw invalidRequest('this request needs a JSON body');
  if (body.trim() === '') throw invalidRequest('this request needs a JSON body');
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw invalidRequest('the request body is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    // The issues name fields and constraints, never values, so a rejected body cannot echo PII
    // back into a log line or a response (hard rule 7).
    throw invalidRequest('the request body is not what this endpoint accepts', issues);
  }
  return parsed.data;
}

export function webhookInputOf(request: FastifyRequest): WebhookInput {
  return {
    rawBody: stringBody(request),
    headers: Object.fromEntries(
      Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  };
}

/**
 * One header's value. Node hands back an array when a client repeats a header, and two values are
 * not one key, so anything except exactly one string reads as absent.
 */
export const headerValue = (header: string | string[] | undefined): string | undefined =>
  typeof header === 'string' ? header : header?.length === 1 ? header[0] : undefined;

const stringBody = (request: FastifyRequest): string => {
  if (typeof request.body !== 'string') {
    throw new AppError('invalid_request', 400, 'this webhook needs a raw JSON body');
  }
  return request.body;
};
