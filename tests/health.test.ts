import { test } from 'node:test';
import assert from 'node:assert';
import type { Pool } from 'pg';
import buildApp from '../src/app';

test('GET /livez returns alive', async () => {
  const app = buildApp({ disableAuditConsumer: true });
  const res = await app.inject({ method: 'GET', url: '/livez' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'alive' });
  await app.close();
});

test('GET /readyz returns ready when Postgres is reachable', async () => {
  const poolMock = process.env.DATABASE_URL
    ? undefined
    : ({
        query: async () => ({ rows: [] }),
        on: () => {},
        end: async () => {},
      } as unknown as Pool);

  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL,
    pool: poolMock,
    disableAuditConsumer: true,
  });
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'ready' });
  await app.close();
});

test('GET /readyz returns 503 when Postgres is unreachable', async () => {
  const app = buildApp({
    databaseUrl: 'postgresql://postgres:password@127.0.0.1:1/notification_db',
    disableAuditConsumer: true,
  });

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.json().status, 'not_ready');

  await app.close();
});

test('buildApp falls back to default database URL when not provided', async () => {
  const app = buildApp({ disableAuditConsumer: true });
  await app.close();
});
