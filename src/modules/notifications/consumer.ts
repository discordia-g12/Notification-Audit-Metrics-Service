import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import { processMessageCreated } from './processor';
import { deleteForChannel, deleteForServer } from './repository';
import { parseMessageCreated } from './rules';
import type { Notification } from './types';

export interface NotificationConsumerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface NotificationConsumerOptions {
  url?: string;
  exchange?: string;
  queue?: string;
  pool: Pool;
  deliver: (notifications: Notification[]) => void;
  logger?: NotificationConsumerLogger;
  /** Para tests: reemplaza amqplib.connect. */
  connect?: (url: string) => Promise<ChannelModel>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const NOTIFICATION_ROUTING_KEYS = ['chat.message.created', 'channel.deleted', 'server.deleted'];
/** Mensajes sin confirmar a la vez: acota la memoria (el contenedor tiene 96 MB de heap). */
export const PREFETCH = 10;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Lo que no se pudo procesar va a la DLQ para revisarlo, no se pierde ni entra en loop. */
export const deadLetterQueueOf = (queue: string) => `${queue}.dlq`;

/**
 * Cola propia (no la de audit: un fallo en una no frena a la otra), con DLQ y prefetch. Mismo ciclo de
 * conexión que AuditConsumer: reintenta con backoff y se reconecta si se corta.
 */
export class NotificationConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private wakeRetry: (() => void) | null = null;

  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly pool: Pool;
  private readonly deliver: (notifications: Notification[]) => void;
  private readonly logger: NotificationConsumerLogger;
  private readonly connectFn?: (url: string) => Promise<ChannelModel>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: NotificationConsumerOptions) {
    this.url = options.url || process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672/';
    this.exchange = options.exchange || process.env.RABBITMQ_EXCHANGE || 'server.events';
    this.queue = options.queue || process.env.RABBITMQ_MESSAGE_QUEUE || 'notification_message_events';
    this.pool = options.pool;
    this.deliver = options.deliver;
    this.logger = options.logger || console;
    this.connectFn = options.connect;
    this.baseDelayMs = options.baseDelayMs ?? RECONNECT_BASE_MS;
    this.maxDelayMs = options.maxDelayMs ?? RECONNECT_MAX_MS;
  }

  get isConnected(): boolean {
    return this.channel !== null;
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.wakeRetry?.();
    if (this.channel) {
      await this.channel.close().catch(() => undefined);
      this.channel = null;
    }
    if (this.connection) {
      await this.connection.close().catch(() => undefined);
      this.connection = null;
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.attempts = 0;
        this.logger.info({ exchange: this.exchange, queue: this.queue }, 'NotificationConsumer connected to RabbitMQ');
        return;
      } catch (err) {
        if (this.stopped) return;
        const delayMs = Math.min(this.baseDelayMs * 2 ** this.attempts, this.maxDelayMs);
        this.attempts += 1;
        this.logger.warn({ err, attempt: this.attempts, delayMs }, 'RabbitMQ unavailable for NotificationConsumer, retrying');
        await new Promise<void>((resolve) => {
          this.wakeRetry = resolve;
          this.retryTimer = setTimeout(resolve, delayMs);
        });
        this.retryTimer = null;
        this.wakeRetry = null;
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const connect = this.connectFn || (await import('amqplib')).connect;
    const conn = await connect(this.url);

    conn.on('error', (err: Error) => this.logger.error({ err }, 'RabbitMQ NotificationConsumer connection error'));
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (this.stopped) return;
      this.logger.warn({}, 'RabbitMQ NotificationConsumer connection closed, reconnecting');
      void this.connectLoop();
    });

    try {
      const channel = await conn.createChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      const dlq = deadLetterQueueOf(this.queue);
      await channel.assertQueue(dlq, { durable: true });
      // Exchange por defecto ('') con la DLQ como routing key: lo rechazado va directo a esa cola
      const q = await channel.assertQueue(this.queue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': dlq },
      });
      for (const routingKey of NOTIFICATION_ROUTING_KEYS) {
        await channel.bindQueue(q.queue, this.exchange, routingKey);
      }
      await channel.prefetch(PREFETCH);
      await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
        if (msg) void this.handleMessage(msg, channel);
      });

      this.connection = conn;
      this.channel = channel;
    } catch (err) {
      conn.removeAllListeners('close');
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  /** ack si se procesó (o ya se había procesado); nack sin reencolar → DLQ si el evento es inválido o falla. */
  async handleMessage(msg: ConsumeMessage, channel: Channel): Promise<void> {
    const routingKey = msg.fields.routingKey;
    try {
      const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;
      if (typeof payload !== 'object' || payload === null) throw new Error('payload is not an object');

      if (routingKey === 'chat.message.created') {
        const event = parseMessageCreated(payload, msg.properties.messageId);
        if (!event) throw new Error('invalid chat.message.created payload');
        const created = await processMessageCreated({ pool: this.pool, deliver: this.deliver }, event);
        if (created.length > 0) {
          this.logger.info({ eventId: event.eventId, notifications: created.length }, 'notifications created');
        }
      } else if (routingKey === 'channel.deleted' && typeof payload.channel_id === 'string') {
        await deleteForChannel(this.pool, payload.channel_id);
      } else if (routingKey === 'server.deleted' && typeof payload.server_id === 'string') {
        await deleteForServer(this.pool, payload.server_id);
      }
      channel.ack(msg);
    } catch (err) {
      this.logger.error({ err, routingKey }, 'Failed to process notification event, sent to DLQ');
      channel.nack(msg, false, false);
    }
  }
}
