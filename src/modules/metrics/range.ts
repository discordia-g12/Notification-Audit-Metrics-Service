// Período de las métricas: lectura y validación de ?from&to.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;

export interface MetricsRange {
  from: Date;
  to: Date;
}

export type RangeResult =
  | { ok: true; range: MetricsRange }
  | { ok: false; errors: Array<{ field: string; message: string }> };

// Empieza con fecha (YYYY-MM-DD) y solo usa caracteres de ISO 8601; el resto lo valida Date.
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const ISO_CHARS = /^[\dTZ:.+-]+$/;
const ISO_MAX_LENGTH = 35;

/** Date de un string ISO 8601, o null. Rechaza lo que Date acepta pero no es ISO ("2026", "nov 3") y días que no existen. */
export function parseIsoDate(value: string): Date | null {
  if (value.length > ISO_MAX_LENGTH || !ISO_CHARS.test(value)) return null;
  const match = ISO_DATE_PREFIX.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  if (value.length > 10 && value.charAt(10) !== 'T') return null;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readParam(
  field: string,
  raw: unknown,
  errors: Array<{ field: string; message: string }>,
): Date | undefined {
  if (raw === undefined) return undefined;
  const date = typeof raw === 'string' ? parseIsoDate(raw) : null;
  if (!date) errors.push({ field, message: 'must be an ISO 8601 date' });
  return date ?? undefined;
}

/**
 * Defaults: to = ahora (al minuto, para que pedidos seguidos compartan caché) y from = to - 30 días. Error si
 * no son fechas, si from >= to o si el período supera 366 días.
 */
export function resolveRange(query: { from?: unknown; to?: unknown }, now: Date): RangeResult {
  const errors: Array<{ field: string; message: string }> = [];
  const from = readParam('from', query.from, errors);
  const to = readParam('to', query.to, errors);
  if (errors.length > 0) return { ok: false, errors };

  const end = to ?? new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const start = from ?? new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

  if (start.getTime() >= end.getTime()) {
    return { ok: false, errors: [{ field: 'from', message: 'must be before to' }] };
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    return { ok: false, errors: [{ field: 'to', message: `range must NOT exceed ${MAX_RANGE_DAYS} days` }] };
  }
  return { ok: true, range: { from: start, to: end } };
}
