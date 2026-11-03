import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import buildApp from '../src/app';
import type { ProbeResult } from '../src/modules/status/types';
import { allOk, DOWN, fakeMonitor, OK } from './status-helpers';

const UNREACHABLE_DB = 'postgresql://postgres:password@127.0.0.1:1/notification_db';

async function appWith(results: Map<string, ProbeResult | Error>) {
  const { monitor } = fakeMonitor(results);
  const app = buildApp({ databaseUrl: UNREACHABLE_DB, env: {}, statusMonitor: monitor, logger: false });
  await app.ready();
  await monitor.poll();
  return app;
}

test('GET /api/v1/status: forma pública exacta, sin campos de staff', async () => {
  const app = await appWith(allOk());
  const res = await app.inject({ method: 'GET', url: '/api/v1/status' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store');

  const body = res.json();
  assert.deepStrictEqual(Object.keys(body).sort(), ['checkedAt', 'services', 'status']);
  assert.strictEqual(body.status, 'operational');
  assert.strictEqual(body.checkedAt, '2026-11-03T12:00:00.035Z');
  assert.deepStrictEqual(body.services, [
    { id: 'gateway', name: 'API Gateway', status: 'operational' },
    { id: 'auth', name: 'Auth y usuarios', status: 'operational' },
    { id: 'server-roles', name: 'Servidores y roles', status: 'operational' },
    { id: 'chat', name: 'Chat', status: 'operational' },
    { id: 'voice', name: 'Voz', status: 'operational' },
    { id: 'notification', name: 'Notificaciones y auditoría', status: 'operational' },
    { id: 'payments', name: 'Pagos', status: 'operational' },
  ]);
  await app.close();
});

test('GET /api/v1/status: global degraded si alguno está degraded', async () => {
  const results = allOk();
  results.set('payments', DOWN);
  results.delete('voice');
  const app = await appWith(results);
  const body = (await app.inject({ method: 'GET', url: '/api/v1/status' })).json();
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.services.find((s: { id: string }) => s.id === 'payments').status, 'degraded');
  assert.strictEqual(body.services.find((s: { id: string }) => s.id === 'voice').status, 'unknown');
  for (const service of body.services) {
    assert.deepStrictEqual(Object.keys(service).sort(), ['id', 'name', 'status']);
  }
  await app.close();
});

test('GET /api/v1/status: global unknown si hay unknown y ninguno degraded', async () => {
  const app = await appWith(new Map([['notification', OK]]));
  const body = (await app.inject({ method: 'GET', url: '/api/v1/status' })).json();
  assert.strictEqual(body.status, 'unknown');
  await app.close();
});

test('GET /api/v1/status: antes de la primera ronda, unknown y checkedAt null', async () => {
  // Monitor que nunca arranca: lo que ve un cliente entre el listen y el fin de la primera ronda.
  const { monitor } = fakeMonitor(allOk());
  const idle = { start: () => {}, stop: async () => {}, snapshot: () => monitor.snapshot() };
  const app = buildApp({ databaseUrl: UNREACHABLE_DB, env: {}, statusMonitor: idle, logger: false });
  const body = (await app.inject({ method: 'GET', url: '/api/v1/status' })).json();
  assert.strictEqual(body.status, 'unknown');
  assert.strictEqual(body.checkedAt, null);
  await app.close();
});

const forbiddenRoles: Array<[string, Record<string, string>]> = [
  ['sin header', {}],
  ['rol user', { 'x-user-role': 'user' }],
  ['Staff con mayúscula', { 'x-user-role': 'Staff' }],
  ['staff con espacio', { 'x-user-role': 'staff ' }],
  ['vacío', { 'x-user-role': '' }],
];

for (const [label, headers] of forbiddenRoles) {
  test(`GET /api/v1/admin/status: 403 problem+json (${label})`, async () => {
    const app = await appWith(allOk());
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/status?x=1', headers });
    assert.strictEqual(res.statusCode, 403);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(res.json(), {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Forbidden: staff only',
      instance: '/api/v1/admin/status',
    });
    await app.close();
  });
}

test('GET /api/v1/admin/status: staff → 200 con todos los campos', async () => {
  const results = allOk();
  results.set('chat', { httpStatus: null, error: 'timeout' });
  const app = await appWith(results);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/status',
    headers: { 'x-user-role': 'staff' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store');

  const body = res.json();
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(typeof body.checkedAt, 'string');
  assert.strictEqual(body.services.length, 7);
  for (const service of body.services) {
    assert.deepStrictEqual(Object.keys(service).sort(), [
      'checkedAt',
      'error',
      'httpStatus',
      'id',
      'latencyMs',
      'name',
      'since',
      'status',
    ]);
  }
  const chat = body.services.find((s: { id: string }) => s.id === 'chat');
  assert.deepStrictEqual(
    { status: chat.status, httpStatus: chat.httpStatus, error: chat.error },
    { status: 'degraded', httpStatus: null, error: 'timeout' },
  );
  assert.strictEqual(chat.since, chat.checkedAt);
  const auth = body.services.find((s: { id: string }) => s.id === 'auth');
  assert.deepStrictEqual(
    { status: auth.status, httpStatus: auth.httpStatus, error: auth.error },
    { status: 'operational', httpStatus: 200, error: null },
  );
  assert.ok(Number.isInteger(auth.latencyMs) && auth.latencyMs >= 0);
  await app.close();
});

test('GET /api/v1/admin/status: header repetido → 403', async () => {
  const app = await appWith(allOk());
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/status',
    headers: { 'x-user-role': ['staff', 'staff'] },
  });
  assert.strictEqual(res.statusCode, 403);
  await app.close();
});

// Monitor real armado por buildApp contra un "Kong" falso: config, sondas http y sonda propia juntas.
test('buildApp: monitor real sondea Kong y se mide a sí mismo', async () => {
  const kong = http.createServer((req, res) => {
    res.writeHead(req.url === '/internal/readyz/chat' ? 503 : 200).end('{}');
  });
  await new Promise<void>((resolve) => kong.listen(0, '127.0.0.1', resolve));
  const { port } = kong.address() as AddressInfo;

  const app = buildApp({
    databaseUrl: UNREACHABLE_DB,
    env: { STATUS_GATEWAY_URL: `http://127.0.0.1:${port}`, STATUS_PROBE_TIMEOUT_MS: '1000' },
    logger: false,
  });
  await app.ready();

  let body = (await app.inject({ method: 'GET', url: '/api/v1/admin/status', headers: { 'x-user-role': 'staff' } })).json();
  for (let i = 0; i < 50 && body.checkedAt === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    body = (await app.inject({ method: 'GET', url: '/api/v1/admin/status', headers: { 'x-user-role': 'staff' } })).json();
  }
  const byId = Object.fromEntries(body.services.map((s: { id: string }) => [s.id, s]));
  assert.strictEqual(byId.gateway.status, 'operational');
  assert.strictEqual(byId.chat.error, 'http_5xx');
  // Postgres inalcanzable: notification degradado, sin el mensaje del driver.
  assert.strictEqual(byId.notification.status, 'degraded');
  assert.strictEqual(byId.notification.httpStatus, 503);
  assert.strictEqual(byId.notification.error, 'connection_refused');
  assert.strictEqual(body.status, 'degraded');

  await app.close();
  await new Promise<void>((resolve) => kong.close(() => resolve()));
});

test('buildApp: sin STATUS_GATEWAY_URL, con TLS inseguro o sin, arranca y cierra', async () => {
  for (const env of [{}, { STATUS_GATEWAY_URL: 'https://127.0.0.1:1', STATUS_TLS_INSECURE: 'true' }]) {
    const app = buildApp({ databaseUrl: UNREACHABLE_DB, env, logger: false });
    await app.ready();
    await app.close();
  }
});

test('buildApp: config inválida corta el arranque', () => {
  assert.throws(() => buildApp({ env: { STATUS_TLS_INSECURE: 'si' }, logger: false }));
});
