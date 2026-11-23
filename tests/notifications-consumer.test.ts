import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import {
  deadLetterQueueOf,
  NOTIFICATION_ROUTING_KEYS,
  NotificationConsumer,
  PREFETCH,
} from '../src/modules/notifications/consumer';

class FakeChannel {
  queues: { name: string; options?: { arguments?: Record<string, unknown> } }[] = [];
  bindings: [string, string, string][] = [];
  prefetchCount = 0;
  consumerCb: ((msg: ConsumeMessage | null) => void) | null = null;
  acked: ConsumeMessage[] = [];
  nacked: ConsumeMessage[] = [];

  async assertExchange(exchange: string) {
    return { exchange };
  }
  async assertQueue(name: string, options?: { arguments?: Record<string, unknown> }) {
    this.queues.push({ name, options });
    return { queue: name, messageCount: 0, consumerCount: 0 };
  }
  async bindQueue(queue: string, source: string, pattern: string) {
    this.bindings.push([queue, source, pattern]);
  }
  async prefetch(count: number) {
    this.prefetchCount = count;
  }
  async consume(_queue: string, cb: (msg: ConsumeMessage | null) => void) {
    this.consumerCb = cb;
    return { consumerTag: 't' };
  }
  ack(msg: ConsumeMessage) {
    this.acked.push(msg);
  }
  nack(msg: ConsumeMessage) {
    this.nacked.push(msg);
  }
  async close() {}
}

class FakeConnection {
  channel = new FakeChannel();
  on() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  async createChannel() {
    return this.channel as unknown as Channel;
  }
  async close() {}
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function message(routingKey: string, body: unknown, messageId?: string): ConsumeMessage {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey },
    properties: { messageId },
  } as unknown as ConsumeMessage;
}

/** Pool falso: registra las consultas y devuelve filas vacías (o las que diga `rows`). */
function fakePool(rows: (sql: string) => unknown[] = () => [], fail = false) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (fail) throw new Error('db down');
      return { rows: rows(sql), rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

async function connected(pool: Pool) {
  const conn = new FakeConnection();
  const consumer = new NotificationConsumer({
    pool,
    deliver: () => {},
    logger: silent,
    queue: 'q',
    connect: async () => conn as unknown as ChannelModel,
  });
  consumer.start();
  await new Promise((resolve) => setImmediate(resolve));
  return { consumer, channel: conn.channel };
}

describe('NotificationConsumer', () => {
  it('declara la cola con DLQ, prefetch y los bindings', async () => {
    const { consumer, channel } = await connected(fakePool().pool);

    assert.strictEqual(consumer.isConnected, true);
    assert.deepStrictEqual(channel.queues[0], { name: 'q.dlq', options: { durable: true } });
    assert.deepStrictEqual(channel.queues[1].options?.arguments, {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': deadLetterQueueOf('q'),
    });
    assert.deepStrictEqual(
      channel.bindings.map(([, , key]) => key),
      NOTIFICATION_ROUTING_KEYS,
    );
    assert.strictEqual(channel.prefetchCount, PREFETCH);
    await consumer.stop();
    assert.strictEqual(consumer.isConnected, false);
  });

  it('chat.message.created válido → procesa y ack', async () => {
    const { pool, queries } = fakePool();
    const { consumer, channel } = await connected(pool);
    const msg = message('chat.message.created', {
      event_id: 'e1',
      channel_id: 'chan',
      thread_id: 'thr',
      message_id: 'm1',
      author_id: 'bob',
      thread_participant_ids: ['alice'],
    });

    await consumer.handleMessage(msg, channel as unknown as Channel);

    assert.deepStrictEqual(channel.acked, [msg]);
    assert.ok(queries.some((q) => q.sql.includes('FROM notification_preferences')));
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO notifications')));
    await consumer.stop();
  });

  it('JSON inválido, payload incompleto o error de base → nack sin reencolar (DLQ)', async () => {
    const { consumer, channel } = await connected(fakePool().pool);
    const bad = [message('chat.message.created', '{no es json'), message('chat.message.created', { channel_id: 'c' })];
    for (const msg of bad) await consumer.handleMessage(msg, channel as unknown as Channel);
    assert.strictEqual(channel.nacked.length, 2);

    const failing = await connected(fakePool(() => [], true).pool);
    const msg = message('channel.deleted', { channel_id: 'chan' });
    await failing.consumer.handleMessage(msg, failing.channel as unknown as Channel);
    assert.deepStrictEqual(failing.channel.nacked, [msg]);
    await consumer.stop();
    await failing.consumer.stop();
  });

  it('channel.deleted y server.deleted limpian; otro evento se confirma sin hacer nada', async () => {
    const { pool, queries } = fakePool();
    const { consumer, channel } = await connected(pool);

    await consumer.handleMessage(message('channel.deleted', { channel_id: 'chan' }), channel as unknown as Channel);
    await consumer.handleMessage(message('server.deleted', { server_id: 'srv' }), channel as unknown as Channel);
    await consumer.handleMessage(message('channel.deleted', {}), channel as unknown as Channel);

    assert.strictEqual(channel.acked.length, 3);
    assert.deepStrictEqual(
      queries.map((q) => q.values[0]),
      ['chan', 'chan', 'srv', 'srv'],
    );
    await consumer.stop();
  });

  it('si RabbitMQ no está, reintenta con backoff hasta que conecta', async () => {
    let attempts = 0;
    const conn = new FakeConnection();
    const consumer = new NotificationConsumer({
      pool: fakePool().pool,
      deliver: () => {},
      logger: silent,
      baseDelayMs: 1,
      maxDelayMs: 2,
      connect: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNREFUSED');
        return conn as unknown as ChannelModel;
      },
    });
    consumer.start();
    for (let i = 0; i < 50 && !consumer.isConnected; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(attempts, 3);
    assert.strictEqual(consumer.isConnected, true);
    await consumer.stop();
  });
});
