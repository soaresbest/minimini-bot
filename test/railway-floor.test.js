import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import { supportsRail } from '../src/railway-support.js';

const data = minecraftData('1.21.5');
const Block = blockLoader('1.21.5');
function state(name, properties = {}) {
  const type = data.blocksByName[name];
  for (let id = type.minStateId; id <= type.maxStateId; id++) {
    const block = Block.fromStateId(id, 0);
    if (Object.entries(properties).every(([key, value]) => block.getProperties()[key] === value)) return block;
  }
  assert.fail(`estado inexistente: ${name}`);
}

for (const name of ['dirt_path', 'farmland', 'oak_fence', 'glass_pane', 'chest', 'white_carpet', 'oak_leaves', 'snow']) {
  test(`forma real de ${name} exige piso substituto`, () => assert.equal(supportsRail(state(name)), false));
}
for (const name of ['stone', 'grass_block', 'glass', 'hopper', 'soul_sand']) {
  test(`preserva apoio compatível de ${name}`, () => assert.equal(supportsRail(state(name)), true));
}
test('considera o estado da laje e da escada, não apenas o nome ou boundingBox', () => {
  assert.equal(supportsRail(state('oak_slab', { type: 'bottom' })), false);
  assert.equal(supportsRail(state('oak_slab', { type: 'top' })), true);
  assert.equal(supportsRail(state('oak_slab', { type: 'double' })), true);
  assert.equal(supportsRail(state('oak_stairs', { half: 'bottom' })), false);
  assert.equal(supportsRail(state('oak_stairs', { half: 'top' })), true);
});
test('bloco futuro parcial e grass_path legado não dependem de lista de nomes', () => {
  for (const name of ['grass_path', 'bloco_parcial_futuro']) {
    assert.equal(supportsRail({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] }), false);
  }
  assert.equal(supportsRail({ name: 'bloco_sem_dados', boundingBox: 'block' }), false);
});
