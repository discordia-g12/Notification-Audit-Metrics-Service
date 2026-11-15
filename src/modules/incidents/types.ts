export const INCIDENT_KINDS = ['degraded', 'maintenance'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_STATUSES = ['active', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  descriptionMax: 1000,
  noteMax: 1000,
  pageDefault: 20,
  pageMax: 100,
} as const;

export interface Incident {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  title: string;
  description: string;
  /** Ids de SERVICE_CATALOG: los servicios que exponen health checks. */
  affectedServices: string[];
  createdBy: string;
  createdAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

export interface NewIncident {
  kind: IncidentKind;
  title: string;
  description: string;
  affectedServices: string[];
  createdBy: string;
}

export interface ResolveIncident {
  resolvedBy: string;
  note: string | null;
}

export type ResolveResult =
  | { outcome: 'resolved'; incident: Incident }
  | { outcome: 'not_found' }
  | { outcome: 'already_resolved'; incident: Incident };

export interface IncidentPage {
  items: Incident[];
  /** Cursor para la página siguiente (createdAt del último, ISO). null si no hay más. */
  nextBefore: string | null;
}

export interface ListIncidentsQuery {
  status?: IncidentStatus;
  limit: number;
  before?: Date;
}

/** Persistencia de incidentes. Cada escritura deja su registro en audit_logs en la misma transacción. */
export interface IncidentStore {
  create(input: NewIncident): Promise<Incident>;
  resolve(id: string, input: ResolveIncident): Promise<ResolveResult>;
  list(query: ListIncidentsQuery): Promise<IncidentPage>;
  listActive(): Promise<Incident[]>;
}
