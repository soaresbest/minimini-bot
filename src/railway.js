import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';

const { goals } = pathfinderPackage;
const { Vec3 } = vec3Package;

const PLAN_HORIZON = 40;
const BUILD_BATCH = 12;
const SEARCH_RADIUS = 64;
const EXTENDED_SEARCH_RADIUS = 96;
const SEARCH_NODE_LIMIT = 12_000;
const EXTENDED_SEARCH_NODE_LIMIT = 120_000;
const GIVE_WAIT_MS = 4_000;
const PLACE_ATTEMPTS = 3;
const PLACE_RETRY_MS = 200;
const SUPPORT_MAX_BLOCKS = 3;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const RAILS = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
const FALLING_SUPPORTS = new Set(['sand', 'red_sand', 'gravel']);
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
  blocked = () => false, costAt = () => 0, goalDistance = 0, radius = SEARCH_RADIUS, maxNodes = SEARCH_NODE_LIMIT }) {
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
      // A orientação faz parte do estado do A*. Sem esta checagem, uma
      // ida-e-volta pode simular uma curva plana e reutilizar o mesmo trilho.
      let repeatedColumn = false;
      for (let ancestor = current; ancestor; ancestor = ancestor.parent) {
        if (ancestor.x === x && ancestor.z === z) { repeatedColumn = true; break; }
      }
      if (repeatedColumn) continue;
      if (current.parent === null && forcedFirst && (x !== forcedFirst.x || z !== forcedFirst.z)) continue;
      const heights = heightsAt(x, z, current.y, current);
      for (const y of heights) {
        if (!Number.isInteger(y) || Math.abs(y - current.y) > 1) continue;
        if (current.parent === null && forcedFirst && Number.isInteger(forcedFirst.y) && y !== forcedFirst.y) continue;
        const slope = y - current.y;
        const turning = current.direction && current.direction !== direction.name;
        // A rampa ocupa o bloco INFERIOR. No topo, o trilho atual pode ser
        // plano e curvar: são os vizinhos mais baixos que ficam inclinados.
        if (turning && (current.slope < 0 || slope > 0)) continue;
        if (current.slope < 0 && slope > 0) continue;
        const g = current.g + 1 + Math.abs(slope) * 0.75 + (turning ? 0.2 : 0) + costAt(x, y, z);
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

export class RailwayTask {
  constructor(controller, signal) {
    this.controller = controller;
    this.bot = controller.bot;
    this.signal = signal;
    this.allowCommands = false;
    this.completedRailColumns = new Map();
    this.lastCompleted = null;
    this.pendingCell = null;
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
    let built = 0;
    let lastPowered = 0;
    const builtColumns = new Set([columnKey(start)]);
    this.log('inicio', { start, end, allowCommands: this.allowCommands });
    const startedAt = Date.now();
    try {
      await this.buildCell({ index: 0, position: start, previous: null, powered: true });

      while (!samePosition(current, end)) {
        this.signal.throwIfAborted();
        const remaining = horizontalDistance(current, end);
        const finalSegment = remaining <= PLAN_HORIZON;
        const planStarted = Date.now();
        const path = this.planTerrainPath({
          start: current,
          goal: end,
          previous,
          forcedFirst,
          blocked: (x, z) => builtColumns.has(`${x},${z}`),
          goalDistance: finalSegment ? 0 : remaining - PLAN_HORIZON,
          heightsAt: (x, z, y, from) => this.terrainRailHeights(x, z, y, from),
          costAt: (x, y, z) => LIQUID.has(this.blockAt(new Vec3(x, y - 1, z))?.name) ? 2 : 0,
        });
        this.log('plano', {
          from: current, to: path.at(-1), steps: path.length - 1, remaining,
          minY: Math.min(...path.map(point => point.y)), maxY: Math.max(...path.map(point => point.y)),
          durationMs: Date.now() - planStarted, path,
        });
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
          await this.buildCell(cell);
          builtColumns.add(columnKey(position));
          previous = current;
          current = position;
          builtOffset = offset;
        }
        forcedFirst = path[builtOffset + 1] ?? null;
      }
      this.log('concluido', { position: current, blocks: built + 1, durationMs: Date.now() - startedAt });
    } catch (error) {
      this.log(this.signal.aborted ? 'cancelado' : 'falha', {
        code: error.code ?? error.name, reason: error.message, lastCompleted: this.lastCompleted,
        pending: this.pendingCell, botPosition: this.bot.entity.position,
        surroundings: this.pendingCell ? this.describeTerrain(this.pendingCell.position) : this.describeTerrain(current),
      });
      throw error;
    }
  }

  log(event, details = {}) {
    this.controller.manager?.log?.(`[railway] ${JSON.stringify({
      time: new Date().toISOString(), bot: this.bot.username, event, ...details,
    })}`);
  }

  describeTerrain(position) {
    if (!this.bot.blockAt) return [];
    return [{ x: 0, z: 0 }, ...DIRECTIONS].map(({ x, z }) => ({
      x: position.x + x, z: position.z + z,
      blocks: [-2, -1, 0, 1, 2].map(offset => ({
        y: position.y + offset,
        name: this.blockAt(new Vec3(position.x + x, position.y + offset, position.z + z))?.name ?? 'não carregado',
      })),
    }));
  }

  planTerrainPath(options) {
    // A busca é síncrona: o mundo não muda até devolvermos o event loop.
    // Reutilizar as leituras neste plano permite explorar desvios longos sem
    // consultar os mesmos blocos centenas de vezes. Nunca reutilize entre lotes.
    this.planningBlocks = new Map();
    try {
      try {
        return findTerrainPath(options);
      } catch (error) {
        if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
        this.log('ampliando_busca', { from: options.start, radius: EXTENDED_SEARCH_RADIUS,
          maxNodes: EXTENDED_SEARCH_NODE_LIMIT, forcedFirst: options.forcedFirst });
        try {
          return findTerrainPath({ ...options, radius: EXTENDED_SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
        } catch (extendedError) {
          if (extendedError?.code !== 'RAILWAY_NO_ROUTE') throw extendedError;
          this.log('sem_rota', { from: options.start, surroundings: this.describeTerrain(options.start) });
          throw new RailwayError(`não encontrei desvio pelo piso a partir de ${format(options.start)}; rampas precisam variar no máximo um bloco por posição`, 'RAILWAY_NO_ROUTE');
        }
      }
    } finally {
      this.planningBlocks = null;
    }
  }

  terrainRailHeights(x, z, currentY, previous = null) {
    const at = y => this.blockAt(new Vec3(x, y, z));
    // Só existem rampas onde o próprio piso sobe/desce. Líquido serve como
    // apoio substituível na superfície, nunca como espaço para o carrinho.
    return [currentY - 1, currentY, currentY + 1].filter(y => {
      const floor = at(y - 1);
      return (this.isSolid(floor) || LIQUID.has(floor?.name))
        && this.isPassable(at(y)) && this.hasClearance(x, z, y, previous);
    });
  }

  isPassable(block) {
    return Boolean(block && !LIQUID.has(block.name)
      && (AIR.has(block.name) || RAILS.has(block.name) || block.boundingBox === 'empty'));
  }

  hasClearance(x, z, y, previous = null) {
    // Não abra um teto que está segurando água/lava sobre o corredor.
    const ceiling = this.blockAt(new Vec3(x, y + 2, z));
    if (!this.isPassable(ceiling) && LIQUID.has(this.blockAt(new Vec3(x, y + 3, z))?.name)) return false;
    if (DIRECTIONS.some(direction => [0, 1, 2].some(height => {
      const point = new Vec3(x + direction.x, y + height, z + direction.z);
      // O piso do passo anterior já terá sido substituído antes da descida.
      if (previous && point.x === previous.x && point.z === previous.z && point.y === previous.y - 1) return false;
      return LIQUID.has(this.blockAt(point)?.name);
    }))) return false;
    return [0, 1, 2].every(offset => {
      const block = this.blockAt(new Vec3(x, y + offset, z));
      // canDigBlock também mede o alcance atual; durante o planejamento basta
      // excluir blocos realmente inquebráveis, pois o bot se aproximará depois.
      return this.isPassable(block) || Boolean(block && !LIQUID.has(block.name) && block.diggable !== false);
    });
  }

  async buildCell(cell) {
    const point = vec(cell.position);
    this.pendingCell = { index: cell.index, position: cell.position, powered: cell.powered };
    this.completedRailColumns ??= new Map();
    if (cell.previous) this.completedRailColumns.set(columnKey(cell.previous), cell.previous.y);
    this.validateFloor(point);
    await this.moveNear(point);
    this.validateFloor(point);
    for (let height = 2; height >= 0; height--) await this.clear(point.offset(0, height, 0));

    const support = point.offset(0, -1, 0);
    const previousSupport = cell.previous ? vec(cell.previous).offset(0, -1, 0) : null;
    const supportBlock = this.blockAt(support);
    this.validateFloor(point);
    const liquidSupport = LIQUID.has(supportBlock?.name);
    const unstableSupport = FALLING_SUPPORTS.has(supportBlock?.name)
      || supportBlock?.name.endsWith('_concrete_powder');
    const usedStoneSupport = liquidSupport || unstableSupport;
    const supportItem = cell.powered ? 'redstone_block' : (usedStoneSupport ? 'stone' : null);
    if (supportItem && supportBlock?.name !== supportItem) {
      this.log('trocando_piso', { position: support, from: supportBlock.name, to: supportItem,
        reason: liquidSupport ? 'liquido' : unstableSupport ? 'gravidade' : 'alimentacao' });
      await this.ensureMaterial(supportItem);
      const existingRail = this.blockAt(point);
      // Retire o trilho antes de trocar o piso: o servidor pode destruir o
      // trilho pela falta de apoio depois que o cliente já o deu por pronto.
      if (RAILS.has(existingRail?.name)) {
        if (!this.bot.canDigBlock(existingRail)) throw new RailwayError(`não posso remover ${existingRail.name} em ${format(point)}`);
        await this.dig(existingRail);
      }
      await this.replace(support, supportItem, { preferredReference: previousSupport });
    }

    await this.replace(point, cell.powered ? 'powered_rail' : 'rail');
    this.completedRailColumns.set(columnKey(point), point.y);
    this.lastCompleted = { index: cell.index, position: cell.position };
    this.pendingCell = null;
    this.log('bloco_concluido', { index: cell.index, position: cell.position,
      deltaY: cell.previous ? point.y - cell.previous.y : 0, powered: cell.powered,
      floor: this.blockAt(support)?.name, botPosition: this.bot.entity.position });
    return { usedStoneSupport };
  }

  validateFloor(point) {
    const support = this.blockAt(point.offset(0, -1, 0));
    if (!support || (!this.isSolid(support) && !LIQUID.has(support.name))) {
      throw new RailwayError(`o piso em ${format(point.offset(0, -1, 0))} não oferece apoio; é necessário procurar um desvio pelo terreno`, 'RAILWAY_TERRAIN_CHANGED');
    }
    if (!this.isPassable(this.blockAt(point)) || !this.hasClearance(point.x, point.z, point.y)) {
      throw new RailwayError(`o corredor em ${format(point)} está bloqueado ou contém líquido; o trilho precisa ficar acima da superfície`, 'RAILWAY_TERRAIN_CHANGED');
    }
  }

  async moveNear(point) {
    if (this.bot.entity.position.distanceTo(point) <= 2.5) return;
    this.log('aproximando', { target: point, botPosition: this.bot.entity.position });
    await this.controller.moveToGoal(new goals.GoalNear(point.x, point.y, point.z, 2), this.signal);
  }

  blockAt(point) {
    if (!this.planningBlocks) return this.bot.blockAt(point);
    const key = `${point.x},${point.y},${point.z}`;
    if (!this.planningBlocks.has(key)) this.planningBlocks.set(key, this.bot.blockAt(point));
    return this.planningBlocks.get(key);
  }
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

  async replace(point, item, { preferredReference = null, buildSupport = true } = {}) {
    let block = this.blockAt(point);
    if (!block) throw new RailwayError('o trecho seguinte ainda não foi carregado pelo servidor');
    if (block.name === item) return;
    this.signal.throwIfAborted();
    await this.ensureMaterial(item);
    let temporaryReference = null;
    if (!AIR.has(block.name) && !LIQUID.has(block.name)) {
      if (!this.bot.canDigBlock(block)) throw new RailwayError(`não posso substituir ${block.name} em ${format(point)}`);
      // Preserve uma face antes de escavar um bloco isolado. Água por si só
      // não exige apoio temporário quando já existe uma face sólida vizinha.
      if (item === 'redstone_block' && !this.findReference(point, preferredReference)) {
        temporaryReference = await this.createTemporaryReference(point, preferredReference);
      }
    }
    try {
      if (!AIR.has(block.name) && !LIQUID.has(block.name)) {
        await this.dig(block);
        block = this.blockAt(point);
      }
      for (let attempt = 1; attempt <= PLACE_ATTEMPTS; attempt++) {
        await this.ensureMaterial(item);
        let reference = this.findReference(point, preferredReference);
        if (!reference && buildSupport && ['stone', 'redstone_block'].includes(item)) {
          await this.connectSupport(point, preferredReference);
          reference = this.findReference(point, preferredReference);
        }
        if (!reference) throw this.supportError(point, item, preferredReference);
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
          this.log('repetindo_colocacao', { target: point, item, attempt,
            observed: this.blockAt(point)?.name, reference: referenceBlock.position,
            referenceBlock: this.blockAt(referenceBlock.position)?.name });
          await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
          if (this.blockAt(point)?.name === item) return;
          if (attempt === PLACE_ATTEMPTS) {
            throw new RailwayError(`o servidor recusou colocar ${item} em ${format(point)} após ${PLACE_ATTEMPTS} tentativas`, 'RAILWAY_PLACEMENT');
          }
          await this.moveNear(point);
          continue;
        }
        if (this.blockAt(point)?.name === item) return;
        if (attempt < PLACE_ATTEMPTS) await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
      }
      throw new RailwayError(`não consegui confirmar ${item} em ${format(point)}`, 'RAILWAY_PLACEMENT');
    } finally {
      if (!this.signal.aborted && this.blockAt(point)?.name === item
        && temporaryReference && this.blockAt(temporaryReference)?.name === 'stone') await this.clear(temporaryReference);
    }
  }

  supportError(point, item, previousSupport) {
    const neighbors = FACES.map(face => {
      const position = point.minus(face);
      return { position, block: this.blockAt(position)?.name ?? 'não carregado' };
    });
    this.controller.manager?.log?.(`[railway] ${JSON.stringify({
      item, target: point, previousSupport, bot: this.bot.entity.position, neighbors,
    })}`);
    return new RailwayError(`não há apoio para colocar ${item} em ${format(point)}`, 'RAILWAY_NO_SUPPORT');
  }

  findSupportConnection(target, previousSupport, excluded = new Set()) {
    // Busca curta pelo espaço vazio, do alvo até uma face sólida. Os apoios
    // ficam no nível do piso ou abaixo, sem invadir o trilho/corredor anterior.
    const queue = [{ position: target, path: [] }];
    const seen = new Set([target.toString()]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { position, path } = queue[cursor];
      if (path.length && this.findReference(position, previousSupport)) return path.reverse();
      if (path.length >= SUPPORT_MAX_BLOCKS) continue;
      for (const face of FACES) {
        const next = position.minus(face);
        const key = next.toString();
        if (seen.has(key) || excluded.has(key) || next.y > target.y) continue;
        const railY = this.completedRailColumns?.get(columnKey(next));
        if (railY !== undefined && next.y >= railY) continue;
        if (previousSupport && next.x === previousSupport.x && next.z === previousSupport.z
          && next.y > previousSupport.y) continue;
        const block = this.blockAt(next);
        if (!block || (!AIR.has(block.name) && !LIQUID.has(block.name))) continue;
        seen.add(key);
        queue.push({ position: next, path: [...path, next] });
      }
    }
    return null;
  }

  async connectSupport(target, previousSupport) {
    const excluded = new Set();
    for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
      this.signal.throwIfAborted();
      if (this.findReference(target, previousSupport)) return;
      const path = this.findSupportConnection(target, previousSupport, excluded);
      if (!path) throw this.supportError(target, 'stone/redstone_block', previousSupport);
      this.log('conectando_apoio', { target, previousSupport, path, attempt: attempt + 1 });
      for (const point of path) {
        try {
          await this.replace(point, 'stone', { preferredReference: previousSupport, buildSupport: false });
        } catch (error) {
          this.signal.throwIfAborted();
          if (!['RAILWAY_NO_SUPPORT', 'RAILWAY_PLACEMENT'].includes(error.code)) throw error;
          excluded.add(point.toString());
          break;
        }
      }
    }
    if (!this.findReference(target, previousSupport)) throw this.supportError(target, 'stone/redstone_block', previousSupport);
  }

  async createTemporaryReference(target, previousSupport) {
    const faces = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
      new Vec3(0, 1, 0),
    ];
    const candidates = faces
      .map(face => target.plus(face))
      .filter(point => !previousSupport || point.x !== previousSupport.x || point.z !== previousSupport.z);
    for (const point of candidates) {
      const railY = this.completedRailColumns?.get(columnKey(point));
      if (railY !== undefined && point.y >= railY) continue;
      const block = this.blockAt(point);
      if (!block || (!AIR.has(block.name) && !LIQUID.has(block.name))) continue;
      try {
        await this.replace(point, 'stone', { preferredReference: target, buildSupport: false });
        return point;
      } catch (error) {
        this.signal.throwIfAborted();
        if (!['RAILWAY_NO_SUPPORT', 'RAILWAY_PLACEMENT'].includes(error.code)) throw error;
      }
    }
    throw new RailwayError(`não há espaço temporário para apoiar redstone em ${format(target)}`);
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
    this.log('repondo_material', { item: name, count: MATERIAL_BATCH[name] });
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
