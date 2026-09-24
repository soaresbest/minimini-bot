import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';
import {
  assertSupportedServerVersion,
  detectServerVersion,
  latestSupportedServerVersion,
  resolveServerVersion,
  supportsServerVersion,
} from '../src/server-version.js';

const config = version => validateConfig({
  server: { host: 'example.test', port: 25565, version },
  bots: [{ name: 'bot1' }],
});

test('detecta a versão pelo protocolo informado no status do servidor', async () => {
  const result = await detectServerVersion(
    { host: 'example.test', port: 25570 },
    {
      ping: async options => {
        assert.equal(options.host, 'example.test');
        assert.equal(options.port, 25570);
        return { version: { name: 'Paper 26.2', protocol: 776 } };
      },
    },
  );
  assert.deepEqual(result, {
    version: '26.2',
    protocol: 776,
    serverName: 'Paper 26.2',
    supported: false,
  });
});

test('versão automática é salva antes de informar falta de suporte', async () => {
  let saved;
  const logs = [];
  await assert.rejects(
    () => resolveServerVersion(config('auto'), {
      detect: async () => ({ version: '26.2', protocol: 776, serverName: 'Paper 26.2', supported: false }),
      save: async value => { saved = structuredClone(value); return value; },
      log: message => logs.push(message),
    }),
    /26\.2.*ainda não é suportada/u,
  );
  assert.equal(saved.server.version, '26.2');
  assert.match(logs.join('\n'), /protocolo 776/u);
});

test('aceita versões antigas e novas e valida dados disponíveis', async () => {
  assert.equal(validateConfig({ server: { host: 'localhost', version: '26.2' }, bots: [{ name: 'bot1' }] }).server.version, '26.2');
  assert.equal(supportsServerVersion('1.16.5'), true);
  assert.equal(latestSupportedServerVersion(), '26.1.2');
  assert.doesNotThrow(() => assertSupportedServerVersion('1.16.5'));
  assert.equal((await resolveServerVersion(config('1.16.5'))).server.version, '1.16.5');
});
