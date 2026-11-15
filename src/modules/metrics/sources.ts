import type { MetricsRange } from './range';

export type FetchFn = typeof globalThis.fetch;

export interface SourceLogger {
  warn(fields: object, message: string): void;
}

export interface ChatMetrics {
  messages: number;
  activeUsers: number;
}

export interface ServerMetrics {
  serversCreated: number;
}

export interface PlatformMetrics {
  from: string;
  to: string;
  activeUsers: number | null;
  serversCreated: number | null;
  messagesSent: number | null;
  partial: boolean;
}

export interface MetricsSourcesOptions {
  chatEngineUrl: string;
  coreServiceUrl: string;
  timeoutMs: number;
  fetchFn?: FetchFn;
}

/** Error saneado: nunca sale el body del upstream ni el mensaje crudo de la excepción. */
class SourceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function reasonOf(error: unknown): string {
  if (error instanceof SourceError) return error.reason;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'connection_error';
}

/**
 * GET a un endpoint interno de métricas. El timeout (AbortSignal.timeout) cubre la request y la lectura del body.
 * Rechaza con SourceError si el status no es 2xx o el body no tiene la forma esperada.
 */
async function getJson(
  fetchFn: FetchFn,
  base: string,
  path: string,
  range: MetricsRange,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const url = new URL(`${base}${path}`);
  url.searchParams.set('from', range.from.toISOString());
  url.searchParams.set('to', range.to.toISOString());
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new SourceError(res.status >= 500 ? 'http_5xx' : 'http_4xx');
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    if (reasonOf(error) === 'timeout') throw error;
    throw new SourceError('invalid_response');
  }
  if (typeof body !== 'object' || body === null) throw new SourceError('invalid_response');
  return body as Record<string, unknown>;
}

/**
 * Agregador (ADR-05): consulta en el momento a Chat y Server-Roles, en paralelo. Si una fuente falla o se pasa
 * del timeout, sus datos van en null y la respuesta queda partial; nunca rechaza.
 */
export class MetricsSources {
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: MetricsSourcesOptions) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async chat(range: MetricsRange): Promise<ChatMetrics> {
    const body = await getJson(
      this.fetchFn,
      this.options.chatEngineUrl,
      '/internal/metrics/messages',
      range,
      this.options.timeoutMs,
    );
    if (!isCount(body.messages) || !isCount(body.activeUsers)) throw new SourceError('invalid_response');
    return { messages: body.messages, activeUsers: body.activeUsers };
  }

  async servers(range: MetricsRange): Promise<ServerMetrics> {
    const body = await getJson(
      this.fetchFn,
      this.options.coreServiceUrl,
      '/internal/metrics/servers',
      range,
      this.options.timeoutMs,
    );
    if (!isCount(body.serversCreated)) throw new SourceError('invalid_response');
    return { serversCreated: body.serversCreated };
  }

  async collect(range: MetricsRange, logger: SourceLogger): Promise<PlatformMetrics> {
    const [chat, servers] = await Promise.allSettled([this.chat(range), this.servers(range)]);
    if (chat.status === 'rejected') {
      logger.warn({ source: 'chat', reason: reasonOf(chat.reason) }, 'metrics: Chat no respondió');
    }
    if (servers.status === 'rejected') {
      logger.warn({ source: 'server-roles', reason: reasonOf(servers.reason) }, 'metrics: Server-Roles no respondió');
    }
    const chatValue = chat.status === 'fulfilled' ? chat.value : null;
    const serversValue = servers.status === 'fulfilled' ? servers.value : null;
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      activeUsers: chatValue?.activeUsers ?? null,
      serversCreated: serversValue?.serversCreated ?? null,
      messagesSent: chatValue?.messages ?? null,
      partial: chatValue === null || serversValue === null,
    };
  }
}
