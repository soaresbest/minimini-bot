import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import vec3Package from 'vec3';
import { navigationMovements, configurePathfinderSearch, navigationWaypoints } from '../src/navigation.js';
import { RailwayTask } from '../src/railway.js';

const { Vec3 } = vec3Package;

test('movimentos reais permitem escavação e usam IDs de itens para terra e pedregulho', () => {
  const registry = minecraftData('1.21.5');
  const bot = { registry, inventory: { items: () => [
    { type: registry.itemsByName.dirt.id, count: 5 },
    { type: registry.itemsByName.cobblestone.id, count: 7 },
    { type: registry.itemsByName.stone.id, count: 64 },
  ] } };
  const movements = navigationMovements(bot);
  assert.equal(movements.canDig, true);
  assert.deepEqual(movements.scafoldingBlocks, [registry.itemsByName.dirt.id, registry.itemsByName.cobblestone.id]);
  assert.equal(movements.countScaffoldingItems(), 12);
  const pathfinder = { thinkTimeout: 5000 };
  configurePathfinderSearch(pathfinder);
  assert.equal(pathfinder.thinkTimeout, 25000);
  assert.equal(pathfinder.tickTimeout, 40);
  assert.equal(pathfinder.searchRadius, -1);
});

for (const end of [new Vec3(200, 64, 0), new Vec3(-200, 90, -300), new Vec3(0, -60, 0), new Vec3(1, 64, 1)]) {
  test(`checkpoints chegam a ${end} com trechos de até 64 blocos`, () => {
    let previous = new Vec3(0, 64, 0);
    const points = [...navigationWaypoints(previous, end)];
    for (const point of points) {
      assert.ok(previous.distanceTo(point) <= 64);
      assert.ok([point.x, point.y, point.z].every(Number.isInteger));
      previous = point;
    }
    assert.deepEqual(previous, end);
  });
}

test('railway espera cada waypoint e envia diagnóstico apenas ao console', async () => {
  const messages = [];
  const reached = [];
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, chat: () => assert.fail('debug não pode ir ao chat') };
  const controller = { bot, manager: { log: line => messages.push(line) },
    moveToGoal: async goal => {
      assert.ok(bot.entity.position.floored().distanceTo(new Vec3(goal.x, goal.y, goal.z)) <= 64);
      await new Promise(resolve => setImmediate(resolve));
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      reached.push(goal.x);
    } };
  await new RailwayTask(controller, new AbortController().signal).moveNear(new Vec3(200, 64, 0));
  assert.deepEqual(reached, [64, 128, 192, 200]);
  assert.equal(messages.filter(line => line.includes('checkpoint_navegacao')).length, 4);
});

test('stop entre checkpoints impede navegar até o próximo', async () => {
  const abort = new AbortController();
  let moves = 0;
  const controller = { bot: { entity: { position: new Vec3(0, 64, 0) } },
    moveToGoal: async () => { moves++; abort.abort(); } };
  await assert.rejects(new RailwayTask(controller, abort.signal).moveNear(new Vec3(200, 64, 0)), { name: 'AbortError' });
  assert.equal(moves, 1);
});
