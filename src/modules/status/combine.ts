import type { Incident } from '../incidents/types';
import type { ServiceStatus, StatusSnapshot } from './types';

/** Estado que ven los usuarios: el sondeado más lo que declaró el staff con un incidente. */
export type PlatformStatus = ServiceStatus | 'maintenance';

export interface CombinedService {
  id: string;
  name: string;
  status: PlatformStatus;
}

export interface CombinedStatus {
  status: PlatformStatus;
  services: CombinedService[];
}

/**
 * Por servicio: un mantenimiento activo gana (el servicio puede estar caído a propósito); si no, degraded si lo
 * dice un incidente o la sonda; si no, lo que diga la sonda.
 */
export function combineServiceStatus(
  probeStatus: ServiceStatus,
  serviceId: string,
  incidents: readonly Incident[],
): PlatformStatus {
  const affecting = incidents.filter((i) => i.affectedServices.includes(serviceId));
  if (affecting.some((i) => i.kind === 'maintenance')) return 'maintenance';
  if (affecting.some((i) => i.kind === 'degraded')) return 'degraded';
  return probeStatus;
}

/** degraded > maintenance > unknown > operational. */
export function aggregatePlatformStatus(statuses: readonly PlatformStatus[]): PlatformStatus {
  for (const status of ['degraded', 'maintenance', 'unknown'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'operational';
}

export function combineStatus(snapshot: StatusSnapshot, incidents: readonly Incident[]): CombinedStatus {
  const services = snapshot.services.map(({ id, name, status }) => ({
    id,
    name,
    status: combineServiceStatus(status, id, incidents),
  }));
  return { status: aggregatePlatformStatus(services.map((s) => s.status)), services };
}
