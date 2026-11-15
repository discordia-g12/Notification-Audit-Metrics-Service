import type { Migration } from './migrate';

/**
 * Migraciones del servicio, en orden (ADR-03). Van en el código y no en archivos .sql: se compilan con la app,
 * la imagen no necesita copiar nada más y no hay lecturas de disco con rutas armadas.
 *
 * Reglas: nunca editar una migración ya desplegada (se agrega otra) y solo cambios aditivos, para que la imagen
 * anterior siga arrancando si el deploy hace rollback.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_incidents_and_audit_logs',
    sql: `
      CREATE TABLE incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('degraded', 'maintenance')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
        title varchar(120) NOT NULL CHECK (char_length(btrim(title)) >= 3),
        description varchar(1000) NOT NULL CHECK (char_length(btrim(description)) >= 1),
        affected_services text[] NOT NULL CHECK (cardinality(affected_services) >= 1),
        created_by text NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        resolved_by text,
        resolved_at timestamptz(3),
        resolution_note varchar(1000),
        CHECK ((status = 'active') = (resolved_at IS NULL)),
        CHECK ((status = 'active') = (resolved_by IS NULL))
      );

      -- El aviso de la app lee solo los activos, en cada consulta de estado.
      CREATE INDEX incidents_active_idx ON incidents (created_at DESC) WHERE status = 'active';
      CREATE INDEX incidents_created_at_idx ON incidents (created_at DESC);

      -- Tabla de auditoría del servicio (ADR 0003 de org-docs). Se escribe en la misma transacción que la
      -- acción del staff que registra.
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        reason text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );

      CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
      CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
      CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
    `,
  },
];
