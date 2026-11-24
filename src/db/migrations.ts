import type { Migration } from './migrate';

/**
 * Migraciones del servicio, en orden (ADR-03). Van en el código y no en archivos .sql: se compilan con la app,
 * la imagen no necesita copiar nada más y no hay lecturas de disco con rutas armadas.
 *
 * Reglas: nunca editar una migración ya desplegada (se agrega otra) y solo cambios aditivos, para que la imagen
 * anterior siga arrancando si el deploy hace rollback.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_incidents_and_audit_logs',
    sql: `
      CREATE TABLE incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('degraded', 'maintenance')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
        title varchar(120) NOT NULL CHECK (char_length(btrim(title)) >= 3),
        description varchar(1000) NOT NULL CHECK (char_length(btrim(description)) >= 1),
        affected_services text[] NOT NULL CHECK (cardinality(affected_services) >= 1),
        created_by text NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        resolved_by text,
        resolved_at timestamptz(3),
        resolution_note varchar(1000),
        CHECK ((status = 'active') = (resolved_at IS NULL)),
        CHECK ((status = 'active') = (resolved_by IS NULL))
      );

      -- El aviso de la app lee solo los activos, en cada consulta de estado.
      CREATE INDEX incidents_active_idx ON incidents (created_at DESC) WHERE status = 'active';
      CREATE INDEX incidents_created_at_idx ON incidents (created_at DESC);

      -- Tabla de auditoría del servicio (ADR 0003 de org-docs). Se escribe en la misma transacción que la
      -- acción del staff que registra.
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        reason text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );

      CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
      CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
      CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
    `,
  },
  {
    // Bandeja y preferencias de notificación (ADR-04 del servicio, ADR 0017 de org-docs). Los valores de
    // reason y scope_type ya incluyen los de la épica de notificaciones: sumar un caso no pide migración.
    id: '002_notifications',
    sql: `
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        reason text NOT NULL CHECK (reason IN ('thread_reply', 'mention', 'dm')),
        server_id text,
        channel_id text NOT NULL,
        thread_id text,
        message_id text NOT NULL,
        actor_id text NOT NULL,
        preview varchar(140) NOT NULL DEFAULT '',
        event_id text NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        read_at timestamptz(3),
        -- Idempotencia del consumer: una entrega repetida del evento no duplica el aviso
        UNIQUE (event_id, user_id)
      );

      -- La bandeja de un usuario, de la más nueva a la más vieja (keyset por created_at, id)
      CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC, id DESC);
      -- El contador de no leídas
      CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
      -- Limpieza al borrar un canal o un servidor
      CREATE INDEX notifications_channel_idx ON notifications (channel_id);
      CREATE INDEX notifications_server_idx ON notifications (server_id) WHERE server_id IS NOT NULL;

      CREATE TABLE notification_preferences (
        user_id text NOT NULL,
        scope_type text NOT NULL CHECK (scope_type IN ('server', 'channel', 'thread')),
        scope_id text NOT NULL,
        -- Servidor al que pertenece el canal o el hilo (null en un DM): para limpiar con server.deleted
        server_id text,
        -- null = hereda del nivel de arriba (hilo -> canal -> servidor -> default)
        level text CHECK (level IN ('all', 'mentions', 'none')),
        -- Silenciar va aparte del nivel: reactivar devuelve el nivel elegido
        muted boolean NOT NULL DEFAULT false,
        muted_until timestamptz(3),
        updated_at timestamptz(3) NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, scope_type, scope_id)
      );

      -- Para la épica: "todos los mensajes" busca quién lo pidió en un canal o servidor, sin recorrer miembros
      CREATE INDEX notification_preferences_all_idx ON notification_preferences (scope_type, scope_id)
        WHERE level = 'all';
      CREATE INDEX notification_preferences_server_idx ON notification_preferences (server_id)
        WHERE server_id IS NOT NULL;
    `,
  },
  {
    // reason `message`: el nivel `all` (un mensaje cualquiera del canal o servidor). Solo amplía el CHECK: la
    // imagen anterior sigue arrancando y lee estas filas igual.
    id: '003_notification_reason_message',
    sql: `
      ALTER TABLE notifications DROP CONSTRAINT notifications_reason_check;
      ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
        CHECK (reason IN ('thread_reply', 'mention', 'dm', 'message'));
    `,
  },
  {
    // Push (ADR-08): dispositivos y el interruptor general por usuario. Tablas nuevas: la imagen anterior las
    // ignora.
    id: '004_push',
    sql: `
      CREATE TABLE push_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
        -- Expo push token en mobile; el endpoint de la suscripción en web. Un dispositivo es de un solo usuario
        token text NOT NULL UNIQUE,
        -- p256dh y auth de la suscripción web (null en mobile)
        keys jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
        CHECK ((platform = 'web') = (keys IS NOT NULL))
      );

      CREATE INDEX push_devices_user_idx ON push_devices (user_id, last_seen_at DESC);

      -- Sin fila = push_enabled true (el default no pide escribir nada por usuario)
      CREATE TABLE push_settings (
        user_id text PRIMARY KEY,
        push_enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `,
  },
];
