import type { ProbeError } from './types';

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ABORT_ERR']);

/** Traduce cualquier error de una sonda a un código fijo. Solo mira code/name, nunca el mensaje. */
export function classifyError(err: unknown): ProbeError {
  if (typeof err !== 'object' || err === null) return 'invalid_response';
  const { code, name } = err as { code?: unknown; name?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (typeof code === 'string') {
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (CONNECTION_CODES.has(code)) return 'connection_refused';
  }
  return 'invalid_response';
}

export function classifyHttpStatus(status: number): ProbeError | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 500 && status < 600) return 'http_5xx';
  if (status >= 400 && status < 500) return 'http_4xx';
  // 1xx/3xx: no se siguen redirects, una sonda que redirige está mal configurada.
  return 'invalid_response';
}
