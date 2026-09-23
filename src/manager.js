import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import path from 'node:path';
import { BotController } from './controller.js';
import { extractMention, parseCommand, HELP, PLAYER_NAME } from './commands.js';
import { saveConfig, validateConfig, configPath } from './config.js';
import { planActions, resolveProviderConfig, validatePlan } from './ai/planner.js';

const MANAGEMENT = new Set(['mode', 'bots', 'botadd', 'botremove', 'botconfig']);
const key = name => name.toLowerCase();

export class BotManager {
  constructor(config, { save = saveConfig, createBot = mineflayer.createBot, planner = planActions, Controller = BotController, log = console.log } = {}) {
    this.config = config;
    this.save = save;
    this.createBot = createBot;
    this.planner = planner;
    this.Controller = Controller;
    this.log = log;
    this.records = new Map();
    this.identities = new Set();
    this.closing = false;
    this.mutations = Promise.resolve();
    for (const spec of config.bots) if (spec.auth === 'offline') this.registerIdentity(spec.username);
  }
  registerIdentity(name) { if (name) this.identities.add(key(name)); }
  isBot(name) { return this.identities.has(key(name)) || this.config.access.ignoredPlayers.some(n => key(n) === key(name)); }
  isAllowed(name) { return !this.isBot(name) && (!this.config.access.allowedPlayers.length || this.config.access.allowedPlayers.some(n => key(n) === key(name))); }
  start() { for (const spec of this.config.bots) this.addConnection(spec); }
  addConnection(spec) {
    const record = { spec, bot: null, controller: null, reconnectTimer: null, watchdog: null, attempts: 0, removed: false };
    this.records.set(key(spec.name), record);
    this.connect(record);
  }
  connect(record) {
    if (this.closing || record.removed) return;
    const { spec } = record;
    this.log(`[${spec.name}] conectando a ${this.config.server.host}:${this.config.server.port}...`);
    try {
      const bot = this.createBot({
        host: this.config.server.host, port: this.config.server.port,
        version: this.config.server.version === 'auto' ? false : this.config.server.version,
        username: spec.username, auth: spec.auth,
        profilesFolder: path.join(path.dirname(configPath()), 'sessions', spec.name),
        onMsaCode: data => this.log(`[${spec.name}] Login Microsoft: abra ${data.verification_uri} e informe o código ${data.user_code}.`)
      });
      record.bot = bot;
      bot.loadPlugin(pathfinderPackage.pathfinder);
      const controller = new this.Controller(bot, spec, this);
      record.controller = controller;
      record.watchdog = setTimeout(() => {
        if (!controller.ready && !record.removed && !this.closing) {
          this.log(`[${spec.name}] conexão não iniciou a tempo; tentando novamente.`);
          controller.close();
          bot.end('Tempo limite de conexão');
        }
      }, spec.auth === 'microsoft' ? 180000 : 45000);
      record.watchdog.unref?.();
      bot.once('login', () => { if (PLAYER_NAME.test(bot.username)) this.registerIdentity(bot.username); });
      bot.once('spawn', () => { clearTimeout(record.watchdog); record.attempts = 0; });
      bot.on('error', error => this.log(`[${spec.name}] falha de conexão (${safeErrorCode(error.code)}). Confira endereço, versão e autenticação.`));
      bot.on('kicked', () => this.log(`[${spec.name}] desconectado pelo servidor. Confira whitelist, conta, versão e regras do servidor.`));
      bot.once('end', () => {
        clearTimeout(record.watchdog);
        controller.close();
        if (record.bot !== bot) return;
        record.bot = null;
        this.scheduleReconnect(record);
      });
    } catch {
      record.controller?.close();
      record.bot?.end();
      record.bot = null;
      this.log(`[${spec.name}] não foi possível iniciar a conexão. Confira a configuração.`);
      this.scheduleReconnect(record);
    }
  }
  scheduleReconnect(record) {
    if (this.closing || record.removed || record.reconnectTimer) return;
    const wait = Math.min(this.config.settings.reconnectDelayMs * 2 ** Math.min(record.attempts++, 5), 60000);
    this.log(`[${record.spec.name}] reconexão em ${Math.round(wait / 1000)}s.`);
    record.reconnectTimer = setTimeout(() => { record.reconnectTimer = null; this.connect(record); }, wait);
  }
  async handleChat(controller, username, message) {
    if (this.closing || controller.closed || !controller.ready || typeof username !== 'string') return;
    // Server/system messages and names absent from the player list cannot issue commands.
    if (!controller.findPlayer(username) || !this.isAllowed(username)) return;
    const text = extractMention(message, controller.spec.name);
    if (text === null) return;
    const command = parseCommand(text);
    if (!['stop', 'status', 'help'].includes(command?.type)) {
      const now = Date.now();
      const last = controller.commandTimes.get(key(username)) ?? 0;
      if (now - last < this.config.settings.commandCooldownMs) { controller.say('Aguarde um instante entre comandos.', true); return; }
      for (const [name, time] of controller.commandTimes) if (now - time > 60000) controller.commandTimes.delete(name);
      controller.commandTimes.set(key(username), now);
    }
    if (command?.type === 'stop') { controller.stop(); controller.say('Entendido. Parei aqui.', true); return; }
    if (command?.type === 'status') { controller.say(controller.status(), true); return; }
    if (command?.type === 'help') { HELP.forEach(line => controller.say(line)); return; }
    if (MANAGEMENT.has(command?.type)) {
      controller.say('Entendido. Vou aplicar a configuração.', true);
      try { await this.mutate(() => this.manage(controller, command)); }
      catch (error) { controller.say(error.message, true); }
      return;
    }
    if (command) {
      try {
        if (command.player) controller.ensurePlayer(command.player);
        const work = controller.startWork(command.type);
        controller.say('Entendido. Vou executar.', true);
        void controller.executePlan([command], work);
      } catch (error) { controller.say(error.message, true); }
      return;
    }
    if (controller.spec.mode === 'default' || !text || /^(mode|botadd|botremove|botconfig)\s*\(/i.test(text)) {
      controller.say('Não entendi. Use help.', true);
      return;
    }
    try { resolveProviderConfig(this.config, controller.spec); }
    catch (error) { controller.say(error.message, true); return; }
    const work = controller.startWork('interpretando pedido com IA');
    controller.say('Recebi seu pedido. Estou interpretando com IA.', true);
    try {
      const result = await this.planner({ config: this.config, botConfig: controller.spec, message: text, player: username, context: controller.context(), signal: work.signal });
      if (work.signal.aborted || controller.closed) return;
      const plan = validatePlan(result);
      for (const action of plan.actions) if (action.player) controller.ensurePlayer(action.player);
      controller.say(plan.reply);
      await controller.executePlan(plan.actions, work);
    } catch (error) {
      if (!work.signal.aborted) { controller.stop(); controller.say(`Não consegui interpretar: ${error.message}`, true); }
    }
  }
  mutate(fn) {
    const next = this.mutations.then(() => { if (this.closing) return; return fn(); });
    this.mutations = next.catch(() => {});
    return next;
  }
  async manage(controller, command) {
    if (command.type === 'bots') {
      controller.say(this.config.bots.map(spec => `${spec.name}: ${spec.mode}, ${this.records.get(key(spec.name))?.controller?.ready ? 'conectado' : 'conectando'}`).join('; '));
      return;
    }
    const next = structuredClone(this.config);
    let target;
    if (command.type === 'botadd') {
      if (next.bots.length >= next.settings.maxBots) throw new Error(`Limite de ${next.settings.maxBots} bots atingido.`);
      if (next.bots.some(b => key(b.name) === key(command.name)) || controller.findPlayer(command.name)) throw new Error('Esse nome já está em uso.');
      if (controller.spec.auth === 'microsoft') throw new Error('Para adicionar uma conta Microsoft, configure outra conta no arquivo da home e reinicie.');
      target = { name: command.name, username: command.name, auth: 'offline', mode: command.mode, ...(command.provider ? { provider: command.provider } : {}) };
      if (target.mode === 'ia') resolveProviderConfig(next, target);
      next.bots.push(target);
    } else {
      const name = command.type === 'mode' ? controller.spec.name : command.name;
      target = next.bots.find(b => key(b.name) === key(name));
      if (!target) throw new Error('Bot não encontrado. Use bots.');
      if (command.type === 'botremove') {
        if (next.bots.length <= 1) throw new Error('Mantenha pelo menos um bot para receber comandos.');
        next.bots = next.bots.filter(b => b !== target);
        // Keep old names ignored across restarts so late chat cannot issue commands.
        const realName = this.records.get(key(target.name))?.bot?.username ?? (target.auth === 'offline' ? target.username : null);
        if (realName && PLAYER_NAME.test(realName) && !next.access.ignoredPlayers.some(n => key(n) === key(realName))) next.access.ignoredPlayers.push(realName);
      } else {
        if (command.type === 'mode') target.mode = command.mode;
        else target[command.key] = command.value;
        if (target.mode === 'ia') resolveProviderConfig(next, target);
      }
    }
    const normalized = validateConfig(next);
    await this.save(normalized);
    this.config = normalized;
    if (command.type === 'botadd') {
      const spec = normalized.bots.find(b => key(b.name) === key(target.name));
      this.registerIdentity(spec.username);
      this.addConnection(spec);
      controller.say(`Bot ${spec.name} criado. Conectando...`);
    } else if (command.type === 'botremove') {
      const record = this.records.get(key(target.name));
      if (record) { record.removed = true; clearTimeout(record.reconnectTimer); clearTimeout(record.watchdog); record.controller?.close(); record.bot?.quit('Removido por comando'); this.records.delete(key(target.name)); }
      const reporter = controller.closed ? [...this.records.values()].find(r => r.controller?.ready)?.controller : controller;
      reporter?.say(`Bot ${target.name} removido.`);
    } else {
      const spec = normalized.bots.find(b => key(b.name) === key(target.name));
      const record = this.records.get(key(spec.name));
      if (record) {
        record.spec = spec;
        record.controller?.stop();
        if (record.controller) record.controller.spec = spec;
      }
      controller.say(`Configuração salva: ${spec.name}, modo ${spec.mode}, provedor ${spec.provider ?? normalized.llm.provider}.`);
    }
  }
  close() {
    this.closing = true;
    for (const record of this.records.values()) {
      record.removed = true;
      clearTimeout(record.reconnectTimer);
      clearTimeout(record.watchdog);
      record.controller?.close();
      record.bot?.quit('Encerrando minimini-bot');
    }
    this.records.clear();
  }
}

function safeErrorCode(code) { return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'conexão interrompida'; }
