import { mkdir, writeFile } from 'node:fs/promises';
import { setImmediate as yieldToServer } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import vec3Package from 'vec3';
import { configPath } from './config.js';

const { Vec3 } = vec3Package;
export const RAILWAY_LOG_SIZE = Object.freeze({ x: 100, y: 10, z: 100 });
export const railwayLogDirectory = () => path.join(path.dirname(configPath()), 'logs', 'railway');

/** Uma ocorrência por arquivo; a varredura cede tempo aos pacotes do servidor. */
export async function writeRailwayIncident({ bot, details }, directory = railwayLogDirectory()) {
  const snapshot = structuredClone(details);
  const center = snapshot.pending?.position ?? snapshot.checkpoint?.current ?? snapshot.botPosition;
  if (!center || ![center.x, center.y, center.z].every(Number.isFinite)) {
    throw new Error('posição indisponível para o diagnóstico railway');
  }
  const min = { x: Math.floor(center.x) - 50, y: Math.floor(center.y) - 5, z: Math.floor(center.z) - 50 };
  const max = { x: min.x + 99, y: min.y + 9, z: min.z + 99 };
  const terrain = { startedAt: new Date().toISOString(), min, max, size: RAILWAY_LOG_SIZE,
    unloaded: 0, readErrors: 0, blocks: [] };
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let y = min.y; y <= max.y; y++) {
        let block = null;
        try { block = bot.blockAt?.(new Vec3(x, y, z)); } catch { terrain.readErrors++; }
        if (!block) terrain.unloaded++;
        terrain.blocks.push({ position: { x, y, z }, name: block?.name ?? null });
      }
    }
    await yieldToServer();
  }
  terrain.finishedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${snapshot.time.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ ...snapshot, terrain }), { flag: 'wx', mode: 0o600 });
  return file;
}
