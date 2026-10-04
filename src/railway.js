import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';

const { goals } = pathfinderPackage;
const { Vec3 } = vec3Package;

const SEGMENT_SIZE = 24;
const GIVE_WAIT_MS = 4_000;
const PLACE_ATTEMPTS = 3;
const PLACE_RETRY_MS = 200;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'flowing_water']);
const RAILS = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
const MATERIAL_BATCH = Object.freeze({ rail: 64, powered_rail: 32, redstone_block: 32, stone: 64 });
const FACES = Object.freeze([
  new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  new Vec3(0, -1, 0),
]);

export class RailwayError extends Error {
  constructor(message, code = 'RAILWAY_FAILED') {
    super(message);
    this.name = 'RailwayError';
    this.code = code;
  }
}

/**
 * Representa uma rota ortogonal sem materializar distâncias potencialmente enormes.
 * A curva permanece plana, pois trilhos curvos não podem ser ascendentes.
 */
export class RailRoute {
  constructor(start, end) {
    this.start = integerPosition(start, 'início');
    this.end = integerPosition(end, 'fim');
    this.xSteps = Math.abs(this.end.x - this.start.x);
    this.zSteps = Math.abs(this.end.z - this.start.z);
    this.length = this.xSteps + this.zSteps;
    this.yDelta = this.end.y - this.start.y;
    this.turn = this.xSteps > 0 && this.zSteps > 0 ? this.xSteps : -1;
    this.flatSteps = new Set(this.turn < 0 ? [] : [this.turn, this.turn + 1].filter(step => step >= 1 && step <= this.length));
    this.slopeSteps = this.length - this.flatSteps.size;
    if (this.length === 0 && this.yDelta !== 0) throw new RailwayError('início e fim verticais exigem pelo menos um bloco de avanço horizontal');
    if (Math.abs(this.yDelta) > this.slopeSteps) {
      throw new RailwayError('a inclinação é íngreme demais para trilhos, inclusive na curva plana');
    }
  }

  positionAt(index) {
    if (!Number.isInteger(index) || index < 0 || index > this.length) throw new RangeError('Índice fora da rota.');
    const xDone = Math.min(index, this.xSteps);
    const zDone = Math.max(0, index - this.xSteps);
    const eligible = index - [...this.flatSteps].filter(step => step <= index).length;
    const rises = this.slopeSteps ? Math.floor(eligible * Math.abs(this.yDelta) / this.slopeSteps) : 0;
    return {
      x: this.start.x + Math.sign(this.end.x - this.start.x) * xDone,
      y: this.start.y + Math.sign(this.yDelta) * rises,
      z: this.start.z + Math.sign(this.end.z - this.start.z) * zDone,
    };
  }

  isCorner(index) { return index === this.turn; }
}

/** Planeja só o próximo trecho e carrega o estado de impulso para o seguinte. */
export function planRailSegment(route, fromIndex, limit = SEGMENT_SIZE, lastPowered = -Infinity) {
  const cells = [];
  const end = Math.min(route.length, fromIndex + limit - 1);
  for (let index = fromIndex; index <= end; index++) {
    const position = route.positionAt(index);
    const previous = index > 0 ? route.positionAt(index - 1) : null;
    const next = index < route.length ? route.positionAt(index + 1) : null;
    const slope = previous?.y !== position.y || next?.y !== position.y;
    const maximumGap = slope ? 3 : 8;
    const endpoint = index === route.length;
    const powered = index === 0 || (!route.isCorner(index) && (index - lastPowered >= maximumGap || endpoint));
    if (powered) lastPowered = index;
    cells.push({ index, position, powered, slope, corner: route.isCorner(index) });
  }
  return { cells, lastPowered, nextIndex: end + 1 };
}

export class RailwayTask {
  constructor(controller, signal) {
    this.controller = controller;
    this.bot = controller.bot;
    this.signal = signal;
    this.allowCommands = false;
  }

  async run(action) {
    this.allowCommands = action.allowCommands;
    const route = new RailRoute(
      { x: action.startX, y: action.startY, z: action.startZ },
      { x: action.endX, y: action.endY, z: action.endZ },
    );
    let index = 0;
    let lastPowered = -Infinity;
    while (index <= route.length) {
      this.signal.throwIfAborted();
      const segment = planRailSegment(route, index, SEGMENT_SIZE, lastPowered);
      for (const cell of segment.cells) {
        this.signal.throwIfAborted();
        this.controller.task = `construindo trilhos ${cell.index + 1}/${route.length + 1}`;
        await this.buildCell(cell);
      }
      index = segment.nextIndex;
      lastPowered = segment.lastPowered;
    }
  }

  async buildCell(cell) {
    const point = vec(cell.position);
    await this.moveNear(point);
    const waterOnPath = LIQUID.has(this.blockAt(point)?.name);
    for (let height = 2; height >= 0; height--) await this.clear(point.offset(0, height, 0));

    const support = point.offset(0, -1, 0);
    if (cell.powered) {
      await this.replace(support, 'redstone_block');
    } else if (waterOnPath || !this.isSolid(this.blockAt(support))) {
      await this.replace(support, 'stone');
    }

    await this.replace(point, cell.powered ? 'powered_rail' : 'rail');
  }

  async moveNear(point) {
    if (this.bot.entity.position.distanceTo(point) <= 2.5) return;
    await this.controller.moveToGoal(new goals.GoalNear(point.x, point.y, point.z, 2), this.signal);
  }

  blockAt(point) { return this.bot.blockAt(point); }
  isSolid(block) { return Boolean(block && block.boundingBox !== 'empty' && !LIQUID.has(block.name)); }

  async clear(point) {
    const block = this.blockAt(point);
    if (!block) throw new RailwayError('o trecho seguinte ainda não foi carregado pelo servidor');
    if (AIR.has(block.name) || LIQUID.has(block.name)) return;
    if (RAILS.has(block.name)) return;
    if (!this.bot.canDigBlock(block)) throw new RailwayError(`não posso remover ${block.name} em ${format(point)}`);
    await this.dig(block);
  }

  async dig(block) {
    await this.controller.useHand(async () => {
      const cancel = () => this.bot.stopDigging();
      this.signal.addEventListener('abort', cancel, { once: true });
      try { await this.bot.dig(block, true); } finally { this.signal.removeEventListener('abort', cancel); }
    }, this.signal);
  }

  async replace(point, item) {
    let block = this.blockAt(point);
    if (!block) throw new RailwayError('o trecho seguinte ainda não foi carregado pelo servidor');
    if (block.name === item) return;
    if (!AIR.has(block.name) && !LIQUID.has(block.name)) {
      if (!this.bot.canDigBlock(block)) throw new RailwayError(`não posso substituir ${block.name} em ${format(point)}`);
      await this.dig(block);
      block = this.blockAt(point);
    }
    for (let attempt = 1; attempt <= PLACE_ATTEMPTS; attempt++) {
      await this.ensureMaterial(item);
      const reference = this.findReference(point);
      if (!reference) throw new RailwayError(`não há apoio para colocar ${item} em ${format(point)}`);
      const { block: referenceBlock, face } = reference;
      try {
        await this.controller.useHand(async () => {
          await this.bot.equip(this.inventoryItem(item), 'hand');
          this.signal.throwIfAborted();
          await this.bot.lookAt(referenceBlock.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
          this.signal.throwIfAborted();
          await this.bot._placeBlockWithOptions(referenceBlock, face, { forceLook: true, swingArm: 'right' });
        }, this.signal);
      } catch (error) {
        this.signal.throwIfAborted();
        await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
        if (this.blockAt(point)?.name === item) return;
        if (attempt === PLACE_ATTEMPTS) {
          throw new RailwayError(`o servidor recusou colocar ${item} em ${format(point)} após ${PLACE_ATTEMPTS} tentativas`);
        }
        await this.moveNear(point);
        continue;
      }
      if (this.blockAt(point)?.name === item) return;
      if (attempt < PLACE_ATTEMPTS) await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
    }
    throw new RailwayError(`não consegui confirmar ${item} em ${format(point)}`);
  }

  findReference(target) {
    for (const face of FACES) {
      const referencePosition = target.offset(-face.x, -face.y, -face.z);
      const block = this.blockAt(referencePosition);
      if (this.isSolid(block)) return { block, face };
    }
    return null;
  }

  inventoryItem(name) { return this.bot.inventory.items().find(item => item.name === name && item.count > 0); }

  async ensureMaterial(name) {
    if (this.inventoryItem(name)) return;
    if (!this.allowCommands) {
      throw new RailwayError(`acabaram os blocos de ${name}; a obra foi interrompida porque só posso usar o inventário`, 'RAILWAY_MATERIALS');
    }
    if (!Object.hasOwn(MATERIAL_BATCH, name) || !/^[A-Za-z0-9_]{1,16}$/u.test(this.bot.username)) {
      throw new RailwayError('não posso solicitar esse material com segurança');
    }
    this.bot.chat(`/give ${this.bot.username} minecraft:${name} ${MATERIAL_BATCH[name]}`);
    const deadline = Date.now() + GIVE_WAIT_MS;
    while (!this.inventoryItem(name)) {
      this.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new RailwayError(`o servidor não entregou ${name}; verifique a permissão para /give`);
      await delay(100, undefined, { signal: this.signal });
    }
  }
}

function integerPosition(value, label) {
  if (!value || !['x', 'y', 'z'].every(key => Number.isInteger(value[key]))) {
    throw new RailwayError(`a posição de ${label} deve usar coordenadas inteiras`);
  }
  return { x: value.x, y: value.y, z: value.z };
}

function vec(position) { return new Vec3(position.x, position.y, position.z); }
function format(position) { return `${position.x}, ${position.y}, ${position.z}`; }
