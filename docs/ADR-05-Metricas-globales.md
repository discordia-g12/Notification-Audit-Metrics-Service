# ADR 05: Métricas globales del backoffice por consulta síncrona a Chat y Server-Roles

- **Estado:** Aceptado
- **Fecha:** 2026-11-11
- **Alcance:** este servicio (`GET /api/v1/admin/metrics`), Chat-Engine-Service (`GET /internal/metrics/messages`),
  Server-Roles-Core-Service (`GET /internal/metrics/servers`), Gateway (ruta `admin-metrics`), Discordia-WebApp
  (backoffice), orquestador (`CHAT_ENGINE_URL` y `CORE_SERVICE_URL` en el compose)
- **Relacionado:** ADR-002 del Gateway (rol staff), [ADR-02](ADR-02-Estado-de-la-plataforma.md) (mismo chequeo de
  staff y mismo criterio de errores saneados), [ADR-04](ADR-04-Registro-de-auditoria-de-servidores.md) (consumo de
  eventos)

## Contexto

El staff necesita ver en el backoffice métricas globales de la plataforma en un período que elige: usuarios
activos, servidores creados y mensajes enviados, sumando todos los servidores. Quien no es staff no las ve.

Los datos viven en otros servicios: los mensajes (de canales y DMs) en la base de Chat, los servidores en la de
Server-Roles. Este servicio es el que tiene "métricas" en el nombre y ya responde rutas `/api/v1/admin/*` de
staff, pero no tiene esos datos. Chat no publica eventos por mensaje enviado y Server-Roles no publica
`server.created`: no hay un flujo de eventos del que derivar los conteos sin cambiar a los dos productores.

En producción este servicio corre en el nodo realtime, igual que Chat; Server-Roles está en edge
(`EDGE_HOST:8002`).

## Decisión

1. **Este servicio agrega, consultando en el momento.** Chat expone `GET /internal/metrics/messages?from&to`
   (`{from, to, messages, activeUsers}`) y Server-Roles `GET /internal/metrics/servers?from&to`
   (`{from, to, serversCreated}`). Cada uno cuenta en su base con un índice por fecha. Este servicio llama a los
   dos en paralelo (`Promise.allSettled`), con 2 s de timeout cada uno (`AbortSignal.timeout`, cubre también el
   body), y arma `{from, to, activeUsers, serversCreated, messagesSent, partial}`. Las URLs base son
   `CHAT_ENGINE_URL` y `CORE_SERVICE_URL`, validadas al arrancar. Las rutas `/internal/*` no pasan por Kong: van
   por la red de Docker o por IP y puerto del nodo.
2. **Definición de usuario activo:** envió al menos un mensaje, en un canal o en un DM, en el período. Lo cuenta
   Chat (usuarios distintos entre los autores). Un usuario que solo se conectó, leyó o habló por voz no cuenta.
   Mensajes enviados: todos los del período, de canales y DMs, incluidos los borrados después (se enviaron
   igual).
3. **Período `[from, to)` en ISO 8601.** Sin parámetros, `to` es ahora truncado al minuto y `from` 30 días antes.
   `400 problem+json` si alguna fecha no es ISO 8601 (o es un día que no existe), si `from >= to` o si el período
   supera 366 días. Se reenvía a las fuentes normalizado con `toISOString()`.
4. **Respuesta parcial antes que error.** Si una fuente falla (red, timeout, no-2xx o body sin la forma
   esperada), sus campos van en `null`, `partial: true`, se loguea un `warn` con la fuente y un motivo fijo
   (`timeout`, `connection_error`, `http_5xx`, `http_4xx`, `invalid_response`) y se responde `200`. Nunca `5xx`
   por un servicio caído: el backoffice muestra lo que hay y marca lo que falta.
5. **Caché en memoria de 60 s** por par `(from, to)` normalizado, con tope de 100 entradas. Solo se guardan
   respuestas completas: una parcial se vuelve a pedir en la próxima request, así el dato vuelve apenas la
   fuente se recupera. El default truncado al minuto hace que recargar la página sin período use la caché.
6. **Autorización como el resto de `/api/v1/admin/*`.** Kong exige `staff` (`validate("staff", false)`) y el
   servicio vuelve a chequear: `401` si falta `X-User-Id`, `403` si `X-User-Role` no es exactamente `staff`
   (regla 2 del ADR-002 del Gateway). `cache-control: no-store`.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
| --- | --- |
| Consumir eventos y guardar contadores propios (como ADR-04) | Chat no publica eventos por mensaje y no existe `server.created`: habría que agregarlos en los dos productores, con Outbox, para tener solo contadores. Además los conteos arrancarían desde el deploy, sin historia, y "usuarios activos" en un período arbitrario necesita los ids por día, no un contador. |
| Leer directo las bases de Chat y Server-Roles | Acopla este servicio al esquema de otros dos (y a Mongo y Postgres a la vez). Cada servicio es dueño de sus datos (org-docs); un endpoint interno deja cambiar el esquema sin romper el backoffice. |
| Que la WebApp llame a cada servicio | Tres rutas de staff nuevas en Kong y la lógica de período, timeout y parcialidad repetida en el cliente. Un solo endpoint deja el contrato y el chequeo de staff en un lugar. |
| Prometheus como fuente | Es para señales operacionales del equipo (ADR-O2 de `observability`), vive en el nodo infra y no guarda datos de negocio por usuario. |
| `5xx` o `503` si una fuente falla | El staff pierde también los datos que sí llegaron. `partial` deja ver qué falta sin ocultar el resto. |

## Consecuencias

- Las métricas están siempre al día (hasta 60 s de caché) y no hay tablas ni migraciones nuevas en este servicio.
- Cada consulta del backoffice cuesta dos queries de conteo en otras bases. Con el tráfico de staff no importa;
  la caché y el tope de 366 días acotan el peor caso.
- **Un servidor borrado no cuenta.** Server-Roles cuenta los servidores que existen hoy con `created_at` en el
  período: uno creado y borrado dentro del período no aparece en `serversCreated`. Lo mismo pasaría con
  mensajes si Chat los borrara físicamente (hoy cuenta también los borrados). Corregirlo necesita borrado lógico
  o eventos de creación.
- Si Chat o Server-Roles están caídos o lentos, la respuesta tarda hasta 2 s y llega con `partial: true`.
- El despliegue tiene que pasarle `CHAT_ENGINE_URL` y `CORE_SERVICE_URL` al contenedor (compose del
  orquestador; en prod `CORE_SERVICE_URL=http://<EDGE_HOST>:8002`). Sin ellas usa los defaults de local y en
  prod las métricas salen `partial` con todo en `null`.
- Las rutas `/internal/metrics/*` no tienen autenticación propia: quedan protegidas porque Kong no las expone.
  Chat además rechaza las requests que traen headers de Kong.
- Cada réplica de este servicio tiene su propia caché; con una sola réplica no importa.
