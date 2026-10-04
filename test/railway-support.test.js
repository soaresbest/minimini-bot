import test from 'node:test';
import assert from 'node:assert/strict';
import vec3Package from 'vec3';
import { RailwayTask } from '../src/railway.js';

const { Vec3 } = vec3Package;
const EMPTY = new Set(['air', 'water', 'rail', 'powered_rail']);

function railwayWorld({ blocks: initialBlocks, botPosition, waterY, blockBody = true, refusePlacement = () => false }) {
  const blocks = new Map();
  const placed = [];
  const dug = [];
  const invalidPlacements = [];
  const refusedPlacements = [];
  const items = ['stone', 'redstone_block', 'powered_rail', 'rail']
    .map((name, index) => ({ name, count: 64, type: index + 1 }));
  let heldItem = null;

  function block(position, name) {
    return {
      name, position: position.clone(), type: name === 'water' ? 0 : 1,
      boundingBox: EMPTY.has(name) ? 'empty' : 'block',
      diggable: true,
    };
  }
  function put(position, name) { blocks.set(position.toString(), block(position, name)); }
  function get(position) {
    assert.ok([position.x, position.y, position.z].every(Number.isInteger), 'consulta de bloco usa coordenadas inteiras');
    return blocks.get(position.toString()) ?? block(position, position.y <= waterY ? 'water' : 'air');
  }
  for (const [position, name] of initialBlocks) put(position, name);

  const bot = {
    entity: { position: botPosition.clone(), width: 0.6, height: 1.8 },
    inventory: { items: () => items.filter(item => item.count > 0) },
    blockAt: get,
    canDigBlock: () => true,
    dig: async current => {
      assert.equal(get(current.position).name, current.name, 'mineração usa o bloco atual do mundo');
      dug.push(current.position.clone());
      blocks.delete(current.position.toString());
    },
    stopDigging: () => {},
    equip: async item => {
      assert.ok(item?.count > 0, 'item equipado existe no inventário');
      heldItem = item;
    },
    lookAt: async () => {},
    chat: () => assert.fail('o teste deve usar somente o inventário'),
    _placeBlockWithOptions: async (reference, face) => {
      const destination = reference.position.plus(face);
      const actualReference = get(reference.position);
      const problem = ![face.x, face.y, face.z].every(Number.isInteger)
        || Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) !== 1
        ? 'a face deve ser um vetor unitário cardinal'
        : actualReference.boundingBox === 'empty'
          ? 'a referência já não é um bloco sólido'
          : actualReference.name !== reference.name
            ? 'a referência está desatualizada'
            : !['water', 'air'].includes(get(destination).name)
              ? 'o destino está ocupado'
              : null;
      if (problem) {
        invalidPlacements.push({ problem, destination: destination.toString() });
        throw new Error(problem);
      }
      assert.ok(heldItem?.count > 0, 'a colocação consome um item disponível');
      if (refusePlacement(destination, heldItem.name)) {
        refusedPlacements.push(destination.clone());
        throw new Error('Server refused to place block');
      }
      if (blockBody && !EMPTY.has(heldItem.name)) {
        const { position, width, height } = bot.entity;
        const overlaps = destination.x < position.x + width / 2 && destination.x + 1 > position.x - width / 2
          && destination.z < position.z + width / 2 && destination.z + 1 > position.z - width / 2
          && destination.y < position.y + height && destination.y + 1 > position.y;
        if (overlaps) throw new Error('Server refused to place block inside the bot');
      }
      if (heldItem.name === 'rail' || heldItem.name === 'powered_rail') {
        assert.equal(get(destination.offset(0, -1, 0)).boundingBox, 'block', 'o trilho precisa de piso sólido');
      }
      put(destination, heldItem.name);
      placed.push({ position: destination.clone(), name: heldItem.name });
      heldItem.count--;
    },
  };
  const controller = {
    bot,
    useHand: async fn => await fn(),
    moveToGoal: async goal => {
      bot.entity.position = new Vec3(goal.x - 1.5, goal.y, goal.z + 0.5);
    },
  };
  const task = new RailwayTask(controller, new AbortController().signal);
  return { task, get, placed, dug, invalidPlacements, refusedPlacements, items };
}

function assertTrack(world, position, previous) {
  assert.equal(world.get(position).name, 'powered_rail');
  assert.equal(world.get(position.offset(0, -1, 0)).name, 'redstone_block');
  assert.equal(world.get(previous).name, 'rail', 'preserva o trilho anterior');
  assert.equal(world.get(previous.offset(0, -1, 0)).name, 'stone', 'preserva o piso anterior');
  assert.ok(!world.dug.some(point => point.equals(previous) || point.equals(previous.offset(0, -1, 0))),
    'não remove o trecho anterior nem temporariamente');
  for (const height of [1, 2]) {
    assert.equal(world.get(position.offset(0, height, 0)).boundingBox, 'empty', 'o corredor permanece livre');
  }
  assert.deepEqual(world.invalidPlacements, [], 'todas as colocações usam faces e referências válidas');
  assert.equal(world.items.find(item => item.name === 'redstone_block').count, 63);
  assert.equal(world.items.find(item => item.name === 'powered_rail').count, 63);
}

for (const [slope, y] of [['subida', 65], ['descida', 63]]) {
  test(`constrói ${slope} na água com piso anterior diagonal sem remover o trecho construído`, async () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, y, 0);
    const world = railwayWorld({
      blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
      botPosition: previous.offset(0.5, 0, 0.5),
      waterY: 65,
    });

    await world.task.buildCell({ index: 1, position, previous, powered: true, slope: true });

    assertTrack(world, position, previous);
    assert.ok(world.placed.some(entry => entry.name === 'stone'), 'cria apoio entre as posições diagonais');
  });
}

test('constrói trilho eletrificado sobre areia submersa e libera o espaço do trilho', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [
      [previous, 'rail'], [previous.offset(0, -1, 0), 'stone'],
      [support, 'sand'], [support.offset(0, -1, 0), 'sand'],
      [support.offset(1, 0, 0), 'sand'],
      [support.offset(0, 0, 1), 'sand'], [support.offset(0, 0, -1), 'sand'],
    ],
    botPosition: previous.offset(0.5, 0, 0.5),
    waterY: 64,
  });

  await world.task.buildCell({ index: 1, position, previous, powered: true });

  assertTrack(world, position, previous);
  assert.equal(world.get(support.offset(0, -1, 0)).name, 'sand', 'não precisa escavar a areia abaixo');
});

test('procura outro apoio quando o servidor recusa a primeira ligação de pedra', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 65, 0);
  const refused = new Vec3(1, 63, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5),
    waterY: 65,
    refusePlacement: point => point.equals(refused),
  });

  await world.task.buildCell({ index: 1, position, previous, powered: true, slope: true });

  assertTrack(world, position, previous);
  assert.ok(world.refusedPlacements.length > 0, 'o primeiro apoio realmente foi recusado');
  assert.ok(world.placed.some(entry => entry.name === 'stone' && !entry.position.equals(refused)),
    'constrói a ligação por outra posição');
});

test('falta de pedra para ligar o apoio interrompe a obra e preserva a ferrovia anterior', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 65, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5),
    waterY: 65,
  });
  world.items.find(item => item.name === 'stone').count = 0;

  await assert.rejects(() => world.task.buildCell({ index: 1, position, previous, powered: true, slope: true }), error => {
    assert.equal(error.code, 'RAILWAY_MATERIALS');
    assert.match(error.message, /stone/u);
    return true;
  });

  assert.equal(world.get(previous).name, 'rail');
  assert.equal(world.get(previous.offset(0, -1, 0)).name, 'stone');
  assert.deepEqual(world.dug, []);
  assert.deepEqual(world.placed, []);
});

test('confere estoque de redstone antes de escavar o piso submerso', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone'], [support, 'sand']],
    botPosition: previous.offset(0.5, 0, 0.5),
    waterY: 64,
  });
  world.items.find(item => item.name === 'redstone_block').count = 0;

  await assert.rejects(() => world.task.buildCell({ index: 1, position, previous, powered: true }), error => {
    assert.equal(error.code, 'RAILWAY_MATERIALS');
    assert.match(error.message, /redstone_block/u);
    return true;
  });

  assert.equal(world.get(support).name, 'sand');
  assert.deepEqual(world.dug, []);
  assert.deepEqual(world.placed, []);
});
