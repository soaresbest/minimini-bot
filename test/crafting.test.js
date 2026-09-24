import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import minecraftData from 'minecraft-data';
import prismarineRecipe from 'prismarine-recipe';
import { Vec3 } from 'vec3';
import { CraftingTask } from '../src/crafting.js';
import { BotController } from '../src/controller.js';

const registry = minecraftData('1.21.4');
const { Recipe } = prismarineRecipe(registry);

function harness({ inventory = {}, logs = 8, stones = 12, table = false } = {}) {
  const counts = new Map(Object.entries(inventory));
  const blocks = new Map();
  const events = [];
  const abort = new AbortController();
  const key = position => `${position.x},${position.y},${position.z}`;
  const count = name => counts.get(name) ?? 0;
  const add = (name, amount) => {
    const next = count(name) + amount;
    assert.ok(next >= 0, `o inventário não pode consumir ${name} inexistente`);
    counts.set(name, next);
  };
  const block = (name, position) => {
    const definition = registry.blocksByName[name];
    return {
      ...definition, type: definition.id, position,
      canHarvest: tool => !definition.harvestTools || Boolean(definition.harvestTools[tool]),
    };
  };
  const putBlock = (name, position) => blocks.set(key(position), block(name, position));
  for (let index = 0; index < logs; index++) putBlock('oak_log', new Vec3(3 + index, 64, 3));
  for (let index = 0; index < stones; index++) putBlock('stone', new Vec3(3 + index, 64, -3));
  if (table) putBlock('crafting_table', new Vec3(2, 64, 0));

  const bot = new EventEmitter();
  Object.assign(bot, {
    registry, entities: {}, heldItem: null,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) },
    inventory: {
      items: () => [...counts.entries()].filter(([, amount]) => amount > 0)
        .map(([name, amount]) => ({ name, type: registry.itemsByName[name].id, count: amount, metadata: 0 })),
    },
    pathfinder: { setGoal: goal => { bot.goal = goal; } },
    findBlocks: ({ matching, maxDistance = 32, count: limit = 64, useExtraInfo }) => {
      const matches = typeof matching === 'function'
        ? matching
        : value => (Array.isArray(matching) ? matching : [matching]).includes(value.type);
      return [...blocks.values()]
        .filter(value => matches(value)
          && value.position.distanceTo(bot.entity.position) <= maxDistance
          && (typeof useExtraInfo !== 'function' || useExtraInfo(value)))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        .slice(0, limit).map(value => value.position.clone());
    },
    blockAt: position => {
      const point = position.floored();
      return blocks.get(key(point)) ?? block(point.y < 64 ? 'dirt' : 'air', point);
    },
    recipesAll: (id, metadata, craftingTable) => Recipe.find(id, metadata)
      .filter(recipe => !recipe.requiresTable || craftingTable),
    canDigBlock: value => value.diggable,
    equip: async item => {
      assert.ok(count(item.name) > 0, 'só pode equipar um item existente');
      bot.heldItem = item;
      events.push({ type: 'equip', item: item.name });
    },
    lookAt: async () => {},
    stopDigging: () => {},
    dig: async value => {
      assert.ok(value.canHarvest(bot.heldItem?.type), `${value.name} exige uma ferramenta apropriada`);
      assert.ok(blocks.delete(key(value.position)), 'só pode minerar um bloco uma vez');
      events.push({ type: 'dig', item: value.name, tool: bot.heldItem?.name });
      add(value.name === 'stone' ? 'cobblestone' : value.name, 1);
    },
    craft: async (recipe, amount, craftingTable) => {
      const name = registry.items[recipe.result.id].name;
      if (recipe.requiresTable) {
        assert.equal(craftingTable?.name, 'crafting_table', `${name} exige uma bancada`);
        assert.equal(bot.blockAt(craftingTable.position).name, 'crafting_table');
        assert.ok(bot.entity.position.distanceTo(craftingTable.position.offset(0.5, 0.5, 0.5)) <= 4.5,
          'a fabricação exige reaproximar-se da bancada depois da coleta');
      }
      for (const ingredient of recipe.delta.filter(entry => entry.count < 0)) {
        const item = registry.items[ingredient.id].name;
        assert.ok(count(item) >= -ingredient.count * amount, `${name} está sem ${item}`);
      }
      for (const entry of recipe.delta) add(registry.items[entry.id].name, entry.count * amount);
      events.push({ type: 'craft', item: name, amount });
    },
  });
  const controller = {
    bot, settings: { actionTimeoutMs: 1000 }, handBusy: false, eating: false,
    say: message => events.push({ type: 'say', message }),
    setGoal: goal => bot.pathfinder.setGoal(goal),
    moveToGoal: async (goal, signal) => {
      signal.throwIfAborted();
      events.push({ type: 'move' });
      if (goal.pos) {
        bot.entity.position = new Vec3(goal.pos.x - 1, Math.max(64, goal.pos.y), goal.pos.z);
      } else if ([goal.x, goal.y, goal.z].every(Number.isFinite)) {
        bot.entity.position = new Vec3(goal.x + 0.5, Math.max(64, goal.y), goal.z + 0.5);
      }
    },
    waitForHand: BotController.prototype.waitForHand,
    useHand: BotController.prototype.useHand,
    execute: async (action, signal) => {
      signal.throwIfAborted();
      assert.equal(action.type, 'place');
      assert.equal(action.item, 'crafting_table');
      assert.equal(action.face, 'up');
      const reference = new Vec3(action.x, action.y, action.z);
      const position = reference.offset(0, 1, 0);
      assert.equal(bot.blockAt(reference).boundingBox, 'block');
      assert.equal(bot.blockAt(position).name, 'air');
      add('crafting_table', -1);
      putBlock('crafting_table', position);
      events.push({ type: 'place', item: 'crafting_table' });
    },
  };
  return { bot, controller, abort, events, count, task: new CraftingTask(controller, abort.signal) };
}

test('picareta de pedra partindo do zero resolve dependências e minera com picareta de madeira', async () => {
  const h = harness();
  await h.task.run('stone_pickaxe', 1);
  assert.equal(h.count('stone_pickaxe'), 1);
  const index = (type, item) => h.events.findIndex(event => event.type === type && event.item === item);
  assert.ok(index('dig', 'oak_log') >= 0);
  assert.ok(index('craft', 'crafting_table') > index('dig', 'oak_log'));
  assert.ok(index('place', 'crafting_table') > index('craft', 'crafting_table'));
  assert.ok(index('craft', 'wooden_pickaxe') > index('place', 'crafting_table'));
  assert.ok(index('dig', 'stone') > index('craft', 'wooden_pickaxe'));
  assert.ok(index('craft', 'stone_pickaxe') > index('dig', 'stone'));
  assert.ok(h.events.filter(event => event.type === 'dig' && event.item === 'stone')
    .every(event => event.tool === 'wooden_pickaxe'));
  assert.equal(h.events.filter(event => event.type === 'place').length, 1);
});

test('item final já existente satisfaz o pedido sem fabricar nem coletar', async () => {
  const h = harness({ inventory: { stone_pickaxe: 2 }, logs: 0, stones: 0 });
  await h.task.run('stone_pickaxe', 2);
  assert.equal(h.count('stone_pickaxe'), 2);
  assert.deepEqual(h.events.filter(event => ['craft', 'dig', 'place'].includes(event.type)), []);
});

test('aproveita materiais e bancada existentes sem fabricar ferramenta intermediária', async () => {
  const h = harness({ inventory: { cobblestone: 3, stick: 2 }, table: true, logs: 0, stones: 0 });
  await h.task.run('stone_pickaxe', 1);
  assert.equal(h.count('stone_pickaxe'), 1);
  assert.equal(h.count('cobblestone'), 0);
  assert.deepEqual(h.events.filter(event => ['craft', 'dig', 'place'].includes(event.type))
    .map(event => [event.type, event.item]), [['craft', 'stone_pickaxe']]);
});

test('quantidade pedida considera o inventário e o rendimento de quatro gravetos', async () => {
  const h = harness({ inventory: { oak_planks: 4, stick: 1 }, logs: 0, stones: 0 });
  await h.task.run('stick', 6);
  assert.equal(h.count('stick'), 9);
  assert.equal(h.count('oak_planks'), 0);
  assert.equal(h.events.filter(event => event.type === 'dig').length, 0);
});

test('duas picaretas reutilizam a mesma bancada e a ferramenta de coleta', async () => {
  const h = harness();
  await h.task.run('stone_pickaxe', 2);
  assert.equal(h.count('stone_pickaxe'), 2);
  assert.equal(h.events.filter(event => event.type === 'craft' && event.item === 'wooden_pickaxe').length, 1);
  assert.equal(h.events.filter(event => event.type === 'place').length, 1);
  assert.equal(h.events.filter(event => event.type === 'dig' && event.item === 'stone').length, 6);
});

test('ausência de recurso próximo falha sem fingir que o item foi produzido', async () => {
  const h = harness({ logs: 0, stones: 0 });
  await assert.rejects(() => h.task.run('stone_pickaxe', 1), /não|indisponível|encontr|recurso|madeira|receita/iu);
  assert.equal(h.count('stone_pickaxe'), 0);
  assert.equal(h.events.filter(event => event.type === 'craft').length, 0);
});

test('ausência de receita na versão do servidor interrompe a fabricação', async () => {
  const h = harness({ inventory: { oak_planks: 8, stick: 2 }, table: true });
  const recipesAll = h.bot.recipesAll;
  h.bot.recipesAll = (id, ...args) => id === registry.itemsByName.wooden_pickaxe.id ? [] : recipesAll(id, ...args);
  await assert.rejects(() => h.task.run('wooden_pickaxe', 1), /receita|versão|fabric|produz|não/iu);
  assert.equal(h.count('wooden_pickaxe'), 0);
});

test('cancelamento durante craft pendente impede as próximas dependências', async () => {
  const h = harness({ inventory: { oak_log: 4 } });
  const craft = h.bot.craft;
  let finishCraft;
  let craftStarted;
  const started = new Promise(resolve => { craftStarted = resolve; });
  h.bot.craft = async (...args) => {
    craftStarted();
    await new Promise(resolve => { finishCraft = resolve; });
    return craft(...args);
  };
  const work = h.task.run('stone_pickaxe', 1);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await started;
  h.abort.abort();
  await rejected;
  assert.equal(h.controller.handBusy, true);
  finishCraft();
  await delay(0);
  assert.equal(h.controller.handBusy, false);
  assert.equal(h.count('stone_pickaxe'), 0);
  assert.equal(h.events.filter(event => event.type === 'craft').length, 1);
  assert.equal(h.events.filter(event => ['dig', 'place'].includes(event.type)).length, 0);
});

test('inventário cheio bloqueia fabricação e coleta antes de consumir recursos', async () => {
  const h = harness({ inventory: { oak_planks: 2 } });
  h.bot.inventory.emptySlotCount = () => 0;
  await assert.rejects(() => h.task.run('stick', 4), /inventário cheio/iu);
  assert.equal(h.count('oak_planks'), 2);
  assert.equal(h.count('stick'), 0);
  assert.deepEqual(h.events.filter(event => ['craft', 'dig', 'place'].includes(event.type)), []);
});

test('picareta com Toque Suave no formato moderno não é usada para obter pedregulho', async () => {
  const h = harness({ inventory: { diamond_pickaxe: 1, oak_log: 4 } });
  const items = h.bot.inventory.items;
  h.bot.inventory.items = () => items().map(item => item.name === 'diamond_pickaxe'
    ? { ...item, enchants: { enchantments: [{ id: registry.enchantmentsByName.silk_touch.id, level: 1 }] } }
    : item);
  await h.task.run('stone_pickaxe', 1);
  assert.equal(h.count('stone_pickaxe'), 1);
  assert.equal(h.events.filter(event => event.type === 'craft' && event.item === 'wooden_pickaxe').length, 1);
  const mining = h.events.filter(event => event.type === 'dig' && event.item === 'stone');
  assert.equal(mining.length, 3);
  assert.ok(mining.every(event => event.tool === 'wooden_pickaxe'));
});

test('receita considera quantidade insuficiente de carvalho e usa tronco de bétula disponível', async () => {
  const h = harness({ inventory: { oak_planks: 1, birch_log: 1 }, logs: 0, stones: 0 });
  await h.task.run('crafting_table', 1);
  assert.equal(h.count('crafting_table'), 1);
  assert.equal(h.count('oak_planks'), 1);
  assert.equal(h.count('birch_log'), 0);
  assert.deepEqual(h.events.filter(event => ['craft', 'dig'].includes(event.type))
    .map(event => [event.type, event.item]), [['craft', 'birch_planks'], ['craft', 'crafting_table']]);
});

test('drop não coletado interrompe a tarefa sem minerar mais blocos para compensar', async t => {
  const h = harness();
  h.controller.settings.actionTimeoutMs = 30;
  h.bot.dig = async value => { h.events.push({ type: 'dig', item: value.name }); };
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(() => h.task.run('crafting_table', 1), /tempo limite|drop/iu);
  assert.equal(h.events.filter(event => event.type === 'dig').length, 1);
  assert.equal(h.count('crafting_table'), 0);
});
