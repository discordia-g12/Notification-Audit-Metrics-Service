import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import {
  AuditConsumer,
  AUDIT_PREFETCH,
  AUDIT_QUEUE,
  AUDIT_ROUTING_KEYS,
  LEGACY_AUDIT_QUEUE,
} from '../src/modules/audit/consumer';

class FakeChannel {
  exchanges: string[] = [];
  queues: string[] = [];
  queueArgs = new Map<string, Record<string, unknown> | undefined>();
  bindings: [string, string, string][] = [];
  unbound: [string, string, string][] = [];
  deleted: string[] = [];
  consumed: string[] = [];
  prefetchCount = 0;
  /** Mensajes en la cola anterior; null: no existe. */
  legacyMessages: number | null = null;
  consumerCb: ((msg: ConsumeMessage | null) => void) | null = null;
  acked: ConsumeMessage[] = [];
  nacked: ConsumeMessage[] = [];

  async assertExchange(exchange: string) {
    this.exchanges.push(exchange);
    return { exchange };
  }

  async assertQueue(queue: string, options?: { arguments?: Record<string, unknown> }) {
    this.queues.push(queue);
    this.queueArgs.set(queue, options?.arguments);
    return { queue, messageCount: 0, consumerCount: 0 };
  }

  async checkQueue(queue: string) {
    if (this.legacyMessages === null) throw new Error('NOT_FOUND');
    return { queue, messageCount: this.legacyMessages, consumerCount: 0 };
  }

  async unbindQueue(queue: string, source: string, pattern: string) {
    this.unbound.push([queue, source, pattern]);
  }

  async deleteQueue(queue: string) {
    this.deleted.push(queue);
  }

  async prefetch(count: number) {
    this.prefetchCount = count;
  }

  on() {
    return this;
  }

  async bindQueue(queue: string, source: string, pattern: string) {
    this.bindings.push([queue, source, pattern]);
  }

  async consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void) {
    this.consumed.push(queue);
    this.consumerCb = onMessage;
    return { consumerTag: 'tag-1' };
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
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, cb: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...list, cb]);
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(...args);
    }
  }

  async createChannel() {
    return this.channel as unknown as Channel;
  }

  async close() {}
}

describe('Audit Consumer', () => {
  it('connects, asserts queue and binds all audit routing keys', async () => {
    const fakeConn = new FakeConnection();
    const inserted: unknown[] = [];

    const poolMock = {
      query: async (_sql: string, values: unknown[]) => {
        inserted.push(values);
        return { rows: [{ id: '1' }] };
      },
    } as unknown as Pool;

    const consumer = new AuditConsumer({
      pool: poolMock,
      connect: async () => fakeConn as unknown as ChannelModel,
      baseDelayMs: 10,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    consumer.start();

    // Esperar a que se conecte
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(consumer.isConnected, true);

    // Verificar bindings
    assert.strictEqual(fakeConn.channel.exchanges[0], 'server.events');
    // D5: la cola nueva con DLQ y prefetch
    assert.deepStrictEqual(fakeConn.channel.queues, [`${AUDIT_QUEUE}.dlq`, AUDIT_QUEUE]);
    assert.deepStrictEqual(fakeConn.channel.queueArgs.get(AUDIT_QUEUE), {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': `${AUDIT_QUEUE}.dlq`,
    });
    assert.strictEqual(fakeConn.channel.prefetchCount, AUDIT_PREFETCH);
    assert.strictEqual(fakeConn.channel.bindings.length, AUDIT_ROUTING_KEYS.length);

    // Enviar mensaje de prueba válido
    const mockMsg: ConsumeMessage = {
      content: Buffer.from(
        JSON.stringify({
          server_id: 'srv-1',
          user_id: 'u-1',
          banned_by: 'admin-1',
          reason: 'Banned for rules violation',
        }),
      ),
      fields: {
        consumerTag: 'tag',
        deliveryTag: 1,
        redelivered: false,
        exchange: 'server.events',
        routingKey: 'member.banned',
      },
      properties: {
        messageId: 'event-uuid-1',
        contentType: 'application/json',
      } as unknown as ConsumeMessage['properties'],
    };

    await consumer.handleMessage(mockMsg, fakeConn.channel as unknown as Channel);

    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(fakeConn.channel.acked.length, 1);

    // Enviar mensaje no parseable (JSON inválido) -> debe hacer nack sin requeue
    const invalidMsg: ConsumeMessage = {
      content: Buffer.from('invalid-json-content'),
      fields: {
        consumerTag: 'tag',
        deliveryTag: 2,
        redelivered: false,
        exchange: 'server.events',
        routingKey: 'member.banned',
      },
      properties: {} as unknown as ConsumeMessage['properties'],
    };

    await consumer.handleMessage(invalidMsg, fakeConn.channel as unknown as Channel);
    assert.strictEqual(fakeConn.channel.nacked.length, 1);

    // Enviar mensaje no mapeable (routing key desconocida) -> ack sin insertar
    const unmappedMsg: ConsumeMessage = {
      content: Buffer.from(JSON.stringify({ some: 'data' })),
      fields: {
        consumerTag: 'tag',
        deliveryTag: 3,
        redelivered: false,
        exchange: 'server.events',
        routingKey: 'unknown.event',
      },
      properties: {} as unknown as ConsumeMessage['properties'],
    };

    await consumer.handleMessage(unmappedMsg, fakeConn.channel as unknown as Channel);
    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(fakeConn.channel.acked.length, 2);

    // Simular error y close en la conexión
    fakeConn.emit('error', new Error('Mock socket error'));
    fakeConn.emit('close');

    await consumer.stop();
    assert.strictEqual(consumer.isConnected, false);
  });

  it('retries connection on failure and honors stop', async () => {
    let connectCalls = 0;
    const consumer = new AuditConsumer({
      pool: {} as unknown as Pool,
      connect: async () => {
        connectCalls += 1;
        throw new Error('Connection refused');
      },
      baseDelayMs: 10,
      maxDelayMs: 20,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(connectCalls >= 2);

    await consumer.stop();
  });

  describe('retiro de la cola anterior (sin DLQ)', () => {
    async function connectWith(legacyMessages: number | null, queue?: string) {
      const fakeConn = new FakeConnection();
      fakeConn.channel.legacyMessages = legacyMessages;
      const consumer = new AuditConsumer({
        pool: {} as unknown as Pool,
        queue,
        connect: async () => fakeConn as unknown as ChannelModel,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      consumer.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await consumer.stop();
      return fakeConn.channel;
    }

    it('vacía: le saca los bindings y la borra', async () => {
      const channel = await connectWith(0);
      assert.strictEqual(channel.unbound.length, AUDIT_ROUTING_KEYS.length);
      assert.ok(channel.unbound.every(([queue]) => queue === LEGACY_AUDIT_QUEUE));
      assert.deepStrictEqual(channel.deleted, [LEGACY_AUDIT_QUEUE]);
    });

    it('con mensajes: deja de recibir y se consume hasta vaciarla, sin borrarla todavía', async () => {
      const channel = await connectWith(3);
      assert.strictEqual(channel.unbound.length, AUDIT_ROUTING_KEYS.length);
      assert.deepStrictEqual(channel.deleted, []);
      assert.deepStrictEqual(channel.consumed, [AUDIT_QUEUE, LEGACY_AUDIT_QUEUE]);
    });

    it('si ya no existe, no hace nada', async () => {
      const channel = await connectWith(null);
      assert.deepStrictEqual(channel.unbound, []);
      assert.deepStrictEqual(channel.deleted, []);
    });

    it('si la cola configurada es la anterior (RABBITMQ_QUEUE viejo), no la toca', async () => {
      const channel = await connectWith(0, LEGACY_AUDIT_QUEUE);
      assert.deepStrictEqual(channel.deleted, []);
      assert.deepStrictEqual(channel.unbound, []);
    });
  });
});
