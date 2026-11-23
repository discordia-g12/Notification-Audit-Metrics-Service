# ADR 04: Registro de auditoría de moderación de servidores y consumo de eventos

- **Estado:** Aceptado
- **Fecha:** 2026-11-10
- **Alcance:** Notification-Audit-Metrics-Service (`GET /api/v1/servers/:serverId/audit-logs`, tabla `server_audit_logs`, cola `notification_audit_events`), Server-Roles-Core-Service (eventos outbox, endpoint interno de permisos), Chat-Engine-Service (evento `message.deleted_by_moderator`), Gateway (Kong), Discordia-WebApp
- **Relacionado:** ADR 0003 de org-docs (`notification_db`), ADR 0004 de org-docs (Outbox pattern), ADR-01 (cliente `pg` sin ORM), ADR-03 (incidentes y migraciones)

## Contexto

La historia 61 ("Ver registro de auditoría de moderación", Épica Moderación) exige un registro histórico inmutable de las acciones de moderación realizadas en cada servidor de Discordia, accesible únicamente por los dueños del servidor y miembros con permisos de moderación (`ADMINISTRATOR`, `MANAGE_SERVER`, `BAN_MEMBERS`, `KICK_MEMBERS`, `MODERATE_MEMBERS`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_MESSAGES`).

Las acciones a auditar abarcan:
1. **Miembros:** bans, unbans, kicks, mutes (timeout), unmutes, asignación y remoción de roles.
2. **Roles:** creación, edición de nombre/color, actualización de permisos y eliminación.
3. **Canales y categorías:** creación, edición de propiedades/nombre/posición y eliminación.
4. **Configuración del servidor:** cambio de nombre, descripción, ícono, banner y transferencia de propiedad.
5. **Invitaciones:** creación y revocación.
6. **Mensajes:** eliminación de mensajes de otros usuarios por moderadores en `Chat-Engine-Service`.

## Decisión

### 1. Almacenamiento desacoplado en `server_audit_logs`

- Se crea la tabla `server_audit_logs` en `notification_db`, separada de la tabla `audit_logs` de plataforma (ADR-03).
- **Esquema:**
  - `id`: identificador único (UUID).
  - `event_id`: ID del evento original (para garantizar **idempotencia** ante reintentos de mensajería: `UNIQUE` con `ON CONFLICT (event_id) DO NOTHING`).
  - `server_id`: UUID del servidor de Discordia.
  - `category`: categoría de la acción (`member`, `role`, `channel`, `category`, `server`, `invite`, `message`).
  - `action`: identificador específico (`member_ban`, `channel_create`, `role_permissions_updated`, `message_delete`, etc.).
  - `actor_id`: usuario que ejecutó la acción (moderador / dueño / sistema).
  - `target_id`: entidad afectada (usuario sancionado, ID de canal, ID de rol, etc.).
  - `reason`: motivo opcional ingresado por el moderador (ej. motivo del ban/kick).
  - `changes`: diff estructurado (`{"campo": {"old": valor, "new": valor}}`).
  - `metadata`: información complementaria (nombre de canal, código de invitación, etc.).
  - `created_at`: timestamp con zona horaria (`timestamptz`).
- **Índices:**
  - Índice cronológico compuesto `(server_id, created_at DESC)` para listar la línea de tiempo.
  - Índices para filtros combinados: `(server_id, category)`, `(server_id, action)`, `(server_id, actor_id)`.

### 2. Ingesta asíncrona mediante RabbitMQ (`AuditConsumer`)

- Consumidor asíncrono con cola durable `notification_audit_events.v2` ligada al exchange `server.events` de RabbitMQ,
  con `prefetch(10)` y DLQ (`notification_audit_events.v2.dlq`): un evento que no se puede procesar (JSON roto,
  error de base) se rechaza sin reencolar y queda en la DLQ para revisarlo, en vez de perderse.
- *Cambio posterior (D5):* la cola original `notification_audit_events` no tenía DLQ, y RabbitMQ no deja agregarle
  argumentos a una cola existente. Al conectar, el consumidor declara la nueva, le saca los bindings a la vieja y
  la borra si está vacía; si tiene mensajes, los consume hasta vaciarla y la borra en el próximo arranque.
- Escucha 22 claves de enrutamiento (`member.*`, `channel.*`, `category.*`, `role.*`, `server.*`, `invite.*`, `message.deleted_by_moderator`).
- Desacoplamiento total: los servicios emisores (`Server-Roles-Core-Service` y `Chat-Engine-Service`) escriben en su outbox transaccional y continúan sin esperar la auditoría.
- Si RabbitMQ no está disponible al iniciar o se interrumpe la conexión, el consumidor reintenta automáticamente con backoff exponencial sin frenar el arranque del servicio.

### 3. Autorización y verificación de permisos

- El endpoint exige `X-User-Id` (inyectado por el Gateway a partir del JWT; responde `401` si falta).
- Verifica permisos consultando de forma síncrona el endpoint interno de `Server-Roles-Core-Service`:
  `GET /internal/servers/{server_id}/members/{user_id}/permissions`.
- Se autoriza si el usuario es `is_owner: true` o `can_moderate: true` (calculado con la máscara de bits de permisos de moderador).
- Si el usuario no tiene permisos: `403 Forbidden` (`application/problem+json`).
- Si el servidor no existe: `404 Not Found`. Si `Server-Roles` no responde: `503 Service Unavailable`.

### 4. API de consulta y paginación

- `GET /api/v1/servers/:serverId/audit-logs`
- Soporta filtros: `category`, `action`, `actorId`, `targetId`.
- Paginación por cursor hacia atrás (`before` timestamp ISO + `limit`), devolviendo `{ items, nextBefore, hasMore }`, optimizada para scroll infinito en clientes Web y Mobile.
- Headers: `Cache-Control: no-store, private` (los registros son sensibles y actualizados en tiempo real).

## Alternativas descartadas

| Alternativa | Motivo de descarte |
| --- | --- |
| Almacenar la auditoría en `Server-Roles-Core-Service` | Sobrecarga la base transaccional OLTP de servidores con histórico de lectura pesada, y obligaría a `Chat-Engine` a llamar a `Server-Roles` cada vez que se borra un mensaje. |
| Reutilizar la tabla `audit_logs` de incidentes de staff | La auditoría de plataforma (ADR-03) es de ámbito global y de operaciones DevOps, mientras que la de servidores requiere particionamiento lógico por `server_id`, categorías específicas de Discord y estructuras de diffs de configuración. |
| Consultas sincrónicas HTTP entre microservicios para registrar eventos | Acoplamiento temporal; si el servicio de auditoría se reinicia, bloquearía o ralentizaría las acciones de moderación de los usuarios. RabbitMQ garantiza entrega garantizada y amortiguación de picos. |
| Paginación tradicional por `offset` | En tablas de auditoría con inserciones frecuentes, `offset` saltea o duplica filas ante nuevas inserciones; la paginación por cursor `(created_at, id)` es determinística y performante. |

## Consecuencias

- `Notification-Audit-Metrics-Service` asume plenamente la responsabilidad del componente de **Auditoría** de su nombre.
- El servicio requiere configuración de `RABBITMQ_URL` y `SERVER_ROLES_URL`.
- La ingesta es eventual: una acción de moderación puede demorar unos pocos milisegundos en verse reflejada en el log mientras el evento viaja por RabbitMQ.
