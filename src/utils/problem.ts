import type { FastifyReply, FastifyRequest } from 'fastify';

const TITLES = new Map<number, string>([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [409, 'Conflict'],
  [415, 'Unsupported Media Type'],
  [500, 'Internal Server Error'],
]);

export interface ProblemExtras {
  /** Errores de validación por campo (400). */
  errors?: Array<{ field: string; message: string }>;
}

/** Respuesta RFC 9457 con el mismo formato que reject() de auth0_validator.lua. */
export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  detail: string,
  extras: ProblemExtras = {},
): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'application/problem+json')
    .send({
      type: 'about:blank',
      title: TITLES.get(status) ?? 'Error',
      status,
      detail,
      instance: request.url.split('?')[0],
      ...extras,
    });
}
