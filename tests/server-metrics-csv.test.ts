import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import buildApp from '../src/app';
import {
  parseExportFormat,
  serverMetricsCsvFilename,
  serverMetricsToCsv,
} from '../src/modules/metrics/serverMetricsCsv';
import type { ServerActivityMetrics } from '../src/modules/metrics/serverMetrics';

/** Exportación de métricas del servidor a CSV (`?format=csv`, ADR-06). */

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-admin-1';
const FROM = '2026-11-10T00:00:00.000Z';
const TO = '2026-11-13T00:00:00.000Z';

const ENV = {
  NODE_ENV: 'test',
  CHAT_ENGINE_URL: 'http://chat.test',
  CORE_SERVICE_URL: 'http://core.test',
};

const poolStub = {
  query: async () => ({ rows: [] }),
  on: () => {},
  end: async () => {},
} as unknown as Pool;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface FetchOptions {
  /** Bits de permiso del usuario en el servidor (default MANAGE_SERVER). */
  permissions?: number;
  chatDown?: boolean;
}

/** Core y Chat simulados: 3 días de período, con actividad el 10 y el 11 y altas el 10 y el 12. */
function buildFetch({ permissions = 1 << 3, chatDown = false }: FetchOptions = {}) {
  const counters = { chat: 0 };
  const metricsFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/permissions')) {
      return json({ is_owner: false, permissions_bitmask: permissions });
    }
    if (url.includes(`/internal/metrics/servers/${SERVER_ID}`)) {
      return json({
        channelIds: ['ch-1'],
        newMembers: 5,
        dailyNewMembers: [
          { date: '2026-11-10', count: 2 },
          { date: '2026-11-12', count: 3 },
        ],
      });
    }
    if (url === 'http://chat.test/internal/metrics/messages' && init?.method === 'POST') {
      counters.chat++;
      if (chatDown) return json({ detail: 'down' }, 503);
      return json({
        messages: 42,
        activeUsers: 11,
        daily: [
          { date: '2026-11-10', messages: 15, activeUsers: 6 },
          { date: '2026-11-11', messages: 27, activeUsers: 9 },
        ],
      });
    }
    return json({ detail: 'unexpected call' }, 500);
  };
  return { metricsFetch, counters };
}

function appWith(metricsFetch: typeof fetch) {
  return buildApp({ pool: poolStub, disableAuditConsumer: true, logger: false, env: ENV, metricsFetch });
}

const exportUrl = (query = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&format=csv`) =>
  `/api/v1/servers/${SERVER_ID}/metrics?${query}`;

describe('Exportación de métricas a CSV (GET /api/v1/servers/:serverId/metrics?format=csv)', () => {
  it('CA 1: un administrador recibe un CSV descargable con una fila por día del período', async () => {
    const { metricsFetch } = buildFetch();
    const app = appWith(metricsFetch);

    const res = await app.inject({ method: 'GET', url: exportUrl(), headers: { 'x-user-id': USER_ID } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.equal(
      res.headers['content-disposition'],
      `attachment; filename="metricas-servidor-${SERVER_ID}-2026-11-10_2026-11-12.csv"`,
    );
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(
      res.body,
      'fecha,miembros_activos,mensajes_enviados,nuevos_miembros\r\n' +
        '2026-11-10,6,15,2\r\n' +
        '2026-11-11,9,27,0\r\n' +
        '2026-11-12,0,0,3\r\n',
    );

    await app.close();
  });

  it('acepta ?days= y reutiliza la caché del JSON para el mismo período', async () => {
    const { metricsFetch, counters } = buildFetch();
    const app = appWith(metricsFetch);
    const range = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

    const jsonRes = await app.inject({ method: 'GET', url: exportUrl(range), headers: { 'x-user-id': USER_ID } });
    assert.equal(jsonRes.statusCode, 200);
    const csvRes = await app.inject({ method: 'GET', url: exportUrl(), headers: { 'x-user-id': USER_ID } });
    assert.equal(csvRes.statusCode, 200);
    assert.equal(counters.chat, 1);

    const daysRes = await app.inject({ method: 'GET', url: exportUrl('days=7&format=csv'), headers: { 'x-user-id': USER_ID } });
    assert.equal(daysRes.statusCode, 200);
    // Encabezado + una fila por cada día que toca el período de 7 días (8 días calendario si no empieza a las 00:00)
    assert.ok(daysRes.body.trim().split('\r\n').length >= 8);

    await app.close();
  });

  it('format=json o sin format devuelve el JSON de siempre', async () => {
    const { metricsFetch } = buildFetch();
    const app = appWith(metricsFetch);

    const res = await app.inject({
      method: 'GET',
      url: exportUrl(`from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&format=json`),
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.json().serverId, SERVER_ID);

    await app.close();
  });

  it('403 a un miembro sin permisos de administración: no hay archivo', async () => {
    const { metricsFetch, counters } = buildFetch({ permissions: 1 << 10 }); // SEND_MESSAGES, sin admin
    const app = appWith(metricsFetch);

    const res = await app.inject({ method: 'GET', url: exportUrl(), headers: { 'x-user-id': USER_ID } });

    assert.equal(res.statusCode, 403);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    assert.equal(counters.chat, 0);

    await app.close();
  });

  it('401 sin X-User-Id', async () => {
    const { metricsFetch } = buildFetch();
    const app = appWith(metricsFetch);

    const res = await app.inject({ method: 'GET', url: exportUrl() });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('400 con un formato desconocido, junto con los errores del período', async () => {
    const { metricsFetch } = buildFetch();
    const app = appWith(metricsFetch);

    const res = await app.inject({
      method: 'GET',
      url: exportUrl('from=not-a-date&format=xlsx'),
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(res.statusCode, 400);
    const fields = res.json().errors.map((e: { field: string }) => e.field);
    assert.deepEqual(fields.sort(), ['format', 'from']);

    await app.close();
  });

  it('503 si alguna fuente no respondió: no exporta un archivo con columnas vacías', async () => {
    const { metricsFetch } = buildFetch({ chatDown: true });
    const app = appWith(metricsFetch);

    const res = await app.inject({ method: 'GET', url: exportUrl(), headers: { 'x-user-id': USER_ID } });

    assert.equal(res.statusCode, 503);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    assert.match(res.json().detail, /Probá exportar de nuevo/);

    await app.close();
  });
});

describe('serverMetricsCsv', () => {
  const metrics: ServerActivityMetrics = {
    serverId: SERVER_ID,
    from: FROM,
    to: TO,
    activeMembers: 1,
    messagesSent: null,
    newMembers: 0,
    hasActivity: true,
    partial: true,
    series: [{ date: '2026-11-10', activeMembers: 1, messagesSent: null, newMembers: 0 }],
  };

  it('deja vacía la celda de una métrica sin dato', () => {
    assert.equal(
      serverMetricsToCsv(metrics),
      'fecha,miembros_activos,mensajes_enviados,nuevos_miembros\r\n2026-11-10,1,,0\r\n',
    );
  });

  it('sin días en la serie, solo el encabezado y el nombre con las fechas del período', () => {
    const empty = { ...metrics, series: [] };
    assert.equal(serverMetricsToCsv(empty), 'fecha,miembros_activos,mensajes_enviados,nuevos_miembros\r\n');
    assert.equal(serverMetricsCsvFilename(empty), `metricas-servidor-${SERVER_ID}-2026-11-10_2026-11-13.csv`);
  });

  it('parseExportFormat acepta json, csv o nada', () => {
    assert.deepEqual(parseExportFormat(undefined), { ok: true, format: 'json' });
    assert.deepEqual(parseExportFormat('json'), { ok: true, format: 'json' });
    assert.deepEqual(parseExportFormat('csv'), { ok: true, format: 'csv' });
    assert.equal(parseExportFormat(['csv', 'json']).ok, false);
    assert.equal(parseExportFormat('CSV').ok, false);
  });
});
