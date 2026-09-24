import { setTimeout as delay } from 'node:timers/promises';
import pathfinderPackage from 'mineflayer-pathfinder';

const { goals } = pathfinderPackage;
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped'];
const LOGS = WOODS.map(wood => `${wood}_${['crimson', 'warped'].includes(wood) ? 'stem' : 'log'}`);
export const CRAFTABLE_ITEMS = Object.freeze([
  'crafting_table', 'stick', 'furnace', ...WOODS.map(wood => `${wood}_planks`),
  ...['wooden', 'stone'].flatMap(material => ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'].map(tool => `${material}_${tool}`)),
]);
const SOURCES = Object.fromEntries([...LOGS.map(log => [log, [log]]), ['cobblestone', ['stone', 'cobblestone']]]);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SEARCH_RADIUS = 32;
const MAX_OPERATIONS = 128;
const MAX_DEPTH = 10;
const TASK_TIMEOUT_MS = 600_000;

/** Objetivo declarativo; receitas vêm do jogo, nunca de código retornado pela IA. */
export class CraftingTask {
  constructor(controller, signal) {
    this.controller = controller;
    this.bot = controller.bot;
    this.signal = AbortSignal.any([signal, AbortSignal.timeout(TASK_TIMEOUT_MS)]);
    this.operations = 0;
    this.table = null;
  }
  count(name) {
    return this.bot.inventory.items().filter(item => item.name === name).reduce((total, item) => total + item.count, 0);
  }
  check() {
    this.signal.throwIfAborted();
    if (++this.operations > MAX_OPERATIONS) throw new Error('limite de etapas de fabricação atingido');
  }
  ensureRoom() {
    const free = typeof this.bot.inventory.emptySlotCount === 'function'
      ? this.bot.inventory.emptySlotCount() : 36 - this.bot.inventory.items().length;
    // Mineflayer pode descartar itens ao esvaziar a grade com o inventário
    // cheio. Reserve um espaço, mesmo quando ingredientes poderiam liberá-lo.
    if (free < 1) throw new Error('inventário cheio; libere pelo menos um espaço para fabricar e coletar');
  }
  async run(item, count) {
    if (!CRAFTABLE_ITEMS.includes(item) || !Number.isInteger(count) || count < 1 || count > 16) {
      throw new Error('objetivo de fabricação não permitido');
    }
    await this.ensure(item, count, []);
    this.signal.throwIfAborted();
    if (this.count(item) < count) throw new Error(`não consegui obter ${item} x${count}`);
  }
  ingredients(recipe) {
    return recipe.delta.filter(part => part.count < 0).map(part => ({
      name: this.bot.registry.items[part.id]?.name, count: -part.count,
    }));
  }
  recipes(name) {
    const item = this.bot.registry.itemsByName[name];
    if (!item || !CRAFTABLE_ITEMS.includes(name)) return [];
    // O terceiro argumento habilita a consulta de receitas 3x3. Somente um
    // bloco real, revalidado e próximo será passado posteriormente a bot.craft.
    return this.bot.recipesAll(item.id, null, true).filter(recipe => recipe.result.count > 0
      && this.ingredients(recipe).every(part => part.name && part.count > 0));
  }
  chooseRecipe(name) {
    const available = new Map();
    const memo = new Map();
    const cost = (item, required, stack) => {
      const missing = Math.max(0, required - this.count(item));
      if (!missing) return 0;
      if (stack.includes(item) || stack.length >= MAX_DEPTH) return Infinity;
      const key = `${item}:${missing}`;
      if (memo.has(key)) return memo.get(key);
      const next = [...stack, item];
      if (SOURCES[item] && !available.has(item)) available.set(item, this.findBlocks(SOURCES[item], true, 1).length > 0);
      const value = SOURCES[item]
        ? (available.get(item) ? missing : Infinity)
        : Math.min(...this.recipes(item).map(recipe => {
          const batches = Math.ceil(missing / recipe.result.count);
          return batches + this.ingredients(recipe).reduce((total, part) => total + cost(part.name, part.count * batches, next), 0);
        }));
      memo.set(key, value);
      return value;
    };
    const candidates = this.recipes(name).map(recipe => ({ recipe, cost: this.ingredients(recipe)
      .reduce((total, part) => total + cost(part.name, part.count, [name]), 0) }));
    candidates.sort((a, b) => a.cost - b.cost);
    const chosen = candidates.find(candidate => Number.isFinite(candidate.cost));
    if (!chosen) throw new Error(`faltam materiais próximos ou receita suportada para ${name}; aproxime-me de madeira e pedra expostas ou entregue os ingredientes`);
    return chosen.recipe;
  }
  async ensure(name, count, stack) {
    this.check();
    if (this.count(name) >= count) return;
    this.ensureRoom();
    if (stack.length >= MAX_DEPTH || stack.includes(name)) throw new Error('dependências de fabricação cíclicas ou profundas demais');
    if (SOURCES[name]) { await this.collect(name, count, [...stack, name]); return; }
    const recipe = this.chooseRecipe(name);
    if (recipe.requiresTable) await this.ensureTable([...stack, name]);
    while (this.count(name) < count) {
      this.check();
      const parts = this.ingredients(recipe);
      // Criar uma ferramenta intermediária pode consumir materiais que já
      // tinham sido obtidos para outra dependência. Reconfira todos os saldos.
      while (parts.some(part => this.count(part.name) < part.count)) {
        this.check();
        for (const part of parts) await this.ensure(part.name, part.count, [...stack, name]);
      }
      if (recipe.requiresTable) await this.approachTable();
      const before = this.count(name);
      await this.perform(`fabricando ${name}`, async signal => {
        await this.controller.useHand(async () => {
          signal.throwIfAborted();
          this.ensureRoom();
          if (recipe.requiresTable) this.validTable(true);
          if (parts.some(part => this.count(part.name) < part.count)) throw new Error(`os ingredientes de ${name} mudaram`);
          // Uma execução por vez: count em Mineflayer é número de receitas,
          // não quantidade de itens. O cancelamento impede a próxima receita.
          await this.bot.craft(recipe, 1, recipe.requiresTable ? this.validTable(true) : null);
        }, signal);
      });
      if (this.count(name) < before + recipe.result.count) throw new Error(`a fabricação de ${name} não foi confirmada no inventário`);
    }
  }
  async perform(label, fn) {
    this.check();
    this.controller.task = label;
    this.controller.say(`Etapa: ${label}.`);
    const timeout = AbortSignal.timeout(this.controller.settings.actionTimeoutMs);
    const signal = AbortSignal.any([this.signal, timeout]);
    try {
      await fn(signal);
      signal.throwIfAborted();
    } catch (error) {
      if (timeout.aborted && !this.signal.aborted) throw new Error(`tempo limite ${label}`);
      throw error;
    }
  }
  findBlocks(names, exposed = false, count = 64) {
    const matching = [...new Set(names.map(name => this.bot.registry.blocksByName[name]?.id).filter(Number.isInteger))];
    if (!matching.length) return [];
    return this.bot.findBlocks({ matching, maxDistance: SEARCH_RADIUS, count,
      ...(exposed ? { useExtraInfo: block => this.safeToCollect(block) } : {}),
    }).map(point => this.bot.blockAt(point)).filter(block => block && names.includes(block.name)
      && (!exposed || this.safeToCollect(block)));
  }
  safeToCollect(block) {
    if (!block || block.diggable === false) return false;
    const feet = this.bot.entity.position.floored();
    const point = block.position;
    if (feet.x === point.x && feet.z === point.z && point.y < feet.y) return false;
    const neighbors = NEIGHBORS.map(offset => this.bot.blockAt(point.offset(...offset)));
    if (neighbors.some(neighbor => ['water', 'lava'].includes(neighbor?.name))) return false;
    const above = neighbors[2];
    if (above && /^(sand|red_sand|gravel|anvil|chipped_anvil|damaged_anvil)$|_concrete_powder$/.test(above.name)) return false;
    return neighbors.some(neighbor => neighbor && AIR.has(neighbor.name));
  }
  pickaxe() {
    const ranks = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };
    return this.bot.inventory.items().filter(item => /_pickaxe$/.test(item.name)
      && !this.hasSilkTouch(item)
      && (item.maxDurability == null || item.durabilityUsed < item.maxDurability))
      .sort((a, b) => (ranks[b.name.split('_')[0]] || 0) - (ranks[a.name.split('_')[0]] || 0))[0];
  }
  hasSilkTouch(item) {
    const enchants = item.enchants;
    const entries = Array.isArray(enchants) ? enchants : enchants?.enchantments || [];
    return entries.some(enchantment => (enchantment.name || this.bot.registry.enchantments?.[enchantment.id]?.name || '')
      .replace(/^minecraft:/, '') === 'silk_touch');
  }
  async collect(name, count, stack) {
    while (this.count(name) < count) {
      this.check();
      this.ensureRoom();
      if (name === 'cobblestone' && !this.pickaxe()) await this.ensure('wooden_pickaxe', this.count('wooden_pickaxe') + 1, stack);
      const candidates = this.findBlocks(SOURCES[name], true).slice(0, 8);
      if (!candidates.length) throw new Error(`não encontrei ${name} exposto e seguro nos chunks carregados a até ${SEARCH_RADIUS} blocos`);
      let collected = false;
      for (const candidate of candidates) {
        this.signal.throwIfAborted();
        let dug = false;
        try {
          await this.perform(`coletando ${name} (${this.count(name)}/${count})`, async signal => {
            await this.controller.moveToGoal(new goals.GoalLookAtBlock(candidate.position, this.bot.world, { reach: 4 }), signal);
            const block = this.bot.blockAt(candidate.position);
            if (!block || !SOURCES[name].includes(block.name) || !this.safeToCollect(block)) throw new Error('o recurso mudou ou não é seguro');
            const before = this.count(name);
            await this.controller.useHand(async () => {
              signal.throwIfAborted();
              this.ensureRoom();
              if (name === 'cobblestone') {
                const tool = this.pickaxe();
                if (!tool) throw new Error('não tenho uma picareta adequada');
                await this.bot.equip(tool, 'hand');
              }
              signal.throwIfAborted();
              if (!this.bot.canDigBlock(block) || !block.canHarvest(this.bot.heldItem?.type ?? null)) throw new Error('não consigo minerar esse bloco com a ferramenta disponível');
              await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
              signal.throwIfAborted();
              const current = this.bot.blockAt(block.position);
              if (current?.name !== block.name || !this.safeToCollect(current) || !this.bot.canDigBlock(current)
                || !current.canHarvest(this.bot.heldItem?.type ?? null)) throw new Error('o recurso ou o alcance mudou antes da mineração');
              const cancel = () => this.bot.stopDigging();
              signal.addEventListener('abort', cancel, { once: true });
              try {
                dug = true;
                await this.bot.dig(current, 'ignore');
              } finally { signal.removeEventListener('abort', cancel); }
            }, signal);
            signal.throwIfAborted();
            await this.pickUp(name, before, block.position, signal);
          });
          collected = true;
          break;
        } catch (error) {
          this.signal.throwIfAborted();
          // Tente outro bloco se o caminho falhou, mas nunca mine mais para
          // compensar um drop perdido, proteção do servidor ou inventário cheio.
          if (dug || candidate === candidates.at(-1)) throw error;
        }
      }
      if (!collected) throw new Error(`não consegui coletar ${name}`);
    }
  }
  async pickUp(name, before, origin, signal) {
    const deadline = Date.now() + 10_000;
    let ownGoal = null;
    let target = '';
    try {
      while (this.count(name) <= before) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error(`o drop de ${name} não entrou no inventário; confira espaço e proteção do servidor`);
        const drop = Object.values(this.bot.entities).filter(entity => entity.getDroppedItem?.()?.name === name
          && entity.position.distanceTo(origin) < 6).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))[0];
        if (drop) {
          const position = drop.position.floored();
          const key = `${position.x},${position.y},${position.z}`;
          if (key !== target) {
            target = key;
            this.controller.setGoal(new goals.GoalNear(position.x, position.y, position.z, 0));
            ownGoal = this.controller.goal;
          }
        }
        if (ownGoal && this.controller.pathFailure) throw new Error(`não há caminho até o drop de ${name}`);
        await delay(100, undefined, { signal });
      }
    } finally {
      if (ownGoal && this.controller.goal === ownGoal) {
        this.controller.goal = null;
        this.bot.pathfinder.setGoal(null);
      }
    }
  }
  validTable(reachable = false) {
    const table = this.table && this.bot.blockAt(this.table.position);
    if (table?.name !== 'crafting_table') throw new Error('a bancada de trabalho não está mais disponível');
    if (reachable && this.bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 4.5) {
      throw new Error('a bancada de trabalho ficou fora do alcance');
    }
    return table;
  }
  async approachTable() {
    await this.perform('aproximando da bancada', signal => this.controller.moveToGoal(
      new goals.GoalLookAtBlock(this.validTable().position, this.bot.world, { reach: 4 }), signal));
  }
  async ensureTable(stack) {
    if (this.table && this.bot.blockAt(this.table.position)?.name === 'crafting_table') return;
    this.table = this.findBlocks(['crafting_table'])[0] || null;
    if (this.table) return;
    await this.ensure('crafting_table', 1, stack);
    await this.perform('colocando bancada de trabalho', async signal => {
      const feet = this.bot.entity.position.floored();
      const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
      for (const [x, z] of offsets) {
        signal.throwIfAborted();
        const position = feet.offset(x, 0, z);
        const destination = this.bot.blockAt(position);
        const reference = this.bot.blockAt(position.offset(0, -1, 0));
        if (!destination || !AIR.has(destination.name) || reference?.boundingBox !== 'block') continue;
        if (Object.values(this.bot.entities).some(entity => entity.position?.distanceTo(position.offset(0.5, 0.5, 0.5)) < 1.5)) continue;
        await this.controller.execute({ type: 'place', ...reference.position, face: 'up', item: 'crafting_table' }, signal);
        this.table = this.bot.blockAt(position);
        this.validTable();
        return;
      }
      throw new Error('não há espaço livre com apoio sólido para colocar a bancada');
    });
  }
}
