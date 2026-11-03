import { test, after, before } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpProbe } from '../src/modules/status/http-probe';
import { classifyError, classifyHttpStatus } from '../src/modules/status/errors';
import { buildMonitoredServices, selfProbe } from '../src/modules/status/catalog';
import { TimeoutError, withTimeout } from '../src/utils/db-check';

const ALLOWED_ERRORS = new Set([
  null,
  'timeout',
  'connection_refused',
  'http_5xx',
  'http_4xx',
  'invalid_response',
]);

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}');
        break;
      case '/down':
        res.writeHead(503).end('{"status":"not_ready","detail":"password authentication failed"}');
        break;
      case '/missing':
        res.writeHead(404).end();
        break;
      case '/redirect':
        res.writeHead(302, { location: '/ok' }).end();
        break;
      case '/big':
        res.writeHead(200);
        res.write(Buffer.alloc(64 * 1024, 'a'));
        // Nunca termina: la sonda tiene que cortar por el límite de body, no por timeout.
        break;
      case '/slow':
        // No responde nunca: lo corta el timeout de la sonda.
        break;
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const opts = { timeoutMs: 300, tlsInsecure: false };

test('probe: 200 → sin error', async () => {
  assert.deepStrictEqual(await httpProbe(`${base}/ok`, opts), { httpStatus: 200, error: null });
});

test('probe: 503 → http_5xx, sin el body del upstream', async () => {
  const result = await httpProbe(`${base}/down`, opts);
  assert.deepStrictEqual(result, { httpStatus: 503, error: 'http_5xx' });
  assert.ok(!JSON.stringify(result).includes('password'));
});

test('probe: 404 → http_4xx', async () => {
  assert.deepStrictEqual(await httpProbe(`${base}/missing`, opts), { httpStatus: 404, error: 'http_4xx' });
});

test('probe: no sigue redirects', async () => {
  assert.deepStrictEqual(await httpProbe(`${base}/redirect`, opts), {
    httpStatus: 302,
    error: 'invalid_response',
  });
});

test('probe: corta bodies grandes sin esperar al timeout', async () => {
  const started = Date.now();
  const result = await httpProbe(`${base}/big`, { ...opts, timeoutMs: 5000, maxBodyBytes: 1024 });
  assert.deepStrictEqual(result, { httpStatus: 200, error: null });
  assert.ok(Date.now() - started < 2000);
});

test('probe: sin respuesta → timeout', async () => {
  assert.deepStrictEqual(await httpProbe(`${base}/slow`, { ...opts, timeoutMs: 100 }), {
    httpStatus: null,
    error: 'timeout',
  });
});

test('probe: puerto cerrado → connection_refused', async () => {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  assert.deepStrictEqual(await httpProbe(`http://127.0.0.1:${port}/readyz`, opts), {
    httpStatus: null,
    error: 'connection_refused',
  });
});

test('probe: TLS contra un servidor http → invalid_response (con y sin verificación)', async () => {
  const httpsBase = base.replace('http:', 'https:');
  for (const tlsInsecure of [false, true]) {
    const result = await httpProbe(`${httpsBase}/ok`, { timeoutMs: 1000, tlsInsecure });
    assert.deepStrictEqual(result, { httpStatus: null, error: 'invalid_response' });
  }
});

test('classifyError: solo códigos fijos, nunca el mensaje', () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error('connect ECONNREFUSED 10.0.1.10:443'), { code: 'ECONNREFUSED' }), 'connection_refused'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND kong'), { code: 'ENOTFOUND' }), 'connection_refused'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'connection_refused'],
    [Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }), 'connection_refused'],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'timeout'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    [new TimeoutError(10), 'timeout'],
    [Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'invalid_response'],
    [new Error('password authentication failed for user "postgres"'), 'invalid_response'],
    ['string', 'invalid_response'],
    [null, 'invalid_response'],
  ];
  for (const [err, expected] of cases) {
    const result = classifyError(err);
    assert.strictEqual(result, expected);
    assert.ok(ALLOWED_ERRORS.has(result));
  }
});

test('classifyHttpStatus', () => {
  assert.strictEqual(classifyHttpStatus(204), null);
  assert.strictEqual(classifyHttpStatus(500), 'http_5xx');
  assert.strictEqual(classifyHttpStatus(401), 'http_4xx');
  assert.strictEqual(classifyHttpStatus(101), 'invalid_response');
  assert.strictEqual(classifyHttpStatus(0), 'invalid_response');
});

test('selfProbe: 200 si el chequeo pasa; 503 con código saneado si falla', async () => {
  assert.deepStrictEqual(await selfProbe(async () => {})(), { httpStatus: 200, error: null });
  assert.deepStrictEqual(
    await selfProbe(async () => {
      throw new TimeoutError(2000);
    })(),
    { httpStatus: 503, error: 'timeout' },
  );
  assert.deepStrictEqual(
    await selfProbe(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    })(),
    { httpStatus: 503, error: 'connection_refused' },
  );
  const leaked = await selfProbe(async () => {
    throw new Error('password authentication failed for user "postgres"');
  })();
  assert.deepStrictEqual(leaked, { httpStatus: 503, error: 'http_5xx' });
});

test('withTimeout: resuelve antes del plazo y rechaza con TimeoutError después', async () => {
  assert.strictEqual(await withTimeout(Promise.resolve(1), 100), 1);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), TimeoutError);
});

test('buildMonitoredServices: catálogo fijo y URLs vía Kong', async () => {
  const calls: string[] = [];
  const services = buildMonitoredServices(
    { gatewayUrl: 'https://kong:8443', tlsInsecure: true, pollIntervalMs: 15000, probeTimeoutMs: 2000 },
    async () => {},
    async (url, options) => {
      calls.push(url);
      assert.deepStrictEqual(options, { timeoutMs: 2000, tlsInsecure: true });
      return { httpStatus: 200, error: null };
    },
  );
  assert.deepStrictEqual(
    services.map((s) => [s.id, s.name]),
    [
      ['gateway', 'API Gateway'],
      ['auth', 'Auth y usuarios'],
      ['server-roles', 'Servidores y roles'],
      ['chat', 'Chat'],
      ['voice', 'Voz'],
      ['notification', 'Notificaciones y auditoría'],
      ['payments', 'Pagos'],
    ],
  );
  await Promise.all(services.map((s) => s.probe?.()));
  assert.deepStrictEqual(calls.sort(), [
    'https://kong:8443/internal/readyz/auth',
    'https://kong:8443/internal/readyz/chat',
    'https://kong:8443/internal/readyz/payments',
    'https://kong:8443/internal/readyz/server-roles',
    'https://kong:8443/internal/readyz/voice',
    'https://kong:8443/readyz',
  ]);
});

test('buildMonitoredServices: sin STATUS_GATEWAY_URL solo queda la sonda propia', () => {
  const services = buildMonitoredServices(
    { gatewayUrl: null, tlsInsecure: false, pollIntervalMs: 15000, probeTimeoutMs: 2000 },
    async () => {},
  );
  assert.deepStrictEqual(
    services.filter((s) => s.probe !== null).map((s) => s.id),
    ['notification'],
  );
});
