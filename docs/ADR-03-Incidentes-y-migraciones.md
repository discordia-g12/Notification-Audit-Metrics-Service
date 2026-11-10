# ADR 03: Incidentes de la plataforma y migraciones del servicio

- **Estado:** Aceptado
- **Fecha:** 2026-11-10
- **Alcance:** este servicio (`/api/v1/admin/incidents`, `/api/v1/status`, tablas `incidents` y `audit_logs`),
  Gateway (ruta `admin-incidents`), Discordia-WebApp (backoffice, aviso y vista de estado de la web)
- **Relacionado:** ADR-01 (sin migraciones), ADR-02 (estado por sondeo), ADR-002 del Gateway (rol staff),
  ADR 0003 de org-docs (`notification_db`)

## Contexto

La historia 74 pide que el staff publique incidentes (degradación o mantenimiento) con título, descripción y
servicios afectados, que los usuarios con sesión vean un aviso mientras estén activos (CA1), que desaparezca al
resolverlos (CA2), que se pueda consultar el estado actual (CA3) y que quien no es staff no pueda hacerlo (CA4).
Se valora que el backoffice sugiera un incidente cuando un health check informa degradación.

ADR-02 resolvió CA3 con el sondeo de `/readyz` en memoria y dejó CA1/CA2 pendientes: necesitan persistencia y
el servicio no tenía tablas ni herramienta de migraciones (ADR-01).

## Decisión

### 1. Migraciones: runner propio sobre `pg`

- Las migraciones son SQL que solo avanza, en `src/db/migrations.ts` (una lista ordenada `{ id, sql }`). Van en
  el código: se compilan con la app, la imagen no copia nada más y no hay lecturas de disco con rutas armadas.
- `src/db/migrate.ts` las aplica al arrancar (`buildApp({ migrate: true })`, lo usa `server.ts`), antes del
  monitor y del `listen`: toma `pg_advisory_lock`, crea `schema_migrations` si falta y aplica cada pendiente en
  su propia transacción junto con su registro. Si una falla, hace rollback y el proceso no arranca: el contenedor
  no queda `healthy` y el deploy vuelve a la imagen anterior.
- Ids registrados que el código no conoce (la base quedó adelante después de un rollback de imagen) solo se
  avisan en el log. Por eso las migraciones tienen que ser aditivas: la versión anterior tiene que seguir
  arrancando con el esquema nuevo. Una migración desplegada no se edita: se agrega otra.

### 2. Modelo

- `incidents`: `id` (uuid), `kind` (`degraded` | `maintenance`), `status` (`active` | `resolved`), `title`
  (3 a 120), `description` (1 a 1000), `affected_services` (`text[]`, al menos uno), `created_by`, `created_at`,
  `resolved_by`, `resolved_at`, `resolution_note`. Los `CHECK` repiten las reglas de la API y atan `status` con
  los campos de cierre. Índice parcial sobre los activos (lo lee cada consulta de estado).
- El historial es la misma tabla: un incidente resuelto no se borra ni se reabre (si vuelve a pasar, es otro).
- Los servicios afectados son los ids de `SERVICE_CATALOG`: los que exponen health checks, como pide la
  consigna. Se validan contra el catálogo y se guardan en su orden.
- `audit_logs` (la tabla de ADR 0003): `actor_id`, `action` (`incident.created`, `incident.resolved`),
  `target_type`, `target_id`, `reason` (la nota de cierre), `metadata` (jsonb) y fecha.

### 3. Endpoints

| Método | Ruta | Quién | Respuesta |
| --- | --- | --- | --- |
| `POST` | `/api/v1/admin/incidents` | staff | `201` con el incidente y `Location` |
| `GET` | `/api/v1/admin/incidents?status=&limit=&before=` | staff | `{ items, nextBefore }`, más nuevos primero |
| `POST` | `/api/v1/admin/incidents/{id}/resolve` | staff | `200`; `404` si no existe; `409` si ya estaba resuelto |
| `GET` | `/api/v1/status` | público | ahora suma `incidents` (activos) y el estado combinado |

- Kong exige `staff` en la ruta `admin-incidents` y el servicio vuelve a chequear `X-User-Role` **antes** de
  validar el body (un no staff recibe `403`, nunca un `400` que le describa el esquema). Escribir además exige
  `X-User-Id`: sin autor no hay auditoría.
- Validación con el esquema de Fastify más el recorte de espacios (un título de solo espacios no pasa). Todos
  los errores salen como `application/problem+json` (los `400` con `errors: [{ field, message }]`); un `500`
  nunca lleva el mensaje del driver.
- Resolver usa `UPDATE ... WHERE status = 'active'`: si dos staff resuelven a la vez, gana uno y el otro recibe
  `409`.
- La vista pública del incidente no tiene autor ni datos de cierre.

### 4. Estado combinado

Por servicio: un mantenimiento activo que lo incluye gana (el servicio puede estar caído a propósito); si no,
`degraded` si lo dice un incidente o la sonda; si no, lo que diga la sonda. Global: `degraded` > `maintenance` >
`unknown` > `operational`. Solo lo ve la vista pública; `/api/v1/admin/status` sigue siendo el sondeo crudo,
que es lo que necesita el staff para decidir (y para la sugerencia).

### 5. Cómo llega el aviso: polling del estado público

La web pide `GET /api/v1/status` cada 60 s mientras la pestaña está visible, y otra vez al volver a ella. Un
incidente publicado o resuelto se ve en menos de un minuto. Los activos se leen con una caché de 5 s por réplica
(se invalida al publicar o resolver en esa réplica): la base recibe como mucho una consulta cada 5 s, haya los
usuarios que haya. Si la base falla se sirve el último valor conocido y el estado sondeado sigue saliendo.

### 6. Sugerencia de incidente

La calcula el backoffice: cruza `/api/v1/admin/status` (sondeo crudo) con los incidentes activos. Un servicio
`degraded` que ningún activo cubre aparece como sugerencia con "_publicar incidente" (completa el formulario con
el servicio, tipo degradación y un título) o "_descartar" (hasta que el servicio se recupere y vuelva a caer).

### 7. Auditoría

Cada publicación y cada cierre escribe en `audit_logs` **en la misma transacción** que el cambio: o quedan los
dos o ninguno. La regla 6 del checklist del Gateway pide mandar la auditoría por el Outbox hacia este servicio;
acá la acción ocurre en el propio servicio de auditoría, así que se escribe directo.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
| --- | --- |
| `node-pg-migrate` | La versión actual (v9) es solo ESM (`"type": "module"`) y el servicio compila a CommonJS. Para dos tablas y SQL que solo avanza, un runner de ~80 líneas con lock y transacción alcanza y queda cubierto por tests. |
| Knex o Prisma | Traen un query builder u ORM entero (y un paso de generación en Prisma) que el servicio no usa: `pg` directo, como dice ADR-01. |
| SQL de inicio del compose (`docker-entrypoint-initdb.d`) | Solo corre en una base nueva, no versiona y no existe en RDS. |
| Migrar en un job o contenedor aparte antes del deploy | Otro paso en `deploy-service.sh` y otra imagen. Con el advisory lock, migrar al arrancar es seguro con varias réplicas y el rollback del deploy ya cubre el fallo. |
| Evento por RabbitMQ y WebSocket de Chat-Engine para el aviso | Aviso instantáneo, pero acopla el estado de la plataforma a Chat (si Chat está caído, que es justo cuando hay incidentes, no llega) y este servicio todavía no tiene RabbitMQ ni Outbox. CA2 no pide inmediatez. |
| Polling del endpoint de staff desde la web | La web no tiene permisos de staff, y el detalle técnico no debe salir a usuarios. |
| Calcular la sugerencia en el backend (`suggestions` en `/admin/status`) | Es una regla de presentación: el backend ya expone los dos datos y el descarte es por sesión del staff. |
| Borrar el incidente al resolverlo | Se pierde el historial y la auditoría queda apuntando a nada. |
| Mandar la auditoría por Outbox a sí mismo | Una cola para hablar con uno mismo: la transacción local da la misma garantía sin infraestructura nueva. |

## Consecuencias

- El servicio tiene tablas y migraciones: el próximo cambio de esquema es agregar una entrada a `MIGRATIONS`.
- Arrancar necesita Postgres alcanzable: si la base no responde al arrancar, el contenedor no queda `healthy`
  (antes arrancaba igual con `/readyz` en 503). El usuario de la base necesita permiso de `CREATE` en
  `notification_db` (en local y en el RDS es el dueño).
- El aviso tiene hasta ~65 s de atraso (60 s de polling más 5 s de caché). Con varias réplicas, cada una puede
  tardar hasta 5 s más en ver un cambio hecho en otra.
- El estado público ahora también depende de Postgres para los incidentes; si la base cae, se muestran los
  últimos conocidos (o ninguno) y el propio servicio figura degradado.
- La paginación del historial usa `created_at` como cursor con precisión de milisegundos: dos incidentes
  creados en el mismo milisegundo en el borde de una página pueden saltearse. Con incidentes cargados a mano no
  pasa en la práctica; si hiciera falta, el cursor pasa a `(created_at, id)`.
- `audit_logs` queda lista para el resto de las acciones de staff que lleguen por el Outbox.
