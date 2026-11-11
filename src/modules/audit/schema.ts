import type { Pool } from 'pg';

export async function initAuditDatabase(pool: Pool): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS server_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id VARCHAR(64) UNIQUE,
      server_id UUID NOT NULL,
      category VARCHAR(32) NOT NULL,
      action VARCHAR(64) NOT NULL,
      actor_id VARCHAR(128) NOT NULL,
      target_id VARCHAR(128),
      reason TEXT,
      changes JSONB DEFAULT '{}'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_server_timeline ON server_audit_logs (server_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_server_category ON server_audit_logs (server_id, category);
    CREATE INDEX IF NOT EXISTS idx_audit_server_action ON server_audit_logs (server_id, action);
    CREATE INDEX IF NOT EXISTS idx_audit_server_actor ON server_audit_logs (server_id, actor_id);
  `;

  await pool.query(ddl);
}
