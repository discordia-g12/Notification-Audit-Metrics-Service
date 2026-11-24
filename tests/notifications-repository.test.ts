import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { processMessageCreated } from '../src/modules/notifications/processor';
import {
  deleteForChannel,
  deleteForServer,
  deletePreference,
  findAllLevelUserIds,
  findPreferencesFor,
  insertNotifications,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  purgeOldNotifications,
  upsertPreference,
  UNREAD_COUNT_CAP,
} from '../src/modules/notifications/repository';
import { parseMessageCreated } from '../src/modules/notifications/rules';
import type { MessageCreatedEvent, NewNotification, Notification } from '../src/modules/notifications/types';
import { createMigratedSchema } from './db-helpers';

type Db = Awaited<ReturnType<typeof createMigratedSchema>>;
let db: Db;

before(async () => {
  db = await createMigratedSchema();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE notifications, notification_preferences');
});

after(async () => {
  await db.drop();
});

const item = (userId: string, change: Partial<NewNotification> = {}): NewNotification => ({
  userId,
  reason: 'thread_reply',
  serverId: 'srv',
  channelId: 'chan',
  threadId: 'thr',
  messageId: 'm1',
  actorId: 'bob',
  preview: 'hola',
  eventId: 'e1',
  createdAt: new Date('2026-11-23T10:00:00Z'),
  ...change,
});

function event(change: Partial<MessageCreatedEvent> = {}): MessageCreatedEvent {
  const parsed = parseMessageCreated({
    event_id: 'e1',
    server_id: 'srv',
    channel_id: 'chan',
    thread_id: 'thr',
    message_id: 'm1',
    author_id: 'bob',
    thread_participant_ids: ['alice', 'carol'],
    preview: 'respuesta',
  });
  return { ...(parsed as MessageCreatedEvent), ...change };
}

describe('insertNotifications', () => {
  it('inserta en lote y una entrega repetida no duplica ni devuelve las que ya estaban', async () => {
    const first = await insertNotifications(db.pool, [item('alice'), item('carol')]);
    assert.strictEqual(first.length, 2);
    assert.match(first[0].id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(first[0].readAt, null);

    const again = await insertNotifications(db.pool, [item('alice'), item('dave')]);
    assert.deepStrictEqual(
      again.map((n) => n.userId),
      ['dave'],
    );
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM notifications');
    assert.strictEqual(rows[0].n, 3);
  });

  it('acepta server_id y thread_id nulos (DM sin hilo)', async () => {
    const [created] = await insertNotifications(db.pool, [item('alice', { serverId: null, threadId: null, reason: 'dm' })]);
    assert.strictEqual(created.serverId, null);
    assert.strictEqual(created.threadId, null);
  });

  it('sin items no consulta', async () => {
    assert.deepStrictEqual(await insertNotifications(db.pool, []), []);
  });
});

describe('listNotifications, markRead, markAllRead', () => {
  async function seed(count: number, userId = 'alice') {
    const base = Date.UTC(2026, 10, 23, 10);
    return insertNotifications(
      db.pool,
      Array.from({ length: count }, (_, i) =>
        item(userId, { eventId: `e${i}`, messageId: `m${i}`, createdAt: new Date(base + i * 1000) }),
      ),
    );
  }

  it('de la más nueva a la más vieja, paginada con before, con el contador de no leídas', async () => {
    await seed(5);
    await seed(2, 'otro');

    const first = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 2 });
    assert.deepStrictEqual(first.items.map((n) => n.messageId), ['m4', 'm3']);
    assert.strictEqual(first.unreadCount, 5);
    assert.ok(first.nextCursor);

    const second = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 2, before: first.nextCursor! });
    assert.deepStrictEqual(second.items.map((n) => n.messageId), ['m2', 'm1']);

    const last = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 2, before: second.nextCursor! });
    assert.deepStrictEqual(last.items.map((n) => n.messageId), ['m0']);
    assert.strictEqual(last.nextCursor, null);
  });

  it('no se saltea avisos con la misma hora (keyset por created_at e id)', async () => {
    const same = new Date('2026-11-23T10:00:00Z');
    await insertNotifications(
      db.pool,
      Array.from({ length: 4 }, (_, i) => item('alice', { eventId: `e${i}`, createdAt: same })),
    );
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 1, before });
      seen.push(...page.items.map((n) => n.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    assert.strictEqual(new Set(seen).size, 4);
  });

  it('un cursor de otro usuario no devuelve nada', async () => {
    const [mine] = await seed(1);
    await seed(3, 'otro');
    const page = await listNotifications(db.pool, 'otro', { unreadOnly: false, limit: 10, before: mine.id });
    assert.deepStrictEqual(page.items, []);
  });

  it('markRead solo marca las propias; unread=true las saca; markAllRead marca el resto', async () => {
    const created = await seed(3);
    const [theirs] = await seed(1, 'otro');

    assert.strictEqual(await markRead(db.pool, 'alice', created[0].id), true);
    assert.strictEqual(await markRead(db.pool, 'alice', theirs.id), false);
    assert.strictEqual(await markRead(db.pool, 'alice', '00000000-0000-0000-0000-000000000000'), false);

    const unread = await listNotifications(db.pool, 'alice', { unreadOnly: true, limit: 10 });
    assert.strictEqual(unread.items.length, 2);
    assert.strictEqual(unread.unreadCount, 2);

    await markAllRead(db.pool, 'alice');
    assert.strictEqual((await listNotifications(db.pool, 'alice', { unreadOnly: true, limit: 10 })).unreadCount, 0);
    assert.strictEqual((await listNotifications(db.pool, 'otro', { unreadOnly: true, limit: 10 })).unreadCount, 1);
  });

  it('marcar leída dos veces conserva la primera hora', async () => {
    const [n] = await seed(1);
    await markRead(db.pool, 'alice', n.id);
    const first = (await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 1 })).items[0].readAt;
    await markRead(db.pool, 'alice', n.id);
    const second = (await listNotifications(db.pool, 'alice', { unreadOnly: false, limit: 1 })).items[0].readAt;
    assert.deepStrictEqual(first, second);
  });

  it('el contador tiene tope', async () => {
    await seed(UNREAD_COUNT_CAP + 5);
    assert.strictEqual((await listNotifications(db.pool, 'alice', { unreadOnly: true, limit: 1 })).unreadCount, UNREAD_COUNT_CAP);
  });
});

describe('preferencias', () => {
  it('upsert cambia solo lo que llega: silenciar no pisa el nivel y reactivar lo conserva', async () => {
    const created = await upsertPreference(db.pool, 'alice', 'channel', 'chan', { level: 'all', serverId: 'srv' });
    assert.strictEqual(created.level, 'all');
    assert.strictEqual(created.muted, false);
    assert.strictEqual(created.serverId, 'srv');

    const muted = await upsertPreference(db.pool, 'alice', 'channel', 'chan', { muted: true });
    assert.strictEqual(muted.level, 'all');
    assert.strictEqual(muted.muted, true);
    assert.strictEqual(muted.serverId, 'srv');

    const until = new Date('2026-12-01T00:00:00Z');
    const timed = await upsertPreference(db.pool, 'alice', 'channel', 'chan', { mutedUntil: until });
    assert.deepStrictEqual(timed.mutedUntil, until);

    const back = await upsertPreference(db.pool, 'alice', 'channel', 'chan', { muted: false, mutedUntil: null });
    assert.strictEqual(back.level, 'all');
    assert.strictEqual(back.muted, false);
    assert.strictEqual(back.mutedUntil, null);

    const inherit = await upsertPreference(db.pool, 'alice', 'channel', 'chan', { level: null });
    assert.strictEqual(inherit.level, null);
  });

  it('en un alcance server, el servidor es el propio scope', async () => {
    const pref = await upsertPreference(db.pool, 'alice', 'server', 'srv', { level: 'none' });
    assert.strictEqual(pref.serverId, 'srv');
  });

  it('findAllLevelUserIds: quienes pidieron all en el canal o el servidor, una vez cada uno', async () => {
    await upsertPreference(db.pool, 'alice', 'server', 'srv', { level: 'all' });
    await upsertPreference(db.pool, 'alice', 'channel', 'chan', { level: 'all', serverId: 'srv' });
    await upsertPreference(db.pool, 'carol', 'channel', 'chan', { level: 'mentions', serverId: 'srv' });
    await upsertPreference(db.pool, 'dave', 'thread', 'chan', { level: 'all', serverId: 'srv' });
    await upsertPreference(db.pool, 'erin', 'server', 'otro', { level: 'all' });

    assert.deepStrictEqual(await findAllLevelUserIds(db.pool, 'srv', 'chan'), ['alice']);
  });

  it('findPreferencesFor trae solo las de ese hilo, canal y servidor, de esos usuarios', async () => {
    await upsertPreference(db.pool, 'alice', 'thread', 'thr', { muted: true });
    await upsertPreference(db.pool, 'alice', 'server', 'srv', { level: 'none' });
    await upsertPreference(db.pool, 'alice', 'channel', 'otro-canal', { level: 'all' });
    await upsertPreference(db.pool, 'zoe', 'thread', 'thr', { muted: true });

    const prefs = await findPreferencesFor(db.pool, ['alice', 'carol'], { serverId: 'srv', channelId: 'chan', threadId: 'thr' });
    assert.deepStrictEqual(prefs.map((p) => `${p.userId}:${p.scopeType}`).sort(), ['alice:server', 'alice:thread']);
    assert.deepStrictEqual(await findPreferencesFor(db.pool, [], { serverId: null, channelId: 'c', threadId: null }), []);
  });

  it('listPreferences y deletePreference (volver al default)', async () => {
    await upsertPreference(db.pool, 'alice', 'thread', 'thr', { muted: true });
    await upsertPreference(db.pool, 'alice', 'server', 'srv', { level: 'mentions' });
    assert.strictEqual((await listPreferences(db.pool, 'alice')).length, 2);

    assert.strictEqual(await deletePreference(db.pool, 'alice', 'thread', 'thr'), true);
    assert.strictEqual(await deletePreference(db.pool, 'alice', 'thread', 'thr'), false);
    assert.deepStrictEqual((await listPreferences(db.pool, 'alice')).map((p) => p.scopeType), ['server']);
  });
});

describe('limpieza y retención', () => {
  it('channel.deleted borra los avisos y las preferencias del canal', async () => {
    await insertNotifications(db.pool, [item('alice'), item('alice', { eventId: 'e2', channelId: 'otro' })]);
    await upsertPreference(db.pool, 'alice', 'channel', 'chan', { muted: true });

    await deleteForChannel(db.pool, 'chan');

    const { rows } = await db.pool.query('SELECT channel_id FROM notifications');
    assert.deepStrictEqual(rows.map((r) => r.channel_id), ['otro']);
    assert.deepStrictEqual(await listPreferences(db.pool, 'alice'), []);
  });

  it('server.deleted borra todo lo del servidor: avisos y preferencias de servidor, canal e hilo', async () => {
    await insertNotifications(db.pool, [item('alice'), item('alice', { eventId: 'e2', serverId: null, channelId: 'dm-1' })]);
    await upsertPreference(db.pool, 'alice', 'server', 'srv', { level: 'none' });
    await upsertPreference(db.pool, 'alice', 'thread', 'thr', { muted: true, serverId: 'srv' });
    await upsertPreference(db.pool, 'alice', 'thread', 'dm-thr', { muted: true });

    await deleteForServer(db.pool, 'srv');

    const { rows } = await db.pool.query('SELECT channel_id FROM notifications');
    assert.deepStrictEqual(rows.map((r) => r.channel_id), ['dm-1']);
    assert.deepStrictEqual((await listPreferences(db.pool, 'alice')).map((p) => p.scopeId), ['dm-thr']);
  });

  it('borra leídas de más de 30 días y cualquiera de más de 90', async () => {
    await insertNotifications(db.pool, [
      item('alice', { eventId: 'reciente' }),
      item('alice', { eventId: 'leida-vieja' }),
      item('alice', { eventId: 'leida-nueva' }),
      item('alice', { eventId: 'muy-vieja', createdAt: new Date(Date.now() - 91 * 86_400_000) }),
    ]);
    await db.pool.query(`UPDATE notifications SET read_at = now() - interval '31 days' WHERE event_id = 'leida-vieja'`);
    await db.pool.query(`UPDATE notifications SET read_at = now() - interval '2 days' WHERE event_id = 'leida-nueva'`);

    assert.strictEqual(await purgeOldNotifications(db.pool), 2);
    const { rows } = await db.pool.query('SELECT event_id FROM notifications ORDER BY event_id');
    assert.deepStrictEqual(rows.map((r) => r.event_id), ['leida-nueva', 'reciente']);
  });
});

describe('processMessageCreated (CA5)', () => {
  const run = async (
    e: MessageCreatedEvent,
    members: string[] | Error = [],
    roles: Record<string, string[] | Error> = {},
    viewers: string[] | Error | null = null, // null: todos ven el canal
  ) => {
    const delivered: Notification[][] = [];
    const memberCalls: string[] = [];
    const roleCalls: string[] = [];
    const viewerCalls: string[][] = [];
    const created = await processMessageCreated(
      {
        pool: db.pool,
        deliver: (n) => delivered.push(n),
        memberIds: async (serverId) => {
          memberCalls.push(serverId);
          if (members instanceof Error) throw members;
          return members;
        },
        roleMemberIds: async (serverId, roleId) => {
          roleCalls.push(`${serverId}/${roleId}`);
          const ids = new Map(Object.entries(roles)).get(roleId) ?? [];
          if (ids instanceof Error) throw ids;
          return ids;
        },
        channelViewerIds: async (_channelId, ids) => {
          viewerCalls.push(ids);
          if (viewers instanceof Error) throw viewers;
          return viewers === null ? ids : ids.filter((id) => viewers.includes(id));
        },
        now: () => new Date('2026-11-23T12:00:00Z'),
      },
      e,
    );
    return { created, delivered, memberCalls, roleCalls, viewerCalls };
  };

  it('avisa a los participantes del hilo con el default, sin preferencias', async () => {
    const { created, delivered } = await run(event());
    assert.deepStrictEqual(created.map((n) => n.userId).sort(), ['alice', 'carol']);
    assert.strictEqual(created[0].reason, 'thread_reply');
    assert.strictEqual(created[0].actorId, 'bob');
    assert.strictEqual(created[0].preview, 'respuesta');
    assert.strictEqual(delivered.length, 1);
  });

  it('respeta preferencias: hilo silenciado, servidor en none, y un canal en all que pisa al servidor', async () => {
    await upsertPreference(db.pool, 'alice', 'thread', 'thr', { muted: true });
    await upsertPreference(db.pool, 'carol', 'server', 'srv', { level: 'none' });
    await upsertPreference(db.pool, 'dave', 'server', 'srv', { level: 'none' });
    await upsertPreference(db.pool, 'dave', 'channel', 'chan', { level: 'all' });

    const { created } = await run(event({ threadParticipantIds: ['alice', 'carol', 'dave'] }));
    assert.deepStrictEqual(created.map((n) => n.userId), ['dave']);
  });

  it('el mismo evento dos veces avisa una sola vez y no vuelve a repartir', async () => {
    await run(event());
    const { created, delivered } = await run(event());
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(delivered, []);
  });

  it('sin candidatos no toca la base', async () => {
    const { created } = await run(event({ threadParticipantIds: ['bob'] }));
    assert.deepStrictEqual(created, []);
  });

  it('DM: avisa a recipient_ids como dm, sin buscar nivel all ni llamar a Server-Roles', async () => {
    const dm = event({ serverId: null, channelId: 'dm-1', threadId: null, isDm: true, threadParticipantIds: [] });
    const { created, memberCalls } = await run({ ...dm, recipientIds: ['alice'] });
    assert.deepStrictEqual(
      created.map((n) => [n.userId, n.reason]),
      [['alice', 'dm']],
    );
    assert.deepStrictEqual(memberCalls, []);
  });

  it('canal privado: la mención directa solo avisa a quien ve el canal', async () => {
    const e = event({ threadId: null, threadParticipantIds: [], mentionUserIds: ['alice', 'zoe'] });
    const { created, viewerCalls } = await run(e, [], {}, ['alice']);
    assert.deepStrictEqual(created.map((n) => n.userId), ['alice']);
    assert.strictEqual(viewerCalls.length, 1);
    assert.deepStrictEqual((await run(e, [], {}, [])).created, []);
  });

  it('canal privado: @everyone solo avisa a los viewers (una llamada por evento)', async () => {
    const e = event({ threadId: null, threadParticipantIds: [], mentionEveryone: true });
    const { created, viewerCalls } = await run(e, ['alice', 'zoe', 'yan'], {}, ['zoe']);
    assert.deepStrictEqual(created.map((n) => n.userId), ['zoe']);
    assert.strictEqual(viewerCalls.length, 1);
  });

  it('DM: no pasa por el filtro de visibilidad', async () => {
    const dm = event({ serverId: null, channelId: 'dm-1', threadId: null, isDm: true, threadParticipantIds: [] });
    const { created, viewerCalls } = await run({ ...dm, recipientIds: ['alice'] }, [], {}, []);
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(viewerCalls, []);
  });

  it('Server-Roles caído al filtrar viewers → lanza (DLQ) y no guarda nada', async () => {
    await assert.rejects(run(event(), [], {}, new Error('timeout')), /timeout/);
    const { rows } = await db.pool.query('SELECT 1 FROM notifications');
    assert.strictEqual(rows.length, 0);
  });

  it('mención directa como mention, aunque también participe del hilo', async () => {
    const { created } = await run(event({ mentionUserIds: ['alice'] }));
    const byUser = Object.fromEntries(created.map((n) => [n.userId, n.reason]));
    assert.deepStrictEqual(byUser, { alice: 'mention', carol: 'thread_reply' });
  });

  it('@everyone: los miembros (menos el autor) como mention', async () => {
    const { created, memberCalls } = await run(event({ threadId: null, threadParticipantIds: [], mentionEveryone: true }), [
      'bob',
      'alice',
      'zoe',
    ]);
    assert.deepStrictEqual(memberCalls, ['srv']);
    assert.deepStrictEqual(created.map((n) => [n.userId, n.reason]).sort(), [
      ['alice', 'mention'],
      ['zoe', 'mention'],
    ]);
  });

  it('Server-Roles caído con @everyone → lanza (DLQ) y no guarda nada', async () => {
    const e = event({ mentionEveryone: true });
    await assert.rejects(run(e, new Error('timeout')), /timeout/);
    const { rows } = await db.pool.query('SELECT 1 FROM notifications');
    assert.strictEqual(rows.length, 0);
  });

  it('mención de rol: avisa a sus miembros como mention, sin pedir member-ids', async () => {
    const e = event({ threadId: null, threadParticipantIds: [], mentionRoleIds: ['mods', 'devs'] });
    const { created, memberCalls, roleCalls } = await run(e, [], { mods: ['alice', 'bob'], devs: ['alice', 'zoe'] });
    assert.deepStrictEqual(roleCalls.sort(), ['srv/devs', 'srv/mods']);
    assert.deepStrictEqual(memberCalls, []);
    assert.deepStrictEqual(created.map((n) => [n.userId, n.reason]).sort(), [
      ['alice', 'mention'],
      ['zoe', 'mention'],
    ]);
  });

  it('rol 404 (de otro servidor o borrado) → nadie; con @everyone no pide los roles', async () => {
    const noThread = { threadId: null, threadParticipantIds: [] };
    assert.deepStrictEqual((await run(event({ ...noThread, mentionRoleIds: ['otro'] }))).created, []);

    const { roleCalls } = await run(event({ ...noThread, mentionRoleIds: ['mods'], mentionEveryone: true }), ['alice']);
    assert.deepStrictEqual(roleCalls, []);
  });

  it('rol y nivel all: los del rol se cruzan con los miembros ya pedidos', async () => {
    await upsertPreference(db.pool, 'zoe', 'server', 'srv', { level: 'all' });
    const e = event({ threadId: null, threadParticipantIds: [], mentionRoleIds: ['mods'] });
    const { created } = await run(e, ['zoe', 'alice'], { mods: ['alice', 'ex'] });
    assert.deepStrictEqual(created.map((n) => [n.userId, n.reason]).sort(), [
      ['alice', 'mention'],
      ['zoe', 'message'],
    ]);
  });

  it('Server-Roles caído al pedir un rol → lanza (DLQ) y no guarda nada', async () => {
    const e = event({ mentionRoleIds: ['mods'] });
    await assert.rejects(run(e, [], { mods: new Error('timeout') }), /timeout/);
    const { rows } = await db.pool.query('SELECT 1 FROM notifications');
    assert.strictEqual(rows.length, 0);
  });

  it('nivel all: avisa como message a los miembros que lo pidieron en el canal o el servidor', async () => {
    await upsertPreference(db.pool, 'zoe', 'server', 'srv', { level: 'all' });
    await upsertPreference(db.pool, 'yan', 'channel', 'chan', { level: 'all', serverId: 'srv' });
    await upsertPreference(db.pool, 'ex', 'server', 'srv', { level: 'all' });
    await upsertPreference(db.pool, 'otro', 'channel', 'otro-canal', { level: 'all', serverId: 'srv' });

    const { created } = await run(event({ threadId: null, threadParticipantIds: [] }), ['zoe', 'yan', 'otro']);
    assert.deepStrictEqual(created.map((n) => [n.userId, n.reason]).sort(), [
      ['yan', 'message'],
      ['zoe', 'message'],
    ], 'ex ya no es miembro; otro pidió all en otro canal');
  });

  it('CA2 con nivel all: el canal en mentions o silenciado pisa al servidor en all', async () => {
    await upsertPreference(db.pool, 'zoe', 'server', 'srv', { level: 'all' });
    await upsertPreference(db.pool, 'zoe', 'channel', 'chan', { level: 'mentions', serverId: 'srv' });
    await upsertPreference(db.pool, 'yan', 'server', 'srv', { level: 'all' });
    await upsertPreference(db.pool, 'yan', 'channel', 'chan', { muted: true, serverId: 'srv' });

    const { created } = await run(event({ threadId: null, threadParticipantIds: [] }), ['zoe', 'yan']);
    assert.deepStrictEqual(created, []);
  });

  it('en un DM sin preferencias avisa (default all)', async () => {
    const { created } = await run(event({ serverId: null, channelId: 'dm-1', isDm: true, threadParticipantIds: ['alice'] }));
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].serverId, null);
  });
});
