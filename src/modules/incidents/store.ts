import type { Pool, PoolClient } from 'pg';
import type {
  Incident,
  IncidentKind,
  IncidentPage,
  IncidentStatus,
  IncidentStore,
  ListIncidentsQuery,
  NewIncident,
  ResolveIncident,
  ResolveResult,
} from './types';

interface IncidentRow {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  title: string;
  description: string;
  affected_services: string[];
  created_by: string;
  created_at: Date;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}

const COLUMNS = `id, kind, status, title, description, affected_services, created_by, created_at,
  resolved_by, resolved_at, resolution_note`;

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    description: row.description,
    affectedServices: row.affected_services,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}

interface AuditEntry {
  actorId: string;
  action: 'incident.created' | 'incident.resolved';
  incidentId: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}

async function audit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, reason, metadata)
     VALUES ($1, $2, 'incident', $3, $4, $5)`,
    [entry.actorId, entry.action, entry.incidentId, entry.reason, JSON.stringify(entry.metadata)],
  );
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** IncidentStore sobre Postgres (tablas de la migración 001). */
export class PgIncidentStore implements IncidentStore {
  constructor(private readonly pool: Pool) {}

  create(input: NewIncident): Promise<Incident> {
    return inTransaction(this.pool, async (client) => {
      const { rows } = await client.query<IncidentRow>(
        `INSERT INTO incidents (kind, title, description, affected_services, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [input.kind, input.title, input.description, input.affectedServices, input.createdBy],
      );
      const incident = toIncident(rows[0]);
      await audit(client, {
        actorId: input.createdBy,
        action: 'incident.created',
        incidentId: incident.id,
        reason: null,
        metadata: { kind: incident.kind, title: incident.title, affectedServices: incident.affectedServices },
      });
      return incident;
    });
  }

  resolve(id: string, input: ResolveIncident): Promise<ResolveResult> {
    return inTransaction(this.pool, async (client): Promise<ResolveResult> => {
      // El WHERE status = 'active' hace que dos staff resolviendo a la vez no pisen el primer cierre.
      const updated = await client.query<IncidentRow>(
        `UPDATE incidents
            SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${COLUMNS}`,
        [id, input.resolvedBy, input.note],
      );
      if (updated.rows.length === 0) {
        const existing = await client.query<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [id]);
        if (existing.rows.length === 0) return { outcome: 'not_found' };
        return { outcome: 'already_resolved', incident: toIncident(existing.rows[0]) };
      }
      const incident = toIncident(updated.rows[0]);
      await audit(client, {
        actorId: input.resolvedBy,
        action: 'incident.resolved',
        incidentId: incident.id,
        reason: input.note,
        metadata: { kind: incident.kind, title: incident.title },
      });
      return { outcome: 'resolved', incident };
    });
  }

  async list(query: ListIncidentsQuery): Promise<IncidentPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      conditions.push(`created_at < $${params.length}`);
    }
    params.push(query.limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await this.pool.query<IncidentRow>(
      `SELECT ${COLUMNS} FROM incidents ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.map(toIncident);
    const last = items.at(-1);
    return {
      items,
      nextBefore: items.length === query.limit && last ? last.createdAt.toISOString() : null,
    };
  }

  async listActive(): Promise<Incident[]> {
    const { rows } = await this.pool.query<IncidentRow>(
      `SELECT ${COLUMNS} FROM incidents WHERE status = 'active' ORDER BY created_at DESC`,
    );
    return rows.map(toIncident);
  }
}
