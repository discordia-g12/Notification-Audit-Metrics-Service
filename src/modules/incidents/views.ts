import type { Incident, IncidentKind, IncidentPage, IncidentStatus } from './types';

/** Lo que ve cualquier usuario: sin autor ni datos de cierre. */
export interface PublicIncidentView {
  id: string;
  kind: IncidentKind;
  title: string;
  description: string;
  affectedServices: string[];
  startedAt: string;
}

export interface AdminIncidentView extends PublicIncidentView {
  status: IncidentStatus;
  createdBy: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

// Campo por campo, como en status/views.ts: lo que no está acá no sale.
export function toPublicIncident(incident: Incident): PublicIncidentView {
  return {
    id: incident.id,
    kind: incident.kind,
    title: incident.title,
    description: incident.description,
    affectedServices: [...incident.affectedServices],
    startedAt: incident.createdAt.toISOString(),
  };
}

export function toAdminIncident(incident: Incident): AdminIncidentView {
  return {
    ...toPublicIncident(incident),
    status: incident.status,
    createdBy: incident.createdBy,
    resolvedBy: incident.resolvedBy,
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    resolutionNote: incident.resolutionNote,
  };
}

export function toAdminPage(page: IncidentPage): { items: AdminIncidentView[]; nextBefore: string | null } {
  return { items: page.items.map(toAdminIncident), nextBefore: page.nextBefore };
}
