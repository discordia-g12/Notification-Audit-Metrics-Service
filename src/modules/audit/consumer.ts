import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import { mapEventToAuditLog } from './event-mapper';
import { insertAuditLog } from './repository';

export interface AuditConsumerLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

export interface AuditConsumerOptions {
  url?: string;
  exchange?: string;
  queue?: string;
  pool: Pool;
  logger?: AuditConsumerLogger;
  /** Para tests: reemplaza amqplib.connect. */
  connect?: (url: string) => Promise<ChannelModel>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export const AUDIT_ROUTING_KEYS = [
  'member.*',
  'role.*',
  'channel.*',
  'category.*',
  'server.*',
  'invite.*',
  'message.deleted_by_moderator',
];

export class AuditConsumer {
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
  private readonly logger: AuditConsumerLogger;
  private readonly connectFn?: (url: string) => Promise<ChannelModel>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: AuditConsumerOptions) {
    this.url = options.url || process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672/';
    this.exchange = options.exchange || process.env.RABBITMQ_EXCHANGE || 'server.events';
    this.queue = options.queue || process.env.RABBITMQ_QUEUE || 'notification_audit_events';
    this.pool = options.pool;
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
      try {
        await this.channel.close();
      } catch {}
      this.channel = null;
    }
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {}
      this.connection = null;
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.attempts = 0;
        this.logger.info({ exchange: this.exchange, queue: this.queue }, 'AuditConsumer connected to RabbitMQ');
        return;
      } catch (err) {
        if (this.stopped) return;
        const delayMs = Math.min(this.baseDelayMs * 2 ** this.attempts, this.maxDelayMs);
        this.attempts += 1;
        this.logger.warn({ err, attempt: this.attempts, delayMs }, 'RabbitMQ unavailable for AuditConsumer, retrying');
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

    conn.on('error', (err: Error) => this.logger.error({ err }, 'RabbitMQ AuditConsumer connection error'));
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (this.stopped) return;
      this.logger.warn('RabbitMQ AuditConsumer connection closed, reconnecting');
      void this.connectLoop();
    });

    try {
      const channel = await conn.createChannel();
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      const q = await channel.assertQueue(this.queue, { durable: true });

      for (const routingKey of AUDIT_ROUTING_KEYS) {
        await channel.bindQueue(q.queue, this.exchange, routingKey);
      }

      await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
        if (!msg) return;
        this.handleMessage(msg, channel);
      });

      this.connection = conn;
      this.channel = channel;
    } catch (err) {
      conn.removeAllListeners('close');
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  async handleMessage(msg: ConsumeMessage, channel: Channel): Promise<void> {
    const routingKey = msg.fields.routingKey;
    try {
      const contentStr = msg.content.toString();
      const payload = JSON.parse(contentStr) as Record<string, unknown>;
      const entry = mapEventToAuditLog(routingKey, payload, msg.properties.messageId);

      if (entry) {
        await insertAuditLog(this.pool, entry);
      }
      channel.ack(msg);
    } catch (err) {
      this.logger.error({ err, routingKey }, 'Failed to process audit event');
      channel.nack(msg, false, false);
    }
  }
}
