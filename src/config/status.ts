// Configuración del monitor de estado de la plataforma (GET /api/v1/status). Se lee una vez al armar la
// app: un valor inválido corta el arranque en vez de dejar el monitor andando con algo que no se pidió.

export interface StatusConfig {
  /** Base de Kong para las sondas, sin barra final. null: las sondas vía Kong quedan "unknown". */
  gatewayUrl: string | null;
  /** Desactiva la verificación TLS solo en las sondas (Origin Certificate de Cloudflare en prod). */
  tlsInsecure: boolean;
  pollIntervalMs: number;
  probeTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

export const STATUS_DEFAULTS = {
  pollIntervalMs: 15000,
  probeTimeoutMs: 2000,
} as const;

const POLL_INTERVAL_RANGE = { min: 1000, max: 3_600_000 } as const;
const PROBE_TIMEOUT_RANGE = { min: 100, max: 60_000 } as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// docker compose pasa "" cuando la variable está declarada pero vacía (${VAR:-}): se trata como no definida.
function clean(value: string | undefined): string | undefined {
  const raw = value?.trim();
  return raw ? raw : undefined;
}

function parseGatewayUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('STATUS_GATEWAY_URL no es una URL válida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('STATUS_GATEWAY_URL tiene que ser http o https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('STATUS_GATEWAY_URL no puede llevar credenciales, query ni fragmento');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new ConfigError(`${name} tiene que ser "true" o "false"`);
}

function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} tiene que ser un entero en milisegundos`);
  }
  const value = Number(raw);
  if (value < range.min || value > range.max) {
    throw new ConfigError(`${name} tiene que estar entre ${range.min} y ${range.max} ms`);
  }
  return value;
}

export function loadStatusConfig(env: Env = process.env): StatusConfig {
  const pollIntervalMs = parseInteger(
    'STATUS_POLL_INTERVAL_MS',
    clean(env.STATUS_POLL_INTERVAL_MS),
    STATUS_DEFAULTS.pollIntervalMs,
    POLL_INTERVAL_RANGE,
  );
  const probeTimeoutMs = parseInteger(
    'STATUS_PROBE_TIMEOUT_MS',
    clean(env.STATUS_PROBE_TIMEOUT_MS),
    STATUS_DEFAULTS.probeTimeoutMs,
    PROBE_TIMEOUT_RANGE,
  );
  // Una ronda tiene que terminar antes de que arranque la siguiente.
  if (probeTimeoutMs >= pollIntervalMs) {
    throw new ConfigError('STATUS_PROBE_TIMEOUT_MS tiene que ser menor que STATUS_POLL_INTERVAL_MS');
  }

  return {
    gatewayUrl: parseGatewayUrl(clean(env.STATUS_GATEWAY_URL)),
    tlsInsecure: parseBoolean('STATUS_TLS_INSECURE', clean(env.STATUS_TLS_INSECURE)),
    pollIntervalMs,
    probeTimeoutMs,
  };
}
