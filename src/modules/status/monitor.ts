import { classifyError } from './errors';
import type {
  Probe,
  ProbeResult,
  ServiceState,
  ServiceStatus,
  StatusSnapshot,
  StatusSource,
} from './types';

export interface MonitoredService {
  id: string;
  name: string;
  /** null: sonda no configurada, el servicio queda "unknown". */
  probe: Probe | null;
}

interface MonitorLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

interface TimerHandle {
  unref?: () => unknown;
}

export interface StatusMonitorOptions {
  services: MonitoredService[];
  intervalMs: number;
  logger?: MonitorLogger;
  // Inyectables para los tests: reloj, reloj monotónico (latencia) y temporizador.
  now?: () => Date;
  monotonic?: () => number;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

/** degraded si alguno lo está; si no, unknown si alguno lo está; si no, operational. */
export function aggregateStatus(statuses: ServiceStatus[]): ServiceStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('unknown')) return 'unknown';
  return 'operational';
}

/**
 * Sondea todos los servicios en paralelo cada intervalMs y guarda en memoria el último resultado. Los
 * endpoints leen snapshot(): ninguna request dispara sondas.
 */
export class StatusMonitor implements StatusSource {
  private readonly services: MonitoredService[];
  private readonly states = new Map<string, ServiceState>();
  private readonly intervalMs: number;
  private readonly logger?: MonitorLogger;
  private readonly now: () => Date;
  private readonly monotonic: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearIntervalFn: (handle: TimerHandle) => void;
  private timer: TimerHandle | null = null;
  private inflight: Promise<void> | null = null;
  private lastRoundAt: Date | null = null;

  constructor(options: StatusMonitorOptions) {
    this.services = options.services;
    this.intervalMs = options.intervalMs;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

    for (const { id, name } of this.services) {
      this.states.set(id, {
        id,
        name,
        status: 'unknown',
        httpStatus: null,
        latencyMs: null,
        checkedAt: null,
        since: null,
        error: null,
      });
    }
  }

  /** Lanza la primera ronda sin esperarla (no bloquea el listen) y agenda las siguientes. */
  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = this.setIntervalFn(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
  }

  /** Una ronda. Si ya hay una en curso devuelve esa en vez de solapar. */
  poll(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.runRound().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  snapshot(): StatusSnapshot {
    const services = this.services.map(({ id }) => ({ ...(this.states.get(id) as ServiceState) }));
    return {
      status: aggregateStatus(services.map((s) => s.status)),
      checkedAt: this.lastRoundAt,
      services,
    };
  }

  private async runRound(): Promise<void> {
    await Promise.all(
      this.services.map(async ({ id, probe }) => {
        if (!probe) return;
        const started = this.monotonic();
        let result: ProbeResult;
        try {
          result = await probe();
        } catch (err) {
          result = { httpStatus: null, error: classifyError(err) };
        }
        const latencyMs = Math.max(0, Math.round(this.monotonic() - started));
        this.record(id, result, latencyMs);
      }),
    );
    this.lastRoundAt = this.now();
  }

  private record(id: string, result: ProbeResult, latencyMs: number): void {
    const previous = this.states.get(id) as ServiceState;
    const checkedAt = this.now();
    const status: ServiceStatus = result.error === null ? 'operational' : 'degraded';
    const changed = previous.status !== status;

    this.states.set(id, {
      ...previous,
      status,
      httpStatus: result.httpStatus,
      latencyMs,
      checkedAt,
      since: changed ? checkedAt : previous.since,
      error: result.error,
    });

    if (changed && this.logger) {
      const fields = { service: id, from: previous.status, to: status, error: result.error };
      if (status === 'degraded') this.logger.warn(fields, 'status: servicio degradado');
      else this.logger.info(fields, 'status: servicio operativo');
    }
  }
}
