// Exportación de las métricas de actividad de un servidor a CSV (ver ADR-06).

import type { ServerActivityMetrics, ServerActivityPoint } from './serverMetrics';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** Una columna por métrica diaria, en el orden en que se escriben. Encabezados sin tildes ni espacios. */
const COLUMNS: ReadonlyArray<{ header: string; value: (point: ServerActivityPoint) => string | number | null }> = [
  { header: 'fecha', value: (point) => point.date },
  { header: 'miembros_activos', value: (point) => point.activeMembers },
  { header: 'mensajes_enviados', value: (point) => point.messagesSent },
  { header: 'nuevos_miembros', value: (point) => point.newMembers },
];

// RFC 4180: líneas terminadas en CRLF
const LINE_END = '\r\n';

export type ExportFormat = 'json' | 'csv';

export type FormatResult = { ok: true; format: ExportFormat } | { ok: false; errors: Array<{ field: string; message: string }> };

/** `?format=` es opcional: sin él (o con `json`) la respuesta es la de siempre. */
export function parseExportFormat(raw: unknown): FormatResult {
  if (raw === undefined || raw === 'json') return { ok: true, format: 'json' };
  if (raw === 'csv') return { ok: true, format: 'csv' };
  return { ok: false, errors: [{ field: 'format', message: 'Debe ser json o csv' }] };
}

/**
 * Una fila por día del período, con encabezado. Las celdas son fechas (YYYY-MM-DD) o enteros, así que no hace
 * falta escapar nada. Una métrica sin dato queda vacía; no hay fila de totales para que el archivo sea una
 * tabla pareja que cualquier herramienta pueda leer.
 */
export function serverMetricsToCsv(metrics: ServerActivityMetrics): string {
  const lines = [
    COLUMNS.map((column) => column.header).join(','),
    ...metrics.series.map((point) => COLUMNS.map((column) => column.value(point) ?? '').join(',')),
  ];
  return lines.join(LINE_END) + LINE_END;
}

/** `metricas-servidor-<id>-<primer día>_<último día>.csv`, con los días incluidos en el período. */
export function serverMetricsCsvFilename(metrics: ServerActivityMetrics): string {
  const first = metrics.series[0]?.date ?? metrics.from.slice(0, 10);
  const last = metrics.series[metrics.series.length - 1]?.date ?? metrics.to.slice(0, 10);
  return `metricas-servidor-${metrics.serverId}-${first}_${last}.csv`;
}
