# ADR 07: Bandeja y preferencias de notificación


- **Alcance:** este servicio (`/api/v1/notifications`, consumo de `chat.message.created`), Chat-Engine
  (publica el evento y reparte el aviso en vivo), Discordia-WebApp (campana, panel del hilo)
- **Relacionado:** ADR-07 de Chat-Engine (hilos), [ADR 0017](../../org-docs/docs/architecture/decisions/0017-notificaciones-in-app.md)
  de la organización (contrato entre servicios), [ADR-04](ADR-04-Registro-de-auditoria-de-servidores.md)
  (el consumer de auditoría, que este copia)

## Contexto

La historia "Responder en un hilo" pide, en su CA5, avisarle a quien participa de un hilo cuando otro responde,
"según sus preferencias de notificación". El servicio no tenía bandeja ni preferencias: Kong ya enrutaba
`/api/v1/notifications` y respondía `404`.

La épica de notificaciones que viene después (silenciar canal o servidor, preferencias por canal o servidor,
push, centro de notificaciones) tiene que poder construirse sobre esto sin rehacer el esquema ni el consumer.

Restricciones:

* **Chat sabe quién participa; no sabe a quién le interesa.** Las preferencias son de este servicio.
* **El tiempo real vive en Chat** (socket `inbox:<usuario>`, ADR 0006). Este servicio no tiene sockets.
* **Nodo realtime chico:** el contenedor tiene 96 MB de heap y el RDS es un `db.t4g.micro`.
* **El consumer de auditoría descarta lo que falla** (`nack` sin DLQ): para avisos eso es perder datos.

## Decisión

* **Cola propia** `notification_message_events` en `server.events`, enlazada a `chat.message.created`,
  `channel.deleted` y `server.deleted`. No se comparte con auditoría: un fallo en una no frena a la otra.
  `prefetch(10)` y **DLQ** (`<cola>.dlq` por el exchange por defecto): un evento inválido o un error de base
  va ahí con `nack` sin reencolar, para revisarlo sin entrar en loop.
* **Tres pasos separados**, para que la épica sume casos sin reescribir:
  1. `candidates(event)`: quién podría querer enterarse y por qué (`reason`). Hoy, los participantes del hilo
     menos el autor (`thread_reply`). Menciones y DMs se suman acá.
  2. `resolve(prefs, scope)` + `shouldNotify(resolved, reason)`: funciones puras. Las preferencias de todos
     los candidatos se leen en una sola consulta.
  3. Entrega: un `INSERT … SELECT unnest(…) ON CONFLICT DO NOTHING RETURNING` y, a los insertados, el aviso en
     vivo. Una entrega repetida del evento no duplica (`UNIQUE (event_id, user_id)`) ni vuelve a avisar.
* **Preferencias:** `notification_preferences (user_id, scope_type, scope_id)` con `scope_type` en `server`,
  `channel` (un DM es un canal `dm-…`) o `thread` (el id del mensaje raíz).
  * `level` (`all`, `mentions`, `none`) y `muted`/`muted_until` son **columnas distintas**: silenciar y
    reactivar no pisan el nivel elegido.
  * `level` nulo hereda. Se aplica la más específica: hilo → canal → servidor → default (`mentions` en un
    servidor, `all` en un DM). Un silencio vigente en cualquier nivel silencia lo de abajo.
  * `mentions` deja pasar lo que te involucra: una mención, un DM o una respuesta en un hilo donde
    participás. `none` y `muted` no dejan pasar nada.
  * `PUT` cambia solo los campos que llegan; `DELETE` vuelve al default. `server_id` se guarda para poder
    limpiar al borrar el servidor.
* **Bandeja:** `notifications` con `reason`, `server_id` (null en DM), `channel_id`, `thread_id`, `actor_id`,
  `preview` (140) y `read_at`. Keyset por `(created_at, id)` para que dos avisos de la misma hora no se
  salteen. El contador de no leídas tiene tope 100 (la interfaz muestra "99+").
* **Aviso en vivo por el inbox de Chat:** `POST {CHAT_ENGINE_URL}/internal/inbox/events` con
  `X-Internal-Token` (V9) y `NOTIFICATION_CREATED`. El evento no lleva el id del aviso ni el usuario: así un
  mismo mensaje viaja igual para todos y se agrupa en lotes de 10 (lo que acepta Chat). El cliente vuelve a
  pedir la bandeja al recibirlo. Un intento por lote, después del `INSERT` y sin demorar el `ack`.
* **Retención:** al arrancar y cada 6 h se borran las leídas de más de 30 días y todas las de más de 90.
  `channel.deleted` y `server.deleted` borran avisos y preferencias de ese canal o servidor.
* **Identidad:** `X-User-Id` que pone Kong; sin él, `401`. Cada usuario solo lee y cambia lo suyo; leer el
  aviso de otro es `404`, igual que uno que no existe.

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| Que Chat decida a quién avisar | Chat tendría que leer las preferencias en cada mensaje: acopla los dos servicios y suma una consulta al camino de escribir. |
| Reutilizar la cola de auditoría | Una falla de un consumidor frena al otro, y cambiar los argumentos de una cola ya declarada (para la DLQ) obliga a borrarla. |
| WebSocket propio en este servicio | Duplica la infraestructura de tiempo real (Redis, reconexión, Kong). El inbox de Chat ya llega a todos los clientes. |
| Un solo campo `level` con `muted` como un nivel más | Reactivar no sabría a qué nivel volver: la épica pide que "reactivar" devuelva el comportamiento anterior. |
| Una fila por notificación y usuario ya resuelta en Chat (fan-out en el productor) | El evento crecería con cada destinatario y Chat necesitaría las preferencias. Con los ids de participantes alcanza. |
| Reintentar el aviso en vivo | Si Chat lo publicó y la respuesta se perdió, saldría dos veces. La bandeja ya lo guarda. |

## Consecuencias

* Un aviso se puede perder entre Chat y RabbitMQ (Chat no tiene outbox, D3 del plan, en la deuda técnica);
  una vez en la cola, no: lo que falla queda en la DLQ.
* Si el aviso en vivo falla, el usuario lo ve al refrescar la bandeja (la web la consulta cada 60 s y al
  volver el foco).
* La DLQ no se vacía sola: hay que revisarla desde el panel de RabbitMQ (`localhost:15672`) y reencolar a mano.
* Escala con la épica: `level = 'all'` tiene un índice parcial para buscar quién lo pidió sin recorrer
  miembros, y `reason` ya acepta `mention` y `dm`. Push sería un paso más en la entrega, con tokens de
  dispositivo y `push_enabled` por usuario.
* Las preferencias de hilos de un canal borrado no se limpian con `channel.deleted` (no se guarda el canal de
  cada hilo); quedan hasta que se borra el servidor. Son filas chicas y sin efecto.
