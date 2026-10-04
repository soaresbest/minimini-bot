import test from 'node:test';
import assert from 'node:assert/strict';
import { RailRoute, RailwayError, RailwayTask, planRailSegment } from '../src/railway.js';

test('rota de trilhos conecta os pontos com passos ortogonais e inclinação segura', () => {
  const route = new RailRoute({ x: 0, y: 64, z: 0 }, { x: 12, y: 68, z: -5 });
  assert.equal(route.length, 17);
  assert.deepEqual(route.positionAt(0), { x: 0, y: 64, z: 0 });
  assert.deepEqual(route.positionAt(route.length), { x: 12, y: 68, z: -5 });
  for (let index = 1; index <= route.length; index++) {
    const previous = route.positionAt(index - 1);
    const current = route.positionAt(index);
    assert.equal(Math.abs(current.x - previous.x) + Math.abs(current.z - previous.z), 1);
    assert.ok(Math.abs(current.y - previous.y) <= 1);
  }
  assert.equal(route.positionAt(route.turn - 1).y, route.positionAt(route.turn).y);
  assert.equal(route.positionAt(route.turn).y, route.positionAt(route.turn + 1).y);
});

test('planejamento é incremental, inicia e termina energizado e reduz intervalos em rampas', () => {
  const route = new RailRoute({ x: 0, y: 64, z: 0 }, { x: 30, y: 72, z: 0 });
  const first = planRailSegment(route, 0, 10);
  const second = planRailSegment(route, first.nextIndex, 10, first.lastPowered);
  const third = planRailSegment(route, second.nextIndex, 20, second.lastPowered);
  const cells = [...first.cells, ...second.cells, ...third.cells];
  assert.equal(cells[0].powered, true);
  assert.equal(cells.at(-1).powered, true);
  const powered = cells.filter(cell => cell.powered).map(cell => cell.index);
  assert.ok(powered.slice(1).every((index, position) => index - powered[position] <= 8));
  for (const cell of cells.filter(cell => cell.slope && !cell.corner)) {
    const previousPowered = powered.filter(index => index <= cell.index).at(-1);
    assert.ok(cell.index - previousPowered <= 3);
  }
});

test('não aceita subida vertical nem curva inclinada impossível', () => {
  assert.throws(() => new RailRoute({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }), RailwayError);
  assert.throws(() => new RailRoute({ x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }), /íngreme/u);
});

test('rota longa é consultada sem materializar todos os blocos', () => {
  const route = new RailRoute({ x: -29_000_000, y: 64, z: 0 }, { x: 29_000_000, y: 64, z: 0 });
  assert.equal(route.length, 58_000_000);
  assert.deepEqual(route.positionAt(57_999_999), { x: 28_999_999, y: 64, z: 0 });
  assert.equal(planRailSegment(route, 40_000_000).cells.length, 24);
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
