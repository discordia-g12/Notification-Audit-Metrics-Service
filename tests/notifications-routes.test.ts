import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { FastifyInstance } from 'fastify';
import buildApp from '../src/app';
import { insertNotifications } from '../src/modules/notifications/repository';
import type { NewNotification } from '../src/modules/notifications/types';
import { createMigratedSchema } from './db-helpers';

type Db = Awaited<ReturnType<typeof createMigratedSchema>>;
let db: Db;
let app: FastifyInstance;

const idle = { start: () => {}, stop: async () => {}, snapshot: () => ({ status: 'unknown', checkedAt: null, services: [] }) };

before(async () => {
  db = await createMigratedSchema();
  app = buildApp({
    databaseUrl: db.url,
    env: {},
    statusMonitor: idle as never,
    disableAuditConsumer: true,
    disableNotificationConsumer: true,
    logger: false,
  });
  await app.ready();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE notifications, notification_preferences');
});

after(async () => {
  await app.close();
  await db.drop();
});

const as = (userId?: string) => (userId ? { 'x-user-id': userId } : {});

const seed = (userId: string, count: number) =>
  insertNotifications(
    db.pool,
    Array.from(
      { length: count },
      (_, i): NewNotification => ({
        userId,
        reason: 'thread_reply',
        serverId: 'srv',
        channelId: 'chan',
        threadId: 'thr',
        messageId: `m${i}`,
        actorId: 'bob',
        preview: `respuesta ${i}`,
        eventId: `e${i}`,
        createdAt: new Date(Date.UTC(2026, 10, 23, 10, 0, i)),
      }),
    ),
  );

describe('GET /api/v1/notifications', () => {
  it('401 sin X-User-Id, en problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    assert.strictEqual(res.statusCode, 401);
    assert.match(String(res.headers['content-type']), /application\/problem\+json/);
  });

  it('devuelve solo la bandeja propia, sin userId, paginada, sin cache', async () => {
    await seed('alice', 3);
    await seed('otro', 2);

    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=2', headers: as('alice') });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    const body = res.json();
    assert.strictEqual(body.unreadCount, 3);
    assert.deepStrictEqual(body.items.map((n: { messageId: string }) => n.messageId), ['m2', 'm1']);
    assert.strictEqual(body.items[0].userId, undefined);
    assert.deepStrictEqual(Object.keys(body.items[0]).sort(), [
      'actorId',
      'channelId',
      'createdAt',
      'id',
      'messageId',
      'preview',
      'readAt',
      'reason',
      'serverId',
      'threadId',
    ]);

    const next = await app.inject({
      method: 'GET',
      url: `/api/v1/notifications?limit=2&before=${body.nextCursor}`,
      headers: as('alice'),
    });
    assert.deepStrictEqual(next.json().items.map((n: { messageId: string }) => n.messageId), ['m0']);
  });

  it('historial vacío: items vacío y contador en 0', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: as('alice') })).json();
    assert.deepStrictEqual(body, { items: [], unreadCount: 0, nextCursor: null });
  });

  it('400 con limit, before o parámetros inválidos', async () => {
    for (const query of ['limit=0', 'limit=51', 'before=abc', 'unread=quizas']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/notifications?${query}`, headers: as('alice') });
      assert.strictEqual(res.statusCode, 400, query);
      assert.ok(Array.isArray(res.json().errors), query);
    }
  });
});

describe('marcar leídas', () => {
  it('POST /:id/read: 204 la propia, 404 la de otro o inexistente', async () => {
    const [mine] = await seed('alice', 1);
    const [theirs] = await seed('otro', 1);

    const read = (id: string) =>
      app.inject({ method: 'POST', url: `/api/v1/notifications/${id}/read`, headers: as('alice') });
    assert.strictEqual((await read(mine.id)).statusCode, 204);
    assert.strictEqual((await read(theirs.id)).statusCode, 404);
    assert.strictEqual((await read('no-es-uuid')).statusCode, 400);

    const unread = (await app.inject({ method: 'GET', url: '/api/v1/notifications?unread=true', headers: as('alice') })).json();
    assert.strictEqual(unread.unreadCount, 0);
  });

  it('POST /read-all: 204 y solo las propias', async () => {
    await seed('alice', 2);
    await seed('otro', 1);
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: as('alice') });
    assert.strictEqual(res.statusCode, 204);
    const { rows } = await db.pool.query(`SELECT user_id FROM notifications WHERE read_at IS NULL`);
    assert.deepStrictEqual(rows.map((r) => r.user_id), ['otro']);
  });
});

describe('preferencias', () => {
  const put = (scope: string, payload: unknown, userId = 'alice') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/notifications/preferences/${scope}`,
      headers: as(userId),
      payload: payload as object,
    });

  it('PUT crea y modifica solo lo que llega; GET lista las propias; DELETE vuelve al default', async () => {
    const created = await put('thread/abc123', { muted: true, serverId: 'srv' });
    assert.strictEqual(created.statusCode, 200);
    assert.deepStrictEqual(
      { ...created.json(), updatedAt: undefined },
      { scopeType: 'thread', scopeId: 'abc123', serverId: 'srv', level: null, muted: true, mutedUntil: null, updatedAt: undefined },
    );

    const leveled = (await put('thread/abc123', { level: 'all' })).json();
    assert.strictEqual(leveled.level, 'all');
    assert.strictEqual(leveled.muted, true);

    await put('server/srv', { level: 'mentions' });
    await put('server/srv', { level: 'none' }, 'otro');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/notifications/preferences', headers: as('alice') })).json();
    assert.deepStrictEqual(list.items.map((p: { scopeType: string }) => p.scopeType).sort(), ['server', 'thread']);

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications/preferences/thread/abc123',
      headers: as('alice'),
    });
    assert.strictEqual(del.statusCode, 204);
    const after = (await app.inject({ method: 'GET', url: '/api/v1/notifications/preferences', headers: as('alice') })).json();
    assert.deepStrictEqual(after.items.map((p: { scopeType: string }) => p.scopeType), ['server']);
  });

  it('acepta mutedUntil como fecha ISO y null para sacarlo', async () => {
    const timed = (await put('channel/dm-123', { muted: true, mutedUntil: '2026-12-01T00:00:00.000Z' })).json();
    assert.strictEqual(timed.mutedUntil, '2026-12-01T00:00:00.000Z');
    assert.strictEqual((await put('channel/dm-123', { mutedUntil: null })).json().mutedUntil, null);
  });

  it('400 con alcance, id o body inválidos', async () => {
    const invalid: [string, unknown][] = [
      ['user/abc', { muted: true }],
      ['thread/con espacio', { muted: true }],
      ['thread/abc', {}],
      ['thread/abc', { level: 'casi' }],
      ['thread/abc', { muted: 'si' }],
      ['thread/abc', { mutedUntil: 'mañana' }],
      ['thread/abc', { otra: 1 }],
    ];
    for (const [scope, body] of invalid) {
      assert.strictEqual((await put(scope, body)).statusCode, 400, `${scope} ${JSON.stringify(body)}`);
    }
  });
});
