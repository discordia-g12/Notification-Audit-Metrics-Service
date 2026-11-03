import type { StatusConfig } from '../../config/status';
import { classifyError } from './errors';
import { httpProbe, type HttpProbeOptions } from './http-probe';
import type { MonitoredService } from './monitor';
import type { Probe, ProbeResult } from './types';

type Target = { kind: 'gateway'; path: string } | { kind: 'self' };

/** Orden y nombres fijos: es el contrato que consume la WebApp. */
export const SERVICE_CATALOG: ReadonlyArray<{ id: string; name: string; target: Target }> = [
  { id: 'gateway', name: 'API Gateway', target: { kind: 'gateway', path: '/readyz' } },
  { id: 'auth', name: 'Auth y usuarios', target: { kind: 'gateway', path: '/internal/readyz/auth' } },
  {
    id: 'server-roles',
    name: 'Servidores y roles',
    target: { kind: 'gateway', path: '/internal/readyz/server-roles' },
  },
  { id: 'chat', name: 'Chat', target: { kind: 'gateway', path: '/internal/readyz/chat' } },
  { id: 'voice', name: 'Voz', target: { kind: 'gateway', path: '/internal/readyz/voice' } },
  { id: 'notification', name: 'Notificaciones y auditoría', target: { kind: 'self' } },
  { id: 'payments', name: 'Pagos', target: { kind: 'gateway', path: '/internal/readyz/payments' } },
];

export type HttpProber = (url: string, options: HttpProbeOptions) => Promise<ProbeResult>;

/** El propio servicio se mide con el mismo chequeo que /readyz, sin pasar por Kong. */
export function selfProbe(check: () => Promise<void>): Probe {
  return async () => {
    try {
      await check();
      return { httpStatus: 200, error: null };
    } catch (err) {
      // Lo que respondería /readyz: 503. El código dice por qué, sin el mensaje del driver.
      const error = classifyError(err);
      return { httpStatus: 503, error: error === 'invalid_response' ? 'http_5xx' : error };
    }
  };
}

export function buildMonitoredServices(
  config: StatusConfig,
  databaseCheck: () => Promise<void>,
  prober: HttpProber = httpProbe,
): MonitoredService[] {
  const probeOptions: HttpProbeOptions = {
    timeoutMs: config.probeTimeoutMs,
    tlsInsecure: config.tlsInsecure,
  };
  const { gatewayUrl } = config;

  return SERVICE_CATALOG.map(({ id, name, target }) => {
    let probe: Probe | null = null;
    if (target.kind === 'self') {
      probe = selfProbe(databaseCheck);
    } else if (gatewayUrl) {
      const url = `${gatewayUrl}${target.path}`;
      probe = () => prober(url, probeOptions);
    }
    return { id, name, probe };
  });
}
