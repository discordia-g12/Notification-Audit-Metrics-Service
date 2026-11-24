import { describe, it } from 'node:test';
import assert from 'node:assert';
import { candidates, parseMessageCreated, resolve, shouldNotify, type Scope } from '../src/modules/notifications/rules';
import type { Level, Preference, ScopeType } from '../src/modules/notifications/types';
import { InboxPublisher, INBOX_BATCH_SIZE } from '../src/modules/notifications/inbox';
import { channelViewerIds, roleMemberIds, serverMemberIds } from '../src/modules/notifications/members';
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
    assert.strictEqual(event.mentionEveryone, false);
    assert.deepStrictEqual(event.recipientIds, [], 'recipient_ids es opcional: los eventos viejos no lo traen');
  });

  it('lee recipient_ids, mention_role_ids y mention_everyone (solo true cuenta)', () => {
    const event = parseMessageCreated({
      ...valid,
      recipient_ids: ['carol', 3],
      mention_role_ids: ['mods', null],
      mention_everyone: true,
    });
    assert.deepStrictEqual(event?.recipientIds, ['carol']);
    assert.deepStrictEqual(event?.mentionRoleIds, ['mods']);
    assert.strictEqual(event?.mentionEveryone, true);
    assert.strictEqual(parseMessageCreated({ ...valid, mention_everyone: 'true' })?.mentionEveryone, false);
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

  it('sin hilo no hay thread_reply', () => {
    assert.deepStrictEqual(candidates({ ...base!, threadId: null }), []);
  });

  it('DM: los destinatarios como dm, solo si es un DM', () => {
    const dm = { ...base!, serverId: null, threadId: null, isDm: true, recipientIds: ['alice', 'bob'] };
    assert.deepStrictEqual(candidates(dm), [{ userId: 'alice', reason: 'dm' }]);
    assert.deepStrictEqual(candidates({ ...dm, isDm: false }), []);
  });

  it('menciones directas, @everyone y roles (expandidos aparte) como mention, nunca al autor', () => {
    const event = { ...base!, threadId: null, mentionUserIds: ['dave', 'bob'] };
    assert.deepStrictEqual(candidates(event, { mentionIds: ['bob', 'dave', 'erin'] }), [
      { userId: 'dave', reason: 'mention' },
      { userId: 'erin', reason: 'mention' },
    ]);
  });

  it('uno por usuario: mention > dm > thread_reply > message', () => {
    const event = { ...base!, isDm: true, mentionUserIds: ['alice'], recipientIds: ['carol', 'alice'] };
    assert.deepStrictEqual(candidates(event, { allLevelIds: ['alice', 'carol', 'zoe', 'bob'] }), [
      { userId: 'alice', reason: 'mention' },
      { userId: 'carol', reason: 'dm' },
      { userId: 'zoe', reason: 'message' },
    ]);
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

  it('un mensaje cualquiera (message) solo pasa con all', () => {
    assert.strictEqual(shouldNotify({ level: 'all', muted: false }, 'message'), true);
    assert.strictEqual(shouldNotify({ level: 'mentions', muted: false }, 'message'), false);
    assert.strictEqual(shouldNotify({ level: 'all', muted: true }, 'message'), false);
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

describe('serverMemberIds (Server-Roles)', () => {
  const client = (respond: () => Response | Promise<Response>, calls: string[] = []) =>
    serverMemberIds({
      serverRolesUrl: 'http://roles:8080/',
      fetchFn: async (url) => {
        calls.push(url);
        return respond();
      },
    });

  it('devuelve los user_ids; 404 (servidor borrado) → vacío', async () => {
    const calls: string[] = [];
    const ids = await client(() => Response.json({ server_id: 's 1', user_ids: ['a', 'b'] }), calls)('s 1');
    assert.deepStrictEqual(ids, ['a', 'b']);
    assert.strictEqual(calls[0], 'http://roles:8080/internal/servers/s%201/member-ids');
    assert.deepStrictEqual(await client(() => new Response(null, { status: 404 }))('s'), []);
  });

  it('roleMemberIds: los del rol; 404 (rol de otro servidor o servidor borrado) → vacío; error → lanza', async () => {
    const calls: string[] = [];
    const role = (respond: () => Response) =>
      roleMemberIds({
        serverRolesUrl: 'http://roles:8080',
        fetchFn: async (url) => {
          calls.push(url);
          return respond();
        },
      });
    assert.deepStrictEqual(await role(() => Response.json({ user_ids: ['a'] }))('srv', 'r/1'), ['a']);
    assert.strictEqual(calls[0], 'http://roles:8080/internal/servers/srv/roles/r%2F1/member-ids');
    assert.deepStrictEqual(await role(() => new Response(null, { status: 404 }))('srv', 'r'), []);
    await assert.rejects(role(() => new Response(null, { status: 500 }))('srv', 'r'));
  });

  it('error, respuesta inválida o caído → lanza (el evento va a la DLQ, no se pierde)', async () => {
    await assert.rejects(client(() => new Response(null, { status: 503 }))('s'));
    await assert.rejects(client(() => Response.json({ user_ids: [1] }))('s'));
    await assert.rejects(client(() => new Response('no json'))('s'));
    await assert.rejects(
      client(() => {
        throw new TypeError('fetch failed');
      })('s'),
    );
  });
});

describe('channelViewerIds (Server-Roles)', () => {
  const client = (respond: (ids: string[]) => Response, calls: { url: string; init: { method?: string; body?: unknown } }[] = []) =>
    channelViewerIds({
      serverRolesUrl: 'http://roles:8080/',
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return respond(JSON.parse(String(init.body)).user_ids);
      },
    });

  it('POST con user_ids en el body; devuelve el subconjunto', async () => {
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    const ids = await client(() => Response.json({ user_ids: ['a'] }), calls)('c/1', ['a', 'b']);
    assert.deepStrictEqual(ids, ['a']);
    assert.strictEqual(calls[0].url, 'http://roles:8080/internal/channels/c%2F1/viewers');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), { user_ids: ['a', 'b'] });
  });

  it('404 (canal borrado) → vacío; error o respuesta inválida → lanza', async () => {
    assert.deepStrictEqual(await client(() => new Response(null, { status: 404 }))('c', ['a']), []);
    await assert.rejects(client(() => new Response(null, { status: 500 }))('c', ['a']));
    await assert.rejects(client(() => Response.json({ user_ids: [1] }))('c', ['a']));
    await assert.rejects(client(() => new Response('no json'))('c', ['a']));
  });

  it('más de 5000 ids: lotes de 5000 y une las respuestas', async () => {
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    const ids = Array.from({ length: 5001 }, (_, i) => `u${i}`);
    const out = await client((sent) => Response.json({ user_ids: sent.slice(0, 1) }), calls)('c', ids);
    assert.deepStrictEqual(calls.map((c) => JSON.parse(String(c.init.body)).user_ids.length), [5000, 1]);
    assert.deepStrictEqual(out, ['u0', 'u5000']);
  });

  it('lista vacía: no llama', async () => {
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    assert.deepStrictEqual(await client(() => Response.json({ user_ids: [] }), calls)('c', []), []);
    assert.strictEqual(calls.length, 0);
  });
});
