import test from 'node:test';
import assert from 'node:assert/strict';
import { planDescentCorridor } from '../src/descent-plan.js';

function options(overrides = {}) {
  return {
    start: { x: -29825631, y: 116, z: -26 },
    goal: { x: -29825681, y: 64, z: -22 },
    heightsAt: (x, z, y) => [y - 1, y],
    ...overrides,
  };
}

function assertGeometry(path, start, goal) {
  assert.deepEqual(path[0], start);
  assert.deepEqual(path.at(-1), goal);
  assert.equal(new Set(path.map(p => `${p.x},${p.z}`)).size, path.length);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.z - b.z), 1);
    assert.ok([0, -1].includes(b.y - a.y));
    if (c && (b.x - a.x !== c.x - b.x || b.z - a.z !== c.z - b.z)) {
      assert.equal(b.y, a.y, 'a curva não ocupa um trilho inclinado');
    }
  }
}

test('planeja o desnível do diagnóstico sem explorar milhares de combinações do A*', async () => {
  const config = options();
  // Cena sintética carregada: reproduz coordenadas e desnível, não infere
  // terreno profundo a partir do diagnóstico limitado a dez alturas.
  const path = await planDescentCorridor(config, new AbortController().signal);
  assertGeometry(path, config.start, config.goal);
});

test('usa desvio lateral com patamares quando a distância direta não comporta a descida', async () => {
  const config = options({ start: { x: 0, y: 80, z: 0 }, goal: { x: 8, y: 60, z: 2 },
    forcedFirst: { x: 1, y: 80, z: 0 } });
  const path = await planDescentCorridor(config, new AbortController().signal);
  assertGeometry(path, config.start, config.goal);
  assert.deepEqual(path[1], config.forcedFirst);
  assert.ok(path.length > 21);
});

test('não atravessa colunas construídas nem assume blocos descarregados como ar', async () => {
  const config = options({ blocked: (x, z) => x === -29825632 && z === -26 });
  const path = await planDescentCorridor(config, new AbortController().signal);
  assertGeometry(path, config.start, config.goal);
  assert.ok(!path.some(p => config.blocked(p.x, p.z)));
  assert.equal(await planDescentCorridor(options({ heightsAt: () => [] }), new AbortController().signal), null);
});

test('destino sem altura ou fora do horizonte fica para o planejador normal', async () => {
  for (const override of [{ goalDistance: 1 }, { goal: { x: 0, y: null, z: 0 } },
    { goal: { x: 0, y: 64, z: 0 } }]) {
    assert.equal(await planDescentCorridor(options(override), new AbortController().signal), null);
  }
});

test('stop interrompe a busca durante as pausas para o servidor', async () => {
  const controller = new AbortController();
  await assert.rejects(planDescentCorridor(options({ onYield: () => controller.abort() }), controller.signal),
    { name: 'AbortError' });
});
