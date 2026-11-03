import type { ProbeError, ServiceStatus, StatusSnapshot } from './types';

export interface PublicStatusView {
  status: ServiceStatus;
  checkedAt: string | null;
  services: Array<{ id: string; name: string; status: ServiceStatus }>;
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
export function toPublicView(snapshot: StatusSnapshot): PublicStatusView {
  return {
    status: snapshot.status,
    checkedAt: iso(snapshot.checkedAt),
    services: snapshot.services.map(({ id, name, status }) => ({ id, name, status })),
  };
}

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
