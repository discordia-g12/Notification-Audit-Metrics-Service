import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Pool } from 'pg';
import buildApp from '../src/app';

describe('Audit Routes (GET /api/v1/servers/:serverId/audit-logs)', () => {
  let mockRows: unknown[] = [];

  const poolMock = {
    query: async () => ({
      rows: mockRows,
    }),
    on: () => {},
    end: async () => {},
  } as unknown as Pool;

  beforeEach(() => {
    mockRows = [];
  });

  it('rejects request without X-User-Id with 401 Unauthorized Problem+JSON', async () => {
    const app = buildApp({
      pool: poolMock,
      disableAuditConsumer: true,
      logger: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-1/audit-logs',
    });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json; charset=utf-8');
    const json = res.json();
    assert.strictEqual(json.status, 401);
    assert.strictEqual(json.title, 'Unauthorized');
    assert.strictEqual(json.detail, 'Missing X-User-Id header');

    await app.close();
  });

  it('rejects request when user does not have moderation permissions with 403 Forbidden', async () => {
    const app = buildApp({
      pool: poolMock,
      disableAuditConsumer: true,
      logger: false,
      checkModeratorAccess: async () => ({
        allowed: false,
        isOwner: false,
        canModerate: false,
        message: 'Forbidden: User does not have moderation permissions',
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-1/audit-logs',
      headers: {
        'x-user-id': 'user-regular',
      },
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json; charset=utf-8');
    const json = res.json();
    assert.strictEqual(json.status, 403);
    assert.strictEqual(json.title, 'Forbidden');

    await app.close();
  });

  it('returns 404 Not Found if server does not exist', async () => {
    const app = buildApp({
      pool: poolMock,
      disableAuditConsumer: true,
      logger: false,
      checkModeratorAccess: async () => ({
        allowed: false,
        notFound: true,
        message: 'Server not found',
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-not-found/audit-logs',
      headers: {
        'x-user-id': 'user-mod',
      },
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json().title, 'Not Found');

    await app.close();
  });

  it('returns 503 Service Unavailable if Server-Roles service is down', async () => {
    const app = buildApp({
      pool: poolMock,
      disableAuditConsumer: true,
      logger: false,
      checkModeratorAccess: async () => ({
        allowed: false,
        upstreamError: true,
        message: 'Upstream unavailable',
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-1/audit-logs',
      headers: {
        'x-user-id': 'user-mod',
      },
    });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().title, 'Service Unavailable');

    await app.close();
  });

  it('returns audit log page with 200 and cache-control no-store for authorized user', async () => {
    mockRows = [
      {
        id: 'log-1',
        event_id: 'evt-1',
        server_id: 'srv-1',
        category: 'members',
        action: 'MEMBER_BAN_ADD',
        actor_id: 'admin-1',
        target_id: 'user-banned',
        reason: 'Violation of rules',
        changes: {},
        metadata: {},
        created_at: new Date('2026-11-10T10:00:00Z'),
      },
    ];

    const app = buildApp({
      pool: poolMock,
      disableAuditConsumer: true,
      logger: false,
      checkModeratorAccess: async () => ({
        allowed: true,
        canModerate: true,
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-1/audit-logs?category=members&action=MEMBER_BAN_ADD&actor_id=admin-1&before=2026-11-10T11:00:00Z&limit=invalid',
      headers: {
        'x-user-id': ['admin-1'],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    const json = res.json();
    assert.strictEqual(json.serverId, 'srv-1');
    assert.strictEqual(json.items.length, 1);
    assert.strictEqual(json.items[0].id, 'log-1');
    assert.strictEqual(json.items[0].action, 'MEMBER_BAN_ADD');
    assert.strictEqual(json.hasMore, false);
    assert.strictEqual(json.nextCursor, null);

    await app.close();
  });
});
