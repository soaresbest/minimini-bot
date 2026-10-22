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
  return { task, get, placed, dug, invalidPlacements, refusedPlacements, items, updatePhysics, flushServerUpdates,
    applyServerBlock: put };
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

for (const material of ['grass_path', 'dirt_path', 'farmland', 'oak_slab', 'bloco_parcial_futuro']) {
  test(`troca ${material} por pedra antes de colocar trilho, sem mudar a altura`, async () => {
    const previous = new Vec3(0, 64, 0), position = new Vec3(1, 64, 0), support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone'], [support, material]],
      botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
    });
    world.get(support).shapes = [[0, 0, 0, 1, 15 / 16, 1]];
    await world.task.buildCell({ index: 1, position, previous, powered: false });
    assert.equal(world.get(support).name, 'stone');
    assert.equal(world.get(position).name, 'rail');
    assert.equal(world.get(previous).name, 'rail');
    assert.deepEqual(world.placed.map(e => e.name), ['stone', 'rail']);
  });
}

test('falta de pedra preserva o piso incompatível e avisa em vez de escavá-lo', async () => {
  const position = new Vec3(1, 64, 0), support = position.offset(0, -1, 0);
  const world = railwayWorld({ blocks: [[support, 'dirt_path']], botPosition: new Vec3(0.5, 64, 0.5), waterY: -1 });
  world.items.find(item => item.name === 'stone').count = 0;
  await assert.rejects(world.task.buildCell({ index: 0, position, powered: false }), { code: 'RAILWAY_MATERIALS' });
  assert.equal(world.get(support).name, 'dirt_path');
  assert.deepEqual(world.dug, []);
});

test('piso aparentemente completo recusado pelo servidor recebe pedra uma única vez', async () => {
  const position = new Vec3(1, 64, 0), support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [[support, 'bloco_de_mod'], [support.offset(0, -1, 0), 'stone']],
    botPosition: new Vec3(0.5, 64, 0.5), waterY: -1,
    refusePlacement: (_, name) => name === 'rail' && world.get(support).name !== 'stone',
  });
  world.get(support).shapes = [[0, 0, 0, 1, 1, 1]];
  await world.task.buildCell({ index: 0, position, powered: false });
  assert.equal(world.get(support).name, 'stone');
  assert.equal(world.get(position).name, 'rail');
  assert.equal(world.placed.filter(e => e.name === 'stone').length, 1);
});

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

test('coloca piso de pedra no vazio antes do trilho', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
  });

  await world.task.buildCell({ index: 1, position, previous, powered: false });

  assert.deepEqual(world.dug, []);
  assert.deepEqual(world.placed.map(entry => entry.name), ['stone', 'rail']);
  assert.equal(world.get(position.offset(0, -1, 0)).name, 'stone');
  assert.equal(world.get(position).name, 'rail');
  assert.deepEqual(world.invalidPlacements, []);
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

for (const material of ['gravel', 'white_concrete_powder']) {
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

test('retira e recoloca trilho existente ao estabilizar cascalho antes das atualizações tardias do servidor', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [
      [previous, 'rail'], [previous.offset(0, -1, 0), 'stone'],
      [position, 'rail'], [support, 'gravel'], [support.offset(0, -3, 0), 'stone'],
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

test('repõe novamente a rampa quando uma atualização tardia a remove após a primeira restauração', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 65, 0);
  const support = position.offset(0, -1, 0);
  const world = railwayWorld({
    blocks: [[previous, 'rail', 'ascending_east'], [previous.offset(0, -1, 0), 'stone'],
      [support, 'grass_block'], [support.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5), waterY: -1,
  });
  const place = world.task.bot._placeBlockWithOptions;
  const update = Promise.withResolvers();
  let restores = 0;
  let timer;
  world.task.bot._placeBlockWithOptions = async (reference, face) => {
    await place(reference, face);
    if (reference.position.plus(face).equals(previous) && ++restores === 1) {
      timer = setTimeout(() => {
        world.applyServerBlock(previous, 'air');
        update.resolve();
      }, 50);
    }
  };

  try {
    await world.task.buildCell({ index: 1, position, previous, powered: true, slope: true });
    assert.ok(restores >= 1, 'a rampa foi recolocada depois da troca do apoio');
    await update.promise;

    assert.equal(world.get(previous).name, 'rail', 'a rampa continua presente depois da atualização tardia');
    assert.equal(restores, 2, 'detecta o desaparecimento e faz nova colocação');
    assert.equal(world.get(support).name, 'redstone_block');
    assert.equal(world.get(position).name, 'powered_rail');
    assert.deepEqual(world.invalidPlacements, []);
  } finally {
    clearTimeout(timer);
  }
});

test('estende piso sobre vários blocos vazios preservando alimentação', async () => {
  const start = new Vec3(0, 64, 0);
  const world = railwayWorld({ blocks: [[start.offset(0, -1, 0), 'stone']],
    botPosition: start.offset(0.5, 0, 0.5), waterY: -1 });
  await world.task.run({ startX: 0, startY: 64, startZ: 0, endX: 12, endY: 64, endZ: 0, allowCommands: false });
  for (let x = 0; x <= 12; x++) {
    const rail = world.get(new Vec3(x, 64, 0)).name;
    assert.ok(['rail', 'powered_rail'].includes(rail));
    assert.equal(world.get(new Vec3(x, 63, 0)).name, rail === 'powered_rail' ? 'redstone_block' : 'stone');
  }
  assert.deepEqual(world.invalidPlacements, []);
});

test('falta de pedra interrompe extensão sobre vazio sem colocar trilho sem apoio', async () => {
  const previous = new Vec3(0, 64, 0);
  const position = new Vec3(1, 64, 0);
  const world = railwayWorld({ blocks: [[previous, 'rail'], [previous.offset(0, -1, 0), 'stone']],
    botPosition: previous.offset(0.5, 0, 0.5), waterY: -1 });
  world.items.find(item => item.name === 'stone').count = 0;
  await assert.rejects(world.task.buildCell({ index: 1, position, previous, powered: false }), /stone/);
  assert.deepEqual(world.placed, []);
  assert.equal(world.get(previous).name, 'rail');
});

test('apoio descarregado não é tratado como ar', async () => {
  const position = new Vec3(1, 64, 0);
  const task = new RailwayTask({ bot: { blockAt: () => null } }, new AbortController().signal);
  assert.deepEqual(task.terrainRailHeights(1, 0, 64), []);
  await assert.rejects(task.buildCell({ index: 1, position, powered: false }), { code: 'RAILWAY_TERRAIN_CHANGED' });
});

for (const material of ['sand', 'red_sand']) {
  for (const existingRail of [false, true]) {
    test(`preserva ${material} ${existingRail ? 'com trilho existente' : 'ao colocar trilho comum'}`, async () => {
      const position = new Vec3(1, 64, 0);
      const support = position.offset(0, -1, 0);
      const world = railwayWorld({
        blocks: [[support, material], [support.offset(0, -1, 0), 'stone'],
          ...(existingRail ? [[position, 'rail']] : [])],
        botPosition: new Vec3(0.5, 64, 0.5), waterY: -1,
      });
      world.items.find(item => item.name === 'stone').count = 0;
      await world.task.buildCell({ index: 1, position, previous: null, powered: false });
      world.updatePhysics();
      assert.equal(world.get(support).name, material);
      assert.equal(world.get(position).name, 'rail');
      assert.deepEqual(world.dug, []);
      assert.ok(world.placed.every(entry => entry.name === 'rail'));
    });
  }
  test(`recusa de trilho sobre ${material} não substitui areia por pedra`, async () => {
    const position = new Vec3(1, 64, 0);
    const support = position.offset(0, -1, 0);
    const world = railwayWorld({
      blocks: [[support, material], [support.offset(0, -1, 0), 'stone']],
      botPosition: new Vec3(0.5, 64, 0.5), waterY: -1,
      refusePlacement: (_point, item) => item === 'rail',
    });
    await assert.rejects(world.task.buildCell({ index: 1, position, previous: null, powered: false }),
      { code: 'RAILWAY_PLACEMENT' });
    assert.equal(world.get(support).name, material);
    assert.deepEqual(world.dug, []);
    assert.deepEqual(world.placed, []);
    assert.equal(world.items.find(item => item.name === 'stone').count, 64);
  });
}

function descendingWorld(length = 14) {
  const start = new Vec3(0, 80, 0);
  const end = new Vec3(length, 80 - length, 0);
  const world = railwayWorld({
    blocks: [[start, 'powered_rail'], [start.offset(0, -1, 0), 'redstone_block'],
      [end.offset(0, -1, 0), 'stone']],
    botPosition: start.offset(0.5, 0, 0.5), waterY: -65,
  });
  const teleports = [];
  world.task.bot.username = 'testbot';
  world.task.bot.chat = command => {
    assert.match(command, /^\/tp testbot /, 'somente teleporte autorizado; materiais vêm do inventário');
    const position = new Vec3(...command.split(' ').slice(2).map(Number));
    teleports.push(position);
    world.task.bot.entity.position = position;
  };
  return { ...world, teleports, start, end, action: { startX: start.x, startY: start.y, startZ: start.z,
    endX: end.x, endY: end.y, endZ: end.z, allowCommands: false } };
}

test('calcula descida sobre vazio e constrói apoios e trilhos de baixo para cima além do lote', async () => {
  const world = descendingWorld();
  await world.task.run(world.action);
  const rails = world.placed.filter(entry => ['rail', 'powered_rail'].includes(entry.name));
  assert.deepEqual(rails.map(entry => entry.position.x), Array.from({ length: 14 }, (_, i) => 14 - i));
  assert.equal(new Set(rails.map(entry => entry.position.toString())).size, 14);
  assert.deepEqual(rails.filter(entry => entry.name === 'powered_rail').map(entry => entry.position.x), [14, 12, 9, 6, 3]);
  const firstRail = world.placed.findIndex(entry => entry === rails[0]);
  assert.ok(world.placed.slice(firstRail).every(entry => ['rail', 'powered_rail'].includes(entry.name)),
    'todos os pisos estão prontos antes de colocar os trilhos');
  for (let x = 1; x <= 14; x++) {
    const point = new Vec3(x, 80 - x, 0);
    const powered = x % 3 === 0 || x === 14;
    assert.equal(world.get(point).name, powered ? 'powered_rail' : 'rail');
    assert.equal(world.get(point.offset(0, -1, 0)).name, powered ? 'redstone_block' : 'stone');
    assert.equal(world.get(point.offset(-1, 0, 0)).boundingBox, 'block', 'face alta sustenta o trilho inclinado');
  }
  assert.equal(world.get(world.start).name, 'powered_rail');
  assert.ok(world.teleports.length > 0, 'usa tp para acompanhar a construção dos apoios');
  assert.deepEqual(world.invalidPlacements, []);
});

for (const phase of ['supports', 'rails']) {
  test(`retoma descida interrompida na fase ${phase} sem repetir o que já concluiu`, async () => {
    const world = descendingWorld(6);
    const original = phase === 'supports' ? world.task.prepareDescentSupport.bind(world.task) : world.task.buildCell.bind(world.task);
    const method = phase === 'supports' ? 'prepareDescentSupport' : 'buildCell';
    world.task[method] = async (cell, ...args) => {
      if (cell.index === 3) throw new Error('conexão perdida');
      return original(cell, ...args);
    };
    await assert.rejects(world.task.run(world.action), /conexão perdida/);
    const checkpoint = structuredClone(world.task.checkpoint);
    assert.equal(checkpoint.descentState.phase, phase);
    const priorRails = world.placed.filter(entry => ['rail', 'powered_rail'].includes(entry.name)).map(entry => entry.position.toString());
    const resumed = new RailwayTask(world.task.controller, new AbortController().signal);
    await resumed.run(world.action, checkpoint);
    const allRails = world.placed.filter(entry => ['rail', 'powered_rail'].includes(entry.name));
    assert.equal(allRails.length, 6);
    for (const position of priorRails) assert.equal(allRails.filter(entry => entry.position.toString() === position).length, 1);
    assert.equal(resumed.descentState, null);
    assert.equal(resumed.checkpoint.built, 6);
  });
}

test('descida cria coluna de fundação de baixo para cima antes do degrau inferior', async () => {
  const world = descendingWorld(3);
  world.applyServerBlock(world.end.offset(0, -1, 0), 'air');
  world.applyServerBlock(world.end.offset(0, -5, 0), 'stone');
  await world.task.run(world.action);
  const foundation = world.placed.filter(entry => entry.position.x === 3 && entry.position.y < world.end.y);
  assert.deepEqual(foundation.map(entry => entry.position.y), [73, 74, 75, 76]);
  assert.equal(foundation.at(-1).name, 'redstone_block');
});

test('base desconhecida impede fundação sem colocar blocos no vazio descarregado', async () => {
  const world = descendingWorld(3);
  world.applyServerBlock(world.end.offset(0, -1, 0), 'air');
  const read = world.task.bot.blockAt;
  world.task.bot.blockAt = point => point.y <= 75 ? null : read(point);
  await assert.rejects(world.task.run(world.action), { code: 'RAILWAY_NO_SUPPORT' });
  assert.deepEqual(world.placed, []);
});

test('stop durante os apoios interrompe a descida antes de colocar trilhos', async () => {
  const world = descendingWorld(6);
  const abort = new AbortController();
  world.task.signal = abort.signal;
  const prepare = world.task.prepareDescentSupport.bind(world.task);
  let calls = 0;
  world.task.prepareDescentSupport = async (...args) => {
    calls++;
    await prepare(...args);
    abort.abort();
  };
  await assert.rejects(world.task.run(world.action), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(world.placed.every(entry => !['rail', 'powered_rail'].includes(entry.name)));
});

test('sem pedra a descida interrompe os apoios e não coloca os trilhos', async () => {
  const world = descendingWorld(6);
  world.items.find(item => item.name === 'stone').count = 0;
  await assert.rejects(world.task.run(world.action), /stone/);
  assert.ok(world.placed.every(entry => !['rail', 'powered_rail'].includes(entry.name)));
});

test('constrói descida de 52 blocos com trilhos existentes na saída e usa tp nos apoios', async () => {
  const start = new Vec3(-29825631, 116, -26);
  const end = new Vec3(-29825681, 64, -22);
  const world = railwayWorld({ blocks: [
    [start, 'powered_rail'], [start.offset(0, -1, 0), 'redstone_block'],
    [start.offset(-1, 0, 0), 'rail'], [start.offset(-1, -1, 0), 'stone'],
    [start.offset(-2, 0, 0), 'powered_rail'], [start.offset(-2, -1, 0), 'redstone_block'],
    // Base sintética carregada para testar construção; o log não contém esta altura.
    ...Array.from({ length: 100 }, (_, x) => Array.from({ length: 50 }, (_, z) =>
      [start.offset(x - 75, -53, z - 25), 'stone'])).flat(),
  ], botPosition: start.offset(0.5, 0, 0.5), waterY: -65 });
  for (const item of world.items) item.count = 10000;
  const teleports = [];
  world.task.bot.username = 'testbot';
  world.task.bot.chat = command => {
    assert.match(command, /^\/tp testbot /);
    const position = new Vec3(...command.split(' ').slice(2).map(Number));
    teleports.push(position);
    world.task.bot.entity.position = position;
  };
  await world.task.run({ startX: start.x, startY: start.y, startZ: start.z,
    endX: end.x, endY: end.y, endZ: end.z, allowCommands: false });
  assert.equal(world.get(end).name, 'powered_rail');
  assert.equal(world.get(end.offset(0, -1, 0)).name, 'redstone_block');
  assert.ok(teleports.length > 0);
  assert.deepEqual(world.invalidPlacements, []);
});

test('teleporte da descida exige piso e espaço livre na posição escolhida', async () => {
  const world = descendingWorld(3);
  const point = new Vec3(20, 60, 20);
  world.applyServerBlock(point.offset(1, -1, 0), 'stone');
  world.applyServerBlock(point.offset(1, 1, 0), 'stone');
  await world.task.positionForDescent(point);
  assert.equal(world.teleports.length, 0, 'não usa posição com cabeça bloqueada nem posições sem piso');
  world.applyServerBlock(point.offset(1, 1, 0), 'air');
  await world.task.positionForDescent(point);
  assert.deepEqual(world.teleports, [point.offset(1.5, 0, 0.5)]);
});
