export { incidentRoutes } from './routes';
export { PgIncidentStore } from './store';
export { ActiveIncidentsCache, type ActiveIncidentsSource } from './active-cache';
export type { Incident, IncidentStore } from './types';

/** TTL de la caché de activos: cuánto puede tardar otra réplica en ver un incidente nuevo o resuelto. */
export const ACTIVE_INCIDENTS_TTL_MS = 5000;
