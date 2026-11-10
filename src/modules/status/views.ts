import type { Incident } from '../incidents/types';
import { toPublicIncident, type PublicIncidentView } from '../incidents/views';
import { combineStatus, type PlatformStatus } from './combine';
import type { ProbeError, ServiceStatus, StatusSnapshot } from './types';

/** Vista pública: estado combinado con los incidentes activos (historia 74, CA1 y CA3). */
export interface PublicStatusView {
  status: PlatformStatus;
  checkedAt: string | null;
  services: Array<{ id: string; name: string; status: PlatformStatus }>;
  incidents: PublicIncidentView[];
}

export interface AdminStatusView {
  status: ServiceStatus;
  checkedAt: string | null;
  services: Array<{
    id: string;
    name: string;
    status: ServiceStatus;
    httpStatus: number | null;
    latencyMs: number | null;
    checkedAt: string | null;
    since: string | null;
    error: ProbeError | null;
  }>;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

// Se arma campo por campo: lo que no está acá no sale, aunque se agregue al estado interno.
export function toPublicView(snapshot: StatusSnapshot, incidents: readonly Incident[] = []): PublicStatusView {
  const combined = combineStatus(snapshot, incidents);
  return {
    status: combined.status,
    checkedAt: iso(snapshot.checkedAt),
    services: combined.services.map(({ id, name, status }) => ({ id, name, status })),
    incidents: incidents.map(toPublicIncident),
  };
}

/** La vista staff es el sondeo crudo: el backoffice la cruza con los incidentes para sugerir uno. */
export function toAdminView(snapshot: StatusSnapshot): AdminStatusView {
  return {
    status: snapshot.status,
    checkedAt: iso(snapshot.checkedAt),
    services: snapshot.services.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      httpStatus: s.httpStatus,
      latencyMs: s.latencyMs,
      checkedAt: iso(s.checkedAt),
      since: iso(s.since),
      error: s.error,
    })),
  };
}
