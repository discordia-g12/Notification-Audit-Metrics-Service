import { StatusMonitor } from '../src/modules/status/monitor';
import { SERVICE_CATALOG } from '../src/modules/status/catalog';
import type { ProbeResult } from '../src/modules/status/types';

export const OK: ProbeResult = { httpStatus: 200, error: null };
export const DOWN: ProbeResult = { httpStatus: 503, error: 'http_5xx' };

/**
 * Monitor con el catálogo real, sondas falsas y reloj controlado. results: resultado por id; un id ausente
 * es una sonda no configurada. Nada de timers reales: la ronda se dispara con poll().
 */
export function fakeMonitor(results: Map<string, ProbeResult | Error>, start = Date.UTC(2026, 10, 3, 12)) {
  const clock = { ms: start };
  const logs: Array<{ level: string; fields: object }> = [];
  let scheduled = 0;
  let cleared = 0;
  const monitor = new StatusMonitor({
    services: SERVICE_CATALOG.map(({ id, name }) => ({
      id,
      name,
      probe: results.has(id)
        ? async () => {
            const result = results.get(id) as ProbeResult | Error;
            if (result instanceof Error) throw result;
            clock.ms += 5; // latencia simulada
            return result;
          }
        : null,
    })),
    intervalMs: 15000,
    now: () => new Date(clock.ms),
    monotonic: () => clock.ms,
    setInterval: () => {
      scheduled += 1;
      return {};
    },
    clearInterval: () => {
      cleared += 1;
    },
    logger: {
      info: (fields) => logs.push({ level: 'info', fields }),
      warn: (fields) => logs.push({ level: 'warn', fields }),
    },
  });
  return {
    monitor,
    clock,
    logs,
    timers: () => ({ scheduled, cleared }),
  };
}

export function allOk(): Map<string, ProbeResult | Error> {
  return new Map(SERVICE_CATALOG.map(({ id }) => [id, OK]));
}
