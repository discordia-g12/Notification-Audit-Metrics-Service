# ADR 08: Notificaciones push


- **Alcance:** este servicio (`/api/v1/notifications/push/*`, entrega después de la bandeja), Discordia-WebApp
  (registro del dispositivo en mobile y web, service worker, navegación al tocar el aviso)
- **Relacionado:** [ADR-07](ADR-07-Notificaciones-y-preferencias.md) (bandeja, preferencias y `deliver`),
  [ADR 0017](../../org-docs/docs/architecture/decisions/0017-notificaciones-in-app.md) de la organización

## Contexto

La historia "Notificaciones push" pide avisar fuera de la app (teléfono bloqueado, pestaña cerrada) de lo mismo
que ya entra en la bandeja, con un interruptor general por usuario. El ADR 0017 dejó el punto de extensión:
un paso más en la entrega, con tokens de dispositivo y `push_enabled`.

Restricciones:

* **La bandeja es la fuente de verdad.** Push es un aviso más, como el inbox de Chat: si falla, el aviso ya
  está guardado.
* **Dos proveedores.** La app mobile es Expo (Expo Push API, que habla con APNs y FCM). La web usa Web Push
  estándar con claves VAPID, contra el servicio de push de cada navegador.
* **El contrato de `chat.message.created` no cambia** (ADR 0017).
* **Nodo realtime chico** (96 MB de heap): nada de colas en memoria ni reintentos largos.

## Decisión

* **Dónde se engancha:** en `deliver` (ADR-07), después del `INSERT` y solo con los avisos nuevos, en paralelo
  con el inbox de Chat. Lo que llega ahí ya pasó `shouldNotify`: push respeta las preferencias sin volver a
  mirarlas. Una entrega repetida del evento no inserta nada y no vuelve a mandar push.
* **Qué reasons:** las cuatro. `mention`, `dm` y `thread_reply` porque te involucran; `message` también,
  porque solo existe si el usuario pidió `all` en ese canal o servidor. Quien no quiere push de un canal lo
  baja a `mentions`, lo silencia o apaga push.
* **Datos:** migración `004_push`, solo tablas nuevas.
  * `push_devices (user_id, platform ios|android|web, token, keys, created_at, last_seen_at)`, único por
    `token`. En web el token es el `endpoint` de la suscripción y `keys` guarda `p256dh` y `auth`. Si otro
    usuario registra el mismo token (otro login en el mismo teléfono), el dispositivo pasa a él.
  * Hasta 10 dispositivos por usuario: al registrar uno más se borra el que hace más que no se registra. Acota
    el fan-out de un `@everyone`.
  * `push_settings (user_id, push_enabled)`. Sin fila es `true`: no hay que escribir nada por usuario nuevo.
* **Entrega:** una consulta trae los dispositivos de los destinatarios que no apagaron push. Después:
  * **Mobile:** `POST https://exp.host/--/api/v2/push/send` con `fetch` nativo, en lotes de 100 (lo que acepta
    Expo). `Authorization: Bearer EXPO_ACCESS_TOKEN` solo si está configurado. Los tickets con
    `DeviceNotRegistered` borran el token.
  * **Web:** `web-push` (VAPID), de a 10 en paralelo, con TTL de 1 h. Un `404` o `410` borra la suscripción.
    Sin las tres variables VAPID (o si son inválidas) push web queda apagado y los dispositivos web se ignoran.
  * Un intento, timeout de 5 s. `send` nunca lanza: devuelve `{ sent, failed, removed }` y app.ts loguea si
    hubo fallas.
* **Payload:** `title` según `reason`, `body` con el preview de la bandeja (140) y `data` con
  `notificationId, reason, serverId, channelId, threadId, messageId`, los mismos nombres que `Notification` de
  la API, para que el cliente arme el mismo destino que desde la bandeja. No viaja el actor ni el usuario.
* **Primer plano:** el backend manda siempre. El cliente oculta el aviso si la app está abierta. No se consulta
  la presencia de Chat.
* **API** (bajo `/api/v1/notifications`, ya enrutado en Kong con JWT; rutas estáticas, no chocan con
  `/{id}/read`):
  * `POST /push/devices` (`{ platform, token }` o `{ platform: 'web', subscription }`) y `DELETE /push/devices`
    (`{ token }`, solo los propios).
  * `GET`/`PUT /push/settings` (`{ pushEnabled }`).
  * `GET /push/vapid-public-key`: la web se suscribe sin tener la clave en el build.
* **SSRF:** el `endpoint` web lo elige el cliente y el servicio le hace un `POST`. Solo se aceptan `https` de
  los servicios de push de los navegadores (`fcm.googleapis.com`, `push.services.mozilla.com`,
  `notify.windows.com`, `push.apple.com` y sus subdominios).

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| `expo-server-sdk` | Para un `POST` en lotes y leer los tickets alcanza con `fetch`. Una dependencia menos en el nodo realtime. |
| FCM/APNs directo | Pide credenciales de Apple y Google por plataforma. Expo ya las maneja para la app. |
| Consultar la presencia de Chat para no mandar con la app abierta | Una llamada más por aviso y una carrera (la app se cierra justo después). El cliente sabe si está en primer plano. |
| Reintentar el push | Igual que el inbox: si el proveedor lo aceptó y la respuesta se perdió, saldría dos veces. La bandeja lo tiene. |
| Leer los receipts de Expo | Pide guardar los ids de ticket y consultarlos más tarde (un job más). `DeviceNotRegistered` también llega en el ticket. |
| Sin push para `message` | El usuario pidió `all` a propósito. Si molesta, tiene `mentions`, silenciar o apagar push. |
| Aceptar cualquier `endpoint` web | SSRF: el servicio haría `POST` a cualquier host desde la red privada de AWS. |

## Consecuencias

* Con `push_enabled = false` no sale push y la bandeja y los contadores no cambian (CA2, test en
  `notifications-push.test.ts`).
* El nodo realtime necesita salida HTTPS a `exp.host` y a los servicios de push de los navegadores. El
  Security Group ya permite toda la salida (`aws_vpc_security_group_egress_rule.all`).
* Variables nuevas en realtime: `EXPO_ACCESS_TOKEN` (opcional), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` (`mailto:` o `https:`). Las claves se generan una vez (`npx web-push generate-vapid-keys`);
  cambiarlas invalida todas las suscripciones web.
* Un mensaje con `@everyone` en un servidor grande manda un push por dispositivo de cada miembro: con 10
  dispositivos de tope por usuario, el costo es lineal y va en lotes de 100.
* Pendiente: los dispositivos que nunca se dan de baja ni fallan (teléfono apagado para siempre) no se
  borran. Hace falta sumar a la retención los que no se registran hace 90 días.
* Pendiente: el preview puede llegar a la pantalla bloqueada. Si se pide privacidad, es un flag más en
  `push_settings` para mandar sin `body`.
