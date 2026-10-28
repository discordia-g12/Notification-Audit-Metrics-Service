# Notification-Audit-Metrics-Service

Servicio de notificaciones, auditoría y métricas de Discordia (Node.js 20, TypeScript, Fastify 4 y
PostgreSQL).

**Estado actual: es un esqueleto.** Tiene el servidor, la conexión a PostgreSQL, los health checks, los tests y
el pipeline de CI/CD, pero todavía no tiene funcionalidad (`src/modules/` está vacío). El Gateway ya le
enruta `/api/v1/notifications`, `/api/v1/audit` y `/api/v1/metrics` (solo `staff`) y `/api/v1/status`
(pública): hoy esas rutas responden `404`.

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

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/livez` | El proceso está vivo, sin I/O: `{"status":"alive"}` |
| `GET` | `/readyz` | `SELECT 1` contra PostgreSQL (timeout de 2 s). `200 {"status":"ready"}` o `503 {"status":"not_ready","detail":...}` |

## Tests, lint y seguridad

Los mismos comandos que corre el CI:

```bash
npm run lint                   # ESLint, con reglas de seguridad
npm run typecheck              # tsc --noEmit
npm audit --audit-level=high   # dependencias con vulnerabilidades (en el CI no bloquea)
npm run test:coverage          # tests + cobertura (mínimo 85 %, ver ADR-01)
```

**Un test necesita PostgreSQL** (el de `/readyz` con la base disponible). Con la base del compose:

```bash
docker compose up -d notification_db
DATABASE_URL=postgresql://postgres:password@localhost:5434/notification_db npm run test:coverage
```

## Estructura

```text
src/
├── server.ts     arranque
├── app.ts        app de Fastify, pool de PostgreSQL, /livez y /readyz
├── modules/      (vacío) acá van las notificaciones, la auditoría y las métricas
├── config/, plugins/, utils/   (vacíos)
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
