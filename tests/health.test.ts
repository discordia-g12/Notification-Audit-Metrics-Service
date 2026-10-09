import { test } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

test('GET /livez returns alive', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/livez' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'alive' });
  await app.close();
});

test('GET /readyz returns ready when Postgres is reachable', async () => {
  const app = buildApp({ databaseUrl: process.env.DATABASE_URL });
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'ready' });
  await app.close();
});

test('GET /readyz returns 503 when Postgres is unreachable', async () => {
  const app = buildApp({
    databaseUrl: 'postgresql://postgres:password@127.0.0.1:1/notification_db',
  });

  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.json().status, 'not_ready');

  await app.close();
});

test('buildApp falls back to default database URL when not provided', async () => {
  const app = buildApp();
  await app.close();
});
