import { describe, it } from 'node:test';
import assert from 'node:assert';
import { candidates, parseMessageCreated, resolve, shouldNotify, type Scope } from '../src/modules/notifications/rules';
import type { Level, Preference, ScopeType } from '../src/modules/notifications/types';
import { InboxPublisher, INBOX_BATCH_SIZE } from '../src/modules/notifications/inbox';
import type { Notification } from '../src/modules/notifications/types';

const NOW = new Date('2026-11-23T12:00:00Z');
const SERVER: Scope = { serverId: 'srv', channelId: 'chan', threadId: 'thr' };
const DM: Scope = { serverId: null, channelId: 'dm-1', threadId: 'thr' };

function pref(scopeType: ScopeType, scopeId: string, change: Partial<Preference> = {}): Preference {
  return {
    userId: 'u1',
    scopeType,
    scopeId,
    serverId: null,
    level: null,
    muted: false,
    mutedUntil: null,
    updatedAt: NOW,
    ...change,
  };
}

const level = (l: Level) => ({ level: l });

describe('parseMessageCreated (frontera con RabbitMQ)', () => {
  const valid = {
    event_id: 'e1',
    server_id: 'srv',
    channel_id: 'chan',
    thread_id: 'thr',
    message_id: 'm1',
    author_id: 'bob',
    thread_participant_ids: ['alice', 'bob', 'alice', 7, ''],
    mention_user_ids: ['carol'],
    is_dm: false,
    preview: 'x'.repeat(300),
    created_at: '2026-11-23T10:00:00.000Z',
  };

  it('normaliza un evento válido: sin repetidos ni ids inválidos, preview recortado', () => {
    const event = parseMessageCreated(valid);
    assert.ok(event);
    assert.deepStrictEqual(event.threadParticipantIds, ['alice', 'bob']);
    assert.strictEqual(event.preview.length, 140);
    assert.strictEqual(event.createdAt.toISOString(), '2026-11-23T10:00:00.000Z');
    assert.strictEqual(event.isDm, false);
  });

  it('usa el messageId de AMQP si falta event_id, y null si faltan datos indispensables', () => {
    const noId = { ...valid, event_id: undefined };
    assert.strictEqual(parseMessageCreated(noId, 'amqp-1')?.eventId, 'amqp-1');
    assert.strictEqual(parseMessageCreated(noId), null);
    assert.strictEqual(parseMessageCreated({ ...valid, channel_id: 5 }), null);
    assert.strictEqual(parseMessageCreated({ ...valid, author_id: '' }), null);
    assert.strictEqual(parseMessageCreated({ ...valid, message_id: 'x'.repeat(300) }), null);
  });

  it('fecha inválida o ausente → ahora; listas que no son listas → vacías', () => {
    const event = parseMessageCreated({ ...valid, created_at: 'ayer', thread_participant_ids: 'alice', preview: 3 });
    assert.ok(event && !Number.isNaN(event.createdAt.getTime()));
    assert.deepStrictEqual(event?.threadParticipantIds, []);
    assert.strictEqual(event?.preview, '');
  });

  it('acota los destinatarios a 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => `u${i}`);
    assert.strictEqual(parseMessageCreated({ ...valid, thread_participant_ids: many })?.threadParticipantIds.length, 100);
  });
});

describe('candidates', () => {
  const base = parseMessageCreated({
    event_id: 'e1',
    channel_id: 'chan',
    thread_id: 'thr',
    message_id: 'm1',
    author_id: 'bob',
    thread_participant_ids: ['alice', 'bob', 'carol'],
  });

  it('participantes del hilo menos el autor, como thread_reply', () => {
    assert.deepStrictEqual(candidates(base!), [
      { userId: 'alice', reason: 'thread_reply' },
      { userId: 'carol', reason: 'thread_reply' },
    ]);
  });

  it('sin hilo no hay candidatos (las menciones y los DMs son de la épica)', () => {
    assert.deepStrictEqual(candidates({ ...base!, threadId: null }), []);
  });
});

describe('resolve: la más específica gana', () => {
  const cases: [string, Preference[], Scope, { level: Level; muted: boolean }][] = [
    ['sin preferencias en un servidor → mentions', [], SERVER, { level: 'mentions', muted: false }],
    ['sin preferencias en un DM → all', [], DM, { level: 'all', muted: false }],
    ['servidor all', [pref('server', 'srv', level('all'))], SERVER, { level: 'all', muted: false }],
    [
      'canal pisa al servidor',
      [pref('server', 'srv', level('all')), pref('channel', 'chan', level('none'))],
      SERVER,
      { level: 'none', muted: false },
    ],
    [
      'hilo pisa al canal',
      [pref('channel', 'chan', level('none')), pref('thread', 'thr', level('all'))],
      SERVER,
      { level: 'all', muted: false },
    ],
    [
      'level null hereda del de arriba',
      [pref('thread', 'thr', { level: null, muted: false }), pref('server', 'srv', level('none'))],
      SERVER,
      { level: 'none', muted: false },
    ],
    ['servidor silenciado silencia el canal', [pref('server', 'srv', { muted: true })], SERVER, { level: 'mentions', muted: true }],
    [
      'silencio con muted_until vencido no cuenta',
      [pref('thread', 'thr', { muted: true, mutedUntil: new Date('2026-11-23T11:00:00Z') })],
      SERVER,
      { level: 'mentions', muted: false },
    ],
    [
      'silencio con muted_until futuro cuenta',
      [pref('channel', 'chan', { muted: true, mutedUntil: new Date('2026-11-23T13:00:00Z') })],
      SERVER,
      { level: 'mentions', muted: true },
    ],
    [
      'reactivar (muted false) conserva el nivel',
      [pref('channel', 'chan', { level: 'all', muted: false })],
      SERVER,
      { level: 'all', muted: false },
    ],
    [
      'ignora preferencias de otro alcance',
      [pref('server', 'otro', level('none')), pref('channel', 'otro-canal', { muted: true })],
      SERVER,
      { level: 'mentions', muted: false },
    ],
    [
      'en un DM no busca servidor',
      [pref('server', '', level('none'))],
      DM,
      { level: 'all', muted: false },
    ],
  ];

  for (const [name, prefs, scope, expected] of cases) {
    it(name, () => assert.deepStrictEqual(resolve(prefs, scope, NOW), expected));
  }

  it('sin hilo no mira preferencias de hilo', () => {
    const noThread = { ...SERVER, threadId: null };
    assert.deepStrictEqual(resolve([pref('thread', 'thr', level('none'))], noThread, NOW), {
      level: 'mentions',
      muted: false,
    });
  });
});

describe('shouldNotify', () => {
  it('muted o none nunca; all siempre; mentions deja pasar lo que te involucra', () => {
    for (const reason of ['thread_reply', 'mention', 'dm'] as const) {
      assert.strictEqual(shouldNotify({ level: 'all', muted: true }, reason), false);
      assert.strictEqual(shouldNotify({ level: 'none', muted: false }, reason), false);
      assert.strictEqual(shouldNotify({ level: 'all', muted: false }, reason), true);
      assert.strictEqual(shouldNotify({ level: 'mentions', muted: false }, reason), true);
    }
  });
});

describe('InboxPublisher', () => {
  const notification = (userId: string, messageId = 'm1'): Notification => ({
    id: `id-${userId}`,
    userId,
    reason: 'thread_reply',
    serverId: 'srv',
    channelId: 'chan',
    threadId: 'thr',
    messageId,
    actorId: 'bob',
    preview: 'hola',
    createdAt: new Date('2026-11-23T10:00:00Z'),
    readAt: null,
  });

  it('agrupa por evento en lotes de 10, con el token y sin el id ni el usuario en el evento', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const publisher = new InboxPublisher({
      chatEngineUrl: 'http://chat:3000/',
      internalToken: 'secreto',
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 202 });
      },
    });
    const users = Array.from({ length: 23 }, (_, i) => `u${i}`);

    const failed = await publisher.publish([...users.map((u) => notification(u)), notification('z', 'm2')]);

    assert.strictEqual(failed, 0);
    assert.strictEqual(calls.length, 4, '3 lotes del primer mensaje y 1 del segundo');
    assert.strictEqual(calls[0].url, 'http://chat:3000/internal/inbox/events');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.strictEqual(headers['x-internal-token'], 'secreto');
    const body = JSON.parse(String(calls[0].init.body));
    assert.strictEqual(body.userIds.length, INBOX_BATCH_SIZE);
    assert.strictEqual(body.event.type, 'NOTIFICATION_CREATED');
    assert.strictEqual(body.event.notification.threadId, 'thr');
    assert.strictEqual(body.event.notification.id, undefined);
    assert.strictEqual(body.event.notification.userId, undefined);
  });

  it('sin token no manda el header; cuenta los lotes que fallan y nunca lanza', async () => {
    const seen: Record<string, string>[] = [];
    const responses = [new Response(null, { status: 401 })];
    const publisher = new InboxPublisher({
      chatEngineUrl: 'http://chat:3000',
      fetchFn: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        const next = responses.shift();
        if (!next) throw new TypeError('fetch failed');
        return next;
      },
    });

    assert.strictEqual(await publisher.publish([notification('a'), notification('b', 'm2')]), 2);
    assert.strictEqual('x-internal-token' in seen[0], false);
  });
});
