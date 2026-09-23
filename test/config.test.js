import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configPath, loadConfig, saveConfig, validateConfig } from '../src/config.js';

const base = () => ({ server: { host: 'localhost' }, bots: [{ name: 'bot1' }] });
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function temporaryConfig(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'minimini-config-test-'));
  const previous = process.env.MINIMINI_CONFIG;
  process.env.MINIMINI_CONFIG = join(directory, 'private', 'config.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.MINIMINI_CONFIG;
    else process.env.MINIMINI_CONFIG = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return configPath();
}

test('configuração mínima recebe defaults sem alterar o objeto original', () => {
  const raw = base();
  const config = validateConfig(raw);
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.server, { host: 'localhost', port: 25565, version: 'auto', registration: true });
  assert.deepEqual(config.bots, [{ name: 'bot1', username: 'bot1', auth: 'offline', mode: 'default' }]);
  assert.deepEqual(config.access, { allowedPlayers: [], ignoredPlayers: [] });
  assert.deepEqual(config.registrations, {});
  assert.equal(config.settings.maxBots, 8);
  assert.equal(config.settings.autoEatAt, 16);
  assert.deepEqual(Object.keys(config.llm.providers).sort(), ['claude', 'gemini', 'grok', 'openai']);
  assert.deepEqual(raw, base());
  assert.equal(config.llm.providers.openai.apiKey, undefined);
});

test('normaliza IPv6 e listas de jogadores sem diferenciar maiúsculas', () => {
  const raw = base();
  raw.server.host = '[::1]';
  raw.access = { allowedPlayers: ['Alice', 'alice', ' Bob '], ignoredPlayers: ['OtherBot'] };
  assert.equal(validateConfig(raw).server.host, '::1');
  assert.deepEqual(validateConfig(raw).access.allowedPlayers, ['Alice', 'Bob']);
});

test('rejeita configuração inválida com mensagens úteis', () => {
  for (const invalid of [null, [], 'texto']) assert.throws(() => validateConfig(invalid), /Configuração deve ser um objeto/u);
  assert.throws(() => validateConfig({ ...base(), schemaVersion: 2 }), /schemaVersion/u);
  for (const port of [0, 65536, '25565', 2.5, null]) {
    assert.throws(() => validateConfig({ ...base(), server: { host: 'localhost', port } }), /Porta do servidor/u);
  }
  for (const host of ['https://example.com', 'host:25565', '..', '[abc]', '999.999.999.999', 'bad host']) {
    assert.throws(() => validateConfig({ ...base(), server: { host } }), /[Ee]ndereço|IPv6/u);
  }
  assert.throws(() => validateConfig({ ...base(), bots: [] }), /pelo menos um bot/u);
  for (const name of ['', 'abcdefghijklmnopq', 'bad-name', 'á']) {
    assert.throws(() => validateConfig({ ...base(), bots: [{ name }] }), /Nome do bot/u);
  }
  assert.throws(() => validateConfig({ ...base(), bots: [{ name: 'Bot1' }, { name: 'bot1' }] }), /únicos/u);
  assert.throws(() => validateConfig({ ...base(), bots: [{ name: 'one', username: 'same' }, { name: 'two', username: 'SAME' }] }), /conta diferente/u);
  assert.throws(() => validateConfig({ ...base(), bots: [{ name: 'bot1', auth: 'password' }] }), /offline ou microsoft/u);
  assert.throws(() => validateConfig({ ...base(), bots: [{ name: 'bot1', mode: 'unknown' }] }), /default ou ia/u);
  assert.throws(() => validateConfig({ ...base(), settings: { autoEatAt: 21 } }), /Limite de fome/u);
  assert.throws(() => validateConfig({ ...base(), settings: { maxBots: 1 }, bots: [{ name: 'one' }, { name: 'two' }] }), /maxBots/u);
  assert.throws(() => validateConfig({ ...base(), access: { allowedPlayers: ['*'] } }), /Jogadores autorizados/u);
  assert.throws(() => validateConfig({ ...base(), llm: { provider: 'unknown' } }), /openai, gemini, grok ou claude/u);
  assert.throws(() => validateConfig({ ...base(), server: { host: 'localhost', registration: 'sim' } }), /true ou false/u);
  assert.throws(() => validateConfig({ ...base(), registrations: { 'localhost:25565': { bot1: '1234567x' } } }), /exatamente 8 dígitos/u);
});

test('preserva senhas de registro por servidor e nome do bot', () => {
  const raw = base();
  raw.registrations = {
    'Example.COM:25565': { Bot1: '00123456', bot2: '87654321' },
    '[::1]:25566': { Bot1: '11112222' }
  };
  const registrations = validateConfig(raw).registrations;
  assert.deepEqual(registrations, {
    'example.com:25565': { bot1: '00123456', bot2: '87654321' },
    '[::1]:25566': { bot1: '11112222' }
  });
});

test('conta Microsoft fica separada do nome usado no chat', () => {
  const raw = base();
  raw.bots = [{ name: 'helper', auth: 'microsoft', username: 'account@example.com' }];
  assert.deepEqual(validateConfig(raw).bots[0], { name: 'helper', username: 'account@example.com', auth: 'microsoft', mode: 'default' });
  delete raw.bots[0].username;
  assert.throws(() => validateConfig(raw), /Conta Microsoft/u);
});

test('modo IA exige chave e não inclui chaves do ambiente no objeto normalizado', (t) => {
  const previous = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  delete process.env.OPENAI_API_KEY;
  const raw = base();
  raw.bots[0].mode = 'ia';
  assert.throws(() => validateConfig(raw), /OPENAI_API_KEY/u);
  assert.equal(validateConfig(raw, { requireAiKeys: false }).bots[0].mode, 'ia');
  process.env.OPENAI_API_KEY = 'fake-test-only-key';
  const config = validateConfig(raw);
  assert.equal(config.llm.providers.openai.apiKey, undefined);
  assert.ok(!JSON.stringify(config).includes('fake-test-only-key'));
  delete process.env.OPENAI_API_KEY;
  raw.llm = { providers: { openai: { apiKey: 'saved-test-only-key' } } };
  assert.equal(validateConfig(raw).llm.providers.openai.apiKey, 'saved-test-only-key');
});

test('erros de validação não repetem valores secretos', () => {
  const raw = base();
  const secret = 'do-not-display-this-secret';
  raw.llm = { providers: { openai: { apiKey: `${secret}\n` } } };
  assert.throws(() => validateConfig(raw), (error) => !error.message.includes(secret) && /Chave de API/u.test(error.message));
});

test('salva e carrega atomicamente com permissões restritas', async (t) => {
  const file = await temporaryConfig(t);
  const saved = await saveConfig(base());
  assert.deepEqual(await loadConfig(), saved);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
  assert.deepEqual(await fs.readdir(dirname(file)), ['config.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(dirname(file))).mode & 0o777, 0o700);
  }
  saved.bots.push({ name: 'bot2' });
  await saveConfig(saved);
  assert.equal((await loadConfig()).bots.length, 2);
  assert.deepEqual(await fs.readdir(dirname(file)), ['config.json']);
});

test('não sobrescreve JSON corrompido e não revela conteúdo no erro', async (t) => {
  const file = await temporaryConfig(t);
  await fs.mkdir(dirname(file), { recursive: true });
  const broken = '{"apiKey":"private-secret-that-must-stay-hidden"';
  await fs.writeFile(file, broken);
  for (const action of [() => loadConfig(), () => loadConfig({ configure: true }), () => saveConfig(base())]) {
    await assert.rejects(action, (error) => /JSON inválido/u.test(error.message) && !error.message.includes('private-secret'));
  }
  assert.equal(await fs.readFile(file, 'utf8'), broken);
});

test('JSON null é inválido e não é tratado como arquivo ausente', async (t) => {
  const file = await temporaryConfig(t);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, 'null');
  await assert.rejects(() => loadConfig(), /Configuração deve ser um objeto/u);
  await assert.rejects(() => saveConfig(base()), /Configuração deve ser um objeto/u);
  assert.equal(await fs.readFile(file, 'utf8'), 'null');
});

test('aceita BOM de editores Windows', async (t) => {
  const file = await temporaryConfig(t);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, `\uFEFF${JSON.stringify(base())}`);
  assert.equal((await loadConfig()).bots[0].name, 'bot1');
});

test('MINIMINI_CONFIG relativo usa o diretório atual', (t) => {
  const previous = process.env.MINIMINI_CONFIG;
  t.after(() => {
    if (previous === undefined) delete process.env.MINIMINI_CONFIG;
    else process.env.MINIMINI_CONFIG = previous;
  });
  process.env.MINIMINI_CONFIG = 'relative-config.json';
  assert.equal(configPath(), resolve('relative-config.json'));
});

test('primeira execução sem terminal falha com instrução e sem aguardar entrada', async (t) => {
  const file = await temporaryConfig(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import { loadConfig } from './src/config.js'; try { await loadConfig(); process.exitCode = 9; } catch (error) { console.error(error.message); process.exitCode = 2; }"], {
    cwd: projectRoot, env: { ...process.env, MINIMINI_CONFIG: file }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /npm run configure/u);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
