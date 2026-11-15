// Configuración de las métricas globales (GET /api/v1/admin/metrics): de dónde se leen los conteos. Se lee una
// vez al armar la app; una URL inválida corta el arranque, igual que las STATUS_*.
import { ConfigError } from './status';

export interface MetricsConfig {
  /** Base de Chat (mensajes y usuarios activos), sin barra final. */
  chatEngineUrl: string;
  /** Base de Server-Roles (servidores creados), sin barra final. */
  coreServiceUrl: string;
}

type Env = Record<string, string | undefined>;

export const METRICS_DEFAULTS = {
  chatEngineUrl: 'http://localhost:3000',
  coreServiceUrl: 'http://localhost:8002',
} as const;

function parseBaseUrl(name: string, value: string | undefined, fallback: string): string {
  // docker compose pasa "" cuando la variable está declarada pero vacía: se trata como no definida.
  const raw = value?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} no es una URL válida`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} tiene que ser http o https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} no puede llevar credenciales, query ni fragmento`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function loadMetricsConfig(env: Env = process.env): MetricsConfig {
  return {
    chatEngineUrl: parseBaseUrl('CHAT_ENGINE_URL', env.CHAT_ENGINE_URL, METRICS_DEFAULTS.chatEngineUrl),
    coreServiceUrl: parseBaseUrl('CORE_SERVICE_URL', env.CORE_SERVICE_URL, METRICS_DEFAULTS.coreServiceUrl),
  };
}
