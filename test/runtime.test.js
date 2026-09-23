import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BotManager } from '../src/manager.js';
import { BotController, bestWeapon } from '../src/controller.js';
import { validateConfig } from '../src/config.js';

class Point {
  constructor(x = 0, y = 64, z = 0) { Object.assign(this, { x, y, z }); }
  clone() { return new Point(this.x, this.y, this.z); }
  distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
  offset(x, y, z) { return new Point(this.x + x, this.y + y, this.z + z); }
  plus(p) { return this.offset(p.x, p.y, p.z); }
  floored() { return new Point(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}
function baseConfig(extra = {}) {
  return validateConfig({ server: { host: 'localhost' }, bots: [{ name: 'Bot1' }], settings: { commandCooldownMs: 0 }, ...extra });
}
function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username: 'Bot1', health: 20, food: 20, heldItem: null, targetDigBlock: null,
    entity: { id: 1, position: new Point() }, entities: {},
    players: { Alice: { username: 'Alice', entity: { id: 2, position: new Point(3, 64, 3) } }, Bot1: { username: 'Bot1' } },
    game: { dimension: 'overworld' }, registry: { foodsByName: { bread: { foodPoints: 5 } } },
    inventory: { items: () => [] }, pathfinder: { setGoal: (g) => { bot.currentGoal = g; }, setMovements: () => {} },
    chat: () => {}, clearControlStates: () => {}, stopDigging: () => {}, loadPlugin: () => {},
    equip: async item => { bot.heldItem = item; }, consume: async () => { bot.food = 20; }, lookAt: async () => {}, attack: e => { bot.attacked = e; },
    quit: () => { bot.emit('end'); }, end: () => { bot.emit('end'); }
  });
  return bot;
}
function harness(extra = {}, options = {}) {
  const config = baseConfig(extra);
  const saved = [];
  const manager = new BotManager(config, { log: () => {}, save: async c => saved.push(c), createBot: fakeBot, ...options });
  const bot = fakeBot();
  const controller = new BotController(bot, config.bots[0], manager);
  controller.ready = true;
  const said = [];
  controller.say = message => said.push(message);
  return { bot, controller, manager, said, saved, close: () => { controller.close(); manager.close(); } };
}

test('roteamento ignora ausência de menção, bots, desconhecidos e jogadores não autorizados', async t => {
  const h = harness({ access: { allowedPlayers: ['Alice'], ignoredPlayers: ['OtherBot'] } }); t.after(h.close);
  h.bot.players.OtherBot = {}; h.bot.players.Bob = {};
  for (const [name, msg] of [['Alice', 'status'], ['Bot1', '@Bot1 stop'], ['OtherBot', '@Bot1 stop'], ['Nobody', '@Bot1 stop'], ['Bob', '@Bot1 stop']]) await h.manager.handleChat(h.controller, name, msg);
  assert.equal(h.said.length, 0);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 stop');
  assert.match(h.said[0], /Parei/);
});

test('comando desconhecido tem resposta curta; follow rejeita jogador offline e bot', async t => {
  const h = harness(); t.after(h.close);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 dance');
  assert.equal(h.said.pop(), 'Não entendi. Use help.');
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 follow(Nobody)');
  assert.match(h.said.pop(), /não está conectado/);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 guard(Bot1)');
  assert.match(h.said.pop(), /não um bot/);
});

test('status preserva tarefa, enquanto stop cancela IA pendente e ignora resultado tardio', async t => {
  let resolvePlan;
  let signal;
  const h = harness({ bots: [{ name: 'Bot1', mode: 'ia' }], llm: { providers: { openai: { apiKey: 'test-key' } } } }, {
    planner: args => { signal = args.signal; return new Promise(resolve => { resolvePlan = resolve; }); }
  }); t.after(h.close);
  const pending = h.manager.handleChat(h.controller, 'Alice', '@Bot1 venha até mim');
  assert.match(h.said[0], /interpretando/);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 status');
  assert.equal(signal.aborted, false);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 stop');
  assert.equal(signal.aborted, true);
  resolvePlan({ reply: 'TARDE', actions: [{ type: 'follow', player: 'Alice' }] });
  await pending;
  assert.ok(!h.said.includes('TARDE'));
  assert.equal(h.controller.task, 'parado');
  assert.equal(h.controller.following, null);
});

test('criação, configuração e remoção persistem; última instância e chaves pelo chat são protegidas', async t => {
  const h = harness(); t.after(h.close);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 botadd(Bot2)');
  assert.equal(h.manager.config.bots.length, 2);
  assert.equal(h.saved.length, 1);
  assert.ok(h.manager.isBot('bot2'));
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 botconfig(Bot2,provider,gemini)');
  assert.equal(h.manager.config.bots[1].provider, 'gemini');
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 botremove(Bot2)');
  assert.equal(h.manager.config.bots.length, 1);
  assert.ok(h.manager.isBot('Bot2'));
  assert.ok(h.manager.config.access.ignoredPlayers.includes('Bot2'));
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 botremove(Bot1)');
  assert.match(h.said.at(-1), /pelo menos um bot/);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 mode(ia)');
  assert.match(h.said.at(-1), /chave/);
  assert.equal(h.manager.config.bots[0].mode, 'default');
});

test('falha ao salvar não aplica configuração parcial nem cria conexão', async t => {
  const h = harness({}, { save: async () => { throw new Error('Não foi possível salvar.'); } }); t.after(h.close);
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 botadd(Bot2)');
  assert.equal(h.manager.config.bots.length, 1);
  assert.equal(h.manager.records.size, 0);
});

test('pedidos simultâneos de criação respeitam maxBots e preservam gravações', async t => {
  const h = harness({ settings: { maxBots: 2, commandCooldownMs: 0 } }); t.after(h.close);
  await Promise.all([
    h.manager.handleChat(h.controller, 'Alice', '@Bot1 botadd(Bot2)'),
    h.manager.handleChat(h.controller, 'Alice', '@Bot1 botadd(Bot3)')
  ]);
  assert.equal(h.manager.config.bots.length, 2);
  assert.equal(h.saved.length, 1);
  assert.match(h.said.at(-1), /Limite/);
});

test('follow aguarda alvo fora do alcance e para ao desconectar', async t => {
  const h = harness(); t.after(h.close);
  const work = h.controller.startWork('follow');
  await h.controller.executePlan([{ type: 'follow', player: 'Alice' }], work);
  assert.ok(h.bot.currentGoal);
  delete h.bot.players.Alice.entity;
  await h.controller.updateFollow();
  assert.equal(h.bot.currentGoal, null);
  assert.match(h.controller.task, /aguardando/);
  h.bot.players.Alice.entity = { id: 3, position: new Point(5, 64, 5) };
  await h.controller.updateFollow();
  assert.ok(h.bot.currentGoal);
  delete h.bot.players.Alice;
  await h.controller.updateFollow();
  assert.equal(h.controller.task, 'parado');
});

test('alimentação segura pausa e retoma navegação, sem retomar após stop', async t => {
  const h = harness(); t.after(h.close);
  const bread = { name: 'bread', count: 2, type: 1 };
  h.bot.inventory.items = () => [bread, { name: 'rotten_flesh', type: 2 }];
  h.bot.food = 10;
  const goal = { goal: true };
  h.controller.setGoal(goal);
  await h.controller.eat();
  assert.equal(h.bot.heldItem, bread);
  assert.equal(h.bot.currentGoal, goal);
  h.bot.food = 10;
  let finish;
  h.bot.consume = () => new Promise(resolve => { finish = resolve; });
  const eating = h.controller.eat();
  await delay(0);
  assert.equal(h.bot.currentGoal, null);
  h.controller.stop();
  finish(); await eating;
  assert.equal(h.bot.currentGoal, null);
});

test('guard equipa arma e ataca mob próximo ao protegido, sem atacar outros jogadores', async t => {
  const h = harness(); t.after(h.close);
  const sword = { name: 'diamond_sword', type: 3 };
  h.bot.inventory.items = () => [{ name: 'wooden_axe', type: 4 }, sword];
  const zombie = { id: 9, name: 'zombie', position: new Point(2, 64, 0) };
  h.bot.entities = { 9: zombie, 10: { id: 10, type: 'player', name: 'player', position: new Point(1, 64, 0) } };
  const work = h.controller.startWork('guard');
  await h.controller.executePlan([{ type: 'guard', player: 'Alice' }], work);
  assert.equal(h.bot.heldItem, sword);
  assert.equal(h.bot.attacked, zombie);
  assert.equal(bestWeapon([{ name: 'bread' }]), undefined);
});

test('goto reporta caminho impossível e cancela imediatamente quando stop é recebido', async t => {
  const h = harness(); t.after(h.close);
  const work = h.controller.startWork('goto');
  const pending = h.controller.executePlan([{ type: 'goto', x: 100, y: 64, z: 100 }], work);
  h.bot.emit('path_update', { status: 'noPath' });
  await pending;
  assert.match(h.said.at(-1), /caminho seguro/);
  const next = h.controller.startWork('goto');
  const other = h.controller.executePlan([{ type: 'goto', x: 100, y: 64, z: 100 }], next);
  h.controller.stop(); await other;
  assert.equal(h.controller.task, 'parado');
  assert.equal(h.bot.currentGoal, null);
});

test('encerrar gerenciador impede reconexões e encerra todas as instâncias', t => {
  const h = harness(); t.after(h.close);
  h.manager.start();
  const record = h.manager.records.get('bot1');
  record.bot.emit('end');
  assert.ok(record.reconnectTimer);
  h.manager.close();
  assert.equal(h.manager.records.size, 0);
  assert.equal(record.removed, true);
});
