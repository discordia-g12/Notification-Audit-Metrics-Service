import type { Pool } from 'pg';

export const PUSH_PLATFORMS = ['ios', 'android', 'web'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** Dispositivos por usuario: al registrar uno más, se borra el que hace más que no se ve. Acota el fan-out. */
export const MAX_DEVICES_PER_USER = 10;

export interface WebPushKeys {
  p256dh: string;
  auth: string;
}

export interface PushDevice {
  userId: string;
  platform: PushPlatform;
  /** Expo push token, o el endpoint de la suscripción web. */
  token: string;
  keys: WebPushKeys | null;
}

interface DeviceRow {
  user_id: string;
  platform: PushPlatform;
  token: string;
  keys: WebPushKeys | null;
}

/**
 * Alta o refresco de un dispositivo. Si el token ya estaba (otro login en el mismo teléfono o navegador), pasa
 * al usuario actual: un dispositivo recibe los avisos de quien lo usa ahora.
 */
export async function upsertDevice(pool: Pool, device: PushDevice): Promise<void> {
  await pool.query(
    `INSERT INTO push_devices (user_id, platform, token, keys) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, keys = EXCLUDED.keys, last_seen_at = now()`,
    [device.userId, device.platform, device.token, device.keys],
  );
  await pool.query(
    `DELETE FROM push_devices WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM push_devices WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT $2)`,
    [device.userId, MAX_DEVICES_PER_USER],
  );
}

/** Solo borra un dispositivo propio. */
export async function deleteDevice(pool: Pool, userId: string, token: string): Promise<void> {
  await pool.query('DELETE FROM push_devices WHERE user_id = $1 AND token = $2', [userId, token]);
}

/** Tokens que el proveedor dio por muertos (DeviceNotRegistered, 404/410). */
export async function deleteTokens(pool: Pool, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await pool.query('DELETE FROM push_devices WHERE token = ANY($1)', [tokens]);
}

/** Dispositivos de esos usuarios, salvo los que apagaron push. Una consulta. */
export async function findPushTargets(pool: Pool, userIds: string[]): Promise<PushDevice[]> {
  if (userIds.length === 0) return [];
  const { rows } = await pool.query<DeviceRow>(
    `SELECT d.user_id, d.platform, d.token, d.keys FROM push_devices d
       LEFT JOIN push_settings s ON s.user_id = d.user_id
      WHERE d.user_id = ANY($1) AND COALESCE(s.push_enabled, true)`,
    [userIds],
  );
  return rows.map((r) => ({ userId: r.user_id, platform: r.platform, token: r.token, keys: r.keys }));
}

export async function getPushEnabled(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ push_enabled: boolean }>(
    'SELECT push_enabled FROM push_settings WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.push_enabled ?? true;
}

export async function setPushEnabled(pool: Pool, userId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO push_settings (user_id, push_enabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, updated_at = now()`,
    [userId, enabled],
  );
}
