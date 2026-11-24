# ADR 06: Exportación de las métricas de un servidor a CSV


- **Alcance:** este servicio (`GET /api/v1/servers/:serverId/metrics?format=csv`), Discordia-WebApp (botón de
  exportar en los ajustes del servidor)
- **Relacionado:** [ADR-05](ADR-05-Metricas-globales.md) (mismas fuentes, período y caché)

## Contexto

La historia "Exportar métricas" pide que un miembro con permisos de administración exporte las métricas de su
servidor de un período a un archivo CSV, para analizarlas fuera de la plataforma (CA 1: el sistema genera un
CSV descargable con los datos de ese período).

Las métricas ya existen: `GET /api/v1/servers/:serverId/metrics` las calcula en el momento consultando a
Server-Roles (canales y altas) y a Chat (mensajes y miembros activos), solo para el dueño o quien tenga
`ADMINISTRATOR` o `MANAGE_SERVER`, con período por `?days=` o `?from=&to=` y una caché de 60 s.

## Decisión

* **El mismo endpoint, con `?format=csv`.** Sin `format` (o con `format=json`) responde lo de siempre. Con
  `csv`, el mismo cálculo se devuelve como archivo: `Content-Type: text/csv; charset=utf-8` y
  `Content-Disposition: attachment; filename="metricas-servidor-<id>-<primer día>_<último día>.csv"`.
  Hereda sin duplicar el chequeo de permisos, la validación del período y la caché.
* **Contenido:** una fila por día del período, con encabezado
  `fecha,miembros_activos,mensajes_enviados,nuevos_miembros`. Fechas `YYYY-MM-DD` (UTC, igual que la serie del
  JSON) y enteros. Separador coma y líneas CRLF (RFC 4180). Encabezados sin tildes ni espacios, para que
  las herramientas los tomen como nombres de columna sin problemas.
* **Sin fila de totales.** El archivo es una tabla pareja que cualquier herramienta lee sin limpiarlo. Los
  totales de mensajes y altas se suman de las filas. Los miembros activos del período no se pueden sumar
  (alguien activo dos días contaría dos veces), y su total sigue en la pantalla y en el JSON.
* **Si una fuente no respondió, `503` y no hay archivo.** En pantalla, una respuesta parcial se muestra con un
  aviso; un archivo sale de la plataforma sin ese aviso, y con columnas vacías se analizarían datos
  incompletos sin saberlo. Como la caché no guarda respuestas parciales, reintentar vuelve a consultar.
* **El formato se valida con el período**, antes de consultar permisos: `format` desconocido es `400` con
  `errors: [{ field: "format" }]`, igual que un período inválido.
* **La confirmación (CA 1) es de la interfaz:** la web muestra el período que se va a exportar y descarga al
  confirmar. El backend no guarda nada por exportación.

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| Generar el CSV en el navegador con el JSON que ya tiene | Evita tocar el backend, pero el formato quedaría en cada cliente (web y mobile) y el archivo no se podría pedir desde fuera de la interfaz (`curl`, scripts). Con el formato en un solo lugar, todos reciben el mismo archivo. |
| Ruta nueva `/metrics/export` | Kong manda `/api/v1/servers/{id}/metrics/...` a Server-Roles (la regex de la ruta ancla en `metrics/?$` para dejar `member-growth` allá): habría que cambiar el Gateway. Además duplicaría permisos, período y caché. |
| Negociar por `Accept: text/csv` | Es lo más REST, pero un enlace o `curl` sin encabezados no lo puede pedir, y los clientes HTTP de la web mandan `Accept` por defecto. El parámetro se ve en la URL y es fácil de probar. |
| Exportar con las columnas vacías y un encabezado `X-Metrics-Partial` | El encabezado se pierde al guardar el archivo. |
| Exportación asíncrona (generar, guardar y avisar) | Para 366 días como máximo son 366 filas: se genera en el mismo pedido. |

## Consecuencias

* No cambian el Gateway ni Server-Roles ni Chat: la ruta de Kong `server-activity-metrics` ya matchea el path
  con cualquier query.
* Exportar justo después de mirar el mismo período en pantalla no vuelve a consultar a las fuentes (caché de
  60 s, la misma clave).
* La app mobile no exporta todavía: guardar o compartir un archivo necesita `expo-file-system` y
  `expo-sharing`, que no están instalados. El endpoint ya le sirve tal cual.
