import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRailwayIncident } from '../src/railway-log.js';

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'railway-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const details = () => ({
  time: '2026-10-20T20:32:59.128Z', bot: 'Bot1', event: 'erro',
  error: { code: 'RAILWAY_PLACEMENT', message: 'recusou stone', stack: 'stack do erro' },
  botPosition: { x: 0, y: 64, z: 0 }, pending: { position: { x: -29981117, y: 64, z: -8 } },
  checkpoint: { built: 5, end: { x: -29981000, y: 64, z: 0 } },
  planning: [{ path: [{ x: -29981118, y: 63, z: -8 }, { x: -29981117, y: 64, z: -8 }] }],
});

test('persiste erro, planejamento e 100 x 100 x 10 posições sem bloquear eventos', async t => {
  const dir = await directory(t);
  const input = details();
  let reads = 0;
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const bot = { blockAt: position => {
    reads++;
    if (reads > 1000) assert.equal(yielded, true);
    return position.y < 64 ? { name: 'mud' } : { name: 'air' };
  } };
  const writing = writeRailwayIncident({ bot, details: input }, dir);
  input.planning[0].path.length = 0;
  const file = await writing;
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(reads, 100000);
  assert.equal(saved.terrain.blocks.length, 100000);
  assert.deepEqual(saved.terrain.min, { x: -29981167, y: 59, z: -58 });
  assert.deepEqual(saved.terrain.max, { x: -29981068, y: 68, z: 41 });
  assert.equal(saved.terrain.unloaded, 0);
  assert.equal(saved.planning[0].path.length, 2);
  assert.deepEqual(saved.error, input.error);
  assert.equal(new Set(saved.terrain.blocks.map(b => JSON.stringify(b.position))).size, 100000);
  assert.ok(saved.terrain.blocks.every(b => b.name === (b.position.y < 64 ? 'mud' : 'air')));
});

test('desconexão registra posições desconhecidas e não sobrescreve arquivos anteriores', async t => {
  const dir = await directory(t);
  const input = { ...details(), event: 'desconectado_pelo_servidor', error: { reason: { text: 'timeout' } } };
  const first = await writeRailwayIncident({ bot: { blockAt: () => null }, details: input }, dir);
  const second = await writeRailwayIncident({ bot: { blockAt: () => { throw new Error('mundo encerrado'); } }, details: input }, dir);
  assert.notEqual(first, second);
  assert.equal((await readdir(dir)).length, 2);
  const saved = JSON.parse(await readFile(second, 'utf8'));
  assert.equal(saved.terrain.unloaded, 100000);
  assert.equal(saved.terrain.readErrors, 100000);
  assert.ok(saved.terrain.blocks.every(b => b.name === null));
  assert.deepEqual(saved.error, input.error);
});

test('falha de escrita é reportada ao chamador', async t => {
  const dir = await directory(t);
  const occupied = path.join(dir, 'arquivo');
  await writeFile(occupied, 'ocupado');
  await assert.rejects(writeRailwayIncident({ bot: {}, details: details() }, occupied));
});
