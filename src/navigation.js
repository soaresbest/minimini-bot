import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';

const { Movements } = pathfinderPackage;
const { Vec3 } = vec3Package;
export const NAVIGATION_CHECKPOINT_DISTANCE = 64;

export function navigationMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowFreeMotion = false;
  // A API 2.4.5 usa esta grafia e espera IDs de itens, não de blocos.
  movements.scafoldingBlocks = ['dirt', 'cobblestone'].map(name => bot.registry.itemsByName[name].id);
  return movements;
}

export function configurePathfinderSearch(pathfinder) {
  // Esta versão não oferece maxSteps; o orçamento nativo é em milissegundos.
  pathfinder.thinkTimeout = 25000;
  pathfinder.tickTimeout = 40;
  pathfinder.searchRadius = -1;
}

/** Gera apenas o próximo alvo, sem materializar rotas de milhões de blocos. */
export function* navigationWaypoints(start, destination) {
  if (![start.x, start.y, start.z, destination.x, destination.y, destination.z].every(Number.isFinite)) {
    throw new Error('coordenadas inválidas para os checkpoints');
  }
  let current = new Vec3(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z));
  const end = new Vec3(Math.floor(destination.x), Math.floor(destination.y), Math.floor(destination.z));
  while (current.distanceTo(end) > NAVIGATION_CHECKPOINT_DISTANCE) {
    const delta = end.minus(current);
    const next = current.plus(delta.scaled(NAVIGATION_CHECKPOINT_DISTANCE / delta.norm())).floored();
    // O arredondamento em diagonais negativas não pode ultrapassar 64 blocos.
    while (next.distanceTo(current) > NAVIGATION_CHECKPOINT_DISTANCE) {
      const axis = ['x', 'y', 'z'].sort((a, b) => Math.abs(next[b] - current[b]) - Math.abs(next[a] - current[a]))[0];
      next[axis] -= Math.sign(next[axis] - current[axis]);
    }
    yield next;
    current = next;
  }
  yield end;
}
