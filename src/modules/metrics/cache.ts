import type { PlatformMetrics } from './sources';

export interface MetricsCacheOptions {
  ttlMs: number;
  /** Tope de entradas: con muchos períodos distintos se descarta la más vieja. */
  maxEntries: number;
  now?: () => number;
}

/**
 * Caché en memoria por período (from|to normalizados a ISO). Solo guarda respuestas completas: una parcial se
 * vuelve a pedir en la próxima request, así el dato aparece apenas la fuente se recupera.
 */
export class MetricsCache<T extends { partial: boolean } = PlatformMetrics> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: MetricsCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (value.partial) return;
    this.entries.delete(key);
    if (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
  }
}
