import type { Pool } from 'pg';

/** Una migración: SQL que solo avanza. El id se ordena lexicográficamente y nunca cambia una vez desplegado. */
export interface Migration {
  id: string;
  sql: string;
}

interface MigrationLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Clave del advisory lock: dos réplicas que arrancan juntas no migran a la vez. */
export const MIGRATION_LOCK_KEY = 740_001;

export class MigrationError extends Error {
  constructor(
    readonly migrationId: string,
    cause: unknown,
  ) {
    super(`la migración ${migrationId} falló`, { cause });
    this.name = 'MigrationError';
  }
}

/** Ids únicos y en orden: un archivo renombrado o fuera de orden se detecta antes de tocar la base. */
export function assertMigrationOrder(migrations: readonly Migration[]): void {
  let previous: string | null = null;
  for (const { id } of migrations) {
    if (previous !== null && previous >= id) {
      throw new Error(`migraciones fuera de orden o repetidas: ${previous}, ${id}`);
    }
    previous = id;
  }
}

/**
 * Aplica las migraciones pendientes, cada una en su transacción junto con su registro en schema_migrations.
 * Devuelve los ids aplicados. Ids registrados que el código no conoce (la base está adelante, por ejemplo
 * después de un rollback de imagen) solo se avisan: las migraciones son aditivas y la versión anterior
 * tiene que poder arrancar.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[],
  logger?: MigrationLogger,
): Promise<string[]> {
  assertMigrationOrder(migrations);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           id text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
      const done = new Set(rows.map((row) => row.id));
      const known = new Set(migrations.map((m) => m.id));
      const unknown = [...done].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        logger?.warn({ unknown }, 'migraciones aplicadas que este código no conoce');
      }

      const applied: string[] = [];
      for (const migration of migrations) {
        if (done.has(migration.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new MigrationError(migration.id, err);
        }
        applied.push(migration.id);
        logger?.info({ migration: migration.id }, 'migración aplicada');
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
