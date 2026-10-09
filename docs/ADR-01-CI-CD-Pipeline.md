## ADR 01: Pipeline de CI y alcance de CD

**Contexto:**
El enunciado del TP exige un pipeline de CI que corra automáticamente ante cada push y **bloquee el merge** ante fallas en los tests, con cobertura mínima del 70% en los servicios backend, y recomienda incorporar análisis estático de seguridad (SAST). También exige CD (despliegue automático a producción desde `main` o por tags), documentado. No existía ningún workflow de CI/CD ni carpeta `docs/` en este repo todavía — es el primer ADR de `Notification-Audit-Metrics-Service`.

**Decisión:**

* **Cliente de Postgres:** `pg` (node-postgres) directo, sin ORM — el esqueleto solo necesita conectividad para `/readyz` (`SELECT 1`), no hay tablas creadas todavía (`notification_db`: `notifications`, `notification_preferences`, `audit_logs`, per ADR 0003 del org — su creación queda para otro issue). Se descartó agregar Prisma/Kysely con su propio sistema de migraciones por ser alcance de otro trabajo, no de "armar el esqueleto + CI".
* **`/readyz` con timeout acotado desde el diseño, no como fix posterior** — a diferencia de Voice-Signaling-Session-Service (donde el cuelgue de `/readyz` se encontró como bug ya con Redis), acá se aplicó `withTimeout` + `connectionTimeoutMillis` desde el primer commit. Con `pg` el timeout resultó menos crítico que con `redis` v4: `pg` no reintenta conectar solo (a diferencia del `reconnectStrategy` de `redis`), así que ante un Postgres inalcanzable el `pool.query` rechaza casi al instante (`ECONNREFUSED`) — el timeout sigue siendo necesario para el caso de un contenedor "parado" pero con la red activa, donde sí puede demorar.
* **Test runner, lint, cobertura:** mismos que los otros dos servicios Node — `node:test` (vía `tsx --test`) + `c8` (gate 85%), ESLint flat config con `typescript-eslint` + `eslint-plugin-security`.
* **Tests sin mutar `process.env`** — `buildApp({ databaseUrl })` acepta la URL de conexión como parámetro desde el primer commit, evitando la carrera entre tests concurrentes que se encontró (y corrigió) en Voice-Signaling-Session-Service.
* **SAST:** `eslint-plugin-security` (integrado al lint) + `npm audit --audit-level=high`, informativo (no bloquea el merge) — mismas vulnerabilidades conocidas de `fastify@4.x` que en los otros dos servicios.
* **Servicio en CI:** `postgres:16-alpine` como service container, usado de verdad por los tests de `/readyz`.
* **`DATABASE_URL` alineado con el orquestador raíz** — `discordia-orchestrator/docker-compose.yml` ya define este servicio con `DATABASE_URL=postgresql://postgres:password@notification-db:5432/notification_db` (string único, no variables separadas). El código y el `docker-compose.yml` local de este repo usan el mismo nombre de variable, evitando desde el diseño el mismatch que se encontró y corrigió en Auth-User-Service (que esperaba variables separadas mientras el orquestador le pasaba `DATABASE_URL`).
* **Build de imagen:** job separado `docker-build`, sin push — no hay registry/target de deploy configurado todavía. Verificado además compilando y corriendo a través del `docker-compose.yml` del orquestador raíz, no solo con el compose local.
* **Bloqueo de merge:** el job `test` se configura como *required status check* en `main`/`develop` desde GitHub, una vez confirmada una corrida verde real en un PR. El merge nunca es automático.

**CD — explícitamente fuera de alcance de este ADR:**
El enunciado exige documentar en un ADR la elección de plataforma de despliegue antes de automatizar el deploy. A la fecha de este ADR no existe esa decisión en `docs/architecture/decisions/` del repo `.github` — mismo motivo por el que CD quedó pendiente en los otros tres servicios. **CD queda pendiente** hasta que exista esa decisión.

**Consecuencias:**

* El pipeline queda verde con 4 tests reales (health checks, incluyendo el caso de falla de Postgres) — la cobertura del 85% se alcanza porque `app.ts` es casi todo lo que hay hoy. Cuando se implemente el consumer real de RabbitMQ (`notification_events_queue`) y se creen las tablas de `notification_db`, el umbral va a exigir tests reales de esa lógica.
* No hay tablas ni migraciones todavía — cuando se agreguen, habrá que decidir además la herramienta de migración para Node/`pg` (ej. `node-pg-migrate` o similar), algo que este ADR no resuelve.
* Cuando exista un ADR de infraestructura de despliegue, este ADR debe actualizarse (o crearse uno nuevo) agregando el job de CD correspondiente.
