export type ServiceStatus = 'operational' | 'degraded' | 'unknown';

/** Códigos fijos: nunca el mensaje de la excepción ni el body del upstream. */
export type ProbeError =
  | 'timeout'
  | 'connection_refused'
  | 'http_5xx'
  | 'http_4xx'
  | 'invalid_response';

/** error === null significa que el servicio respondió 2xx. */
export interface ProbeResult {
  httpStatus: number | null;
  error: ProbeError | null;
}

export type Probe = () => Promise<ProbeResult>;

export interface ServiceState {
  id: string;
  name: string;
  status: ServiceStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: Date | null;
  /** Desde cuándo está en el estado actual. null si nunca se chequeó. */
  since: Date | null;
  error: ProbeError | null;
}

export interface StatusSnapshot {
  status: ServiceStatus;
  /** Fin de la última ronda completa. null antes de la primera. */
  checkedAt: Date | null;
  services: ServiceState[];
}

export interface StatusSource {
  start(): void;
  stop(): Promise<void>;
  snapshot(): StatusSnapshot;
}
