# Notification-Audit-Metrics-Service

Servicio de notificaciones, auditoría y métricas de Discordia (Node.js 20, TypeScript, Fastify 4 y
PostgreSQL).

**Estado actual:** tiene el servidor, la conexión a PostgreSQL, los health checks, el pipeline de CI/CD y el
**estado de la plataforma** con sus **incidentes** (`/api/v1/status`, `/api/v1/admin/status` y
`/api/v1/admin/incidents`, ver [ADR-02](docs/ADR-02-Estado-de-la-plataforma.md) y
[ADR-03](docs/ADR-03-Incidentes-y-migraciones.md)). Las tablas se crean con migraciones al arrancar.
Notificaciones, auditoría y métricas todavía no están: el Gateway ya le enruta `/api/v1/notifications`,
`/api/v1/audit` y `/api/v1/metrics` (solo `staff`), y hoy esas rutas responden `404`.

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

Un valor inválido en las `STATUS_*` corta el arranque.

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
├── config/       status.ts: lectura y validación de las STATUS_*
├── db/           migrate.ts (runner con advisory lock) y migrations.ts (las migraciones, en orden)
├── modules/
│   ├── status/   monitor en memoria, sondas HTTP, catálogo de servicios, estado combinado, vistas y rutas
│   └── incidents/ store en Postgres (con auditoría), caché de activos, vistas y rutas de staff
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
