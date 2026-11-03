import type { FastifyBaseLogger } from 'fastify';
import type { StatusConfig } from '../../config/status';
import { buildMonitoredServices } from './catalog';
import { StatusMonitor } from './monitor';

export { statusRoutes } from './routes';
export { StatusMonitor } from './monitor';
export type { StatusSource } from './types';

export function createStatusMonitor(
  config: StatusConfig,
  databaseCheck: () => Promise<void>,
  logger: FastifyBaseLogger,
): StatusMonitor {
  if (!config.gatewayUrl) {
    logger.warn(
      'STATUS_GATEWAY_URL no está definido: los servicios que se sondean a través de Kong quedan "unknown"',
    );
  } else if (config.tlsInsecure) {
    logger.warn('STATUS_TLS_INSECURE=true: las sondas de estado no verifican el certificado de Kong');
  }

  return new StatusMonitor({
    services: buildMonitoredServices(config, databaseCheck),
    intervalMs: config.pollIntervalMs,
    logger,
  });
}
