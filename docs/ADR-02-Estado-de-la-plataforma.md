# ADR 02: Estado de la plataforma por sondeo de `/readyz` a través de Kong

- **Estado:** Aceptado
- **Fecha:** 2026-11-03
- **Alcance:** este servicio (`/api/v1/status`, `/api/v1/admin/status`), Gateway (rutas `/internal/readyz/*`),
  Discordia-WebApp (página de estado y backoffice)
- **Relacionado:** ADR-002 del Gateway (rol staff), ADR-O2 de `observability` (niveles de señales)

## Contexto

La historia 74 pide una página de estado de la plataforma. CA3: cualquiera, con o sin sesión, ve si los
servicios funcionan. CA1 y CA2 (incidentes publicados por el staff, con historial) necesitan tablas y este
servicio todavía no tiene migraciones ni herramienta para crearlas (ADR-01).

Cada servicio ya expone `/readyz`, que chequea sus dependencias. Este servicio corre en el nodo realtime; los
demás están repartidos en edge, realtime e infra y entre nodos solo se llega por IP y puerto publicado. Kong
(edge) ya alcanza a todos, y expone para el sondeo interno `GET /internal/readyz/{auth|server-roles|chat|voice|payments}`
y su propio `GET /readyz`. En producción Kong sirve TLS con el Origin Certificate de Cloudflare, que Node no
valida.

## Decisión

1. **Fuente: el `/readyz` de cada servicio, a través de Kong.** Una sola URL configurable
   (`STATUS_GATEWAY_URL`) en vez de una por servicio. Kong se sondea en su `/readyz`. Este servicio se mide a sí
   mismo con el mismo chequeo de su `/readyz` (`SELECT 1` con timeout), sin pasar por Kong.
2. **Sondeo periódico con caché en memoria.** Un `StatusMonitor` sondea los siete servicios en paralelo cada
   `STATUS_POLL_INTERVAL_MS` (15 s) con timeout `STATUS_PROBE_TIMEOUT_MS` (2 s) y guarda el último resultado.
   Los endpoints sirven esa caché: una request no dispara sondas, así que una página pública muy visitada no
   multiplica el tráfico hacia los servicios. La primera ronda arranca con la app sin demorar el `listen`; el
   timer es `unref()` y se detiene en el `onClose` de Fastify. Las rondas no se solapan.
3. **Reglas de estado.** `2xx` → `operational`; timeout, error de red o no-2xx → `degraded`; nunca chequeado o
   sonda sin configurar → `unknown`. Global: `degraded` si alguno lo está, si no `unknown` si alguno lo está,
   si no `operational`. Sin `STATUS_GATEWAY_URL` los seis servicios vía Kong quedan `unknown` (se loguea una vez).
4. **Dos vistas.** `GET /api/v1/status` es pública y solo dice id, nombre y estado. `GET /api/v1/admin/status`
   agrega código HTTP, latencia, hora del chequeo, desde cuándo está en ese estado (`since`) y un código de
   error. Kong exige `staff` en la ruta admin y el servicio vuelve a chequear `X-User-Role === "staff"`
   (regla 2 del ADR-002 del Gateway), con el mismo `403 application/problem+json` que responde Kong.
5. **Errores saneados.** `error` es siempre un código fijo (`timeout`, `connection_refused`, `http_5xx`,
   `http_4xx`, `invalid_response`), derivado del `code`/`name` de la excepción o del status HTTP. Nunca sale el
   mensaje del driver ni el body del upstream: pueden traer IPs internas, usuarios de base o trazas.
6. **Sondas con `node:http`/`node:https`, sin dependencias nuevas.** No siguen redirects (un 3xx es
   `invalid_response`), leen y descartan como máximo 4 KiB de body y el timeout cubre toda la request.
   `STATUS_TLS_INSECURE=true` desactiva la verificación del certificado **solo** en estas requests
   (`rejectUnauthorized: false` por request, no `NODE_TLS_REJECT_UNAUTHORIZED`): son GET sin credenciales a
   una IP privada y la respuesta solo se usa para el código de estado.
7. **Config validada al arrancar.** Un valor inválido en las `STATUS_*` corta el arranque en vez de dejar el
   monitor con algo que nadie pidió.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
| --- | --- |
| Prometheus como fuente (`up`, métricas de `/readyz`) | Prometheus vive en el nodo infra y no es alcanzable desde realtime. Además ADR-O2 lo deja para señales operacionales del equipo, no para exponer datos al producto: la página pública dependería del stack de observabilidad, que puede estar caído sin que la plataforma lo esté. |
| Sondear en cada request | Una página pública haría fan-out de siete requests por visita: carga y latencia proporcionales al tráfico, y una forma fácil de amplificar un abuso. |
| Una URL por servicio, sin Kong | Siete variables más, y conocer IP y puerto de cada nodo desde realtime. Kong ya resuelve ese ruteo y el sondeo prueba también el camino real de las requests. |
| Agregar la CA de origen de Cloudflare a la imagen | El certificado está emitido para el dominio, no para la IP privada que se sondea (fallaría igual la verificación del nombre), y el local es autofirmado. Verificar TLS no protege nada en una sonda sin secretos dentro de la VPC. |
| Persistir el historial en Postgres | Es CA1/CA2 (incidentes), que necesita migraciones que todavía no existen. |

## Consecuencias

- La WebApp tiene un contrato estable (ids, nombres y orden fijos) para la página pública y el backoffice.
- El estado tiene hasta un intervalo de atraso (15 s por defecto) y se pierde al reiniciar: después de un
  deploy, todo es `unknown` hasta que termina la primera ronda.
- Si Kong cae, los seis servicios que se sondean a través de él quedan `degraded` aunque estén sanos. Es lo que
  ve un usuario (sin Kong no hay plataforma), pero el detalle staff no distingue la causa.
- Cada réplica de este servicio sondea por su cuenta. Con una sola réplica no importa; si se escala, el tráfico
  de sondeo crece con las réplicas y cada una puede mostrar un estado un poco distinto.
- Queda pendiente CA1/CA2 (incidentes y su historial), cuando el servicio tenga migraciones.
- El despliegue tiene que pasarle `STATUS_GATEWAY_URL` y `STATUS_TLS_INSECURE` al contenedor
  (`deploy/` del orquestador). Sin ellas el servicio arranca igual, con esos seis servicios en `unknown`.
