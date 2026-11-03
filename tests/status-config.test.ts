import { test } from 'node:test';
import assert from 'node:assert';
import { ConfigError, loadStatusConfig } from '../src/config/status';

test('config: defaults sin variables', () => {
  assert.deepStrictEqual(loadStatusConfig({}), {
    gatewayUrl: null,
    tlsInsecure: false,
    pollIntervalMs: 15000,
    probeTimeoutMs: 2000,
  });
});

test('config: variables vacías cuentan como no definidas', () => {
  const config = loadStatusConfig({
    STATUS_GATEWAY_URL: '',
    STATUS_TLS_INSECURE: ' ',
    STATUS_POLL_INTERVAL_MS: '',
  });
  assert.strictEqual(config.gatewayUrl, null);
  assert.strictEqual(config.tlsInsecure, false);
  assert.strictEqual(config.pollIntervalMs, 15000);
});

test('config: valores válidos, URL sin barra final', () => {
  const config = loadStatusConfig({
    STATUS_GATEWAY_URL: 'https://10.0.1.10:443/',
    STATUS_TLS_INSECURE: 'true',
    STATUS_POLL_INTERVAL_MS: '5000',
    STATUS_PROBE_TIMEOUT_MS: '500',
  });
  assert.deepStrictEqual(config, {
    gatewayUrl: 'https://10.0.1.10',
    tlsInsecure: true,
    pollIntervalMs: 5000,
    probeTimeoutMs: 500,
  });
  assert.strictEqual(
    loadStatusConfig({ STATUS_GATEWAY_URL: 'http://kong:8000/base//' }).gatewayUrl,
    'http://kong:8000/base',
  );
  assert.strictEqual(loadStatusConfig({ STATUS_TLS_INSECURE: 'false' }).tlsInsecure, false);
});

const invalid: Array<[string, Record<string, string>]> = [
  ['URL inválida', { STATUS_GATEWAY_URL: 'no es una url' }],
  ['protocolo no http', { STATUS_GATEWAY_URL: 'ftp://kong:21' }],
  ['URL con credenciales', { STATUS_GATEWAY_URL: 'https://user:pass@kong' }],
  ['URL con query', { STATUS_GATEWAY_URL: 'https://kong/?x=1' }],
  ['TLS_INSECURE distinto de true/false', { STATUS_TLS_INSECURE: 'yes' }],
  ['TLS_INSECURE con mayúsculas', { STATUS_TLS_INSECURE: 'TRUE' }],
  ['intervalo no numérico', { STATUS_POLL_INTERVAL_MS: '15s' }],
  ['intervalo negativo', { STATUS_POLL_INTERVAL_MS: '-1' }],
  ['intervalo decimal', { STATUS_POLL_INTERVAL_MS: '1500.5' }],
  ['intervalo demasiado chico', { STATUS_POLL_INTERVAL_MS: '10' }],
  ['intervalo demasiado grande', { STATUS_POLL_INTERVAL_MS: '99999999' }],
  ['timeout demasiado chico', { STATUS_PROBE_TIMEOUT_MS: '5' }],
  ['timeout mayor o igual al intervalo', { STATUS_POLL_INTERVAL_MS: '2000', STATUS_PROBE_TIMEOUT_MS: '2000' }],
];

for (const [label, env] of invalid) {
  test(`config: rechaza ${label}`, () => {
    assert.throws(() => loadStatusConfig(env), ConfigError);
  });
}
