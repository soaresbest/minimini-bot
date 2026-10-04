import test from 'node:test';
import assert from 'node:assert/strict';
import vec3Package from 'vec3';
import { RailwayError, RailwayTask, findTerrainPath } from '../src/railway.js';

const { Vec3 } = vec3Package;

test('A* acompanha terreno plano e rampas de um bloco', () => {
  const heights = new Map([['1,0', 65], ['2,0', 66], ['3,0', 66], ['4,0', 65]]);
  const path = findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 4, y: 65, z: 0 },
    heightsAt: (x, z, currentY) => {
      const y = heights.get(`${x},${z}`) ?? 64;
      return Math.abs(y - currentY) <= 1 ? [y] : [];
    },
  });
  assert.deepEqual(path, [
    { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }, { x: 2, y: 66, z: 0 },
    { x: 3, y: 66, z: 0 }, { x: 4, y: 65, z: 0 },
  ]);
});

test('A* contorna degrau de dois blocos e mantém a curva plana', () => {
  const path = findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 4, y: 64, z: 0 },
    heightsAt: (x, z, currentY) => {
      const y = x === 2 && z === 0 ? 67 : 64;
      return Math.abs(y - currentY) <= 1 ? [y] : [];
    },
  });
  assert.ok(!path.some(point => point.x === 2 && point.z === 0));
  assert.ok(path.some(point => point.z !== 0));
  for (let index = 1; index < path.length - 1; index++) {
    const before = path[index - 1];
    const current = path[index];
    const after = path[index + 1];
    const turn = before.x - current.x !== current.x - after.x || before.z - current.z !== current.z - after.z;
    if (turn) assert.equal(before.y, after.y);
  }
});

test('A* informa quando não há alternativa dentro da área pesquisada', () => {
  assert.throws(() => findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 3, y: 64, z: 0 }, radius: 2,
    heightsAt: (x, _z, currentY) => x === 1 ? [] : [currentY],
  }), RailwayError);
});

test('leitura do mundo sobe ou desce um bloco e recusa desníveis maiores', () => {
  const ground = new Map([[1, 64], [2, 62], [3, 65], [4, 61]]);
  const bot = {
    blockAt: ({ x, y, z }) => {
      assert.equal(z, 0);
      const top = ground.get(x) ?? 63;
      return { name: y <= top ? 'stone' : 'air', boundingBox: y <= top ? 'block' : 'empty', position: new Vec3(x, y, z) };
    },
    canDigBlock: () => true,
  };
  const task = new RailwayTask({ bot }, new AbortController().signal);
  assert.deepEqual(task.terrainRailHeights(1, 0, 64), [65]);
  assert.deepEqual(task.terrainRailHeights(2, 0, 64), [63]);
  assert.deepEqual(task.terrainRailHeights(3, 0, 64), []);
  assert.deepEqual(task.terrainRailHeights(4, 0, 64), []);
});

test('reposição por comando é opt-in e usa somente comando e material fixos', async () => {
  const items = [];
  const sent = [];
  const controller = new AbortController();
  const task = new RailwayTask({ bot: {
    username: 'Bot1',
    inventory: { items: () => items },
    chat: command => { sent.push(command); items.push({ name: 'powered_rail', count: 32 }); },
  } }, controller.signal);

  await assert.rejects(() => task.ensureMaterial('powered_rail'), (error) => {
    assert.equal(error.code, 'RAILWAY_MATERIALS');
    assert.match(error.message, /só posso usar o inventário/u);
    return true;
  });
  assert.deepEqual(sent, []);

  task.allowCommands = true;
  await task.ensureMaterial('powered_rail');
  assert.deepEqual(sent, ['/give Bot1 minecraft:powered_rail 32']);
  await assert.rejects(() => task.ensureMaterial('command_block'), /segurança/u);
  assert.equal(sent.length, 1);
});

test('colocação relê o mundo e repete uma recusa transitória do servidor', async () => {
  const target = new Vec3(0, 64, 0);
  const support = new Vec3(0, 63, 0);
  const blocks = new Map([
    [target.toString(), { name: 'air', type: 0, boundingBox: 'empty', position: target }],
    [support.toString(), { name: 'redstone_block', type: 1, boundingBox: 'block', position: support }],
  ]);
  let attempts = 0;
  const bot = {
    entity: { position: target },
    inventory: { items: () => [{ name: 'powered_rail', count: 2, type: 2 }] },
    blockAt: point => blocks.get(point.toString()) ?? { name: 'air', type: 0, boundingBox: 'empty', position: point },
    equip: async () => {}, lookAt: async () => {},
    _placeBlockWithOptions: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Server refused to place powered_rail');
      blocks.set(target.toString(), { name: 'powered_rail', type: 3, boundingBox: 'empty', position: target });
    },
  };
  const controller = { bot, useHand: async fn => await fn() };
  const task = new RailwayTask(controller, new AbortController().signal);
  await task.replace(target, 'powered_rail');
  assert.equal(attempts, 2);
  assert.equal(bot.blockAt(target).name, 'powered_rail');
});
