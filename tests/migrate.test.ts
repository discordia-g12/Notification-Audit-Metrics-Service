import { after, before, test } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';
import { MIGRATIONS } from '../src/db/migrations';
import { assertMigrationOrder, MigrationError, runMigrations, type Migration } from '../src/db/migrate';
import { createTestSchema } from './db-helpers';

type Db = Awaited<ReturnType<typeof createTestSchema>>;
let db: Db;

before(async () => {
  db = await createTestSchema();
});

after(async () => {
  await db.drop();
});

function memoryLogger() {
  const lines: Array<{ level: string; fields: object; msg: string }> = [];
  return {
    lines,
    info: (fields: object, msg: string) => lines.push({ level: 'info', fields, msg }),
    warn: (fields: object, msg: string) => lines.push({ level: 'warn', fields, msg }),
  };
}

async function tables(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

test('assertMigrationOrder: rechaza ids repetidos o fuera de orden', () => {
  assert.doesNotThrow(() => assertMigrationOrder(MIGRATIONS));
  assert.doesNotThrow(() => assertMigrationOrder([]));
  assert.throws(() => assertMigrationOrder([{ id: '002_b', sql: '' }, { id: '001_a', sql: '' }]), /fuera de orden/);
  assert.throws(() => assertMigrationOrder([{ id: '001_a', sql: '' }, { id: '001_a', sql: '' }]), /repetidas/);
});

test('runMigrations: aplica las del servicio una sola vez', async () => {
  const logger = memoryLogger();
  const first = await runMigrations(db.pool, MIGRATIONS, logger);
  assert.deepStrictEqual(first, MIGRATIONS.map((m) => m.id));
  assert.deepStrictEqual(await tables(), [
    'audit_logs',
    'incidents',
    'notification_preferences',
    'notifications',
    'schema_migrations',
  ]);
  assert.strictEqual(logger.lines.filter((l) => l.msg === 'migración aplicada').length, MIGRATIONS.length);

  const second = await runMigrations(db.pool, MIGRATIONS);
  assert.deepStrictEqual(second, []);
});

test('runMigrations: una que falla hace rollback completo y corta', async () => {
  const broken: Migration[] = [
    ...MIGRATIONS,
    { id: '900_partial', sql: 'CREATE TABLE should_not_exist (id int); SELECT * FROM missing_table;' },
  ];
  await assert.rejects(runMigrations(db.pool, broken), (err: unknown) => {
    assert.ok(err instanceof MigrationError);
    assert.strictEqual(err.migrationId, '900_partial');
    assert.ok(err.cause);
    return true;
  });
  assert.ok(!(await tables()).includes('should_not_exist'));
  const { rows } = await db.pool.query(`SELECT id FROM schema_migrations WHERE id = '900_partial'`);
  assert.strictEqual(rows.length, 0);
  // El lock quedó liberado: otra corrida no se cuelga.
  assert.deepStrictEqual(await runMigrations(db.pool, MIGRATIONS), []);
});

test('runMigrations: ids aplicados que el código no conoce solo se avisan (rollback de imagen)', async () => {
  await runMigrations(db.pool, [...MIGRATIONS, { id: '901_future', sql: 'SELECT 1' }]);
  const logger = memoryLogger();
  assert.deepStrictEqual(await runMigrations(db.pool, MIGRATIONS, logger), []);
  const warning = logger.lines.find((l) => l.level === 'warn');
  assert.deepStrictEqual(warning?.fields, { unknown: ['901_future'] });
});

test('buildApp({ migrate: true }) migra antes de quedar lista', async () => {
  const fresh = await createTestSchema();
  const app = buildApp({ databaseUrl: fresh.url, env: {}, migrate: true, logger: false });
  await app.ready();
  const { rows } = await fresh.pool.query(`SELECT id FROM schema_migrations`);
  assert.strictEqual(rows.length, MIGRATIONS.length);
  await app.close();
  await fresh.drop();
});

test('buildApp({ migrate: true }) sin base: ready() rechaza', async () => {
  const app = buildApp({
    databaseUrl: 'postgresql://postgres:password@127.0.0.1:1/notification_db',
    env: {},
    migrate: true,
    logger: false,
  });
  await assert.rejects(app.ready());
  await app.close().catch(() => undefined);
});
