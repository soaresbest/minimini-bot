import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PROVIDERS } from './ai/planner.js';

const MINECRAFT_NAME = /^[A-Za-z0-9_]{1,16}$/;
const MODES = new Set(['default', 'ia']);
const AUTH_TYPES = new Set(['offline', 'microsoft']);
const MISSING_CONFIG = Symbol('missing configuration');
const DEFAULT_SETTINGS = Object.freeze({
  maxBots: 8,
  progressIntervalMs: 15_000,
  reconnectDelayMs: 5_000,
  commandCooldownMs: 1_000,
  actionTimeoutMs: 120_000,
  autoEatAt: 16,
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath() {
  return process.env.MINIMINI_CONFIG?.trim()
    ? resolve(process.env.MINIMINI_CONFIG.trim())
    : join(homedir(), '.minimini-bot', 'config.json');
}

function object(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${label} deve ser um objeto.`);
  }
  return value;
}

function string(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ConfigError(`${label} deve ser um texto não vazio, sem caracteres de controle.`);
  }
  return value.trim();
}

function integer(value, label, fallback, minimum, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ConfigError(`${label} deve ser um número inteiro entre ${minimum} e ${maximum}.`);
  }
  return result;
}

function boolean(value, label, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'boolean') throw new ConfigError(`${label} deve ser true ou false.`);
  return result;
}

function minecraftName(value, label) {
  const result = string(value, label);
  if (!MINECRAFT_NAME.test(result)) {
    throw new ConfigError(`${label} deve ter de 1 a 16 letras, números ou sublinhados.`);
  }
  return result;
}

function providerName(value, label = 'Provedor de IA', fallback = 'openai') {
  const result = string(value, label, fallback).toLowerCase();
  if (!Object.hasOwn(PROVIDERS, result)) {
    throw new ConfigError(`${label} deve ser openai, gemini, grok ou claude.`);
  }
  return result;
}

function modelName(value, fallback) {
  const result = string(value, 'Modelo de IA', fallback);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(result)) {
    throw new ConfigError('Modelo de IA inválido; use o identificador informado pelo provedor.');
  }
  return result;
}

function serverHost(value) {
  const result = string(value, 'Endereço do servidor');
  if (result.length > 253 || !/^[A-Za-z0-9_.:[\]-]+$/u.test(result)) {
    throw new ConfigError('Endereço do servidor inválido; informe somente o hostname ou IP, sem protocolo ou porta.');
  }
  // Endereços IPv6 entre colchetes também são aceitos no assistente.
  const host = result.startsWith('[') && result.endsWith(']') ? result.slice(1, -1) : result;
  if ((result.includes('[') || result.includes(']')) && isIP(host) !== 6) {
    throw new ConfigError('Endereço IPv6 entre colchetes inválido.');
  }
  if (isIP(host)) return host;
  if (host.includes(':')) throw new ConfigError('Endereço IPv6 inválido ou porta incluída no endereço; informe a porta separadamente.');
  if (/^[\d.]+$/u.test(host) || !/^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)*[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.?$/u.test(host)) {
    throw new ConfigError('Endereço do servidor inválido; informe um hostname ou IP válido.');
  }
  return host;
}

function serverVersion(value) {
  const result = string(value, 'Versão do Minecraft', 'auto');
  if (result !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/u.test(result)) {
    throw new ConfigError('Versão do Minecraft inválida; use auto ou uma versão como 1.21.11 ou 26.2.');
  }
  return result;
}

function playerList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${label} deve ser uma lista de nomes.`);
  const seen = new Set();
  return value.map((name) => minecraftName(name, label)).filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function define(target, property, value) {
  Object.defineProperty(target, property, { value, enumerable: true, configurable: true, writable: true });
}

function registrationStore(value) {
  const raw = object(value, 'Registros de servidor', {});
  if (Object.keys(raw).length > 100) throw new ConfigError('Registros de servidor excedem o limite de 100 servidores.');
  const registrations = {};
  for (const [server, rawBots] of Object.entries(raw)) {
    if (!/^[^\u0000-\u001f\u007f]{1,320}:\d{1,5}$/u.test(server)) throw new ConfigError('Identificador de servidor inválido nos registros.');
    const bots = object(rawBots, 'Bots registrados');
    if (Object.keys(bots).length > 64) throw new ConfigError('Registros de servidor excedem o limite de 64 bots.');
    const normalizedBots = {};
    for (const [name, password] of Object.entries(bots)) {
      const botName = minecraftName(name, 'Nome do bot registrado').toLowerCase();
      if (typeof password !== 'string' || !/^\d{8}$/u.test(password)) {
        throw new ConfigError('Senha de registro inválida; ela deve conter exatamente 8 dígitos.');
      }
      define(normalizedBots, botName, password);
    }
    define(registrations, server.toLowerCase(), normalizedBots);
  }
  return registrations;
}

export function serverKey(server) {
  const host = server.host.toLowerCase();
  return `${host.includes(':') ? `[${host}]` : host}:${server.port}`;
}

/** Valida e devolve uma cópia normalizada; nunca copia chaves do ambiente. */
export function validateConfig(input, { requireAiKeys = true } = {}) {
  const config = object(input, 'Configuração');
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw new ConfigError('Versão de configuração não suportada; schemaVersion deve ser 1.');
  }
  const server = object(config.server, 'Servidor');
  const rawLlm = object(config.llm, 'Integração de IA', {});
  const rawProviders = object(rawLlm.providers, 'Provedores de IA', {});
  const llm = { provider: providerName(rawLlm.provider), providers: {} };
  for (const name of Object.keys(rawProviders)) {
    if (!Object.hasOwn(PROVIDERS, name)) throw new ConfigError('Os provedores devem usar os identificadores openai, gemini, grok ou claude.');
  }
  for (const [name, definition] of Object.entries(PROVIDERS)) {
    const raw = object(rawProviders[name], 'Configuração do provedor de IA', {});
    const provider = { model: modelName(raw.model, definition.defaultModel) };
    if (raw.apiKey !== undefined && raw.apiKey !== '') {
      const apiKey = string(raw.apiKey, 'Chave de API');
      if (apiKey.length > 4096) throw new ConfigError('Chave de API inválida.');
      provider.apiKey = apiKey;
    }
    llm.providers[name] = provider;
  }

  const rawSettings = object(config.settings, 'Preferências', {});
  const settings = {
    maxBots: integer(rawSettings.maxBots, 'Limite de bots', DEFAULT_SETTINGS.maxBots, 1, 64),
    progressIntervalMs: integer(rawSettings.progressIntervalMs, 'Intervalo de progresso', DEFAULT_SETTINGS.progressIntervalMs, 1000, 3_600_000),
    reconnectDelayMs: integer(rawSettings.reconnectDelayMs, 'Intervalo de reconexão', DEFAULT_SETTINGS.reconnectDelayMs, 1000, 300_000),
    commandCooldownMs: integer(rawSettings.commandCooldownMs, 'Intervalo entre comandos', DEFAULT_SETTINGS.commandCooldownMs, 0, 60_000),
    actionTimeoutMs: integer(rawSettings.actionTimeoutMs, 'Tempo limite de ação', DEFAULT_SETTINGS.actionTimeoutMs, 1000, 3_600_000),
    autoEatAt: integer(rawSettings.autoEatAt, 'Limite de fome para comer', DEFAULT_SETTINGS.autoEatAt, 0, 20),
  };
  if (!Array.isArray(config.bots) || config.bots.length === 0) {
    throw new ConfigError('Configure pelo menos um bot na lista bots.');
  }
  if (config.bots.length > settings.maxBots) throw new ConfigError('A quantidade de bots excede settings.maxBots.');
  const names = new Set();
  const accounts = new Set();
  const bots = config.bots.map((raw) => {
    const bot = object(raw, 'Bot');
    const name = minecraftName(bot.name, 'Nome do bot');
    if (names.has(name.toLowerCase())) throw new ConfigError('Os nomes dos bots devem ser únicos, inclusive sem diferenciar maiúsculas de minúsculas.');
    names.add(name.toLowerCase());
    const auth = string(bot.auth, 'Autenticação do bot', 'offline').toLowerCase();
    if (!AUTH_TYPES.has(auth)) throw new ConfigError('Autenticação do bot deve ser offline ou microsoft.');
    const username = auth === 'offline'
      ? minecraftName(bot.username ?? name, 'Usuário do bot')
      : string(bot.username, 'Conta Microsoft do bot');
    if (username.length > 254 || /\s/u.test(username)) throw new ConfigError('Usuário do bot inválido.');
    if (accounts.has(username.toLowerCase())) throw new ConfigError('Cada bot precisa de um usuário/conta diferente.');
    accounts.add(username.toLowerCase());
    const mode = string(bot.mode, 'Modo do bot', 'default').toLowerCase();
    if (!MODES.has(mode)) throw new ConfigError('Modo do bot deve ser default ou ia.');
    const result = { name, username, auth, mode };
    if (bot.provider !== undefined) result.provider = providerName(bot.provider, 'Provedor do bot');
    if (bot.model !== undefined) result.model = modelName(bot.model);
    const selectedProvider = result.provider ?? llm.provider;
    if (requireAiKeys && mode === 'ia' && !llm.providers[selectedProvider].apiKey && !process.env[PROVIDERS[selectedProvider].envKey]?.trim()) {
      throw new ConfigError(`O modo IA exige uma chave de ${selectedProvider}. Execute npm run configure ou defina ${PROVIDERS[selectedProvider].envKey}.`);
    }
    return result;
  });
  const rawAccess = object(config.access, 'Controle de acesso', {});
  const registrations = registrationStore(config.registrations);
  return {
    schemaVersion: 1,
    server: {
      host: serverHost(server.host),
      port: integer(server.port, 'Porta do servidor', 25565, 1, 65535),
      version: serverVersion(server.version),
      registration: boolean(server.registration, 'Registro automático do servidor', true),
    },
    bots,
    llm,
    access: {
      allowedPlayers: playerList(rawAccess.allowedPlayers, 'Jogadores autorizados'),
      ignoredPlayers: playerList(rawAccess.ignoredPlayers, 'Jogadores ignorados'),
    },
    settings,
    registrations,
  };
}

async function readConfigFile(file) {
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return MISSING_CONFIG;
    throw new ConfigError(`Não foi possível ler a configuração em ${file} (${error.code ?? 'erro de leitura'}).`);
  }
  try {
    return JSON.parse(content.replace(/^\uFEFF/u, ''));
  } catch {
    throw new ConfigError(`O arquivo ${file} contém JSON inválido. Corrija-o ou mova-o para um backup antes de configurar novamente; ele não foi alterado.`);
  }
}

/** Escrita atômica: um arquivo incompleto nunca substitui a configuração válida. */
export async function saveConfig(input) {
  const config = validateConfig(input);
  const file = configPath();
  // Mesmo chamadas diretas não sobrescrevem uma configuração danificada.
  const existing = await readConfigFile(file);
  if (existing !== MISSING_CONFIG) validateConfig(existing, { requireAiKeys: false });
  const directory = dirname(file);
  let temporary;
  let handle;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (directory === join(homedir(), '.minimini-bot') && process.platform !== 'win32') {
      await fs.chmod(directory, 0o700);
    }
    temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    temporary = undefined;
    return config;
  } catch (error) {
    throw new ConfigError(`Não foi possível salvar a configuração em ${file} (${error.code ?? 'erro de escrita'}).`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

async function ask(label, fallback, { secret = false } = {}) {
  const suffix = fallback === undefined || fallback === '' ? '' : ` [${fallback}]`;
  let output = process.stdout;
  if (secret) {
    output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    output.isTTY = true;
    output.columns = process.stdout.columns;
    process.stdout.write(`${label}: `);
  }
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  readline.once('SIGINT', () => controller.abort());
  readline.once('close', () => controller.abort());
  try {
    const result = (await readline.question(secret ? '' : `${label}${suffix}: `, { signal: controller.signal })).trim();
    return result || fallback || '';
  } catch (error) {
    if (error.name === 'AbortError') throw new ConfigError('Configuração cancelada; nenhuma alteração foi salva.');
    throw error;
  } finally {
    readline.close();
    if (secret) {
      output.destroy();
      process.stdout.write('\n');
    }
  }
}

async function askValidated(label, fallback, validate) {
  for (;;) {
    const value = await ask(label, fallback);
    try { return validate(value); } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      process.stdout.write(`${error.message}\n`);
    }
  }
}

async function configure(existing) {
  process.stdout.write('\nConfiguração do minimini-bot. Enter mantém o valor entre colchetes.\n');
  process.stdout.write(`A configuração será salva em ${configPath()}.\n`);
  const config = existing ? structuredClone(existing) : {
    server: {}, bots: [], llm: { providers: {} }, access: {}, settings: {},
  };
  config.server.host = await askValidated('Endereço do servidor Minecraft', config.server.host ?? 'localhost', serverHost);
  config.server.port = await askValidated('Porta', String(config.server.port ?? 25565), (value) => integer(Number(value), 'Porta', 25565, 1, 65535));
  let detectedVersion;
  process.stdout.write(`Consultando a versão de ${config.server.host}:${config.server.port}...\n`);
  try {
    const { detectServerVersion } = await import('./server-version.js');
    const detected = await detectServerVersion(config.server);
    detectedVersion = detected.version;
    process.stdout.write(`Servidor identificado como ${detected.serverName} (protocolo ${detected.protocol}); versão ${detected.version}.\n`);
    if (!detected.supported) process.stdout.write('Aviso: esta versão ainda não é suportada pelas dependências instaladas.\n');
  } catch (error) {
    process.stdout.write(`Não foi possível detectar automaticamente: ${error.message}.\n`);
  }
  config.server.version = await askValidated('Versão do Minecraft', detectedVersion ?? (config.server.version === 'auto' ? undefined : config.server.version) ?? 'auto', serverVersion);
  config.server.registration = (await askValidated('Servidor usa /register e /login? (s/n)', config.server.registration === false ? 'n' : 's', (value) => {
    if (!['s', 'n'].includes(value.toLowerCase())) throw new ConfigError('Responda s ou n.');
    return value.toLowerCase();
  })) === 's';
  const bot = config.bots[0] ?? {};
  const previousName = bot.name;
  bot.name = await askValidated('Nome para mencionar o primeiro bot no chat', bot.name ?? 'bot1', (value) => minecraftName(value, 'Nome do bot'));
  bot.auth = await askValidated('Autenticação (offline/microsoft)', bot.auth ?? 'offline', (value) => {
    const auth = value.toLowerCase();
    if (!AUTH_TYPES.has(auth)) throw new ConfigError('Escolha offline ou microsoft.');
    return auth;
  });
  if (bot.auth === 'offline') {
    bot.username = await askValidated('Nome do bot dentro do Minecraft', !MINECRAFT_NAME.test(bot.username ?? '') || bot.username === previousName ? bot.name : bot.username, (value) => minecraftName(value, 'Usuário do bot'));
  } else {
    process.stdout.write('Use uma conta Microsoft com Minecraft Java. A autenticação por código será solicitada ao conectar.\n');
    bot.username = await askValidated('E-mail/identificador da conta Microsoft', bot.username?.includes('@') ? bot.username : undefined, (value) => {
      const username = string(value, 'Conta Microsoft');
      if (username.length > 254 || /\s/u.test(username)) throw new ConfigError('Informe o e-mail/identificador da conta, sem espaços.');
      return username;
    });
  }
  bot.mode = await askValidated('Modo inicial (default/ia)', bot.mode ?? 'default', (value) => {
    const mode = value.toLowerCase();
    if (!MODES.has(mode)) throw new ConfigError('Escolha default ou ia.');
    return mode;
  });
  config.bots[0] = bot;
  const configureAi = bot.mode === 'ia' || (await askValidated('Configurar uma integração de IA agora? (s/n)', 'n', (value) => {
    if (!['s', 'n'].includes(value.toLowerCase())) throw new ConfigError('Responda s ou n.');
    return value.toLowerCase();
  })) === 's';
  if (configureAi) {
    const provider = await askValidated('Provedor (openai/gemini/grok/claude)', bot.provider ?? config.llm.provider ?? 'openai', providerName);
    config.llm.provider = provider;
    if (bot.mode === 'ia' || bot.provider) bot.provider = provider;
    const providerConfig = config.llm.providers[provider] ?? {};
    providerConfig.model = await askValidated('Modelo de IA', bot.model ?? providerConfig.model ?? PROVIDERS[provider].defaultModel, (value) => modelName(value));
    if (bot.model) bot.model = providerConfig.model;
    process.stdout.write(`A chave pode estar em ${PROVIDERS[provider].envKey}. A digitação ficará oculta; Enter preserva a chave salva e "-" a remove.\n`);
    const apiKey = await ask('Chave de API (opcional)', undefined, { secret: true });
    if (apiKey === '-') delete providerConfig.apiKey;
    else if (apiKey) providerConfig.apiKey = apiKey;
    config.llm.providers[provider] = providerConfig;
  }
  process.stdout.write('Uma lista vazia de autorizados permite comandos de todos os jogadores. Bots deste processo são sempre ignorados.\n');
  config.access.allowedPlayers = await askValidated('Jogadores autorizados, separados por vírgula (* permite todos)', config.access.allowedPlayers?.join(',') || '*', (value) => playerList(value === '*' ? [] : value.split(','), 'Jogadores autorizados'));
  config.access.ignoredPlayers = await askValidated('Nomes de outros bots/jogadores a ignorar (- para nenhum)', config.access.ignoredPlayers?.join(',') || '-', (value) => playerList(value === '-' ? [] : value.split(','), 'Jogadores ignorados'));
  const saved = await saveConfig(config);
  process.stdout.write('Configuração salva.\n\n');
  return saved;
}

export async function loadConfig({ configure: reconfigure = false } = {}) {
  const file = configPath();
  const raw = await readConfigFile(file);
  if (raw === MISSING_CONFIG || reconfigure) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new ConfigError(`Execute npm run configure em um terminal interativo para preparar ${file}, ou crie esse arquivo antes de iniciar sem terminal.`);
    }
    const existing = raw === MISSING_CONFIG ? null : validateConfig(raw, { requireAiKeys: false });
    return configure(existing);
  }
  return validateConfig(raw);
}
