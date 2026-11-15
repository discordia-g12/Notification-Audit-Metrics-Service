import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import { AuditConsumer, AUDIT_ROUTING_KEYS } from '../src/modules/audit/consumer';

class FakeChannel {
  exchanges: string[] = [];
  queues: string[] = [];
  bindings: [string, string, string][] = [];
  consumerCb: ((msg: ConsumeMessage | null) => void) | null = null;
  acked: ConsumeMessage[] = [];
  nacked: ConsumeMessage[] = [];

  async assertExchange(exchange: string) {
    this.exchanges.push(exchange);
    return { exchange };
  }

  async assertQueue(queue: string) {
    this.queues.push(queue);
    return { queue, messageCount: 0, consumerCount: 0 };
  }

  async bindQueue(queue: string, source: string, pattern: string) {
    this.bindings.push([queue, source, pattern]);
  }

  async consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void) {
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
    assert.strictEqual(fakeConn.channel.queues[0], 'notification_audit_events');
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
});
