# Notification-Audit-Metrics-Service

Servicio de notificaciones, auditoría y métricas de Discordia (Node.js 26, TypeScript, Fastify 5 y
PostgreSQL).

**Estado actual:** tiene el servidor, la conexión a PostgreSQL, los health checks, el pipeline de CI/CD, el
**estado de la plataforma** con sus **incidentes** (`/api/v1/status`, `/api/v1/admin/status` y
`/api/v1/admin/incidents`, ver [ADR-02](docs/ADR-02-Estado-de-la-plataforma.md) y
[ADR-03](docs/ADR-03-Incidentes-y-migraciones.md)), y el **registro de auditoría de moderación de servidores**
(`GET /api/v1/servers/:serverId/audit-logs`, ver [ADR-04](docs/ADR-04-Registro-de-auditoria-de-servidores.md)),
y las **métricas globales** del backoffice (`GET /api/v1/admin/metrics`, ver
[ADR-05](docs/ADR-05-Metricas-globales.md)), y la **bandeja y las preferencias de notificación**
(`/api/v1/notifications`, ver [ADR-07](docs/ADR-07-Notificaciones-y-preferencias.md)). Hoy solo se generan
avisos de respuestas en hilos; menciones, DMs y push son de la épica de notificaciones.

## Requisitos

- Node.js 20 (la versión de la imagen y del CI) y npm.
- Docker, para PostgreSQL.

## Levantarlo en local

### Todo en contenedores

```bash
docker compose up -d --build
curl localhost:3001/readyz        # {"status":"ready"}
```

`docker-compose.yml` levanta el servicio en `localhost:3001` y PostgreSQL en `localhost:5434` (usuario
`postgres`, contraseña `password`, base `notification_db`). Bajarlo: `docker compose down` (con `-v` también
borra los datos).

### Desde el host, con recarga en caliente

```bash
npm install
docker compose up -d notification_db

# El servicio no lee .env: las variables van exportadas o en la línea
export DATABASE_URL=postgresql://postgres:password@localhost:5434/notification_db
npm run dev                        # escucha en localhost:3000
```

### Con el resto del sistema

Para levantarlo junto con el Gateway y los demás servicios, usar el compose del orquestador
(`discordia-orchestrator/deploy/docker-compose.yml`, profile `local`). Ahí se llama `notification-service`,
publica el 3001 y usa la base `notification_db` del Postgres compartido (en producción, el RDS).

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP |
| `DATABASE_URL` | `postgresql://postgres:password@127.0.0.1:5432/notification_db` | PostgreSQL. En producción lleva `?sslmode=no-verify`: el RDS exige TLS y la imagen no trae la CA de Amazon |
| `STATUS_GATEWAY_URL` | (sin definir) | Base de Kong para las sondas de estado (`https://10.0.1.10:443` en prod, `https://host.docker.internal:8443` en local). Sin definir, los servicios que se sondean vía Kong quedan `unknown` |
| `STATUS_TLS_INSECURE` | `false` | `true` desactiva la verificación del certificado **solo** en las sondas de estado (el Origin Certificate de Cloudflare y el autofirmado local no los valida Node) |
| `STATUS_POLL_INTERVAL_MS` | `15000` | Cada cuánto se sondea (1000 a 3600000) |
| `STATUS_PROBE_TIMEOUT_MS` | `2000` | Timeout de cada sonda (100 a 60000, menor que el intervalo) |
| `RABBITMQ_URL` | `amqp://admin:admin@rabbitmq:5672/` | Conexión al broker RabbitMQ para consumir eventos de auditoría |
| `SERVER_ROLES_URL` | `http://localhost:8000` | URL interna de Server-Roles-Core para validación de permisos de moderador |
| `CHAT_ENGINE_URL` | `http://localhost:3000` | Base de Chat-Engine para las métricas (`/internal/metrics/messages`). En prod, mismo nodo realtime |
| `CORE_SERVICE_URL` | `http://localhost:8002` | Base de Server-Roles-Core para las métricas (`/internal/metrics/servers`). En prod, `http://<EDGE_HOST>:8002` |
| `RABBITMQ_MESSAGE_QUEUE` | `notification_message_events` | Cola de `chat.message.created`, `channel.deleted` y `server.deleted` (aparte de la de auditoría). Lo que falla va a `<cola>.dlq` |
| `INTERNAL_API_TOKEN` | (sin definir) | Secreto compartido con Chat para avisar en vivo por `/internal/inbox/events` (header `X-Internal-Token`). Tiene que ser el mismo que el de Chat |

Un valor inválido en las `STATUS_*`, `CHAT_ENGINE_URL` o `CORE_SERVICE_URL` corta el arranque.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/livez` | El proceso está vivo, sin I/O: `{"status":"alive"}` |
| `GET` | `/readyz` | `SELECT 1` contra PostgreSQL (timeout de 2 s). `200 {"status":"ready"}` o `503 {"status":"not_ready","detail":...}` |
| `GET` | `/api/v1/status` | Estado de la plataforma e incidentes activos, **público** (historia 74, CA1 y CA3) |
| `GET` | `/api/v1/admin/status` | Estado con detalle técnico, solo `staff` (`X-User-Role: staff`, si no `403 application/problem+json`) |
| `POST` | `/api/v1/admin/incidents` | Publicar un incidente, solo `staff` (CA1) |
| `GET` | `/api/v1/admin/incidents` | Historial (`?status=active\|resolved&limit=1..100&before=<ISO>`), solo `staff` |
| `POST` | `/api/v1/admin/incidents/{id}/resolve` | Resolver (`{"note"?}`), solo `staff` (CA2). `404` si no existe, `409` si ya estaba resuelto |
| `GET` | `/api/v1/admin/metrics` | Métricas globales del período (`?from=<ISO>&to=<ISO>`), solo `staff` ([ADR-05](docs/ADR-05-Metricas-globales.md)) |
| `GET` | `/api/v1/servers/{serverId}/metrics` | Métricas de actividad del servidor (`?days=` o `?from=&to=`), solo dueño, `ADMINISTRATOR` o `MANAGE_SERVER`. Con `?format=csv`, la serie diaria como archivo CSV descargable ([ADR-06](docs/ADR-06-Exportacion-de-metricas-a-CSV.md)) |
| `GET` | `/api/v1/servers/{serverId}/audit-logs` | Registro de auditoría de moderación de un servidor (HU 61, [ADR-04](docs/ADR-04-Registro-de-auditoria-de-servidores.md)) |
| `GET` | `/api/v1/notifications` | Bandeja del usuario (`?unread=true&limit=1..50&before=<id>`): `{ items, unreadCount, nextCursor }` ([ADR-07](docs/ADR-07-Notificaciones-y-preferencias.md)) |
| `POST` | `/api/v1/notifications/{id}/read` | Marca una leída: `204`, `404` si no existe o es de otro |
| `POST` | `/api/v1/notifications/read-all` | Marca todas leídas: `204` |
| `GET` | `/api/v1/notifications/preferences` | Preferencias del usuario: `{ items }` |
| `PUT` | `/api/v1/notifications/preferences/{server\|channel\|thread}/{scopeId}` | Crea o cambia una preferencia (`{ level?, muted?, mutedUntil?, serverId? }`); solo cambia lo que llega |
| `DELETE` | `/api/v1/notifications/preferences/{server\|channel\|thread}/{scopeId}` | Vuelve al default: `204` |

El contrato completo está en [`docs/openapi.yaml`](docs/openapi.yaml).

### Estado de la plataforma

Un monitor en memoria sondea en paralelo cada `STATUS_POLL_INTERVAL_MS` el `/readyz` de cada servicio a través
de Kong (`{STATUS_GATEWAY_URL}/readyz` para el propio Kong y `/internal/readyz/{auth|server-roles|chat|voice|payments}`
para el resto). Este servicio se mide a sí mismo con el mismo chequeo de `/readyz`, sin pasar por Kong. Los
endpoints devuelven el último resultado guardado: ninguna request dispara sondas. Ambos con
`cache-control: no-store`.

- Por servicio: `2xx` → `operational`; timeout, error de red o no-2xx → `degraded`; nunca chequeado o sonda no
  configurada → `unknown`.
- Global: `degraded` si alguno lo está; si no, `unknown` si alguno lo está; si no, `operational`.

```text
GET /api/v1/status
{ status, checkedAt, services: [{ id, name, status }],
  incidents: [{ id, kind, title, description, affectedServices, startedAt }] }

GET /api/v1/admin/status
{ status, checkedAt, services: [{ id, name, status, httpStatus, latencyMs, checkedAt, since, error }] }
```

`checkedAt` global es el fin de la última ronda (`null` antes de la primera). `since` es desde cuándo el
servicio está en el estado actual. `error` es `null` o un código fijo (`timeout`, `connection_refused`,
`http_5xx`, `http_4xx`, `invalid_response`): nunca el mensaje de la excepción ni el body del upstream.

Probarlo en local (con `npm run dev`, puerto 3000):

```bash
curl -s localhost:3000/api/v1/status | jq
curl -si localhost:3000/api/v1/admin/status                          # 403 problem+json
curl -s -H 'X-User-Role: staff' localhost:3000/api/v1/admin/status | jq
```

### Incidentes

El staff publica un incidente (`degraded` o `maintenance`) con título (3 a 120), descripción (hasta 1000) y
servicios afectados (ids del catálogo de arriba). Mientras está activo, sale en `GET /api/v1/status` y cambia el
estado: por servicio, un mantenimiento gana; si no, `degraded` si lo dice un incidente o la sonda. Global:
`degraded` > `maintenance` > `unknown` > `operational`. Cada publicación y cierre queda en `audit_logs` en la
misma transacción. Escribir necesita `X-User-Id` además del rol (el autor de la auditoría).

```bash
curl -s -X POST localhost:3000/api/v1/admin/incidents \
  -H 'X-User-Role: staff' -H 'X-User-Id: auth0|local' -H 'content-type: application/json' \
  -d '{"title":"Demoras en la voz","description":"Los canales tardan en conectar","kind":"degraded","affectedServices":["voice"]}' | jq
curl -s localhost:3000/api/v1/status | jq '.status, .incidents'
curl -s -X POST localhost:3000/api/v1/admin/incidents/<id>/resolve \
  -H 'X-User-Role: staff' -H 'X-User-Id: auth0|local' -H 'content-type: application/json' -d '{"note":"listo"}' | jq
```

El header `X-User-Role` a mano es **solo para local**, llamando directo al servicio. A través de Kong el header
del cliente se borra y lo pone el Gateway desde el token: `/api/v1/admin/status` necesita un access token con
rol `staff` (ADR-002 del Gateway). Lo mismo para `/api/v1/admin/incidents`. Sin `STATUS_GATEWAY_URL` todo lo que va por Kong sale `unknown`; para
sondear el Kong local: `STATUS_GATEWAY_URL=https://localhost:8443 STATUS_TLS_INSECURE=true npm run dev`.

### Métricas globales

Para el backoffice: usuarios activos, servidores creados y mensajes enviados en toda la plataforma, en el
período `[from, to)`. Sin parámetros, los últimos 30 días (`to` = ahora, al minuto). `400 problem+json` si una
fecha no es ISO 8601, si `from >= to` o si el período supera 366 días. Necesita `X-User-Id` (si no, `401`) y
`X-User-Role: staff` (si no, `403`).

El servicio no guarda nada: en cada request consulta en paralelo a Chat (`/internal/metrics/messages`) y a
Server-Roles (`/internal/metrics/servers`), con 2 s de timeout cada una. Si una no responde, sus campos van en
`null`, `partial` en `true`, se loguea un `warn` y la respuesta es `200` igual. Las respuestas completas se
reusan 60 s para el mismo período.

```text
GET /api/v1/admin/metrics?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z
{ from, to, activeUsers, serversCreated, messagesSent, partial }
```

```bash
curl -s -H 'X-User-Role: staff' -H 'X-User-Id: auth0|local' \
  'localhost:3000/api/v1/admin/metrics?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z' | jq
curl -si -H 'X-User-Role: user' -H 'X-User-Id: auth0|local' localhost:3000/api/v1/admin/metrics   # 403
```

Un offset con `+` en la query va como `%2B` (sin codificar, `+` llega como espacio y es `400`).

### Notificaciones

Bandeja y preferencias del usuario (historia "Responder en un hilo", CA5). Todas las rutas necesitan
`X-User-Id` (lo pone Kong; sin él, `401`) y cada usuario solo ve y cambia lo suyo.

- **Qué genera avisos:** `chat.message.created` de Chat con `thread_participant_ids` (una respuesta en un
  hilo). Se avisa a los participantes menos el autor, según sus preferencias. Una entrega repetida no duplica
  (`UNIQUE (event_id, user_id)`).
- **Preferencias:** por `server`, `channel` (también un DM, `dm-…`) o `thread`. `level` (`all`, `mentions`,
  `none`, o `null` para heredar) y `muted`/`mutedUntil` van por separado: silenciar y reactivar no cambian el
  nivel. Se aplica la más específica (hilo → canal → servidor → default: `mentions` en servidores, `all` en
  DMs); un silencio vigente en cualquier nivel silencia todo lo de abajo. Una respuesta en un hilo tuyo pasa
  con `mentions`.
- **Entrega:** se guarda en `notifications` (la fuente de verdad) y se avisa en vivo con `NOTIFICATION_CREATED`
  por el inbox de Chat (`/internal/inbox/events`, lotes de 10, sin reintento). Si Chat no responde, el aviso
  igual queda en la bandeja.
- **Retención:** al arrancar y cada 6 h se borran las leídas de más de 30 días y todas las de más de 90.
  `channel.deleted` y `server.deleted` borran avisos y preferencias de ese canal o servidor.

```bash
curl -s -H 'X-User-Id: auth0|local' 'localhost:3000/api/v1/notifications?unread=true' | jq
curl -s -X PUT -H 'X-User-Id: auth0|local' -H 'content-type: application/json' \
  -d '{"muted":true}' localhost:3000/api/v1/notifications/preferences/thread/<id del mensaje raíz> | jq
```

## Tests, lint y seguridad

Los mismos comandos que corre el CI:

```bash
npm run lint                   # ESLint, con reglas de seguridad
npm run typecheck              # tsc --noEmit
npm audit --audit-level=high   # dependencias con vulnerabilidades (en el CI no bloquea)
npm run test:coverage          # tests + cobertura (mínimo 85 %, ver ADR-01)
```

**Los tests necesitan PostgreSQL**: el de `/readyz` y los de migraciones, incidentes y auditoría. Cada archivo
de tests usa un schema propio (`test_<random>`) que borra al terminar, así corren en paralelo sin pisarse. Con la
base del compose:

```bash
docker compose up -d notification_db
DATABASE_URL=postgresql://postgres:password@localhost:5434/notification_db npm run test:coverage
```

## Estructura

```text
src/
├── server.ts     arranque
├── app.ts        app de Fastify, pool de PostgreSQL, /livez, /readyz, migraciones y registro de los módulos
├── config/       status.ts y metrics.ts: lectura y validación de las STATUS_* y de las URLs de las métricas
├── db/           migrate.ts (runner con advisory lock) y migrations.ts (las migraciones, en orden)
├── modules/
│   ├── status/   monitor en memoria, sondas HTTP, catálogo de servicios, estado combinado, vistas y rutas
│   ├── incidents/ store en Postgres (con auditoría), caché de activos, vistas y rutas de staff
│   ├── audit/     almacenamiento en Postgres, consumidor RabbitMQ, permisos y endpoint de auditoría de servidores
│   ├── metrics/   métricas globales: período, consulta a Chat y Server-Roles, caché de 60 s y ruta de staff
│   └── notifications/ reglas de preferencia (puras), consumer con DLQ, bandeja en Postgres, aviso por el inbox de Chat y rutas
├── utils/        db-check.ts (SELECT 1 con timeout) y problem.ts (respuestas application/problem+json)
├── plugins/      (vacío)
tests/
```

## CI/CD

`.github/workflows/ci.yml`, en cada push y PR a `main` y `develop`:

1. `test`: lint, typecheck y tests con cobertura, contra un PostgreSQL de servicio. `npm audit` se muestra
   en el log pero no bloquea.
2. `docker`: construye la imagen; en push la publica como `ghcr.io/discordia-g12/notification-service:<sha>`.
3. `deploy`: en push a `main`, la despliega en el nodo **realtime** con el workflow del orquestador. Si no
   queda sana, vuelve sola a la versión anterior.

## Decisiones de arquitectura

| ADR | Tema |
|-----|------|
| [ADR-01](docs/ADR-01-CI-CD-Pipeline.md) | Pipeline de CI/CD |
| [ADR-02](docs/ADR-02-Estado-de-la-plataforma.md) | Estado de la plataforma por sondeo de `/readyz` vía Kong |
| [ADR-03](docs/ADR-03-Incidentes-y-migraciones.md) | Incidentes de la plataforma, migraciones y auditoría |
| [ADR-04](docs/ADR-04-Registro-de-auditoria-de-servidores.md) | Registro de auditoría de moderación de servidores y consumo de eventos (HU 61) |
| [ADR-05](docs/ADR-05-Metricas-globales.md) | Métricas globales del backoffice por consulta síncrona a Chat y Server-Roles |
| [ADR-06](docs/ADR-06-Exportacion-de-metricas-a-CSV.md) | Exportación de métricas a CSV |
| [ADR-07](docs/ADR-07-Notificaciones-y-preferencias.md) | Bandeja y preferencias de notificación, consumo de `chat.message.created` |
