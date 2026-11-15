import { test } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';
import { ConfigError } from '../src/config/status';
import { loadMetricsConfig } from '../src/config/metrics';
import { MetricsCache, MetricsSources, type FetchFn, type PlatformMetrics } from '../src/modules/metrics';
import { parseIsoDate, resolveRange } from '../src/modules/metrics/range';
import { fakeMonitor } from './status-helpers';

const UNREACHABLE_DB = 'postgresql://postgres:password@127.0.0.1:1/notification_db';
const STAFF = { 'x-user-role': 'staff', 'x-user-id': 'auth0|staff' };
const ENV = { CHAT_ENGINE_URL: 'http://chat.test', CORE_SERVICE_URL: 'http://core.test/' };
const RANGE = 'from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z';

interface Call {
  url: URL;
  signal: AbortSignal | undefined;
}

type Handler = (url: URL, signal: AbortSignal | undefined) => Promise<Response>;

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

/** fetch falso: responde según el host (chat.test / core.test) y guarda cada llamada. */
function fakeFetch(handlers: { chat?: Handler; core?: Handler }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, signal: init?.signal ?? undefined });
    const handler = url.host === 'chat.test' ? handlers.chat : handlers.core;
    if (!handler) throw new TypeError('fetch failed');
    return handler(url, init?.signal ?? undefined);
  }) as FetchFn;
  return { fetchFn, calls };
}

const chatOk: Handler = (url) =>
  json({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), messages: 1200, activeUsers: 37 });
const coreOk: Handler = (url) =>
  json({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), serversCreated: 5 });

/** Nunca responde: rechaza recién cuando se aborta la señal (como fetch con AbortSignal.timeout). */
const hangs: Handler = (_url, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

async function appWith(handlers: { chat?: Handler; core?: Handler }, timeoutMs = 2000) {
  const { fetchFn, calls } = fakeFetch(handlers);
  const app = buildApp({
    databaseUrl: UNREACHABLE_DB,
    env: ENV,
    statusMonitor: fakeMonitor(new Map()).monitor,
    logger: false,
    metricsFetch: fetchFn,
    metricsTimeoutMs: timeoutMs,
  });
  await app.ready();
  return { app, calls };
}

const forbidden: Array<[string, Record<string, string>]> = [
  ['rol user', { 'x-user-role': 'user', 'x-user-id': 'auth0|u' }],
  ['sin rol', { 'x-user-id': 'auth0|u' }],
  ['Staff con mayúscula', { 'x-user-role': 'Staff', 'x-user-id': 'auth0|u' }],
];

for (const [label, headers] of forbidden) {
  test(`GET /api/v1/admin/metrics: 403 problem+json (${label})`, async () => {
    const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers });
    assert.strictEqual(res.statusCode, 403);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(res.json(), {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Forbidden: staff only',
      instance: '/api/v1/admin/metrics',
    });
    assert.strictEqual(calls.length, 0);
    await app.close();
  });
}

test('GET /api/v1/admin/metrics: sin X-User-Id → 401', async () => {
  const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/metrics', headers: { 'x-user-role': 'staff' } });
  assert.strictEqual(res.statusCode, 401);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  assert.strictEqual(res.json().title, 'Unauthorized');
  assert.strictEqual(calls.length, 0);
  await app.close();
});

test('GET /api/v1/admin/metrics: staff → 200 con los tres datos', async () => {
  const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
  const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.deepStrictEqual(res.json(), {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    activeUsers: 37,
    serversCreated: 5,
    messagesSent: 1200,
    partial: false,
  });

  const byHost = Object.fromEntries(calls.map((c) => [c.url.host, c.url]));
  assert.strictEqual(byHost['chat.test'].pathname, '/internal/metrics/messages');
  assert.strictEqual(byHost['core.test'].pathname, '/internal/metrics/servers');
  for (const url of Object.values(byHost)) {
    assert.strictEqual(url.searchParams.get('from'), '2026-10-01T00:00:00.000Z');
    assert.strictEqual(url.searchParams.get('to'), '2026-11-01T00:00:00.000Z');
  }
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal));
  await app.close();
});

test('GET /api/v1/admin/metrics: Chat caído → 200 parcial con null', async () => {
  const { app } = await appWith({ core: coreOk });
  const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.deepStrictEqual(
    { activeUsers: body.activeUsers, messagesSent: body.messagesSent, serversCreated: body.serversCreated, partial: body.partial },
    { activeUsers: null, messagesSent: null, serversCreated: 5, partial: true },
  );
  await app.close();
});

test('GET /api/v1/admin/metrics: Server-Roles con 5xx o body inválido → parcial', async () => {
  for (const core of [() => json({ error: 'x' }, 503), () => json({ serversCreated: -1 }), () => Promise.resolve(new Response('no json'))]) {
    const { app } = await appWith({ chat: chatOk, core });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF })).json();
    assert.strictEqual(body.serversCreated, null);
    assert.strictEqual(body.messagesSent, 1200);
    assert.strictEqual(body.partial, true);
    await app.close();
  }
});

test('GET /api/v1/admin/metrics: timeout → 200 parcial sin esperar de más', async () => {
  const { app } = await appWith({ chat: chatOk, core: hangs }, 50);
  const started = Date.now();
  const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(
    { serversCreated: res.json().serversCreated, activeUsers: res.json().activeUsers, partial: res.json().partial },
    { serversCreated: null, activeUsers: 37, partial: true },
  );
  await app.close();
});

test('GET /api/v1/admin/metrics: los dos caídos → 200 todo null', async () => {
  const { app } = await appWith({});
  const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    activeUsers: null,
    serversCreated: null,
    messagesSent: null,
    partial: true,
  });
  await app.close();
});

test('GET /api/v1/admin/metrics: sin parámetros → últimos 30 días', async () => {
  const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
  const before = Date.now();
  const body = (await app.inject({ method: 'GET', url: '/api/v1/admin/metrics', headers: STAFF })).json();
  const to = Date.parse(body.to);
  assert.ok(to <= before && before - to < 60_000);
  assert.strictEqual(to - Date.parse(body.from), 30 * 24 * 60 * 60 * 1000);
  assert.strictEqual(calls[0].url.searchParams.get('to'), body.to);
  await app.close();
});

test('GET /api/v1/admin/metrics: respuesta completa cacheada, parcial no', async () => {
  const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
  await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  // Mismo período escrito distinto: misma clave.
  await app.inject({
    method: 'GET',
    url: '/api/v1/admin/metrics?from=2026-10-01&to=2026-11-01T00:00:00.000Z',
    headers: STAFF,
  });
  assert.strictEqual(calls.length, 2);
  await app.close();

  const partial = await appWith({ chat: chatOk });
  await partial.app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  await partial.app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${RANGE}`, headers: STAFF });
  assert.strictEqual(partial.calls.length, 4);
  await partial.app.close();
});

const invalid: Array<[string, string, string]> = [
  ['from no es fecha', 'from=ayer', 'from'],
  ['to no ISO', 'to=2026', 'to'],
  ['día inexistente', 'from=2026-02-30', 'from'],
  ['from igual a to', 'from=2026-10-01&to=2026-10-01', 'from'],
  ['from después de to', 'from=2026-11-01&to=2026-10-01', 'from'],
  ['más de 366 días', 'from=2025-01-01&to=2026-01-03', 'to'],
  ['parámetro repetido', 'from=2026-10-01&from=2026-10-02', 'from'],
];

for (const [label, query, field] of invalid) {
  test(`GET /api/v1/admin/metrics: 400 (${label})`, async () => {
    const { app, calls } = await appWith({ chat: chatOk, core: coreOk });
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/metrics?${query}`, headers: STAFF });
    assert.strictEqual(res.statusCode, 400);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    const body = res.json();
    assert.strictEqual(body.title, 'Bad Request');
    assert.strictEqual(body.instance, '/api/v1/admin/metrics');
    assert.strictEqual(body.errors[0].field, field);
    assert.strictEqual(calls.length, 0);
    await app.close();
  });
}

test('resolveRange: 366 días justos pasa; solo from → to = ahora al minuto', () => {
  const ok = resolveRange({ from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, new Date());
  assert.strictEqual(ok.ok, true);

  const now = new Date('2026-11-11T10:20:30.400Z');
  const only = resolveRange({ from: '2026-11-01T00:00:00Z' }, now);
  assert.ok(only.ok);
  assert.strictEqual(only.range.to.toISOString(), '2026-11-11T10:20:00.000Z');

  const onlyTo = resolveRange({ to: '2026-11-01T00:00:00Z' }, now);
  assert.ok(onlyTo.ok);
  assert.strictEqual(onlyTo.range.from.toISOString(), '2026-10-02T00:00:00.000Z');
});

test('parseIsoDate: formatos aceptados y rechazados', () => {
  assert.strictEqual(parseIsoDate('2026-11-01T03:00:00-03:00')?.toISOString(), '2026-11-01T06:00:00.000Z');
  assert.strictEqual(parseIsoDate('2026-11-01T00:00:00.123Z')?.toISOString(), '2026-11-01T00:00:00.123Z');
  for (const bad of ['2026-11-01 00:00', '2026-13-01', '2026-11-01T25:00Z', 'x'.repeat(40), '+2026-11-01']) {
    assert.strictEqual(parseIsoDate(bad), null, bad);
  }
});

test('MetricsSources.collect: loguea warn por fuente caída, con motivo saneado', async () => {
  const { fetchFn } = fakeFetch({ chat: () => json({}, 500), core: hangs });
  const sources = new MetricsSources({
    chatEngineUrl: 'http://chat.test',
    coreServiceUrl: 'http://core.test',
    timeoutMs: 20,
    fetchFn,
  });
  const warns: object[] = [];
  // AbortSignal.timeout usa un timer unref: sin un servidor escuchando, nada más mantiene vivo el event loop.
  const keepAlive = setInterval(() => {}, 1000);
  const result = await sources.collect(
    { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') },
    { warn: (fields) => warns.push(fields) },
  );
  clearInterval(keepAlive);
  assert.strictEqual(result.partial, true);
  assert.deepStrictEqual(warns, [
    { source: 'chat', reason: 'http_5xx' },
    { source: 'server-roles', reason: 'timeout' },
  ]);
});

test('MetricsCache: vence a los ttlMs y respeta el tope de entradas', () => {
  let now = 0;
  const cache = new MetricsCache({ ttlMs: 60_000, maxEntries: 2, now: () => now });
  const value = (n: number): PlatformMetrics => ({
    from: 'a',
    to: 'b',
    activeUsers: n,
    serversCreated: n,
    messagesSent: n,
    partial: false,
  });
  cache.set('a', value(1));
  cache.set('b', value(2));
  cache.set('c', value(3));
  assert.strictEqual(cache.get('a'), undefined);
  assert.strictEqual(cache.get('b')?.activeUsers, 2);
  now = 60_000;
  assert.strictEqual(cache.get('b'), undefined);
  cache.set('p', { ...value(4), partial: true });
  assert.strictEqual(cache.get('p'), undefined);
});

test('loadMetricsConfig: defaults, barra final y URLs inválidas', () => {
  assert.deepStrictEqual(loadMetricsConfig({ CHAT_ENGINE_URL: '' }), {
    chatEngineUrl: 'http://localhost:3000',
    coreServiceUrl: 'http://localhost:8002',
  });
  assert.strictEqual(loadMetricsConfig({ CORE_SERVICE_URL: 'http://10.0.1.10:8002/' }).coreServiceUrl, 'http://10.0.1.10:8002');
  for (const bad of ['no-url', 'ftp://x', 'http://u:p@x', 'http://x/?a=1']) {
    assert.throws(() => loadMetricsConfig({ CHAT_ENGINE_URL: bad }), ConfigError);
  }
});
