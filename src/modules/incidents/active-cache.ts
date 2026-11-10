import type { Incident } from './types';

interface CacheLogger {
  warn(obj: object, msg: string): void;
}

export interface ActiveIncidentsOptions {
  load: () => Promise<Incident[]>;
  ttlMs: number;
  logger?: CacheLogger;
  now?: () => number;
}

/** Lo que consume la vista de estado: los incidentes activos. Nunca rechaza. */
export interface ActiveIncidentsSource {
  get(): Promise<Incident[]>;
  invalidate(): void;
}

/**
 * Incidentes activos con caché corta. GET /api/v1/status lo consulta cada cliente con sesión cada 60 s: con el
 * TTL, la base recibe como mucho una consulta cada ttlMs por réplica. Crear o resolver invalida la caché de la
 * réplica que atendió la request; en las demás el cambio se ve al vencer el TTL.
 *
 * Si la base falla se sirve el último valor conocido (vacío si nunca cargó) y se loguea: el estado sondeado
 * sigue saliendo aunque Postgres esté caído, y en ese caso el propio servicio ya figura degradado.
 */
export class ActiveIncidentsCache implements ActiveIncidentsSource {
  private value: Incident[] = [];
  private loadedAt: number | null = null;
  private inflight: Promise<Incident[]> | null = null;
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: ActiveIncidentsOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get(): Promise<Incident[]> {
    if (this.loadedAt !== null && this.now() - this.loadedAt < this.options.ttlMs) {
      return Promise.resolve(this.value);
    }
    if (!this.inflight) {
      const generation = this.generation;
      const load: Promise<Incident[]> = this.options
        .load()
        .then((incidents) => {
          // Una invalidación durante la carga gana: este resultado puede ser anterior a la escritura.
          if (generation === this.generation) {
            this.value = incidents;
            this.loadedAt = this.now();
          }
          return incidents;
        })
        .catch((err: unknown) => {
          this.options.logger?.warn(
            { code: (err as { code?: unknown })?.code ?? null },
            'incidents: no se pudieron leer los activos, se sirve el último valor',
          );
          return this.value;
        })
        .finally(() => {
          if (this.inflight === load) this.inflight = null;
        });
      this.inflight = load;
    }
    return this.inflight;
  }

  invalidate(): void {
    this.generation += 1;
    this.loadedAt = null;
    this.inflight = null;
  }
}
