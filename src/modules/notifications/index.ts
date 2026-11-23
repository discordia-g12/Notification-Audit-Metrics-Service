export { notificationRoutes } from './routes';
export { NotificationConsumer } from './consumer';
export { InboxPublisher } from './inbox';
export { purgeOldNotifications } from './repository';

/** Cada cuánto se borran los avisos viejos (además de al arrancar). */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
