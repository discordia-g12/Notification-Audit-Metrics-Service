import type { Pool } from 'pg';
import type { AuditLogEntry, AuditLogQueryFilters, AuditLogPageResponse } from './types';

interface AuditLogRow {
  id: string;
  event_id: string | null;
  server_id: string;
  category: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  reason: string | null;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
}

function mapRowToEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    eventId: row.event_id,
    serverId: row.server_id,
    category: row.category as AuditLogEntry['category'],
    action: row.action as AuditLogEntry['action'],
    actorId: row.actor_id,
    targetId: row.target_id,
    reason: row.reason,
    changes: row.changes ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function insertAuditLog(pool: Pool, entry: AuditLogEntry): Promise<AuditLogEntry | null> {
  const query = `
    INSERT INTO server_audit_logs (
      event_id,
      server_id,
      category,
      action,
      actor_id,
      target_id,
      reason,
      changes,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING *;
  `;

  const values = [
    entry.eventId || null,
    entry.serverId,
    entry.category,
    entry.action,
    entry.actorId,
    entry.targetId || null,
    entry.reason || null,
    JSON.stringify(entry.changes ?? {}),
    JSON.stringify(entry.metadata ?? {}),
  ];

  const result = await pool.query<AuditLogRow>(query, values);
  if (result.rows.length === 0) {
    return null; // Ignorado por idempotencia
  }

  return mapRowToEntry(result.rows[0]);
}

export async function listAuditLogs(
  pool: Pool,
  serverId: string,
  filters: AuditLogQueryFilters = {},
): Promise<AuditLogPageResponse> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
  const conditions: string[] = ['server_id = $1'];
  const values: unknown[] = [serverId];
  let paramIndex = 2;

  if (filters.category) {
    conditions.push(`category = $${paramIndex++}`);
    values.push(filters.category);
  }

  if (filters.action) {
    conditions.push(`action = $${paramIndex++}`);
    values.push(filters.action);
  }

  if (filters.actorId) {
    conditions.push(`actor_id = $${paramIndex++}`);
    values.push(filters.actorId);
  }

  if (filters.before) {
    conditions.push(`created_at < $${paramIndex++}`);
    values.push(filters.before);
  }

  values.push(limit + 1);

  const query = `
    SELECT
      id,
      event_id,
      server_id,
      category,
      action,
      actor_id,
      target_id,
      reason,
      changes,
      metadata,
      created_at
    FROM server_audit_logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT $${paramIndex};
  `;

  const result = await pool.query<AuditLogRow>(query, values);
  const rows = result.rows;

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRowToEntry);
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].createdAt ?? null : null;

  return {
    serverId,
    items,
    limit,
    hasMore,
    nextCursor,
  };
}
