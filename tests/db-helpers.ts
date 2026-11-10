import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { MIGRATIONS } from '../src/db/migrations';
import { runMigrations } from '../src/db/migrate';

/** El Postgres de CI (service container) o el local. Mismo default que app.ts. */
export const BASE_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:password@127.0.0.1:5432/notification_db';

/**
 * Cada archivo de tests corre en su propio proceso y en paralelo: cada uno usa un schema propio para no
 * pisarse las tablas. El search_path va en la URL, así buildApp lo usa sin cambios.
 */
export async function createTestSchema(): Promise<{ url: string; pool: Pool; drop: () => Promise<void> }> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: BASE_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const url = new URL(BASE_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 3 });

  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

export async function createMigratedSchema() {
  const db = await createTestSchema();
  await runMigrations(db.pool, MIGRATIONS);
  return db;
}
