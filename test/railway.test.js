import test from 'node:test';
import assert from 'node:assert/strict';
import vec3Package from 'vec3';
import { RailwayError, RailwayTask, findTerrainPath } from '../src/railway.js';

const { Vec3 } = vec3Package;
const FLUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);

function terrainRun(blockNameAt, start = { x: 0, y: 64, z: 0 }) {
  const built = [];
  const bot = {
    entity: { position: new Vec3(start.x + 0.5, start.y, start.z + 0.5) },
    blockAt: position => {
      const name = blockNameAt(position);
      return { name, boundingBox: name === 'air' || FLUIDS.has(name) ? 'empty' : 'block',
        diggable: !FLUIDS.has(name), position: position.clone() };
    },
  };
  const task = new RailwayTask({ bot }, new AbortController().signal);
  task.buildCell = async cell => {
    const point = new Vec3(cell.position.x, cell.position.y, cell.position.z);
    assert.equal(bot.blockAt(point).name, 'air', 'o trilho fica acima do piso, fora de líquidos e paredes');
    const floor = bot.blockAt(point.offset(0, -1, 0));
    assert.notEqual(floor.name, 'air', 'não cria ponte ou escada artificial sobre vazio');
    built.push(cell);
    assert.ok(built.length < 100, 'a rota curta não deve entrar em loop');
    bot.entity.position = point.offset(0.5, 0, 0.5);
    return { usedStoneSupport: FLUIDS.has(floor.name) };
  };
  return { task, built };
}

function runTo(task, end) {
  return task.run({ startX: null, startY: null, startZ: null,
    endX: end.x, endY: end.y ?? null, endZ: end.z, allowCommands: false });
}

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

test('A* contorna degrau de dois blocos sem colocar curvas na parte inclinada do trilho', () => {
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
    if (turn) {
      assert.ok(before.y <= current.y, 'a curva não pode ser a parte baixa da rampa de chegada');
      assert.ok(after.y <= current.y, 'a curva não pode ser a parte baixa da rampa de saída');
    }
  }
});

for (const { description, previousY, nextY, allowed } of [
  { description: 'permite curva no topo depois de subir', previousY: 63, nextY: 64, allowed: true },
  { description: 'permite curva no topo antes de descer', previousY: 64, nextY: 63, allowed: true },
  { description: 'recusa curva na parte baixa depois de descer', previousY: 65, nextY: 64, allowed: false },
  { description: 'recusa curva na parte baixa antes de subir', previousY: 64, nextY: 65, allowed: false },
]) {
  test(`A* ${description}`, () => {
    const start = { x: 0, y: 64, z: 0 };
    const goal = { x: 0, y: nextY, z: 1 };
    const find = () => findTerrainPath({
      start, previous: { x: -1, y: previousY, z: 0 }, goal,
      heightsAt: (x, z) => x === goal.x && z === goal.z ? [goal.y] : [],
    });

    if (allowed) assert.deepEqual(find(), [start, goal]);
    else assert.throws(find, error => error.code === 'RAILWAY_NO_ROUTE');
  });
}

test('A* permite topo com trilho plano entre duas rampas inferiores', () => {
  const start = { x: 0, y: 64, z: 0 };
  const goal = { x: 1, y: 63, z: 0 };
  const path = findTerrainPath({
    start, previous: { x: -1, y: 63, z: 0 }, goal,
    heightsAt: (x, z) => x === goal.x && z === goal.z ? [goal.y] : [],
  });

  assert.deepEqual(path, [start, goal]);
});

test('A* recusa vale em que o mesmo trilho precisaria subir nas duas direções', () => {
  const goal = { x: 1, y: 65, z: 0 };
  assert.throws(() => findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, previous: { x: -1, y: 65, z: 0 }, goal,
    heightsAt: (x, z) => x === goal.x && z === goal.z ? [goal.y] : [],
  }), error => error.code === 'RAILWAY_NO_ROUTE');
});

test('A* escolhe uma rampa alternativa sem voltar à mesma coluna para mudar a orientação', () => {
  const heights = new Map([
    ['0,0', 64], ['0,1', 64], ['1,0', 64], ['2,0', 65], ['3,0', 65],
    ['3,-1', 65], ['2,-1', 65], ['1,-1', 65], ['0,-1', 65],
  ]);
  const previous = { x: -1, y: 64, z: 0 };
  const path = findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, previous, goal: { x: 0, y: 65, z: -1 },
    heightsAt: (x, z) => heights.has(`${x},${z}`) ? [heights.get(`${x},${z}`)] : [],
  });

  // A ida e volta 0,0 -> 0,1 -> 0,0 permitiria uma subida ao norte
  // artificialmente. A ferrovia precisa alcançar o topo pela outra rampa.
  assert.equal(new Set(path.map(({ x, z }) => `${x},${z}`)).size, path.length);
  assert.deepEqual(path, [
    { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 65, z: 0 },
    { x: 2, y: 65, z: -1 }, { x: 1, y: 65, z: -1 }, { x: 0, y: 65, z: -1 },
  ]);
  const whole = [previous, ...path];
  for (let index = 1; index < whole.length - 1; index++) {
    const [before, current, after] = whole.slice(index - 1, index + 2);
    const turns = current.x - before.x !== after.x - current.x || current.z - before.z !== after.z - current.z;
    if (turns) {
      assert.ok(before.y <= current.y, 'a curva não pode ser a parte baixa da rampa de chegada');
      assert.ok(after.y <= current.y, 'a curva não pode ser a parte baixa da rampa de saída');
    }
  }
});

test('A* recusa acesso a rampa cuja única rota exigiria retornar pela coluna inicial', () => {
  const heights = new Map([['0,0', 64], ['0,1', 64], ['0,-1', 65]]);
  assert.throws(() => findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, previous: { x: -1, y: 64, z: 0 }, goal: { x: 0, y: 65, z: -1 },
    heightsAt: (x, z) => heights.has(`${x},${z}`) ? [heights.get(`${x},${z}`)] : [],
  }), error => error.code === 'RAILWAY_NO_ROUTE');
});

test('A* informa quando não há alternativa dentro da área pesquisada', () => {
  assert.throws(() => findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 3, y: 64, z: 0 }, radius: 2,
    heightsAt: (x, _z, currentY) => x === 1 ? [] : [currentY],
  }), error => error instanceof RailwayError && error.code === 'RAILWAY_NO_ROUTE');
});

test('obra contorna uma parede após a água sem antecipar escada acima do terreno', async () => {
  const { task, built } = terrainRun(({ x, y, z }) => {
    if (x === 3 && Math.abs(z) <= 1 && y <= 69) return 'stone';
    if (x >= 0 && x <= 2 && z === 0 && y >= 60 && y <= 63) return 'water';
    return y <= 63 ? 'grass_block' : 'air';
  });

  await runTo(task, { x: 8, z: 0 });

  assert.deepEqual(built.at(-1).position, { x: 8, y: 64, z: 0 });
  assert.ok(built.some(cell => Math.abs(cell.position.z) === 2), 'desvia pela lateral da parede');
  assert.ok(built.every(cell => cell.position.y === 64), 'mantém o trilho no piso durante todo o desvio');
  assert.equal(new Set(built.map(cell => `${cell.position.x},${cell.position.z}`)).size, built.length,
    'não volta às colunas já construídas');
});

test('obra informa rota impossível em abismo sem construir passagem plana sobre o vazio', async () => {
  const { task, built } = terrainRun(({ x, y }) => y <= (x === 1 ? 50 : 63) ? 'stone' : 'air');

  await assert.rejects(runTo(task, { x: 2, z: 0 }), error => error.code === 'RAILWAY_NO_ROUTE');

  assert.deepEqual(built.map(cell => cell.position), [{ x: 0, y: 64, z: 0 }]);
});

for (const liquid of FLUIDS) {
  test(`obra atravessa a superfície de ${liquid} e desce ao chão assim que o líquido acaba`, async () => {
    const { task, built } = terrainRun(({ x, y }) => {
      if (x <= 3) {
        if (y <= 60) return 'stone';
        return y <= 63 ? liquid : 'air';
      }
      return y <= 62 ? 'grass_block' : 'air';
    });

    await runTo(task, { x: 7, z: 0 });

    assert.deepEqual(built.map(cell => cell.position), Array.from({ length: 8 }, (_, x) => ({
      x, y: x < 4 ? 64 : 63, z: 0,
    })));
  });
}

test('replaneja um percurso longo mantendo as descidas naturais e o desvio no chão', async () => {
  const { task, built } = terrainRun(({ x, y, z }) => {
    if (x === 32 && Math.abs(z) <= 1 && y <= 69) return 'stone';
    if (x >= 4 && x <= 15 && y >= 60 && y <= 63) return 'water';
    const floorY = x <= 15 ? 63 : x <= 28 ? 62 : 61;
    return y <= floorY ? 'grass_block' : 'air';
  });
  const plan = task.planTerrainPath.bind(task);
  let plans = 0;
  task.planTerrainPath = options => { plans++; return plan(options); };

  await runTo(task, { x: 45, z: 0 });

  assert.ok(plans > 1, 'calcula novos trechos durante a execução');
  assert.deepEqual(built.at(-1).position, { x: 45, y: 62, z: 0 });
  assert.ok(built.every(({ position: { x, y } }) => y === (x <= 15 ? 64 : x <= 28 ? 63 : 62)));
  assert.ok(built.some(({ position: { z } }) => Math.abs(z) === 2));
  assert.equal(new Set(built.map(cell => `${cell.position.x},${cell.position.z}`)).size, built.length,
    'replanejar não retorna aos trilhos já feitos');
});

test('planeja o desvio antes de ultrapassar a bifurcação de um corredor sem saída', async () => {
  const { task, built } = terrainRun(({ x, y, z }) => {
    const corridor = z === 0 && x >= 0 && x <= 20;
    const fork = x === 5 && z >= 0 && z <= 3;
    const bypass = z === 3 && x >= 5 && x <= 50;
    const arrival = x === 50 && z >= 0 && z <= 3;
    return y <= (corridor || fork || bypass || arrival ? 63 : 50) ? 'stone' : 'air';
  });

  await runTo(task, { x: 50, z: 0 });

  assert.deepEqual(built.at(-1).position, { x: 50, y: 64, z: 0 });
  assert.ok(built.some(({ position: { x, z } }) => x === 5 && z === 1), 'usa a bifurcação antes do beco sem saída');
  assert.ok(!built.some(({ position: { x, z } }) => x > 5 && x <= 20 && z === 0),
    'não constrói além da bifurcação para depois precisar voltar');
  assert.equal(new Set(built.map(cell => `${cell.position.x},${cell.position.z}`)).size, built.length,
    'o desvio chega ao fim sem reutilizar colunas');
});

test('preserva um desvio longo que começa afastando-se do destino e reserva a próxima orientação', async () => {
  const { task, built } = terrainRun(({ y }) => y <= 63 ? 'stone' : 'air');
  const point = (x, z) => ({ x, y: 64, z });
  const first = [
    point(0, 0),
    ...Array.from({ length: 4 }, (_, index) => point(-index - 1, 0)),
    ...Array.from({ length: 4 }, (_, index) => point(-4, index + 1)),
    ...Array.from({ length: 48 }, (_, index) => point(index - 3, 4)),
  ];
  const reserved = first.at(-1);
  const second = [
    first.at(-2), reserved,
    ...Array.from({ length: 4 }, (_, index) => point(44, 3 - index)),
    ...Array.from({ length: 16 }, (_, index) => point(45 + index, 0)),
  ];
  let plans = 0;
  task.planTerrainPath = options => {
    plans++;
    if (plans === 1) return first;
    assert.equal(plans, 2, 'consome o caminho confirmado em vez de recalcular a cada lote');
    assert.deepEqual(built.map(cell => cell.position), first.slice(0, -1),
      'conclui o desvio confirmado, deixando apenas o último ponto para conectar o próximo trecho');
    assert.deepEqual(options.start, first.at(-2));
    assert.deepEqual(options.previous, first.at(-3));
    assert.deepEqual(options.forcedFirst, reserved, 'preserva a direção prevista pelo trilho já construído');
    return second;
  };

  await runTo(task, { x: 60, z: 0 });

  assert.equal(plans, 2);
  assert.deepEqual(built.map(cell => cell.position), [...first.slice(0, -1), ...second.slice(1)]);
  assert.deepEqual(built.at(-1).position, point(60, 0));
  assert.equal(new Set(built.map(cell => `${cell.position.x},${cell.position.z}`)).size, built.length);
  const connection = built.find(({ position }) => position.x === reserved.x && position.z === reserved.z);
  assert.equal(connection.corner, true, 'só decide a curva do ponto reservado depois do próximo planejamento');
  assert.equal(connection.powered, false, 'a conexão curva usa trilho comum');
});

test('cada planejamento consulta cada bloco uma vez e relê alterações do mundo no próximo plano', () => {
  let wall = false;
  const { task } = terrainRun(({ x, y, z }) => {
    if (wall && x === 1 && z === 0 && y <= 66) return 'stone';
    return y <= 63 ? 'stone' : 'air';
  });
  const readBlock = task.bot.blockAt;
  const reads = new Map();
  task.bot.blockAt = position => {
    const key = `${position.x},${position.y},${position.z}`;
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return readBlock(position);
  };
  const options = {
    start: { x: 0, y: 64, z: 0 }, goal: { x: 4, y: 64, z: 0 },
    heightsAt: (x, z, y, from) => task.terrainRailHeights(x, z, y, from),
  };

  const first = task.planTerrainPath(options);

  assert.ok(first.some(({ x, z }) => x === 1 && z === 0));
  assert.ok(reads.size > 0);
  assert.ok([...reads.values()].every(count => count === 1), 'reutiliza consultas dentro do mesmo planejamento');

  wall = true;
  assert.equal(task.blockAt(new Vec3(1, 64, 0)).name, 'stone', 'fora do planejamento a leitura já vê a parede nova');
  reads.clear();
  const second = task.planTerrainPath(options);

  assert.ok(!second.some(({ x, z }) => x === 1 && z === 0), 'o próximo plano não reutiliza o corredor antigo');
  assert.ok(second.some(({ z }) => z !== 0), 'encontra o desvio ao redor da parede nova');
  assert.ok(reads.size > 0);
  assert.ok([...reads.values()].every(count => count === 1));
});

test('amplia a busca quando o orçamento inicial não permite concluir o plano', () => {
  const { task } = terrainRun(({ y }) => y <= 63 ? 'stone' : 'air');
  const path = task.planTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 4, y: 64, z: 0 }, maxNodes: 1,
    heightsAt: (x, z, y, from) => task.terrainRailHeights(x, z, y, from),
  });

  assert.deepEqual(path.at(-1), { x: 4, y: 64, z: 0 });
  assert.equal(path.length, 5);
});

test('coordenadas automáticas usam a posição atual e aceitam qualquer Y no destino', async () => {
  const task = new RailwayTask({ bot: { entity: { position: new Vec3(4.5, 71.8, 9.5) } } }, new AbortController().signal);
  const built = [];
  task.buildCell = async cell => { built.push(cell); return { usedStoneSupport: false }; };
  await task.run({ startX: null, startY: null, startZ: null, endX: null, endY: null, endZ: null, allowCommands: false });
  assert.deepEqual(built, [{ index: 0, position: { x: 4, y: 71, z: 9 }, previous: null, powered: true }]);
});

test('leitura do mundo sobe ou desce um bloco e recusa desníveis maiores', () => {
  const ground = new Map([[1, 64], [2, 62], [3, 65], [4, 61]]);
  const bot = {
    blockAt: ({ x, y, z }) => {
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

for (const liquid of ['water', 'lava']) {
  test(`recusa escavar teto com ${liquid} imediatamente acima do corredor`, () => {
    const { task } = terrainRun(({ x, y, z }) => {
      if (x === 1 && z === 0 && y === 67) return liquid;
      if (x === 1 && z === 0 && y === 66) return 'stone';
      return y <= 63 ? 'stone' : 'air';
    });

    assert.deepEqual(task.terrainRailHeights(1, 0, 64), [], 'o planejador desvia do teto que liberaria líquido');
    assert.throws(() => task.validateFloor(new Vec3(1, 64, 0)),
      error => error.code === 'RAILWAY_TERRAIN_CHANGED', 'a construção também recusa o perigo antes de escavar');
  });
}

for (const ceiling of ['air', 'stone']) {
  test(`permite corredor com teto de ${ceiling} sem líquido acima`, () => {
    const { task } = terrainRun(({ x, y, z }) => {
      if (x === 1 && z === 0 && y === 66) return ceiling;
      return y <= 63 ? 'stone' : 'air';
    });

    assert.deepEqual(task.terrainRailHeights(1, 0, 64), [64]);
    assert.doesNotThrow(() => task.validateFloor(new Vec3(1, 64, 0)));
  });
}

test('A* não reutiliza colunas de trilhos já construídas', () => {
  const path = findTerrainPath({
    start: { x: 0, y: 64, z: 0 }, goal: { x: 3, y: 64, z: 0 },
    heightsAt: (_x, _z, currentY) => [currentY],
    blocked: (x, z) => x === 1 && z === 0,
  });
  assert.ok(!path.some(point => point.x === 1 && point.z === 0));
  assert.ok(path.some(point => point.z !== 0));
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

test('redstone usa o piso anterior como apoio preferencial', () => {
  const target = new Vec3(1, 63, 0);
  const previousFloor = new Vec3(0, 63, 0);
  const lowerFloor = new Vec3(1, 62, 0);
  const blocks = new Map([
    [previousFloor.toString(), { name: 'stone', boundingBox: 'block', position: previousFloor }],
    [lowerFloor.toString(), { name: 'stone', boundingBox: 'block', position: lowerFloor }],
  ]);
  const task = new RailwayTask({ bot: {
    blockAt: point => blocks.get(point.toString()) ?? { name: 'air', boundingBox: 'empty', position: point },
  } }, new AbortController().signal);

  const reference = task.findReference(target, previousFloor);

  assert.equal(reference.block.position.toString(), previousFloor.toString());
  assert.deepEqual(reference.face, new Vec3(1, 0, 0));
});

test('troca pedra isolada por redstone usando apoio lateral temporário na água', async () => {
  const target = new Vec3(1, 63, 0);
  const previousFloor = new Vec3(0, 62, 0);
  const blocks = new Map([[target.toString(), {
    name: 'stone', type: 1, boundingBox: 'block', position: target,
  }]]);
  let equipped = null;
  const items = [
    { name: 'stone', count: 2, type: 2 },
    { name: 'redstone_block', count: 2, type: 3 },
  ];
  const air = point => ({ name: 'water', type: 0, boundingBox: 'empty', position: point });
  const bot = {
    entity: { position: target },
    inventory: { items: () => items },
    blockAt: point => blocks.get(point.toString()) ?? air(point),
    canDigBlock: () => true,
    dig: async block => blocks.delete(block.position.toString()),
    stopDigging: () => {},
    equip: async item => { equipped = item.name; },
    lookAt: async () => {},
    _placeBlockWithOptions: async (reference, face) => {
      const placed = reference.position.plus(face);
      blocks.set(placed.toString(), { name: equipped, type: 4, boundingBox: 'block', position: placed });
    },
  };
  const task = new RailwayTask({ bot, useHand: async fn => await fn() }, new AbortController().signal);

  await task.replace(target, 'redstone_block', { preferredReference: previousFloor });

  assert.equal(bot.blockAt(target).name, 'redstone_block');
  assert.equal([...blocks.values()].filter(block => block.name === 'stone').length, 0);
});

test('troca areia submersa por redstone mesmo após perder a referência abaixo', async () => {
  const target = new Vec3(1, 63, 0);
  const above = target.offset(0, 1, 0);
  const below = target.offset(0, -1, 0);
  const previousFloor = new Vec3(0, 62, 0);
  const sandPositions = [target, below, target.offset(1, 0, 0), target.offset(-1, 0, 0),
    target.offset(0, 0, 1), target.offset(0, 0, -1)];
  const blocks = new Map(sandPositions.map(position => [position.toString(), {
    name: 'sand', type: 1, boundingBox: 'block', position,
  }]));
  let equipped = null;
  const items = [
    { name: 'stone', count: 2, type: 2 },
    { name: 'redstone_block', count: 2, type: 3 },
  ];
  const water = point => ({ name: 'water', type: 0, boundingBox: 'empty', position: point });
  const bot = {
    entity: { position: target },
    inventory: { items: () => items },
    blockAt: point => blocks.get(point.toString()) ?? water(point),
    canDigBlock: () => true,
    dig: async block => {
      blocks.delete(block.position.toString());
      if (block.position.equals(target)) blocks.delete(below.toString());
    },
    stopDigging: () => {},
    equip: async item => { equipped = item.name; },
    lookAt: async () => {},
    _placeBlockWithOptions: async (reference, face) => {
      const placed = reference.position.plus(face);
      blocks.set(placed.toString(), { name: equipped, type: 4, boundingBox: 'block', position: placed });
    },
  };
  const task = new RailwayTask({ bot, useHand: async fn => await fn() }, new AbortController().signal);

  await task.replace(target, 'redstone_block', { preferredReference: previousFloor });

  assert.equal(bot.blockAt(target).name, 'redstone_block');
  assert.equal(bot.blockAt(above).name, 'water');
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
