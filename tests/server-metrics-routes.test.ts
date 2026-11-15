import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import buildApp from '../src/app';
import { resolveServerMetricsRange } from '../src/modules/metrics/serverMetrics';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-admin-1';

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Server Activity Metrics (GET /api/v1/servers/:serverId/metrics)', () => {
  it('CA 1: administrador con MANAGE_SERVER ve métricas básicas y serie diaria para un período', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let chatCalls = 0;

    const metricsFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });

      if (url.includes(`/internal/servers/${SERVER_ID}/members/${USER_ID}/permissions`)) {
        return json({
          server_id: SERVER_ID,
          user_id: USER_ID,
          is_owner: false,
          can_moderate: true,
          permissions_bitmask: 1 << 3, // MANAGE_SERVER
        });
      }
      if (url.includes(`/internal/metrics/servers/${SERVER_ID}`)) {
        return json({
          serverId: SERVER_ID,
          from: '2026-11-10T00:00:00.000Z',
          to: '2026-11-13T00:00:00.000Z',
          channelIds: ['ch-1', 'ch-2'],
          newMembers: 5,
          dailyNewMembers: [
            { date: '2026-11-10', count: 2 },
            { date: '2026-11-12', count: 3 },
          ],
        });
      }
      if (url === 'http://chat.test/internal/metrics/messages' && method === 'POST') {
        chatCalls++;
        return json({
          from: '2026-11-10T00:00:00.000Z',
          to: '2026-11-13T00:00:00.000Z',
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

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const from = '2026-11-10T00:00:00.000Z';
    const to = '2026-11-13T00:00:00.000Z';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json(), {
      serverId: SERVER_ID,
      from,
      to,
      activeMembers: 11,
      messagesSent: 42,
      newMembers: 5,
      hasActivity: true,
      partial: false,
      series: [
        { date: '2026-11-10', activeMembers: 6, messagesSent: 15, newMembers: 2 },
        { date: '2026-11-11', activeMembers: 9, messagesSent: 27, newMembers: 0 },
        { date: '2026-11-12', activeMembers: 0, messagesSent: 0, newMembers: 3 },
      ],
    });

    const chatCall = calls.find((c) => c.url === 'http://chat.test/internal/metrics/messages');
    assert.deepEqual(chatCall?.body, { from, to, channelIds: ['ch-1', 'ch-2'] });

    // La segunda consulta con el mismo período reutiliza la caché sin volver a pegarle a Chat.
    const cachedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(cachedRes.statusCode, 200);
    assert.equal(chatCalls, 1);

    await app.close();
  });

  it('CA 1: soporta parámetro days y permiso ADMINISTRATOR o dueño', async () => {
    let seenCoreUrl = '';
    const metricsFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/permissions')) {
        return json({ is_owner: false, permissions_bitmask: 1 << 20 }); // ADMINISTRATOR
      }
      if (url.includes('/internal/metrics/servers/')) {
        seenCoreUrl = url;
        return json({
          serverId: SERVER_ID,
          channelIds: ['ch-1'],
          newMembers: 1,
          dailyNewMembers: [],
        });
      }
      return json({ messages: 3, activeUsers: 2, daily: [] });
    };

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics?days=7`,
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.activeMembers, 2);
    assert.equal(body.messagesSent, 3);
    assert.equal(body.newMembers, 1);
    assert.equal(body.hasActivity, true);
    const diffMs = Date.parse(body.to) - Date.parse(body.from);
    assert.equal(diffMs, 7 * 86_400_000);
    assert.ok(seenCoreUrl.includes('from=') && seenCoreUrl.includes('to='));

    const exactNow = new Date('2026-11-14T22:52:45.123Z');
    const ranged = resolveServerMetricsRange({ days: '7' }, exactNow);
    assert.equal(ranged.ok, true);
    if (ranged.ok) {
      assert.equal(ranged.range.to.toISOString(), '2026-11-14T22:52:45.123Z');
    }

    await app.close();
  });

  it('CA 2: indica hasActivity=false cuando el servidor no tuvo actividad en el período', async () => {
    let chatCalled = false;
    const metricsFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/permissions')) {
        return json({ is_owner: true, permissions_bitmask: 0 });
      }
      if (url.includes('/internal/metrics/servers/')) {
        return json({
          serverId: SERVER_ID,
          channelIds: [],
          newMembers: 0,
          dailyNewMembers: [],
        });
      }
      chatCalled = true;
      return json({ messages: 0, activeUsers: 0, daily: [] });
    };

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-03T00:00:00.000Z';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { 'x-user-id': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(chatCalled, false);
    assert.deepEqual(res.json(), {
      serverId: SERVER_ID,
      from,
      to,
      activeMembers: 0,
      messagesSent: 0,
      newMembers: 0,
      hasActivity: false,
      partial: false,
      series: [
        { date: '2026-11-01', activeMembers: 0, messagesSent: 0, newMembers: 0 },
        { date: '2026-11-02', activeMembers: 0, messagesSent: 0, newMembers: 0 },
      ],
    });

    await app.close();
  });

  it('CA 3: rechaza con 401 sin X-User-Id y 403 a miembros sin permisos de administración', async () => {
    const metricsFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/members/regular-user/permissions')) {
        return json({ is_owner: false, permissions_bitmask: 0 });
      }
      if (url.includes('/members/mod-only/permissions')) {
        // KICK/BAN/MUTE sin ADMINISTRATOR ni MANAGE_SERVER
        return json({ is_owner: false, can_moderate: true, permissions_bitmask: (1 << 10) | (1 << 11) | (1 << 12) });
      }
      if (url.includes('/members/outsider/permissions')) {
        return json({ detail: 'Forbidden' }, 403);
      }
      return json({}, 500);
    };

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const noAuth = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics`,
    });
    assert.equal(noAuth.statusCode, 401);
    assert.ok(String(noAuth.headers['content-type']).startsWith('application/problem+json'));

    for (const userId of ['regular-user', 'mod-only', 'outsider']) {
      const forbidden = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${SERVER_ID}/metrics`,
        headers: { 'x-user-id': userId },
      });
      assert.equal(forbidden.statusCode, 403, userId);
      assert.ok(String(forbidden.headers['content-type']).startsWith('application/problem+json'));
    }

    await app.close();
  });

  it('devuelve 400 para serverId o período inválidos, 404 si el servidor no existe y 503 si falla permisos', async () => {
    const metricsFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('22222222-2222-4222-8222-222222222222')) {
        return json({ detail: 'Not found' }, 404);
      }
      if (url.includes('33333333-3333-4333-8333-333333333333')) {
        return json({ detail: 'boom' }, 500);
      }
      return json({ is_owner: true, permissions_bitmask: 0 });
    };

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const badId = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/not-a-uuid/metrics',
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(badId.statusCode, 400);

    const badDays = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics?days=0`,
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(badDays.statusCode, 400);

    const notFound = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/22222222-2222-4222-8222-222222222222/metrics',
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(notFound.statusCode, 404);

    const upstreamErr = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/33333333-3333-4333-8333-333333333333/metrics',
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(upstreamErr.statusCode, 503);

    await app.close();
  });

  it('marca partial=true cuando Chat falla y no lo cachea para permitir recuperación', async () => {
    let chatAttempts = 0;
    const metricsFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/permissions')) {
        return json({ is_owner: true, permissions_bitmask: 0 });
      }
      if (url.includes('/internal/metrics/servers/')) {
        return json({
          serverId: SERVER_ID,
          channelIds: ['ch-1'],
          newMembers: 2,
          dailyNewMembers: [{ date: '2026-11-10', count: 2 }],
        });
      }
      chatAttempts++;
      if (chatAttempts === 1) {
        return json({ error: 'down' }, 500);
      }
      return json({ messages: 4, activeUsers: 2, daily: [{ date: '2026-11-10', messages: 4, activeUsers: 2 }] });
    };

    const app = buildApp({
      pool: poolStub,
      disableAuditConsumer: true,
      logger: false,
      env: ENV,
      metricsFetch,
    });

    const query = '?from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z';
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics${query}`,
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().partial, true);
    assert.equal(first.json().newMembers, 2);
    assert.equal(first.json().activeMembers, null);
    assert.equal(first.json().messagesSent, null);

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/metrics${query}`,
      headers: { 'x-user-id': USER_ID },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().partial, false);
    assert.equal(second.json().messagesSent, 4);

    await app.close();
  });
});
