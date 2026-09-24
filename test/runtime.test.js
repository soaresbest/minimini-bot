import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BotManager, generateRegistrationPassword } from '../src/manager.js';
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
function fakeBot({ username = 'Bot1' } = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username, health: 20, food: 20, heldItem: null, targetDigBlock: null,
    entity: { id: 1, position: new Point() }, entities: {},
    players: { Alice: { username: 'Alice', entity: { id: 2, position: new Point(3, 64, 3) } }, Bot1: { username: 'Bot1' } },
    game: { dimension: 'overworld' }, registry: { foodsByName: { bread: { foodPoints: 5 } } },
    inventory: { items: () => [] }, pathfinder: { setGoal: (g) => { bot.currentGoal = g; }, setMovements: () => {} },
    sent: [], chat: message => bot.sent.push(message), clearControlStates: () => {}, stopDigging: () => {}, loadPlugin: () => {},
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

test('contexto de IA inclui estado, inventário, jogadores e blocos carregados visíveis', t => {
  const h = harness(); t.after(h.close);
  const stonePosition = new Point(1, 64, 0);
  const stone = { name: 'stone', position: stonePosition };
  h.bot.health = 17;
  h.bot.food = 14;
  h.bot.foodSaturation = 3.5;
  h.bot.oxygenLevel = 12;
  h.bot.heldItem = { name: 'iron_pickaxe', count: 1 };
  h.bot.inventory.items = () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 4 }];
  h.bot.players.Bob = { username: 'Bob' };
  let rays = 0;
  h.bot.world = {
    raycast: (_eye, _direction, distance) => {
      assert.equal(distance, 192);
      rays++;
      return rays <= 2 ? stone : null;
    },
  };
  for (let index = 0; index < 22; index++) h.controller.rememberConversation('Alice', `pedido ${index}`, `resposta ${index}`);

  const context = h.controller.context();
  assert.equal(context.health, 17);
  assert.equal(context.food, 14);
  assert.equal(context.foodSaturation, 3.5);
  assert.equal(context.oxygen, 12);
  assert.deepEqual(context.heldItem, { name: 'iron_pickaxe', count: 1 });
  assert.deepEqual(context.inventory, [{ name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 4 }]);
  assert.deepEqual(context.nearbyBlocks, [{ name: 'stone', position: { x: 1, y: 64, z: 0 }, distance: 1 }]);
  assert.equal(rays, 144);
  assert.equal(context.conversationHistory.length, 20);
  assert.equal(context.conversationHistory[0].message, 'pedido 2');
  assert.equal(context.conversationHistory.at(-1).reply, 'resposta 21');
  assert.equal(context.players.find(player => player.name === 'Alice').loaded, true);
  assert.equal(context.players.find(player => player.name === 'Bob').loaded, false);
  assert.equal(context.players.some(player => player.name === 'Bot1'), false);
});

test('histórico anterior do bot é enviado ao próximo pedido de IA', async t => {
  let receivedContext;
  const h = harness({ bots: [{ name: 'Bot1', mode: 'ia' }], llm: { providers: { openai: { apiKey: 'test-key' } } } }, {
    planner: async args => { receivedContext = args.context; return { reply: 'Resposta atual.', actions: [] }; }
  }); t.after(h.close);
  h.controller.rememberConversation('Alice', 'mensagem anterior', 'resposta anterior');
  await h.manager.handleChat(h.controller, 'Alice', '@Bot1 mensagem atual');
  assert.deepEqual(receivedContext.conversationHistory, [{ player: 'Alice', message: 'mensagem anterior', reply: 'resposta anterior' }]);
  assert.deepEqual(h.controller.conversationHistory.at(-1), { player: 'Alice', message: 'mensagem atual', reply: 'Resposta atual.' });
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

test('alias de menção não bloqueia um jogador humano com o mesmo nome', async t => {
  const h = harness({ bots: [{ name: 'Alice', username: 'helperMC' }] }); t.after(h.close);
  assert.equal(h.manager.isBot('helperMC'), true);
  assert.equal(h.manager.isBot('Alice'), false);
  await h.manager.handleChat(h.controller, 'Alice', '@Alice status');
  assert.match(h.said.at(-1), /Vida 20/);
});

test('goto com coordenadas fracionárias reconhece o mesmo destino do pathfinder', async t => {
  const h = harness(); t.after(h.close);
  h.bot.entity.position = new Point(100.5, 63, 100.5);
  const work = h.controller.startWork('goto');
  await h.controller.executePlan([{ type: 'goto', x: 100.9, y: 64.9, z: 100.9 }], work);
  assert.equal(h.controller.task, 'parado');
  assert.match(h.said.at(-1), /concluída/);
  assert.equal(h.bot.currentGoal, null);
});

test('guard só reage a jogador agressor identificado e ignora bots conhecidos', async t => {
  const h = harness(); t.after(h.close);
  const bob = { id: 7, username: 'Bob', name: 'player', position: new Point(2, 64, 0) };
  h.bot.entities[7] = bob;
  const work = h.controller.startWork('guard');
  await h.controller.executePlan([{ type: 'guard', player: 'Alice' }], work);
  assert.equal(h.bot.attacked, undefined);
  h.bot.emit('entityHurt', h.bot.players.Alice.entity, bob);
  await h.controller.updateFollow();
  assert.equal(h.bot.attacked, bob);
  h.bot.attacked = null;
  h.controller.following.aggressor.expires = 0;
  h.manager.registerIdentity('Bob');
  h.bot.emit('entityHurt', h.bot.players.Alice.entity, bob);
  h.controller.lastAttack = 0;
  await h.controller.updateFollow();
  assert.equal(h.bot.attacked, null);
});

test('cancelar equip pendente encerra espera mas conserva trava até protocolo terminar', async t => {
  const h = harness(); t.after(h.close);
  h.bot.inventory.items = () => [{ name: 'iron_sword', type: 1 }];
  let finish;
  h.bot.equip = () => new Promise(resolve => { finish = resolve; });
  const work = h.controller.startWork('equip');
  const pending = h.controller.executePlan([{ type: 'equip', item: 'iron_sword' }], work);
  await delay(0);
  assert.equal(h.controller.handBusy, true);
  h.controller.stop();
  await pending;
  assert.equal(h.controller.handBusy, true);
  assert.equal(h.controller.task, 'parado');
  finish(); await delay(0);
  assert.equal(h.controller.handBusy, false);
  assert.equal(h.controller.task, 'parado');
});

test('timeout de operação nativa pendente retorna falha e ignora conclusão tardia', async t => {
  const h = harness(); t.after(h.close);
  h.manager.config.settings.actionTimeoutMs = 20;
  let finish;
  h.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const work = h.controller.startWork('look');
  await h.controller.executePlan([{ type: 'look', x: 1, y: 64, z: 1 }], work);
  assert.match(h.said.at(-1), /tempo limite/);
  assert.equal(h.controller.task, 'parado');
  const before = h.said.length;
  finish(); await delay(0);
  assert.equal(h.said.length, before);
});

test('morte durante alimentação não restaura item nem tarefa da vida anterior', async t => {
  const h = harness(); t.after(h.close);
  const sword = { name: 'iron_sword', type: 1 };
  const bread = { name: 'bread', type: 2 };
  h.bot.heldItem = sword;
  h.bot.inventory.items = () => [sword, bread];
  h.bot.food = 10;
  let finish;
  h.bot.consume = () => new Promise(resolve => { finish = resolve; });
  h.controller.setGoal({ old: true });
  const pending = h.controller.eat();
  await delay(0);
  h.bot.emit('death');
  assert.equal(h.controller.task, 'parado');
  // Simula o respawn e um novo pedido antes da operação anterior terminar.
  h.controller.life++;
  h.controller.ready = true;
  const newGoal = { current: true };
  h.controller.setGoal(newGoal);
  finish(); await pending;
  assert.equal(h.bot.heldItem, bread);
  assert.equal(h.bot.currentGoal, newGoal);
  assert.equal(h.controller.eating, false);
});

test('não envia progresso periódico e só alerta estado crítico sem comida', async t => {
  const h = harness(); t.after(h.close);
  h.controller.task = 'indo para 100, 64, 100';
  await h.controller.tick();
  assert.deepEqual(h.said, []);

  h.bot.food = 8;
  await h.controller.tick();
  assert.equal(h.said.length, 1);
  assert.match(h.said[0], /vida 20\/20; fome 8\/20;.*sem comida segura/u);
  await h.controller.tick();
  assert.equal(h.said.length, 1, 'o alerta não deve inundar o chat');

  h.bot.food = 20;
  h.bot.health = 20;
  await h.controller.tick();
  h.bot.health = 8;
  await h.controller.tick();
  assert.equal(h.said.length, 2);
  assert.match(h.said[1], /vida 8\/20; fome 20\/20/u);

  h.bot.inventory.items = () => [{ name: 'bread', count: 1, type: 1 }];
  h.bot.health = 7;
  await h.controller.tick();
  assert.equal(h.said.length, 2, 'com comida segura não deve haver alerta automático');
});

test('cancelar equip antes de colocar um bloco não coloca depois da conclusão tardia', async t => {
  const h = harness(); t.after(h.close);
  h.bot.inventory.items = () => [{ name: 'stone', type: 1 }];
  h.bot.blockAt = position => ({ name: position.y === 64 ? 'air' : 'stone', type: position.y === 64 ? 0 : 1, boundingBox: position.y === 64 ? 'empty' : 'block', position });
  let placed = false;
  let finish;
  h.bot.equip = () => new Promise(resolve => { finish = resolve; });
  h.bot._placeBlockWithOptions = async () => { placed = true; };
  const work = h.controller.startWork('place');
  const pending = h.controller.executePlan([{ type: 'place', x: 1, y: 63, z: 1, face: 'up', item: 'stone' }], work);
  await delay(0);
  h.controller.stop();
  await pending;
  finish(); await delay(0);
  assert.equal(placed, false);
  assert.equal(h.controller.handBusy, false);
});

test('gera senha aleatória com exatamente 8 dígitos', () => {
  for (let index = 0; index < 100; index++) assert.match(generateRegistrationPassword(), /^\d{8}$/u);
});

test('cancelar durante look da colocação impede o pacote de bloco tardio', async t => {
  const h = harness(); t.after(h.close);
  h.bot.inventory.items = () => [{ name: 'crafting_table', type: 1 }];
  h.bot.blockAt = position => ({ name: position.y === 64 ? 'air' : 'stone', boundingBox: position.y === 64 ? 'empty' : 'block', position });
  let finish;
  let placed = false;
  h.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  h.bot._placeBlockWithOptions = async () => { placed = true; };
  const work = h.controller.startWork('bancada');
  const pending = h.controller.executePlan([{ type: 'place', x: 1, y: 63, z: 1, face: 'up', item: 'crafting_table' }], work);
  await delay(0);
  h.controller.stop();
  await pending;
  assert.equal(h.controller.handBusy, true);
  finish(); await delay(0);
  assert.equal(placed, false);
  assert.equal(h.controller.handBusy, false);
});

test('objetivo craft já satisfeito passa pelo executor sem ações no mundo', async t => {
  const h = harness(); t.after(h.close);
  h.bot.inventory.items = () => [{ name: 'stone_pickaxe', count: 1 }];
  const work = h.controller.startWork('fabricando');
  await h.controller.executePlan([{ type: 'craft', item: 'stone_pickaxe', count: 1 }], work);
  assert.equal(h.controller.task, 'parado');
  assert.equal(h.said.at(-1), 'Tarefa concluída.');
});

test('registro é salvo por servidor e bot antes de agendar os comandos', async () => {
  const config = validateConfig({
    server: { host: 'Example.COM', port: 25570 },
    bots: [{ name: 'Bot1' }, { name: 'Bot2' }]
  });
  const saved = [];
  const scheduled = [];
  const events = [];
  const passwords = ['00123456', '87654321'];
  const manager = new BotManager(config, {
    log: () => {}, save: async value => { events.push('save'); saved.push(structuredClone(value)); },
    registrationPassword: () => passwords.shift()
  });
  const first = { spec: config.bots[0], closed: false, life: 1, scheduleServerAuthentication: password => { events.push('schedule'); scheduled.push(password); } };
  await manager.authenticateServer(first, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].registrations['example.com:25570'].bot1, '00123456');
  assert.deepEqual(scheduled, ['00123456']);
  assert.deepEqual(events, ['save', 'schedule']);
  await manager.authenticateServer(first, 1);
  assert.equal(saved.length, 1, 'a senha existente deve ser reutilizada sem nova gravação');
  assert.deepEqual(scheduled, ['00123456', '00123456']);
  const second = { spec: config.bots[1], closed: false, life: 1, scheduleServerAuthentication: password => scheduled.push(password) };
  await manager.authenticateServer(second, 1);
  assert.equal(saved.length, 2);
  assert.equal(manager.config.registrations['example.com:25570'].bot2, '87654321');
});

test('controller envia /register e /login sem revelar a senha no chat normal', async t => {
  const h = harness(); t.after(h.close);
  h.controller.life = 4;
  h.controller.scheduleServerAuthentication('00123456', 4, [0, 5]);
  await delay(15);
  assert.deepEqual(h.bot.sent, ['/register 00123456 00123456', '/login 00123456']);
  assert.ok(h.said.every(message => !message.includes('00123456')));
});

test('registro desativado não gera nem envia senha', async () => {
  const config = validateConfig({ server: { host: 'localhost', registration: false }, bots: [{ name: 'Bot1' }] });
  let generated = false;
  let scheduled = false;
  const manager = new BotManager(config, {
    save: async () => assert.fail('não deve salvar'), log: () => {},
    registrationPassword: () => { generated = true; return '12345678'; }
  });
  await manager.authenticateServer({ spec: config.bots[0], closed: false, life: 1, scheduleServerAuthentication: () => { scheduled = true; } }, 1);
  assert.equal(generated, false);
  assert.equal(scheduled, false);
});

test('falha ao salvar impede o envio da senha ao servidor', async () => {
  const config = baseConfig();
  let scheduled = false;
  const manager = new BotManager(config, {
    log: () => {}, registrationPassword: () => '12345678',
    save: async () => { throw new Error('disco indisponível'); }
  });
  const controller = { spec: config.bots[0], closed: false, life: 1, scheduleServerAuthentication: () => { scheduled = true; } };
  await assert.rejects(() => manager.authenticateServer(controller, 1), /disco indisponível/u);
  assert.equal(scheduled, false);
  assert.deepEqual(manager.config.registrations, {});
});
