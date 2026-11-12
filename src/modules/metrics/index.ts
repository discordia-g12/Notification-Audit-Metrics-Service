export { metricsRoutes } from './routes';
export { MetricsCache } from './cache';
export { MetricsSources, type FetchFn, type PlatformMetrics } from './sources';

/** Timeout de cada consulta a Chat y Server-Roles. */
export const METRICS_SOURCE_TIMEOUT_MS = 2000;
/** Cuánto se reusa una respuesta completa para el mismo período. */
export const METRICS_CACHE_TTL_MS = 60_000;
export const METRICS_CACHE_MAX_ENTRIES = 100;
