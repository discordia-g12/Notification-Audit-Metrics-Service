import http from 'node:http';
import https from 'node:https';
import { classifyError, classifyHttpStatus } from './errors';
import type { ProbeResult } from './types';

export interface HttpProbeOptions {
  timeoutMs: number;
  /** Solo para https: acepta certificados que Node no puede validar (Origin Certificate, autofirmado). */
  tlsInsecure: boolean;
  /** El body se lee y se descarta; pasado este límite se corta la conexión. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 4096;

/**
 * GET a un /readyz. No sigue redirects, no lee más de maxBodyBytes y nunca rechaza: cualquier falla vuelve
 * como código en ProbeResult.error. El timeout cubre toda la request, body incluido.
 */
export function httpProbe(target: string, options: HttpProbeOptions): Promise<ProbeResult> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const requestOptions: https.RequestOptions = {
      method: 'GET',
      agent: false,
      headers: { accept: 'application/json', 'user-agent': 'discordia-status-monitor' },
    };
    if (isHttps) requestOptions.rejectUnauthorized = !options.tlsInsecure;

    const req = (isHttps ? https : http).request(url, requestOptions, (res) => {
      const httpStatus = res.statusCode ?? 0;
      const done = (): void => finish({ httpStatus, error: classifyHttpStatus(httpStatus) });
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBodyBytes) {
          done();
          res.destroy();
        }
      });
      res.on('end', done);
      res.on('error', (err) => finish({ httpStatus: null, error: classifyError(err) }));
    });

    req.on('error', (err) => finish({ httpStatus: null, error: classifyError(err) }));

    const timer = setTimeout(() => {
      finish({ httpStatus: null, error: 'timeout' });
      req.destroy();
    }, options.timeoutMs);

    req.end();
  });
}
