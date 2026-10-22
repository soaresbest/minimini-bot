import test from 'node:test';
import assert from 'node:assert/strict';
import vec3Package from 'vec3';
import { RailwayTask, RailwayError } from '../src/railway.js';
const { Vec3 } = vec3Package;

function tunnelWorld(read = () => 'stone') {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: position => {
    const name = read(position);
    return name === null ? null : { name, position, boundingBox: name === 'air' ? 'empty' : 'block',
      diggable: name !== 'bedrock' };
  } };
  return new RailwayTask({ bot }, new AbortController().signal);
}
const options = () => ({ start: { x: 0, y: 64, z: 0 }, goal: { x: 30, y: 64, z: 0 },
  heightsAt: () => [], blocked: () => false });

test('RAILWAY_NO_ROUTE esgotado aciona planejamento de túnel e registra plano', async () => {
  const task = tunnelWorld();
  const search = task.searchTerrainPath.bind(task);
  let calls = 0;
  task.searchTerrainPath = async config => {
    if (++calls <= 2) throw new RailwayError('sem rota normal', 'RAILWAY_NO_ROUTE');
    return search(config);
  };
  task.planWideContour = async () => null;
  const path = await task.planTerrainPath(options());
  assert.equal(calls, 3);
  assert.equal(path.length, 13);
  assert.ok(path.slice(1).every(p => p.tunnel && p.y === 64));
  assert.ok(task.planningHistory.some(plan => plan.path?.[1]?.tunnel));
});

for (const obstacle of ['bedrock', null, 'water', 'lava']) {
  test(`túnel recusa barreira de ${obstacle ?? 'chunk desconhecido'}`, async () => {
    const task = tunnelWorld(({ x }) => x === 1 ? obstacle : 'stone');
    await assert.rejects(task.planTunnel({ ...options(), forcedFirst: { x: 1, y: 64, z: 0 } }),
      { code: 'RAILWAY_NO_ROUTE' });
  });
}

test('não escava sob líquido nem junto de líquido lateral', () => {
  for (const liquid of [new Vec3(1, 67, 0), new Vec3(1, 65, 1)]) {
    const task = tunnelWorld(p => p.equals(liquid) ? 'water' : 'stone');
    assert.equal(task.canTunnelAt(new Vec3(1, 64, 0)), false);
  }
});

test('stop cancela planejamento do túnel', async () => {
  const task = tunnelWorld();
  task.signal = AbortSignal.abort();
  await assert.rejects(task.planTunnel(options()), { name: 'AbortError' });
});

test('rota normal disponível não aciona túnel nem intercepta outros erros', async () => {
  const task = tunnelWorld();
  const path = [options().start, { x: 1, y: 64, z: 0 }];
  task.searchTerrainPath = async () => path;
  task.planTunnel = async () => assert.fail('não deve abrir túnel');
  assert.deepEqual(await task.planTerrainPath(options()), path);
  task.searchTerrainPath = async () => { throw new Error('conexão encerrada'); };
  await assert.rejects(task.planTerrainPath(options()), /conexão encerrada/);
});

test('stop durante escavação impede remover os próximos blocos', async () => {
  const task = tunnelWorld();
  const controller = new AbortController();
  task.signal = controller.signal;
  task.moveNear = async () => {};
  let removed = 0;
  task.clear = async () => { removed++; controller.abort(); };
  await assert.rejects(task.openTunnelCell({ index: 1, previous: options().start,
    position: { x: 1, y: 64, z: 0, tunnel: true } }), { name: 'AbortError' });
  assert.equal(removed, 1);
});

test('revalida líquido surgido enquanto abre o túnel antes de continuar a escavação', async () => {
  let flooded = false;
  const task = tunnelWorld(p => flooded && p.z === 1 ? 'water' : 'stone');
  task.moveNear = async () => {};
  let removed = 0;
  task.clear = async () => { removed++; flooded = true; };
  await assert.rejects(task.openTunnelCell({ index: 1, previous: options().start,
    position: { x: 1, y: 64, z: 0, tunnel: true } }), { code: 'RAILWAY_TERRAIN_CHANGED' });
  assert.equal(removed, 1);
});
