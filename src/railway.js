import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';

const { goals } = pathfinderPackage;
const { Vec3 } = vec3Package;

const PLAN_HORIZON = 20;
const BUILD_BATCH = 12;
const SEARCH_RADIUS = 32;
const EXTENDED_SEARCH_RADIUS = 64;
const SEARCH_NODE_LIMIT = 12_000;
const WALL_SCAN_DISTANCE = 20;
const WALL_MAX_HEIGHT = 48;
const GIVE_WAIT_MS = 4_000;
const PLACE_ATTEMPTS = 3;
const PLACE_RETRY_MS = 200;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'flowing_water']);
const LAVA = new Set(['lava', 'flowing_lava']);
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

const DIRECTIONS = Object.freeze([
  { x: 1, z: 0, name: 'east' }, { x: -1, z: 0, name: 'west' },
  { x: 0, z: 1, name: 'south' }, { x: 0, z: -1, name: 'north' },
]);

/** Busca A* respeitando rampas de um bloco e a geometria plana das curvas. */
export function findTerrainPath({ start, goal, heightsAt, previous = null, forcedFirst = null,
  blocked = () => false, goalDistance = 0, radius = SEARCH_RADIUS, maxNodes = SEARCH_NODE_LIMIT }) {
  start = integerPosition(start, 'início do trecho');
  goal = { ...integerPosition({ ...goal, y: goal.y ?? start.y }, 'objetivo do trecho'), y: goal.y ?? null };
  const initialDirection = previous ? directionBetween(previous, start) : null;
  const initialSlope = previous ? start.y - previous.y : 0;
  const initial = { ...start, direction: initialDirection, slope: initialSlope, g: 0, parent: null };
  const open = new MinHeap((a, b) => a.f - b.f);
  const best = new Map([[stateKey(initial), 0]]);
  open.push({ ...initial, f: heuristic(initial, goal, goalDistance) });
  let visited = 0;

  while (open.size) {
    const current = open.pop();
    if (current.g !== best.get(stateKey(current))) continue;
    if (reachedGoal(current, goal, goalDistance)) return reconstruct(current);
    if (++visited > maxNodes) break;

    const directions = [...DIRECTIONS].sort((a, b) => directionHeuristic(current, a, goal) - directionHeuristic(current, b, goal));
    for (const direction of directions) {
      const x = current.x + direction.x;
      const z = current.z + direction.z;
      if (Math.max(Math.abs(x - start.x), Math.abs(z - start.z)) > radius) continue;
      if (blocked(x, z)) continue;
      if (current.parent === null && forcedFirst && (x !== forcedFirst.x || z !== forcedFirst.z)) continue;
      const heights = heightsAt(x, z, current.y);
      for (const y of heights) {
        if (!Number.isInteger(y) || Math.abs(y - current.y) > 1) continue;
        if (current.parent === null && forcedFirst && Number.isInteger(forcedFirst.y) && y !== forcedFirst.y) continue;
        const slope = y - current.y;
        const turning = current.direction && current.direction !== direction.name;
        if (turning && (current.slope !== 0 || slope !== 0)) continue;
        if (current.slope !== 0 && slope !== 0 && current.slope !== slope) continue;
        const g = current.g + 1 + Math.abs(slope) * 0.75 + (turning ? 0.2 : 0);
        const next = { x, y, z, direction: direction.name, slope, g, parent: current };
        const key = stateKey(next);
        if (g >= (best.get(key) ?? Infinity)) continue;
        best.set(key, g);
        open.push({ ...next, f: g + heuristic(next, goal, goalDistance) });
      }
    }
  }
  throw new RailwayError('não encontrei uma rota pelo terreno com rampas de no máximo um bloco', 'RAILWAY_NO_ROUTE');
}

/** Escolhe o próximo bloco de uma ponte/túnel plano quando o terreno não oferece rota. */
export function stoneFallbackStep({ current, end, previous = null, forcedFirst = null }) {
  if (horizontalDistance(current, end) === 0) {
    throw new RailwayError('cheguei às coordenadas horizontais finais, mas a altura do destino não é alcançável');
  }
  let direction;
  if (forcedFirst) {
    direction = DIRECTIONS.find(candidate => current.x + candidate.x === forcedFirst.x && current.z + candidate.z === forcedFirst.z);
  } else if (previous && previous.y !== current.y) {
    direction = DIRECTIONS.find(candidate => previous.x + candidate.x === current.x && previous.z + candidate.z === current.z);
  } else {
    const xDistance = end.x - current.x;
    const zDistance = end.z - current.z;
    direction = Math.abs(xDistance) >= Math.abs(zDistance)
      ? DIRECTIONS.find(candidate => candidate.x === Math.sign(xDistance))
      : DIRECTIONS.find(candidate => candidate.z === Math.sign(zDistance));
  }
  if (!direction) throw new RailwayError('não consegui definir a direção da passagem de pedra');
  const position = { x: current.x + direction.x, y: current.y, z: current.z + direction.z };
  if (position.x === end.x && position.z === end.z && end.y !== null && position.y !== end.y) {
    throw new RailwayError('a passagem plana chegou ao destino horizontal, mas a altura final é diferente');
  }
  const endpoint = samePosition(position, end);
  const next = endpoint ? null : { x: position.x + direction.x, z: position.z + direction.z };
  return { position, next };
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
    const origin = {
      x: Math.floor(this.bot.entity.position.x),
      y: Math.floor(this.bot.entity.position.y),
      z: Math.floor(this.bot.entity.position.z),
    };
    const start = integerPosition({
      x: action.startX ?? origin.x, y: action.startY ?? origin.y, z: action.startZ ?? origin.z,
    }, 'início');
    const validatedEnd = integerPosition({
      x: action.endX ?? origin.x, y: action.endY ?? origin.y, z: action.endZ ?? origin.z,
    }, 'fim');
    const end = { ...validatedEnd, y: action.endY === null ? null : validatedEnd.y };
    let current = start;
    let previous = null;
    let forcedFirst = null;
    let passageDirection = null;
    let climbTargetY = null;
    let built = 0;
    let lastPowered = 0;
    const builtColumns = new Set([columnKey(start)]);
    const firstResult = await this.buildCell({ index: 0, position: start, previous: null, powered: true });
    if (firstResult.usedStoneSupport) passageDirection = preferredDirection(start, end)?.name ?? null;

    while (!samePosition(current, end)) {
      this.signal.throwIfAborted();
      if (passageDirection) {
        const direction = DIRECTIONS.find(candidate => candidate.name === passageDirection);
        climbTargetY ??= this.highWallAhead(current, direction);
        if (climbTargetY !== null && current.y < climbTargetY) {
          const position = { x: current.x + direction.x, y: current.y + 1, z: current.z + direction.z };
          const next = { x: position.x + direction.x, z: position.z + direction.z };
          const index = ++built;
          const endpoint = samePosition(position, end);
          const powered = endpoint || index - lastPowered >= 2;
          if (powered) lastPowered = index;
          this.controller.task = `subindo parede com pedra: ${current.y + 1}/${climbTargetY}`;
          await this.buildCell({ index, position, previous: current, powered, slope: true, corner: false, forceStone: true });
          builtColumns.add(columnKey(position));
          previous = current;
          current = position;
          forcedFirst = endpoint ? null : next;
          if (current.y >= climbTargetY) climbTargetY = null;
          continue;
        }
        climbTargetY = null;
      }
      const remaining = horizontalDistance(current, end);
      const finalSegment = remaining <= PLAN_HORIZON;
      let path;
      try {
        path = this.planTerrainPath({
          start: current,
          goal: end,
          previous,
          forcedFirst,
          blocked: (x, z) => builtColumns.has(`${x},${z}`),
          goalDistance: finalSegment ? 0 : remaining - PLAN_HORIZON,
          heightsAt: (x, z, y) => this.terrainRailHeights(x, z, y),
        });
      } catch (error) {
        if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
        const fallback = stoneFallbackStep({ current, end, previous, forcedFirst });
        const index = ++built;
        const corner = isCorner(current, fallback.position, fallback.next);
        const endpoint = samePosition(fallback.position, end);
        const powered = !corner && (endpoint || index - lastPowered >= 8);
        if (powered) lastPowered = index;
        this.controller.task = `construindo passagem de pedra: ${index + 1} blocos; faltam aproximadamente ${horizontalDistance(fallback.position, end)}`;
        await this.buildCell({ index, position: fallback.position, previous: current, powered, slope: false, corner, forceStone: true });
        builtColumns.add(columnKey(fallback.position));
        passageDirection = directionBetween(current, fallback.position);
        previous = current;
        current = fallback.position;
        forcedFirst = fallback.next;
        continue;
      }
      const count = Math.min(BUILD_BATCH, path.length - 1);
      if (count < 1) throw new RailwayError('o planejamento do terreno não avançou');
      let builtOffset = 0;
      for (let offset = 1; offset <= count; offset++) {
        this.signal.throwIfAborted();
        const position = path[offset];
        const next = path[offset + 1] ?? null;
        const index = ++built;
        const slope = current.y !== position.y || next?.y !== position.y;
        const corner = isCorner(current, position, next);
        const endpoint = samePosition(position, end);
        const maximumGap = slope ? 3 : 8;
        const powered = !corner && (endpoint || index - lastPowered >= maximumGap);
        if (powered) lastPowered = index;
        const cell = { index, position, previous: current, powered, slope, corner };
        this.controller.task = `construindo trilhos: ${index + 1} blocos; faltam aproximadamente ${horizontalDistance(position, end)}`;
        const result = await this.buildCell(cell);
        builtColumns.add(columnKey(position));
        passageDirection = result.usedStoneSupport ? directionBetween(current, position) : null;
        previous = current;
        current = position;
        builtOffset = offset;
        // Sobre piso artificial, replaneje bloco a bloco para detectar uma
        // parede antes que o A* escolha voltar ou contorná-la.
        if (result.usedStoneSupport) break;
      }
      forcedFirst = path[builtOffset + 1] ?? null;
    }
  }

  planTerrainPath(options) {
    try {
      return findTerrainPath(options);
    } catch (error) {
      if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
      return findTerrainPath({ ...options, radius: EXTENDED_SEARCH_RADIUS, maxNodes: SEARCH_NODE_LIMIT * 3 });
    }
  }

  terrainRailHeights(x, z, currentY) {
    const at = y => this.blockAt(new Vec3(x, y, z));
    const solid = block => this.isSolid(block) && !RAILS.has(block.name);
    if (solid(at(currentY)) && this.isPassable(at(currentY + 1)) && this.hasClearance(x, z, currentY + 1)) return [currentY + 1];
    if (this.isPassable(at(currentY)) && (solid(at(currentY - 1)) || LIQUID.has(at(currentY)?.name)
      || LIQUID.has(at(currentY - 1)?.name)) && this.hasClearance(x, z, currentY)) return [currentY];
    if (this.isPassable(at(currentY - 1)) && solid(at(currentY - 2)) && this.hasClearance(x, z, currentY - 1)) return [currentY - 1];
    return [];
  }

  isPassable(block) {
    return Boolean(block && !LAVA.has(block.name)
      && (AIR.has(block.name) || LIQUID.has(block.name) || RAILS.has(block.name) || block.boundingBox === 'empty'));
  }

  hasClearance(x, z, y) {
    return [0, 1, 2].every(offset => {
      const block = this.blockAt(new Vec3(x, y + offset, z));
      // canDigBlock também mede o alcance atual; durante o planejamento basta
      // excluir blocos realmente inquebráveis, pois o bot se aproximará depois.
      return this.isPassable(block) || Boolean(block && block.diggable !== false);
    });
  }

  wallTopRailY(x, z, currentY) {
    for (let y = currentY + 2; y <= Math.min(319, currentY + WALL_MAX_HEIGHT); y++) {
      const support = this.blockAt(new Vec3(x, y - 1, z));
      if (this.isSolid(support) && !RAILS.has(support.name) && this.isPassable(this.blockAt(new Vec3(x, y, z)))
        && this.hasClearance(x, z, y)) return y;
    }
    return null;
  }

  highWallAhead(current, direction) {
    if (!direction) return null;
    for (let distance = 1; distance <= WALL_SCAN_DISTANCE; distance++) {
      const x = current.x + direction.x * distance;
      const z = current.z + direction.z * distance;
      const top = this.wallTopRailY(x, z, current.y);
      if (top !== null) return top;
    }
    return null;
  }

  async buildCell(cell) {
    const point = vec(cell.position);
    await this.moveNear(point);
    const waterOnPath = LIQUID.has(this.blockAt(point)?.name);
    for (let height = 2; height >= 0; height--) await this.clear(point.offset(0, height, 0));

    const support = point.offset(0, -1, 0);
    const previousSupport = cell.previous ? vec(cell.previous).offset(0, -1, 0) : null;
    const missingSupport = !this.isSolid(this.blockAt(support));
    const usedStoneSupport = cell.forceStone || waterOnPath || missingSupport;
    if (cell.powered) {
      await this.replace(support, 'redstone_block', { preferredReference: previousSupport });
    } else if (usedStoneSupport) {
      await this.replace(support, 'stone');
    }

    await this.replace(point, cell.powered ? 'powered_rail' : 'rail');
    return { usedStoneSupport };
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

  async replace(point, item, { preferredReference = null } = {}) {
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
      const reference = this.findReference(point, preferredReference);
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

  findReference(target, preferredPosition = null) {
    if (preferredPosition) {
      const face = target.minus(preferredPosition);
      const adjacent = Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) === 1;
      const preferredBlock = this.blockAt(preferredPosition);
      if (adjacent && this.isSolid(preferredBlock)) return { block: preferredBlock, face };
    }
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

function reachedGoal(position, goal, goalDistance) {
  const horizontal = horizontalDistance(position, goal);
  if (horizontal > goalDistance) return false;
  return goalDistance > 0 || goal.y === null || position.y === goal.y;
}

function heuristic(position, goal, goalDistance) {
  const horizontal = Math.max(0, horizontalDistance(position, goal) - goalDistance);
  return horizontal + (goalDistance === 0 && goal.y !== null ? Math.abs(position.y - goal.y) * 0.75 : 0);
}

function directionHeuristic(position, direction, goal) {
  return Math.abs(position.x + direction.x - goal.x) + Math.abs(position.z + direction.z - goal.z);
}

function stateKey(state) { return `${state.x},${state.y},${state.z},${state.direction ?? '-'},${state.slope}`; }

function reconstruct(last) {
  const path = [];
  for (let state = last; state; state = state.parent) path.push({ x: state.x, y: state.y, z: state.z });
  return path.reverse();
}

function directionBetween(from, to) {
  const direction = DIRECTIONS.find(candidate => from.x + candidate.x === to.x && from.z + candidate.z === to.z);
  if (!direction) throw new RailwayError('o trecho anterior não é adjacente ao planejamento atual');
  return direction.name;
}

function isCorner(previous, current, next) {
  if (!previous || !next) return false;
  return directionBetween(previous, current) !== directionBetween(current, next);
}

function preferredDirection(current, end) {
  const xDistance = end.x - current.x;
  const zDistance = end.z - current.z;
  return Math.abs(xDistance) >= Math.abs(zDistance)
    ? DIRECTIONS.find(candidate => candidate.x === Math.sign(xDistance))
    : DIRECTIONS.find(candidate => candidate.z === Math.sign(zDistance));
}

function columnKey(position) { return `${position.x},${position.z}`; }
function samePosition(a, b) { return a.x === b.x && a.z === b.z && (a.y === b.y || a.y === null || b.y === null); }
function horizontalDistance(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.z - b.z); }

class MinHeap {
  constructor(compare) { this.values = []; this.compare = compare; }
  get size() { return this.values.length; }
  push(value) {
    this.values.push(value);
    for (let index = this.values.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], value) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
      this.values[index] = value;
    }
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length && last) {
      this.values[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.values.length && this.compare(this.values[left], this.values[smallest]) < 0) smallest = left;
        if (right < this.values.length && this.compare(this.values[right], this.values[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]];
        index = smallest;
      }
    }
    return first;
  }
}

function vec(position) { return new Vec3(position.x, position.y, position.z); }
function format(position) { return `${position.x}, ${position.y}, ${position.z}`; }
