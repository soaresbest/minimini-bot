import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatQueue } from './chat.js';
import { HELP } from './commands.js';

const { Movements, goals } = pathfinderPackage;
const { Vec3 } = vec3Package;
const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider', 'silverfish', 'endermite', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'blaze', 'breeze', 'slime', 'magma_cube', 'zoglin', 'hoglin', 'guardian', 'elder_guardian']);
const UNSAFE_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'chicken']);
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const RENDER_DISTANCE_CHUNKS = 12;
const BLOCK_SCAN_DISTANCE = RENDER_DISTANCE_CHUNKS * 16;
const SURFACE_RAY_LEVELS = [-0.75, -0.45, -0.2, 0, 0.2, 0.4];
const SURFACE_RAYS_PER_LEVEL = 24;
const VISIBLE_BLOCK_LIMIT = 120;
const CONVERSATION_LIMIT = 20;
const FACES = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

export class BotController {
  constructor(bot, spec, manager) {
    this.bot = bot;
    this.spec = spec;
    this.manager = manager;
    this.chat = new ChatQueue(bot);
    this.ready = false;
    this.life = 0;
    this.closed = false;
    this.task = 'parado';
    this.abort = null;
    this.goal = null;
    this.following = null;
    this.handBusy = false;
    this.eating = false;
    this.lastSurvivalWarning = null;
    this.lastAttack = 0;
    this.pathFailure = false;
    this.commandTimes = new Map();
    this.conversationHistory = [];
    this.serverAuthTimers = new Set();
    this.tickBusy = false;
    this.listeners = [];
    this.listen('spawn', () => this.onSpawn());
    this.listen('chat', (username, message) => { void manager.handleChat(this, username, message).catch(() => this.say('Não consegui concluir o comando.')); });
    this.listen('death', () => { this.life++; this.ready = false; this.clearServerAuthentication(); this.stop(); this.say('Morri. Aguardando renascer.'); });
    this.listen('path_update', result => { if (result.status === 'noPath' && !this.eating) this.pathFailure = true; });
    this.listen('entityHurt', (entity, source) => {
      const protectedEntity = this.following?.guard && this.findPlayer(this.following.player)?.entity;
      if (!protectedEntity || entity?.id !== protectedEntity.id || !source?.position || source.id === protectedEntity.id || source.id === this.bot.entity.id || (source.username && this.manager.isBot(source.username))) return;
      this.following.aggressor = { id: source.id, expires: Date.now() + 10000 };
    });
    this.listen('end', () => this.close());
    this.tickTimer = setInterval(() => { void this.tick().catch(() => {}); }, 500);
    this.tickTimer.unref?.();
  }
  listen(event, fn) { this.bot.on(event, fn); this.listeners.push([event, fn]); }
  get settings() { return this.manager.config.settings; }
  say(message, priority = false) { this.chat.say(message, priority); }
  onSpawn() {
    if (this.closed) return;
    this.life++;
    this.stop();
    this.ready = true;
    const movements = new Movements(this.bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowFreeMotion = false;
    movements.scafoldingBlocks = [];
    this.bot.pathfinder.setMovements(movements);
    this.manager.registerIdentity(this.bot.username);
    const life = this.life;
    void this.manager.authenticateServer(this, life).catch(() => {
      if (!this.closed && this.life === life) this.manager.log(`[${this.spec.name}] não foi possível preparar o registro automático; nenhuma senha foi enviada.`);
    });
    this.say(`Pronto! Modo ${this.spec.mode}. Use @${this.spec.name} help.`);
    this.manager.log(`[${this.spec.name}] conectado como ${this.bot.username}.`);
  }
  scheduleServerAuthentication(password, life = this.life, delays = [250, 750]) {
    this.clearServerAuthentication();
    const schedule = (command, wait) => {
      const timer = setTimeout(() => {
        this.serverAuthTimers.delete(timer);
        if (this.ready && !this.closed && this.life === life) this.bot.chat(command);
      }, wait);
      timer.unref?.();
      this.serverAuthTimers.add(timer);
    };
    schedule(`/register ${password} ${password}`, delays[0]);
    schedule(`/login ${password}`, delays[1]);
  }
  clearServerAuthentication() {
    for (const timer of this.serverAuthTimers) clearTimeout(timer);
    this.serverAuthTimers.clear();
  }
  findPlayer(name) {
    return Object.entries(this.bot.players ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  ensurePlayer(name) {
    if (this.manager.isBot(name)) throw new Error('Escolha um jogador, não um bot.');
    const player = this.findPlayer(name);
    if (!player) throw new Error(`O jogador ${name} não está conectado.`);
    return player;
  }
  stop() {
    this.abort?.abort();
    this.abort = null;
    this.following = null;
    this.goal = null;
    this.task = 'parado';
    this.pathFailure = false;
    this.bot.pathfinder?.setGoal(null);
    this.bot.clearControlStates?.();
    if (this.bot.targetDigBlock) this.bot.stopDigging();
  }
  startWork(label) {
    this.stop();
    const work = new AbortController();
    this.abort = work;
    this.task = label;
    return work;
  }
  setGoal(goal, dynamic = false) {
    this.goal = { goal, dynamic };
    this.pathFailure = false;
    if (!this.eating) this.bot.pathfinder.setGoal(goal, dynamic);
  }
  vector(x, y, z) { const v = this.bot.entity.position.clone(); v.x = x; v.y = y; v.z = z; return v; }
  async waitForHand(signal) {
    while (this.handBusy || this.eating) await delay(100, undefined, { signal });
    signal.throwIfAborted();
  }
  async useHand(fn, signal) {
    await this.waitForHand(signal);
    this.handBusy = true;
    // Keep the hand locked until the actual protocol operation settles, even if
    // the caller has cancelled its wait. Already-sent packets cannot be undone.
    const operation = (async () => {
      try { signal.throwIfAborted(); return await fn(); } finally { this.handBusy = false; }
    })();
    return await abortable(operation, signal);
  }
  async executePlan(actions, work) {
    try {
      for (const action of actions) {
        work.signal.throwIfAborted();
        await this.execute(action, work.signal);
      }
      if (!work.signal.aborted && this.abort === work && !this.following) {
        this.task = 'parado';
        this.goal = null;
        this.bot.pathfinder.setGoal(null);
        if (actions.some(a => !['status', 'help'].includes(a.type))) this.say('Tarefa concluída.');
      }
    } catch (error) {
      if (!work.signal.aborted && this.abort === work) {
        this.stop();
        this.say(`Não consegui concluir: ${error.name === 'TimeoutError' ? 'tempo limite atingido' : error.message}.`);
      }
    } finally {
      if (this.abort === work && !this.following) this.abort = null;
    }
  }
  async execute(action, signal) {
    signal.throwIfAborted();
    if (action.type === 'status') { this.say(this.status()); return; }
    if (action.type === 'help') { HELP.forEach(line => this.say(line)); return; }
    if (action.type === 'stop') {
      this.following = null;
      this.goal = null;
      this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
      this.task = 'parado';
      return;
    }
    const timeout = AbortSignal.timeout(this.settings.actionTimeoutMs);
    const bounded = AbortSignal.any([signal, timeout]);
    if (action.type === 'goto') {
      this.task = `indo para ${action.x}, ${action.y}, ${action.z}`;
      // GoalNear accounts for a standing player's fractional position.
      const goal = new goals.GoalNear(action.x, action.y, action.z, 1);
      this.setGoal(goal);
      try {
        while (!goal.isEnd(this.bot.entity.position.floored())) {
          bounded.throwIfAborted();
          if (this.pathFailure) throw new Error('não há caminho seguro até o destino');
          await delay(200, undefined, { signal: bounded });
        }
      } catch (error) {
        if (timeout.aborted && !signal.aborted) throw new Error('tempo limite para chegar ao destino');
        throw error;
      }
      signal.throwIfAborted();
      this.goal = null;
      this.bot.pathfinder.setGoal(null);
      return;
    }
    if (action.type === 'follow' || action.type === 'guard') {
      this.ensurePlayer(action.player);
      this.task = `${action.type === 'guard' ? 'protegendo' : 'seguindo'} ${action.player}`;
      this.following = { player: action.player, guard: action.type === 'guard', targetId: null };
      await this.updateFollow();
      return;
    }
    this.task = `${action.type}${action.item ? ` ${action.item}` : ''}`;
    if (action.type === 'wait') { await delay(action.seconds * 1000, undefined, { signal: bounded }); return; }
    if (action.type === 'look') { await abortable(this.bot.lookAt(this.vector(action.x, action.y, action.z), true), bounded); return; }
    if (action.type === 'equip') {
      await this.useHand(async () => { await this.bot.equip(this.inventoryItem(action.item), 'hand'); }, bounded);
      return;
    }
    if (action.type === 'dig') {
      const block = this.reachableBlock(action);
      if (!this.bot.canDigBlock(block)) throw new Error('esse bloco não pode ser minerado daqui');
      await this.useHand(async () => {
        const cancel = () => this.bot.stopDigging();
        bounded.addEventListener('abort', cancel, { once: true });
        try { bounded.throwIfAborted(); await this.bot.dig(block, true); } finally { bounded.removeEventListener('abort', cancel); }
      }, bounded);
      return;
    }
    if (action.type === 'place') {
      const block = this.reachableBlock(action);
      const face = this.vector(...FACES[action.face]);
      const destination = this.bot.blockAt(block.position.plus(face));
      if (!destination || !['air', 'cave_air', 'void_air'].includes(destination.name)) throw new Error('o espaço para colocar o bloco está ocupado');
      await this.useHand(async () => {
        await this.bot.equip(this.inventoryItem(action.item), 'hand');
        bounded.throwIfAborted();
        // The pinned Mineflayer implementation exposes this variant to force
        // immediate look, avoiding delayed placement after a cancelled turn.
        await this.bot._placeBlockWithOptions(block, face, { forceLook: true, swingArm: 'right' });
      }, bounded);
      return;
    }
    throw new Error('ação não permitida');
  }
  inventoryItem(name) {
    const item = this.bot.inventory.items().find(i => i.name === name);
    if (!item) throw new Error(`não tenho ${name} no inventário`);
    return item;
  }
  reachableBlock({ x, y, z }) {
    const point = this.vector(x, y, z);
    if (this.bot.entity.position.distanceTo(point) > 4.5) throw new Error('bloco fora do alcance; aproxime-se primeiro');
    const block = this.bot.blockAt(point);
    if (!block || block.boundingBox === 'empty') throw new Error('bloco de referência indisponível');
    return block;
  }
  async updateFollow() {
    const following = this.following;
    if (!following || this.eating) return;
    const player = this.findPlayer(following.player);
    if (!player) { this.stop(); this.say(`O jogador ${following.player} desconectou. Parei.`); return; }
    if (!player.entity) {
      this.bot.pathfinder.setGoal(null);
      this.goal = null;
      following.targetId = null;
      this.task = `aguardando ${following.player} entrar no alcance visível`;
      return;
    }
    let target = player.entity;
    let threat = null;
    if (following.guard) {
      const aggressor = following.aggressor?.expires > Date.now() ? this.bot.entities[following.aggressor.id] : null;
      if (aggressor?.position.distanceTo(player.entity.position) <= 8 && aggressor.position.distanceTo(this.bot.entity.position) <= 16) threat = aggressor;
      threat ??= Object.values(this.bot.entities).filter(e => e !== this.bot.entity && HOSTILE.has(e.name) && e.position.distanceTo(player.entity.position) <= 8 && e.position.distanceTo(this.bot.entity.position) <= 16)
        .sort((a, b) => a.position.distanceTo(player.entity.position) - b.position.distanceTo(player.entity.position))[0];
      if (threat) target = threat;
    }
    this.task = `${following.guard ? 'protegendo' : 'seguindo'} ${following.player}${threat ? ` contra ${threat.username ?? threat.name}` : ''}`;
    if (following.targetId !== target.id) {
      following.targetId = target.id;
      this.setGoal(new goals.GoalFollow(target, threat ? 2 : 2.5), true);
    }
    if (threat && !this.handBusy && Date.now() - this.lastAttack >= 800 && threat.position.distanceTo(this.bot.entity.position) <= 3) {
      this.handBusy = true;
      try {
        const weapon = bestWeapon(this.bot.inventory.items());
        if (weapon && this.bot.heldItem?.type !== weapon.type) await this.bot.equip(weapon, 'hand');
        if (this.following !== following || this.closed || this.eating) return;
        await this.bot.lookAt(threat.position.offset(0, Math.min(threat.height ?? 1, 1), 0));
        if (this.following !== following || this.closed) return;
        this.bot.attack(threat);
        this.lastAttack = Date.now();
      } finally { this.handBusy = false; }
    }
  }
  async eat() {
    if (this.eating || this.handBusy || this.bot.food > this.settings.autoEatAt || this.bot.food >= 20) return;
    const food = this.safeFood();
    if (!food) return;
    this.eating = true;
    const life = this.life;
    const previous = this.bot.heldItem;
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
    try {
      this.say(`Vou comer ${food.name}.`);
      await this.bot.equip(food, 'hand');
      if (!this.ready || this.closed || this.life !== life) return;
      await this.bot.consume();
      if (this.ready && !this.closed && this.life === life && previous && this.bot.inventory.items().some(i => i.type === previous.type)) await this.bot.equip(previous, 'hand');
    } catch { /* inventory or connection may change while eating */ }
    finally {
      this.eating = false;
      if (this.ready && !this.closed && this.goal) this.bot.pathfinder.setGoal(this.goal.goal, this.goal.dynamic);
    }
  }
  safeFood() {
    return this.bot.inventory.items().filter(i => this.bot.registry.foodsByName?.[i.name] && !UNSAFE_FOOD.has(i.name))
      .sort((a, b) => (this.bot.registry.foodsByName[b.name].foodPoints ?? 0) - (this.bot.registry.foodsByName[a.name].foodPoints ?? 0))[0];
  }
  warnSurvival() {
    const needsWarning = (this.bot.food <= 8 || this.bot.health <= 8) && !this.safeFood();
    if (!needsWarning) { this.lastSurvivalWarning = null; return; }
    if (this.lastSurvivalWarning !== null && Date.now() - this.lastSurvivalWarning < 60000) return;
    this.say(`Alerta: vida ${this.bot.health}/20; fome ${this.bot.food}/20; estou sem comida segura no inventário.`);
    this.lastSurvivalWarning = Date.now();
  }
  async tick() {
    if (!this.ready || this.closed || this.tickBusy) return;
    this.tickBusy = true;
    try {
      await this.eat();
      if (!this.ready || this.closed) return;
      await this.updateFollow();
      this.warnSurvival();
    } finally { this.tickBusy = false; }
  }
  status() {
    const items = this.bot.inventory.items().map(i => `${i.name} x${i.count}`).join(', ') || 'vazio';
    return `Vida ${this.bot.health}/20; fome ${this.bot.food}/20; tarefa: ${this.task}; modo: ${this.spec.mode}; inventário: ${items}.`;
  }
  rememberConversation(player, message, reply) {
    this.conversationHistory.push({
      player: String(player).slice(0, 16),
      message: String(message).slice(0, 500),
      reply: String(reply).slice(0, 500),
    });
    if (this.conversationHistory.length > CONVERSATION_LIMIT) {
      this.conversationHistory.splice(0, this.conversationHistory.length - CONVERSATION_LIMIT);
    }
  }
  context() {
    const position = this.bot.entity.position;
    return {
      position: { x: position.x, y: position.y, z: position.z }, health: this.bot.health, food: this.bot.food,
      foodSaturation: this.bot.foodSaturation, oxygen: this.bot.oxygenLevel,
      task: this.task, dimension: this.bot.game.dimension,
      heldItem: this.bot.heldItem ? { name: this.bot.heldItem.name, count: this.bot.heldItem.count } : null,
      inventory: this.bot.inventory.items().map(({ name, count }) => ({ name, count })),
      players: Object.entries(this.bot.players).filter(([name]) => !this.manager.isBot(name)).map(([name, p]) => ({
        name,
        position: p.entity?.position,
        distance: p.entity?.position?.distanceTo(position),
        loaded: Boolean(p.entity),
      })),
      nearbyBlocks: this.visibleBlocks(position),
      nearbyEntities: Object.values(this.bot.entities).filter(e => e.position.distanceTo(position) < 24).slice(0, 30).map(e => ({ name: e.name ?? e.username, type: e.type, position: e.position })),
      conversationHistory: this.conversationHistory.map(entry => ({ ...entry })),
    };
  }
  visibleBlocks(position = this.bot.entity.position) {
    if (typeof this.bot.world?.raycast !== 'function') return [];
    try {
      const origin = new Vec3(position.x, position.y + 1.62, position.z);
      const visible = new Map();
      for (const vertical of SURFACE_RAY_LEVELS) {
        for (let index = 0; index < SURFACE_RAYS_PER_LEVEL; index++) {
          const angle = index * Math.PI * 2 / SURFACE_RAYS_PER_LEVEL;
          const direction = new Vec3(Math.cos(angle), vertical, Math.sin(angle)).normalize();
          const hit = this.bot.world.raycast(origin, direction, BLOCK_SCAN_DISTANCE, block => block && !AIR_BLOCKS.has(block.name));
          if (!hit?.position || AIR_BLOCKS.has(hit.name)) continue;
          const key = `${hit.position.x},${hit.position.y},${hit.position.z}`;
          if (!visible.has(key)) visible.set(key, {
            name: hit.name,
            position: { x: hit.position.x, y: hit.position.y, z: hit.position.z },
            distance: hit.position.distanceTo(position),
          });
        }
      }
      return [...visible.values()].sort((a, b) => a.distance - b.distance).slice(0, VISIBLE_BLOCK_LIMIT);
    } catch {
      // Chunks can unload while the snapshot is being collected.
      return [];
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.stop();
    this.clearServerAuthentication();
    clearInterval(this.tickTimer);
    this.chat.close();
    for (const [event, fn] of this.listeners) this.bot.removeListener(event, fn);
  }
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('Ação cancelada'));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export function bestWeapon(items) {
  const material = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 };
  return items.filter(i => /_(sword|axe)$/.test(i.name)).sort((a, b) => {
    const score = item => (material[item.name.split('_')[0]] ?? 0) * 2 + Number(item.name.endsWith('_sword'));
    return score(b) - score(a);
  })[0];
}
