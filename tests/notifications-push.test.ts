import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import buildApp from '../src/app';
import { processMessageCreated } from '../src/modules/notifications/processor';
import { EXPO_PUSH_URL, PushSender, toPushMessage, vapidFromEnv } from '../src/modules/notifications/push';
import { setPushEnabled, upsertDevice, MAX_DEVICES_PER_USER } from '../src/modules/notifications/push-repository';
import { listNotifications } from '../src/modules/notifications/repository';
import type { MessageCreatedEvent, Notification } from '../src/modules/notifications/types';
import { createMigratedSchema } from './db-helpers';

type Db = Awaited<ReturnType<typeof createMigratedSchema>>;
let db: Db;
let app: FastifyInstance;

const vapidKeys = webpush.generateVAPIDKeys();
const vapid = { ...vapidKeys, subject: 'mailto:ops@example.com' };
const idle = { start: () => {}, stop: async () => {}, snapshot: () => ({ status: 'unknown', checkedAt: null, services: [] }) };

before(async () => {
  db = await createMigratedSchema();
  app = buildApp({
    databaseUrl: db.url,
    env: { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: vapid.subject },
    statusMonitor: idle as never,
    disableAuditConsumer: true,
    disableNotificationConsumer: true,
    logger: false,
  });
  await app.ready();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE notifications, notification_preferences, push_devices, push_settings');
});

after(async () => {
  await app.close();
  await db.drop();
});

const expoToken = (i: number | string) => `ExponentPushToken[tok${i}]`;
const webEndpoint = (i: number | string) => `https://fcm.googleapis.com/fcm/send/sub${i}`;
const webKeys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

const notification = (userId: string, i = 0): Notification => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  userId,
  reason: 'mention',
  serverId: 'srv',
  channelId: 'chan',
  threadId: null,
  messageId: `m${i}`,
  actorId: 'bob',
  preview: 'hola @alice',
  createdAt: new Date(),
  readAt: null,
});

/** Fetch falso de Expo: guarda los lotes y responde un ticket por mensaje (`tickets` decide cuál). */
function fakeExpo(ticket: (to: string) => object = () => ({ status: 'ok', id: 'x' })) {
  const calls: { url: string; init: RequestInit; messages: { to: string }[] }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const messages = JSON.parse(String(init.body)) as { to: string }[];
    calls.push({ url, init, messages });
    return new Response(JSON.stringify({ data: messages.map((m) => ticket(m.to)) }), { status: 200 });
  };
  return { calls, fetchFn };
}

const tokens = async () =>
  (await db.pool.query<{ token: string }>('SELECT token FROM push_devices ORDER BY token')).rows.map((r) => r.token);

describe('PushSender', () => {
  it('manda a Expo en lotes de 100 con el payload de navegación y borra los DeviceNotRegistered', async () => {
    // 101 usuarios con un teléfono cada uno: dos lotes
    for (let i = 0; i < 101; i++) await upsertDevice(db.pool, { userId: `u${i}`, platform: 'android', token: expoToken(i), keys: null });
    const expo = fakeExpo((to) =>
      to === expoToken(7) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' },
    );
    const sender = new PushSender({ pool: db.pool, fetchFn: expo.fetchFn, expoAccessToken: 'secret' });

    const result = await sender.send(Array.from({ length: 101 }, (_, i) => notification(`u${i}`)));

    assert.deepStrictEqual(result, { sent: 100, failed: 1, removed: 1 });
    assert.deepStrictEqual(expo.calls.map((c) => c.messages.length), [100, 1]);
    assert.strictEqual(expo.calls[0].url, EXPO_PUSH_URL);
    assert.strictEqual((expo.calls[0].init.headers as Record<string, string>).authorization, 'Bearer secret');
    const first = expo.calls[0].messages[0] as unknown as Record<string, unknown>;
    assert.deepStrictEqual(first.data, {
      notificationId: '00000000-0000-4000-8000-000000000000',
      reason: 'mention',
      serverId: 'srv',
      channelId: 'chan',
      threadId: null,
      messageId: 'm0',
    });
    assert.strictEqual(first.body, 'hola @alice');
    assert.strictEqual(first.title, 'Te mencionaron');
    assert.ok(!(await tokens()).includes(expoToken(7)));
    assert.strictEqual((await tokens()).length, 100);
  });

  it('web: manda con web-push y borra las suscripciones 404/410; sin VAPID no manda web', async () => {
    await upsertDevice(db.pool, { userId: 'alice', platform: 'web', token: webEndpoint('a'), keys: webKeys });
    await upsertDevice(db.pool, { userId: 'alice', platform: 'web', token: webEndpoint('gone'), keys: webKeys });
    const sent: { endpoint: string; payload: string }[] = [];
    const webPushSend = async (sub: webpush.PushSubscription, payload: string) => {
      if (sub.endpoint === webEndpoint('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload });
    };

    const noVapid = await new PushSender({ pool: db.pool, webPushSend }).send([notification('alice')]);
    assert.deepStrictEqual(noVapid, { sent: 0, failed: 0, removed: 0 });

    const result = await new PushSender({ pool: db.pool, vapid, webPushSend }).send([notification('alice')]);
    assert.deepStrictEqual(result, { sent: 1, failed: 1, removed: 1 });
    assert.deepStrictEqual(JSON.parse(sent[0].payload), JSON.parse(JSON.stringify(toPushMessage(notification('alice')))));
    assert.deepStrictEqual(await tokens(), [webEndpoint('a')]);
  });

  it('Expo caído o la base caída: cuenta la falla y no lanza', async () => {
    await upsertDevice(db.pool, { userId: 'alice', platform: 'ios', token: expoToken('a'), keys: null });
    const down = new PushSender({ pool: db.pool, fetchFn: async () => Promise.reject(new Error('down')) });
    assert.deepStrictEqual(await down.send([notification('alice')]), { sent: 0, failed: 1, removed: 0 });
    const http500 = new PushSender({ pool: db.pool, fetchFn: async () => new Response('', { status: 500 }) });
    assert.deepStrictEqual(await http500.send([notification('alice')]), { sent: 0, failed: 1, removed: 0 });
    const brokenPool = { query: async () => Promise.reject(new Error('db down')) } as never;
    assert.strictEqual((await new PushSender({ pool: brokenPool }).send([notification('alice')])).failed, 1);
  });

  it('VAPID incompleto o inválido deja push web apagado', () => {
    assert.strictEqual(vapidFromEnv({ VAPID_PUBLIC_KEY: 'x' }), undefined);
    assert.strictEqual(new PushSender({ pool: db.pool, vapid: { ...vapid, subject: 'no-es-url' } }).webEnabled, false);
    assert.strictEqual(new PushSender({ pool: db.pool, vapid }).webEnabled, true);
  });

  it('un usuario no junta más de MAX_DEVICES_PER_USER dispositivos', async () => {
    for (let i = 0; i < MAX_DEVICES_PER_USER + 2; i++) {
      await upsertDevice(db.pool, { userId: 'alice', platform: 'ios', token: expoToken(i), keys: null });
    }
    assert.strictEqual((await tokens()).length, MAX_DEVICES_PER_USER);
  });
});

describe('CA2: push_enabled=false', () => {
  const dm = (eventId: string): MessageCreatedEvent => ({
    eventId,
    serverId: null,
    channelId: 'dm-1',
    threadId: null,
    messageId: `msg-${eventId}`,
    authorId: 'bob',
    threadParticipantIds: [],
    mentionUserIds: [],
    mentionRoleIds: [],
    mentionEveryone: false,
    recipientIds: ['alice'],
    isDm: true,
    preview: 'hola',
    createdAt: new Date(),
  });

  it('no sale push y la bandeja y el contador quedan igual que con push prendido', async () => {
    await upsertDevice(db.pool, { userId: 'alice', platform: 'ios', token: expoToken('a'), keys: null });
    const expo = fakeExpo();
    const sender = new PushSender({ pool: db.pool, fetchFn: expo.fetchFn });
    let pushing: Promise<unknown> = Promise.resolve();
    const deps = {
      pool: db.pool,
      deliver: (created: Notification[]) => {
        pushing = sender.send(created);
      },
      memberIds: async () => [],
      roleMemberIds: async () => [],
      channelViewerIds: async (_c, ids) => ids,
    };

    await processMessageCreated(deps, dm('e1'));
    await pushing;
    assert.strictEqual(expo.calls.length, 1);
    const withPush = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 20 });

    await db.pool.query('TRUNCATE notifications');
    await setPushEnabled(db.pool, 'alice', false);
    await processMessageCreated(deps, dm('e1'));
    await pushing;
    assert.strictEqual(expo.calls.length, 1, 'no sale otro push');
    const withoutPush = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 20 });

    assert.strictEqual(withoutPush.unreadCount, withPush.unreadCount);
    assert.deepStrictEqual(
      withoutPush.items.map((n) => [n.reason, n.messageId, n.readAt]),
      withPush.items.map((n) => [n.reason, n.messageId, n.readAt]),
    );
    assert.strictEqual(withoutPush.unreadCount, 1);
  });
});

describe('rutas de push', () => {
  const as = (userId: string) => ({ 'x-user-id': userId });
  const register = (userId: string, payload: object) =>
    app.inject({ method: 'POST', url: '/api/v1/notifications/push/devices', headers: as(userId), payload });

  it('401 sin X-User-Id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/push/settings' });
    assert.strictEqual(res.statusCode, 401);
  });

  it('registra mobile y web; el mismo token pasa al último usuario', async () => {
    assert.strictEqual((await register('alice', { platform: 'ios', token: expoToken('a') })).statusCode, 204);
    assert.strictEqual(
      (await register('alice', { platform: 'web', subscription: { endpoint: webEndpoint('a'), keys: webKeys, expirationTime: null } }))
        .statusCode,
      204,
    );
    assert.strictEqual((await register('bob', { platform: 'ios', token: expoToken('a') })).statusCode, 204);
    const { rows } = await db.pool.query('SELECT user_id, platform, token, keys FROM push_devices ORDER BY platform');
    assert.deepStrictEqual(rows, [
      { user_id: 'bob', platform: 'ios', token: expoToken('a'), keys: null },
      { user_id: 'alice', platform: 'web', token: webEndpoint('a'), keys: webKeys },
    ]);
  });

  it('400: token inválido, endpoint fuera de los servicios de push, plataforma y campos cruzados', async () => {
    const bad = [
      { platform: 'ios', token: 'no-es-expo' },
      { platform: 'web', subscription: { endpoint: 'https://169.254.169.254/latest', keys: webKeys } },
      { platform: 'web', subscription: { endpoint: 'https://fcm.googleapis.com.evil.com/x', keys: webKeys } },
      { platform: 'web', subscription: { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: webKeys } },
      { platform: 'web', token: expoToken('a') },
      { platform: 'android', subscription: { endpoint: webEndpoint('a'), keys: webKeys } },
      { platform: 'symbian', token: expoToken('a') },
    ];
    for (const payload of bad) {
      const res = await register('alice', payload);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepStrictEqual(await tokens(), []);
  });

  it('DELETE solo borra el dispositivo propio', async () => {
    await register('alice', { platform: 'android', token: expoToken('a') });
    const del = (userId: string) =>
      app.inject({ method: 'DELETE', url: '/api/v1/notifications/push/devices', headers: as(userId), payload: { token: expoToken('a') } });
    assert.strictEqual((await del('bob')).statusCode, 204);
    assert.deepStrictEqual(await tokens(), [expoToken('a')]);
    assert.strictEqual((await del('alice')).statusCode, 204);
    assert.deepStrictEqual(await tokens(), []);
  });

  it('GET/PUT settings: default true, se apaga solo para quien lo pide', async () => {
    const get = (userId: string) =>
      app.inject({ method: 'GET', url: '/api/v1/notifications/push/settings', headers: as(userId) }).then((r) => r.json());
    assert.deepStrictEqual(await get('alice'), { pushEnabled: true });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/push/settings',
      headers: as('alice'),
      payload: { pushEnabled: false },
    });
    assert.deepStrictEqual(put.json(), { pushEnabled: false });
    assert.deepStrictEqual(await get('alice'), { pushEnabled: false });
    assert.deepStrictEqual(await get('bob'), { pushEnabled: true });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/push/settings',
      headers: as('alice'),
      payload: { pushEnabled: 'no' },
    });
    assert.strictEqual(bad.statusCode, 400);
  });

  it('GET vapid-public-key devuelve la clave pública configurada', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/push/vapid-public-key', headers: as('alice') });
    assert.deepStrictEqual(res.json(), { publicKey: vapid.publicKey });
  });
});
