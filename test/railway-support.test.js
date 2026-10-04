import test from 'node:test';
import assert from 'node:assert/strict';
import vec3Package from 'vec3';
import { RailwayTask } from '../src/railway.js';

const { Vec3 } = vec3Package;
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const EMPTY = new Set(['air', ...LIQUIDS, 'rail', 'powered_rail']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'white_concrete_powder']);

function railwayWorld({ blocks: initialBlocks, botPosition, waterY, liquid = 'water', blockBody = true, refusePlacement = () => false }) {
  const blocks = new Map();
  const placed = [];
  const dug = [];
  const invalidPlacements = [];
  const refusedPlacements = [];
  const delayedRailRemovals = [];
  const items = ['stone', 'redstone_block', 'powered_rail', 'rail']
    .map((name, index) => ({ name, count: 64, type: index + 1 }));
  let heldItem = null;

  function block(position, name, shape = null) {
    return {
      name, position: position.clone(), type: LIQUIDS.has(name) ? 0 : 1,
      boundingBox: EMPTY.has(name) ? 'empty' : 'block',
      diggable: true,
      getProperties: () => shape ? { shape } : {},
    };
  }
  function put(position, name, shape = null) { blocks.set(position.toString(), block(position, name, shape)); }
  function get(position) {
    assert.ok([position.x, position.y, position.z].every(Number.isInteger), 'consulta de bloco usa coordenadas inteiras');
    return blocks.get(position.toString()) ?? block(position, position.y <= waterY ? liquid : 'air');
  }
  for (const [position, name, shape] of initialBlocks) put(position, name, shape);

  function updatePhysics() {
    for (const current of [...blocks.values()].sort((a, b) => a.position.y - b.position.y)) {
      if (!FALLING.has(current.name)) continue;
      let destination = current.position;
      while (destination.y > 0 && get(destination.offset(0, -1, 0)).boundingBox === 'empty') {
        destination = destination.offset(0, -1, 0);
      }
      if (!destination.equals(current.position)) {
        blocks.delete(current.position.toString());
        put(destination, current.name);
      }
    }
    for (const current of [...blocks.values()]) {
      if (['rail', 'powered_rail'].includes(current.name)
        && get(current.position.offset(0, -1, 0)).boundingBox === 'empty') {
        blocks.delete(current.position.toString());
      }
    }
  }

  function flushServerUpdates() {
    for (const position of delayedRailRemovals.splice(0)) blocks.delete(position.toString());
  }

  const bot = {
    entity: { position: botPosition.clone(), width: 0.6, height: 1.8 },
    inventory: { items: () => items.filter(item => item.count > 0) },
    blockAt: get,
    canDigBlock: current => !LIQUIDS.has(current.name),
    dig: async current => {
      assert.equal(get(current.position).name, current.name, 'mineração usa o bloco atual do mundo');
      const above = current.position.offset(0, 1, 0);
      if (current.boundingBox === 'block' && ['rail', 'powered_rail'].includes(get(above).name)) {
        // O servidor já removeu o trilho sem apoio, mas o pacote ainda não
        // chegou: blockAt continua vendo o trilho até flushServerUpdates.
        delayedRailRemovals.push(above);
      }
      if (current.boundingBox === 'block') {
        for (const [x, z, shape] of [
          [-1, 0, 'ascending_east'], [1, 0, 'ascending_west'],
          [0, -1, 'ascending_south'], [0, 1, 'ascending_north'],
        ]) {
          const neighbor = get(current.position.offset(x, 0, z));
          if (['rail', 'powered_rail'].includes(neighbor.name) && neighbor.getProperties().shape === shape) {
            // A rampa precisa também da face lateral no topo; removê-la
            // destrói o trilho mesmo com seu piso inferior ainda sólido.
            delayedRailRemovals.push(neighbor.position);
          }
        }
      }
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
            : !['air', ...LIQUIDS].includes(get(destination).name)
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
  return { task, get, placed, dug, invalidPlacements, refusedPlacements, items, updatePhysics, flushServerUpdates };
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
      waterY: y - 1,
    });

    await world.task.buildCell({ index: 1, position, previous, powered: true, slope: true });

    assertTrack(world, position, previous);
    assert.ok(world.placed.some(entry => entry.name === 'stone'), 'cria apoio entre as posições diagonais');
  });
}

test('constrói trilho eletrificado sobre areia cercada por água no nível do piso', async () => {
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
    waterY: 63,
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
    waterY: 64,
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
    waterY: 64,
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
    waterY: 63,
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

for (const material of ['grass_block', 'dirt', 'stone']) {
  test(`preserva o piso natural de ${material} ao instalar trilho comum`, async () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, 64, 0);
    const support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone'], [support, material]],
      botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
    });

    await world.task.buildCell({ index: 1, position, previous, powered: false });

    assert.equal(world.get(support).name, material);
    assert.equal(world.get(position).name, 'rail');
    assert.deepEqual(world.dug, []);
    assert.deepEqual(world.placed.map(entry => entry.name), ['rail']);
  });
}

for (const liquid of LIQUIDS) {
  test(`substitui o piso de ${liquid} por pedra e mantém o trilho fora do líquido`, async () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, 64, 0);
    const support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
      botPosition: previous.offset(0.5, 0, 0.5), waterY: 63, liquid,
    });

    await world.task.buildCell({ index: 1, position, previous, powered: false });

    assert.equal(world.get(support).name, 'stone');
    assert.equal(world.get(position).name, 'rail');
    assert.equal(world.get(position.offset(0, 1, 0)).name, 'air');
    assert.deepEqual(world.dug, [], 'líquidos são deslocados pelo bloco, sem tentativa de mineração');
    assert.deepEqual(world.invalidPlacements, []);
  });
}

test('recusa piso vazio antes de construir uma ponte artificial', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
  });

  await assert.rejects(world.task.buildCell({ index: 1, position, previous, powered: false }),
    error => error.code === 'RAILWAY_TERRAIN_CHANGED');

  assert.deepEqual(world.dug, []);
  assert.deepEqual(world.placed, []);
  assert.equal(world.get(previous).name, 'rail');
});

for (const offset of [0, 1, 2]) {
  test(`recusa lava no corredor à altura ${offset} sem escavar o piso`, async () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, 64, 0);
    const support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone'],
        [support, 'stone'], [position.offset(0, offset, 0), 'lava']],
      botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
    });

    await assert.rejects(world.task.buildCell({ index: 1, position, previous, powered: true }),
      error => error.code === 'RAILWAY_TERRAIN_CHANGED');

    assert.deepEqual(world.dug, []);
    assert.deepEqual(world.placed, []);
    assert.equal(world.get(support).name, 'stone');
  });
}

for (const material of FALLING) {
  test(`estabiliza ${material} suspenso antes do trilho comum para resistir às atualizações de gravidade`, async () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, 64, 0);
    const support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [
        [previous, 'rail'], [previous.offset(0, -1, 0), 'stone'],
        [support, material], [support.offset(0, -3, 0), 'stone'],
      ],
      botPosition: previous.offset(0.5, 0, 0.5),
      waterY: -1,
    });

    assert.equal(world.get(support.offset(0, -1, 0)).name, 'air', 'o piso natural começa suspenso');
    await world.task.buildCell({ index: 1, position, previous, powered: false });
    world.updatePhysics();

    assert.equal(world.get(support).name, 'stone', 'o piso final é um bloco que não cai');
    assert.equal(world.get(position).name, 'rail', 'o trilho continua apoiado depois da atualização física');
    assert.equal(world.get(previous).name, 'rail');
    assert.equal(world.get(previous.offset(0, -1, 0)).name, 'stone');
    assert.ok(!world.dug.some(point => point.equals(previous) || point.equals(previous.offset(0, -1, 0))));
    assert.deepEqual(world.invalidPlacements, []);
    assert.equal(world.items.find(item => item.name === 'stone').count, 63);
    assert.equal(world.items.find(item => item.name === 'rail').count, 63);
  });
}

test('retira e recoloca trilho existente ao estabilizar areia antes das atualizações tardias do servidor', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [
      [previous, 'rail'], [previous.offset(0, -1, 0), 'stone'],
      [position, 'rail'], [support, 'sand'], [support.offset(0, -3, 0), 'stone'],
    ],
    botPosition: previous.offset(0.5, 0, 0.5),
    waterY: -1,
  });

  await world.task.buildCell({ index: 1, position, previous, powered: false });
  world.flushServerUpdates();
  world.updatePhysics();

  assert.equal(world.get(support).name, 'stone');
  assert.equal(world.get(position).name, 'rail', 'o trilho permanece após receber todas as atualizações do servidor');
  const railDigIndex = world.dug.findIndex(point => point.equals(position));
  const supportDigIndex = world.dug.findIndex(point => point.equals(support));
  assert.ok(railDigIndex >= 0 && supportDigIndex > railDigIndex, 'retira o trilho antes de escavar seu piso');
  assert.ok(world.placed.some(entry => entry.name === 'rail' && entry.position.equals(position)),
    'confirma uma nova colocação do trilho após substituir o piso');
  assert.equal(world.get(previous).name, 'rail');
  assert.equal(world.get(previous.offset(0, -1, 0)).name, 'stone');
  assert.deepEqual(world.invalidPlacements, []);
});

for (const previousRail of ['rail', 'powered_rail']) {
  const makeAscendingWorld = () => {
    const previous = new Vec3(0, 64, 0);
    const position = new Vec3(1, 65, 0);
    const support = position.offset(0, -1, 0);
    const previousFloor = previousRail === 'powered_rail' ? 'redstone_block' : 'stone';
    const world = railwayWorld({
      blocks: [[previous, previousRail, 'ascending_east'], [previous.offset(0, -1, 0), previousFloor],
        [support, 'grass_block'], [support.offset(0, -1, 0), 'stone']],
      botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
    });
    return { world, previous, position, support, previousFloor };
  };

  test(`preserva rampa anterior de ${previousRail} ao trocar seu apoio lateral alto por redstone`, async () => {
    const { world, previous, position, support, previousFloor } = makeAscendingWorld();

    await world.task.buildCell({ index: 1, position, previous, powered: true, slope: true });
    world.flushServerUpdates();
    world.updatePhysics();

    assert.equal(world.get(previous).name, previousRail, 'a rampa resiste às atualizações tardias do servidor');
    assert.equal(world.get(previous.offset(0, -1, 0)).name, previousFloor, 'preserva o piso inferior da rampa');
    assert.equal(world.get(support).name, 'redstone_block');
    assert.equal(world.get(position).name, 'powered_rail');
    const railDig = world.dug.findIndex(point => point.equals(previous));
    const supportDig = world.dug.findIndex(point => point.equals(support));
    assert.ok(railDig >= 0 && supportDig > railDig, 'retira a rampa explicitamente antes de remover a face de apoio');
    const supportPlaced = world.placed.findIndex(entry => entry.position.equals(support));
    const railPlaced = world.placed.findIndex(entry => entry.position.equals(previous) && entry.name === previousRail);
    assert.ok(supportPlaced >= 0 && railPlaced > supportPlaced, 'restaura o mesmo tipo de trilho após confirmar o apoio');
    assert.ok(!world.dug.some(point => point.equals(previous.offset(0, -1, 0))));
    assert.deepEqual(world.invalidPlacements, []);
  });

  test(`falta de ${previousRail} para restaurar a rampa preserva o piso alto e o trecho anterior`, async () => {
    const { world, previous, position, support } = makeAscendingWorld();
    world.items.find(item => item.name === previousRail).count = 0;

    await assert.rejects(world.task.buildCell({ index: 1, position, previous, powered: true, slope: true }),
      error => error.code === 'RAILWAY_MATERIALS' && error.message.includes(previousRail));
    world.flushServerUpdates();

    assert.equal(world.get(previous).name, previousRail);
    assert.equal(world.get(support).name, 'grass_block');
    assert.deepEqual(world.dug, []);
    assert.deepEqual(world.placed, []);
  });
}
