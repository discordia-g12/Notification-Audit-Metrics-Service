import type { Pool } from 'pg';

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rechaza si PostgreSQL no responde un SELECT 1 a tiempo. La usan /readyz y el monitor de estado. */
export type DatabaseCheck = () => Promise<void>;

export function createDatabaseCheck(pool: Pool, timeoutMs: number): DatabaseCheck {
  return async () => {
    await withTimeout(pool.query('SELECT 1'), timeoutMs);
  };
}
