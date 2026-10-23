import pathfinderPackage from 'mineflayer-pathfinder';
import vec3Package from 'vec3';
import { setTimeout as delay, setImmediate as yieldToServer } from 'node:timers/promises';
import { supportsRail } from './railway-support.js';
import { navigationWaypoints } from './navigation.js';
import { planDescentCorridor } from './descent-plan.js';

const { goals } = pathfinderPackage;
const { Vec3 } = vec3Package;

const PLAN_HORIZON = 64;
const BUILD_BATCH = 12;
const SEARCH_RADIUS = 64;
const EXTENDED_SEARCH_RADIUS = 96;
const SEARCH_NODE_LIMIT = 25_000;
const EXTENDED_SEARCH_NODE_LIMIT = 120_000;
const GIVE_WAIT_MS = 4_000;
const PLACE_ATTEMPTS = 3;
const PLACE_RETRY_MS = 200;
const SUPPORT_MAX_BLOCKS = 3;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const RAILS = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
const SAND = new Set(['sand', 'red_sand']);
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
export function findTerrainPath(options) {
  const search = terrainPathSearch(options);
  let step;
  do { step = search.next(); } while (!step.done);
  return step.value;
}

function* terrainPathSearch({ start, goal, heightsAt, previous = null, forcedFirst = null,
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
  let iterations = 0;
  let sliceStarted = performance.now();

  while (open.size) {
    if (++iterations % 64 === 0 && performance.now() - sliceStarted >= 10) {
      yield;
      sliceStarted = performance.now();
    }
    const current = open.pop();
    if (current.g !== best.get(stateKey(current))) continue;
    const atGoal = reachedGoal(current, goal, goalDistance);
    if (atGoal && goalDistance === 0) return reconstruct(current);
    if (++visited > maxNodes) break;
    let hasContinuation = false;

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
        hasContinuation = true;
        const g = current.g + 1 + Math.abs(slope) * 0.75 + (turning ? 0.2 : 0) + costAt(x, y, z);
        const next = { x, y, z, direction: direction.name, slope, g, parent: current };
        const key = stateKey(next);
        if (g >= (best.get(key) ?? Infinity)) continue;
        best.set(key, g);
        open.push({ ...next, f: g + heuristic(next, goal, goalDistance) });
      }
    }
    // Um limite de planejamento não é o destino final: não aceite parar
    // exatamente num beco cuja única saída exigiria refazer os trilhos.
    if (atGoal && hasContinuation) return reconstruct(current);
  }
  const error = new RailwayError('não encontrei uma rota pelo terreno com rampas de no máximo um bloco', 'RAILWAY_NO_ROUTE');
  error.searchReason = visited > maxNodes ? 'limite_de_busca' : 'rotas_esgotadas';
  error.visited = visited;
  throw error;
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
    this.planningHistory = [];
    this.descentState = null;
    this.prebuiltDescent = new Map();
  }

  async run(action, resume = null) {
    this.signal.throwIfAborted();
    let start, end;
    if (resume) {
      ({ start, end } = resume);
      this.completedRailColumns = new Map(resume.completedRailColumns);
      this.lastCompleted = resume.lastCompleted;
      this.contourDirection = resume.contourDirection;
      this.planningHistory = resume.planningHistory ?? [];
      this.descentState = resume.descentState ?? null;
      this.prebuiltDescent = new Map(resume.prebuiltDescent ?? []);
      this.allowCommands = resume.allowCommands;
    } else {
      if (action.player !== undefined) {
        const player = this.controller.ensurePlayer(action.player);
        const position = player.entity?.position;
        if (!position) throw new RailwayError(`O jogador ${action.player} está fora do alcance visível do bot`, 'RAILWAY_PLAYER_NOT_VISIBLE');
        const end = integerPosition({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }, 'fim');
        // Assim como no início, normalize o piso parcial sob os pés do jogador.
        const feet = this.blockAt(vec(end));
        if (this.isFloorCandidate(feet) && !this.isPassable(feet)
          && this.isPassable(this.blockAt(vec(end).offset(0, 1, 0)))) end.y++;
        action = { startX: null, startY: null, startZ: null,
          endX: end.x, endY: end.y, endZ: end.z, allowCommands: action.allowCommands };
      }
      this.allowCommands = action.allowCommands;
      const origin = {
        x: Math.floor(this.bot.entity.position.x),
        y: Math.floor(this.bot.entity.position.y),
        z: Math.floor(this.bot.entity.position.z),
      };
      start = integerPosition({
        x: action.startX ?? origin.x, y: action.startY ?? origin.y, z: action.startZ ?? origin.z,
      }, 'início');
      // Em paths/lajes o pé está dentro do bloco parcial. O trilho deve ficar
      // acima do piso normalizado, não tentar ocupar o próprio piso.
      if (action.startY == null && this.bot.blockAt) {
        const feet = this.blockAt(vec(start));
        if (this.isFloorCandidate(feet) && !this.isPassable(feet)
          && this.isPassable(this.blockAt(vec(start).offset(0, 1, 0)))) start.y++;
      }
      const validatedEnd = integerPosition({
        x: action.endX ?? origin.x, y: action.endY ?? origin.y, z: action.endZ ?? origin.z,
      }, 'fim');
      end = { ...validatedEnd, y: action.endY === null ? null : validatedEnd.y };
    }
    let current = resume?.current ?? start;
    let previous = resume?.previous ?? null;
    let forcedFirst = resume?.forcedFirst ?? null;
    let plannedPath = resume?.plannedPath ?? null;
    let built = resume?.built ?? 0;
    let lastPowered = resume?.lastPowered ?? 0;
    const builtColumns = new Set(resume?.builtColumns ?? [columnKey(start)]);
    const checkpoint = (initialBuilt, path = plannedPath) => {
      this.checkpoint = structuredClone({ start, end, current, previous, forcedFirst: path?.[1] ?? forcedFirst,
        plannedPath: path, built, lastPowered, builtColumns: [...builtColumns], initialBuilt,
        completedRailColumns: [...this.completedRailColumns], lastCompleted: this.lastCompleted,
        contourDirection: this.contourDirection, allowCommands: this.allowCommands, planningHistory: this.planningHistory,
        descentState: this.descentState, prebuiltDescent: [...this.prebuiltDescent] });
    };
    this.log('inicio', { start, end, allowCommands: this.allowCommands });
    const startedAt = Date.now();
    try {
      checkpoint(resume?.initialBuilt ?? false);
      if (!resume?.initialBuilt) {
        await this.moveNear(vec(start));
        await this.buildCellWithRetry({ index: 0, position: start, previous: null, powered: true });
      }
      checkpoint(true);
      if (this.descentState) await this.buildDescent(null, () => checkpoint(true));

      while (!samePosition(current, end)) {
        this.signal.throwIfAborted();
        const remaining = horizontalDistance(current, end);
        if (!plannedPath || (plannedPath.length <= 2 && !this.prebuiltDescent.size)) {
          const planStarted = Date.now();
          plannedPath = await this.planTerrainPath({
            start: current,
            goal: end,
            previous,
            forcedFirst,
            blocked: (x, z) => builtColumns.has(`${x},${z}`),
            goalDistance: remaining <= PLAN_HORIZON ? 0 : remaining - PLAN_HORIZON,
            heightsAt: (x, z, y, from) => this.terrainRailHeights(x, z, y, from, Number.isInteger(end.y) && end.y < current.y ? end.y : null),
            costAt: (x, y, z) => {
              const floor = this.blockAt(new Vec3(x, y - 1, z));
              return AIR.has(floor?.name) ? 4 : LIQUID.has(floor?.name) ? 2 : 0;
            },
          });
          this.log('plano', {
            from: current, to: plannedPath.at(-1), steps: plannedPath.length - 1, remaining,
            minY: Math.min(...plannedPath.map(point => point.y)), maxY: Math.max(...plannedPath.map(point => point.y)),
            durationMs: Date.now() - planStarted, path: plannedPath,
          });
        } else {
          this.log('continuando_desvio', { from: current, to: plannedPath.at(-1), steps: plannedPath.length - 1 });
        }
        // Um desvio pode começar se afastando do destino. Não troque sua saída
        // por uma nova meta mais próxima a cada lote: isso faria o
        // bot voltar ao obstáculo. Reserve a última posição para conhecer a
        // orientação do próximo trilho antes de terminar o trecho atual.
        const path = plannedPath;
        const reserve = samePosition(path.at(-1), end) || this.prebuiltDescent.size ? 0 : 1;
        const count = Math.min(BUILD_BATCH, path.length - 1 - reserve);
        if (count < 1) throw new RailwayError('o planejamento do terreno não avançou');
        let builtOffset = 0;
        for (let offset = 1; offset <= count; offset++) {
          this.signal.throwIfAborted();
          const position = path[offset];
          const next = path[offset + 1] ?? null;
          checkpoint(true, path.slice(offset - 1));
          const index = built + 1;
          const slope = current.y !== position.y || next?.y !== position.y;
          const corner = isCorner(current, position, next);
          const endpoint = samePosition(position, end);
          const maximumGap = slope ? 3 : 8;
          // Trilhos eletrificados não fazem curvas: reponha o impulso na
          // primeira posição reta após a curva, inclusive ao retomar um lote.
          const afterCorner = isCorner(previous, current, position);
          const powered = !corner && (afterCorner || endpoint || index - lastPowered >= maximumGap);

          const cell = { index, position, previous: current, powered, slope, corner };
          this.controller.task = `construindo trilhos: ${index + 1} blocos; faltam aproximadamente ${horizontalDistance(position, end)}`;
          if (position.y < current.y && !this.prebuiltDescent.has(index)) {
            // Calcule a alimentação na ordem da rota, mas construa a rampa
            // inteira na ordem inversa, inclusive além do limite do lote.
            const cells = [];
            let powerIndex = lastPowered;
            for (let step = offset; step < path.length && path[step].y < path[step - 1].y; step++) {
              const candidate = path[step];
              const after = path[step + 1] ?? null;
              const cellIndex = built + step - offset + 1;
              const turn = isCorner(path[step - 1], candidate, after);
              const beforePrevious = step === offset ? previous : path[step - 2];
              const afterTurn = isCorner(beforePrevious, path[step - 1], candidate);
              const energize = !turn && (afterTurn || samePosition(candidate, end) || cellIndex - powerIndex >= 3);
              if (energize) powerIndex = cellIndex;
              cells.push({ index: cellIndex, position: candidate, previous: path[step - 1],
                powered: energize, slope: true, corner: turn });
            }
            await this.buildDescent(cells, () => checkpoint(true, path.slice(offset - 1)));
          }
          const prebuilt = this.prebuiltDescent.get(index);
          if (prebuilt && samePosition(prebuilt, position)) {
            this.prebuiltDescent.delete(index);
            this.lastCompleted = { index, position };
          } else await this.buildCellWithRetry(cell);
          built = index;
          if (powered) lastPowered = index;
          builtColumns.add(columnKey(position));
          previous = current;
          current = position;
          builtOffset = offset;
          checkpoint(true, path.slice(offset));
        }
        forcedFirst = path[builtOffset + 1] ?? null;
        // Reavalie uma saída natural após cada trecho escavado. O checkpoint
        // mantém os pontos restantes se houver desconexão antes do recálculo.
        plannedPath = path[builtOffset]?.tunnel ? null : path.slice(builtOffset);
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
    if (event === 'plano' || event === 'plano_descida' || event === 'plano_tunel') this.planningHistory.push(structuredClone({ time: new Date().toISOString(), ...details }));
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

  async searchTerrainPath(options) {
    this.signal.throwIfAborted();
    const search = terrainPathSearch(options);
    while (true) {
      this.signal.throwIfAborted();
      const step = search.next();
      if (step.done) return step.value;
      // Permita keepalive, chunks e stop durante buscas extensas.
      await yieldToServer(undefined, { signal: this.signal });
      this.planningBlocks?.clear();
    }
  }

  async planTerrainPath(options) {
    // Cache apenas entre pausas: pacotes do servidor podem alterar o mundo.
    this.signal.throwIfAborted();
    this.planningBlocks = new Map();
    try {
      if (!this.contourDirection) {
        const descent = await planDescentCorridor({ ...options,
          onYield: () => this.planningBlocks?.clear() }, this.signal);
        if (descent) {
          this.log('corredor_descida', { from: options.start, to: options.goal, path: descent });
          return descent;
        }
      }
      if (this.contourDirection) {
        // Durante o contorno, reduzir a distância Manhattan voltando pela
        // lateral da mesma parede não significa ter vencido o obstáculo.
        // Primeiro confirme uma passagem para o outro lado da montanha.
        const direction = this.contourDirection;
        const axis = direction.x === 0 ? 'x' : 'z';
        const delta = options.goal[axis] - options.start[axis];
        const goal = { ...options.start, y: null,
          [axis]: options.start[axis] + Math.sign(delta) * Math.min(48, Math.abs(delta)) };
        try {
          const path = await this.searchTerrainPath({ ...options, goal, goalDistance: Math.abs(delta) >= 48 ? 16 : 0,
            radius: SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
          if (path.length > 2) {
            this.contourDirection = null;
            this.log('saida_do_contorno', { from: options.start, to: path.at(-1) });
            return path;
          }
        } catch (error) {
          if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
        }
        const path = await this.planWideContour(options);
        if (path) return path;
        throw new RailwayError('não encontrei continuação segura para contornar a montanha pelo piso carregado', 'RAILWAY_NO_ROUTE');
      }
      try {
        const path = await this.searchTerrainPath(options);
        this.contourDirection = null;
        return path;
      } catch (error) {
        if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
        this.log('ampliando_busca', { from: options.start, radius: EXTENDED_SEARCH_RADIUS,
          maxNodes: EXTENDED_SEARCH_NODE_LIMIT, forcedFirst: options.forcedFirst,
          reason: error.searchReason, visited: error.visited });
        try {
          const path = await this.searchTerrainPath({ ...options, radius: EXTENDED_SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
          this.contourDirection = null;
          return path;
        } catch (extendedError) {
          if (extendedError?.code !== 'RAILWAY_NO_ROUTE') throw extendedError;
          // Um trilho comum concluído pela própria obra pode mudar a saída
          // reservada. A geometria com o passo anterior continua validada.
          if (options.forcedFirst
            && this.completedRailColumns.get(columnKey(options.start)) === options.start.y
            && this.blockAt(vec(options.start))?.name === 'rail') {
            this.log('ajustando_saida', { from: options.start, forcedFirst: options.forcedFirst,
              radius: EXTENDED_SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
            try {
              const path = await this.searchTerrainPath({ ...options, forcedFirst: null,
                radius: EXTENDED_SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
              this.contourDirection = null;
              return path;
            } catch (adjustedError) {
              if (adjustedError?.code !== 'RAILWAY_NO_ROUTE') throw adjustedError;
            }
          }
          // Uma busca esgotada não prova que o terreno é impossível. Tente
          // um horizonte menor sem mudar a saída reservada.
          const dx = options.goal.x - options.start.x;
          const dz = options.goal.z - options.start.z;
          const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
          const probe = { ...options.start,
            [axis]: options.start[axis] + Math.sign(options.goal[axis] - options.start[axis]) * PLAN_HORIZON };
          const remaining = horizontalDistance(options.start, options.goal);
          const searchLimited = extendedError.searchReason === 'limite_de_busca';
          if (remaining > 32 && (searchLimited || !this.blockAt(vec(probe)))) {
            try {
              const path = await this.searchTerrainPath({ ...options, goalDistance: remaining - 32,
                radius: SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
              this.log('horizonte_reduzido', { from: options.start, to: path.at(-1), reason: searchLimited ? 'limite_de_busca' : 'chunks_nao_carregados' });
              return path;
            } catch (error) {
              if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
            }
          }
          const contour = await this.planWideContour(options);
          if (contour) return contour;
          this.log('sem_rota', { from: options.start, reason: extendedError.searchReason, visited: extendedError.visited, surroundings: this.describeTerrain(options.start) });
          throw new RailwayError(`não encontrei desvio pelo piso a partir de ${format(options.start)}; a busca pode ter atingido seu limite ou não haver continuação segura no terreno carregado`, 'RAILWAY_NO_ROUTE');
        }
      }
    } catch (error) {
      if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
      return await this.planTunnel(options);
    } finally {
      this.planningBlocks = null;
    }
  }

  async planTunnel(options) {
    this.signal.throwIfAborted();
    const remaining = horizontalDistance(options.start, options.goal);
    if (!remaining) throw new RailwayError('não há avanço horizontal para abrir um túnel até o destino', 'RAILWAY_NO_ROUTE');
    // Abra trechos curtos na altura atual; a busca normal volta a procurar
    // uma saída e rampas a cada lote, conforme o bot carrega novos chunks.
    const path = await this.searchTerrainPath({ ...options,
      goalDistance: Math.max(0, remaining - BUILD_BATCH),
      radius: EXTENDED_SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT,
      heightsAt: (x, z, y) => this.canTunnelAt(new Vec3(x, y, z)) ? [y] : [],
      costAt: (x, y, z) => [0, 1, 2].reduce((cost, height) =>
        cost + (this.isPassable(this.blockAt(new Vec3(x, y + height, z))) ? 0 : 2), 0),
    });
    if (path.length < 2) throw new RailwayError('não encontrei continuação escavável para o túnel', 'RAILWAY_NO_ROUTE');
    this.contourDirection = null;
    const tunnel = path.map((position, index) => index ? { ...position, tunnel: true } : position);
    this.log('plano_tunel', { from: options.start, to: path.at(-1), path: tunnel });
    return tunnel;
  }

  canTunnelAt(point) {
    const floor = this.blockAt(point.offset(0, -1, 0));
    if (!this.isFloorCandidate(floor) && !AIR.has(floor?.name)) return false;
    if (!this.hasClearance(point.x, point.z, point.y)) return false;
    // Não abra faces que exponham água/lava, inclusive no teto após minerar.
    if (LIQUID.has(this.blockAt(point.offset(0, 3, 0))?.name)) return false;
    return [0, 1, 2].every(height => {
      const block = this.blockAt(point.offset(0, height, 0));
      return this.isPassable(block) || Boolean(block && !LIQUID.has(block.name) && block.diggable === true);
    });
  }

  async openTunnelCell(cell) {
    const point = vec(cell.position);
    this.signal.throwIfAborted();
    if (!this.canTunnelAt(point)) throw new RailwayError('o túnel contém líquido, bloco inquebrável ou terreno desconhecido', 'RAILWAY_TERRAIN_CHANGED');
    // Trabalhe a partir do último trilho aberto, sem tentar navegar/teleportar
    // para dentro da parede que ainda precisa ser escavada.
    await this.moveNear(vec(cell.previous));
    for (let height = 2; height >= 0; height--) {
      this.signal.throwIfAborted();
      if (!this.canTunnelAt(point)) throw new RailwayError('o terreno mudou durante a escavação do túnel', 'RAILWAY_TERRAIN_CHANGED');
      await this.clear(point.offset(0, height, 0));
    }
    this.log('tunel_aberto', { index: cell.index, position: cell.position });
  }

  async planWideContour(options) {
    // Não imponha progresso em direção ao destino em todos os trechos: uma
    // montanha pode exceder tanto o raio da busca quanto os chunks carregados.
    // Mantenha o lado escolhido até encontrar novamente uma rota de progresso.
    const dx = options.goal.x - options.start.x;
    const dz = options.goal.z - options.start.z;
    const tangent = Math.abs(dx) >= Math.abs(dz) ? { x: 0, z: 1 } : { x: 1, z: 0 };
    if (!this.contourDirection) {
      const forward = tangent.x === 0 ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) };
      let mountain = false;
      for (let distance = 1; distance <= 48; distance++) {
        const block = this.blockAt(new Vec3(options.start.x + forward.x * distance,
          options.start.y + 1, options.start.z + forward.z * distance));
        if (!block) break;
        if (this.isSolid(block) && !RAILS.has(block.name)) { mountain = true; break; }
      }
      // Não transforme um abismo/área desconhecida em uma caminhada lateral
      // ilimitada. Este fallback é específico para obstáculos altos visíveis.
      if (!mountain) return null;
    }
    const directions = this.contourDirection ? [this.contourDirection]
      : [tangent, { x: -tangent.x, z: -tangent.z }];
    for (const direction of directions) {
      this.signal.throwIfAborted();
      const goal = { x: options.start.x + direction.x * 48,
        y: null, z: options.start.z + direction.z * 48 };
      try {
        // A margem de 16 aceita uma saída lateral segura, sem exigir um ponto
        // exato. O A* exige continuação e mantém todas as regras de piso/rampa.
        const path = await this.searchTerrainPath({ ...options, goal, goalDistance: 16,
          radius: SEARCH_RADIUS, maxNodes: EXTENDED_SEARCH_NODE_LIMIT });
        this.contourDirection = direction;
        this.log('contornando_montanha', { from: options.start, to: path.at(-1),
          direction, steps: path.length - 1, remaining: horizontalDistance(path.at(-1), options.goal) });
        return path;
      } catch (error) {
        if (error?.code !== 'RAILWAY_NO_ROUTE') throw error;
      }
    }
    return null;
  }

  terrainRailHeights(x, z, currentY, previous = null, descentGoalY = null) {
    const at = y => this.blockAt(new Vec3(x, y, z));
    // Sobre ar, desça somente para atender a um destino explicitamente mais baixo.
    // Líquido serve como apoio substituível, nunca como espaço para o carrinho.
    return [currentY - 1, currentY, currentY + 1].filter(y => {
      const floor = at(y - 1);
      return (this.isFloorCandidate(floor) || (AIR.has(floor?.name) && (y === currentY
        || (Number.isInteger(descentGoalY) && y === currentY - 1 && y >= descentGoalY))))
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

  async buildDescent(cells, saveCheckpoint) {
    if (!this.descentState) {
      this.descentState = { cells, phase: 'supports', cursor: cells.length - 1 };
      this.log('plano_descida', { cells, order: 'baixo_para_cima' });
      saveCheckpoint();
    }
    const state = this.descentState;
    if (state.phase === 'supports') {
      while (state.cursor >= 0) {
        this.signal.throwIfAborted();
        const cell = state.cells[state.cursor];
        this.pendingCell = cell;
        await this.buildCellWithRetry(cell, () => this.prepareDescentSupport(cell, state.cells[state.cursor + 1] ?? null));
        state.cursor--;
        saveCheckpoint();
      }
      state.phase = 'rails';
      state.cursor = state.cells.length - 1;
      saveCheckpoint();
    }
    while (state.cursor >= 0) {
      this.signal.throwIfAborted();
      const cell = state.cells[state.cursor];
      await this.buildCellWithRetry(cell);
      this.prebuiltDescent.set(cell.index, cell.position);
      state.cursor--;
      saveCheckpoint();
    }
    this.descentState = null;
    saveCheckpoint();
  }

  async prepareDescentSupport(cell, lowerCell) {
    const point = vec(cell.position);
    await this.positionForDescent(point, lowerCell?.position);
    this.validateFloor(point);
    for (let height = 2; height >= 0; height--) await this.clear(point.offset(0, height, 0));
    const support = point.offset(0, -1, 0);
    if (lowerCell) {
      // Dois pisos em diagonal não fornecem uma face de colocação entre si.
      // A pedra abaixo do piso superior conecta os degraus lateralmente.
      const connector = support.offset(0, -1, 0);
      if (!this.isSolid(this.blockAt(connector))) {
        await this.moveOffDescentBlock(connector, vec(lowerCell.position));
        await this.replace(connector, 'stone', { preferredReference: vec(lowerCell.position).offset(0, -1, 0) });
      }
    }
    if (!this.findReference(support) && !this.isSolid(this.blockAt(support))) {
      await this.buildDescentFoundation(support);
    }
    // Areia existente continua preservada sob trilhos comuns.
    const item = cell.powered ? 'redstone_block' : SAND.has(this.blockAt(support)?.name) ? null : 'stone';
    if (item && this.blockAt(support)?.name !== item) {
      await this.moveOffDescentBlock(support, lowerCell ? vec(lowerCell.position) : point);
      await this.prepareRailFloor(point, item, lowerCell?.position ?? null, 'descida');
    }
    this.log('apoio_descida_concluido', { index: cell.index, position: support, item: this.blockAt(support)?.name });
  }

  async positionForDescent(point, preferred = null) {
    const candidates = [
      ...(preferred ? [vec(preferred)] : []),
      ...DIRECTIONS.map(({ x, z }) => point.offset(x, 0, z)),
    ];
    for (const standing of candidates) {
      if (!supportsRail(this.blockAt(standing.offset(0, -1, 0)))
        || !this.isPassable(this.blockAt(standing)) || !this.isPassable(this.blockAt(standing.offset(0, 1, 0)))) continue;
      if (this.bot.entity.position.distanceTo(standing.offset(0.5, 0, 0.5)) > 0.5) {
        await this.teleportNear(standing, 'construcao_descida');
      }
      return;
    }
    // Não teleporte para dentro de blocos, líquidos ou sobre um vão sem piso.
    await this.moveNear(point);
  }

  overlapsBot(target) {
    const position = this.bot.entity.position;
    const halfWidth = (this.bot.entity.width ?? 0.6) / 2;
    const height = this.bot.entity.height ?? 1.8;
    return target.x < position.x + halfWidth && target.x + 1 > position.x - halfWidth
      && target.z < position.z + halfWidth && target.z + 1 > position.z - halfWidth
      && target.y < position.y + height && target.y + 1 > position.y;
  }

  async moveOffDescentBlock(target, standing) {
    if (!this.overlapsBot(target)) return;
    this.log('liberando_apoio_descida', { target, standing });
    await this.controller.moveToGoal(new goals.GoalBlock(standing.x, standing.y, standing.z), this.signal, {
      onStalled: reason => this.teleportNear(standing, reason),
    });
    this.signal.throwIfAborted();
  }

  async positionForFoundation(target) {
    this.signal.throwIfAborted();
    const candidates = DIRECTIONS.map(({ x, z }) => target.offset(x, 0, z))
      .filter(standing => this.isPassable(this.blockAt(standing))
        && this.isPassable(this.blockAt(standing.offset(0, 1, 0))));
    let standing = candidates.find(p => supportsRail(this.blockAt(p.offset(0, -1, 0))));
    if (!standing) {
      standing = candidates.find(p => AIR.has(this.blockAt(p.offset(0, -1, 0))?.name));
      if (!standing || !supportsRail(this.blockAt(target.offset(0, -1, 0)))
        || !this.isPassable(this.blockAt(target)) || !this.isPassable(this.blockAt(target.offset(0, 1, 0)))) {
        throw new RailwayError('não há posição livre com apoio para construir a fundação', 'RAILWAY_NO_SUPPORT');
      }
      // Fique centralizado sobre a base já pronta enquanto monta o andaime
      // lateral. Depois saia da coluna antes de acrescentar o próximo bloco.
      await this.ensureMaterial('stone');
      await this.teleportNear(target, 'centralizando_fundacao');
      const platform = standing.offset(0, -1, 0);
      await this.replace(platform, 'stone', { buildSupport: false,
        preferredReference: target.offset(0, -1, 0) });
      this.log('andaime_fundacao', { position: platform });
    }
    await this.teleportNear(standing, 'liberando_fundacao');
    if (this.overlapsBot(target)) throw new RailwayError('o bot ainda ocupa o bloco da fundação', 'RAILWAY_PLACEMENT');
  }

  async buildDescentFoundation(support) {
    const column = [];
    const minY = this.bot.game?.minY ?? -64;
    for (let y = support.y - 1; y >= minY; y--) {
      this.signal.throwIfAborted();
      const position = new Vec3(support.x, y, support.z);
      const block = this.blockAt(position);
      if (!block) throw new RailwayError('a base da descida ainda não está carregada', 'RAILWAY_NO_SUPPORT');
      if (this.isSolid(block)) {
        for (const point of column.reverse()) {
          await this.replace(point, 'stone', { buildSupport: false,
            beforePlace: () => this.positionForFoundation(point) });
        }
        return;
      }
      if (!AIR.has(block.name) && !LIQUID.has(block.name)) break;
      column.push(position);
    }
    throw new RailwayError('não encontrei uma base carregada para sustentar a descida', 'RAILWAY_NO_SUPPORT');
  }

  async buildCellWithRetry(cell, operation = () => this.buildCell(cell)) {
    try {
      return await operation();
    } catch (error) {
      this.signal.throwIfAborted();
      if (error.code !== 'RAILWAY_TERRAIN_CHANGED') throw error;
      this.log('aguardando_terreno', { position: cell.position, waitMs: 10000 });
      await delay(10000, undefined, { signal: this.signal });
      try {
        return await operation();
      } catch (retryError) {
        this.signal.throwIfAborted();
        if (retryError.code !== 'RAILWAY_TERRAIN_CHANGED'
          || !RAILS.has(this.blockAt(vec(cell.position))?.name)) throw retryError;
        this.completedRailColumns.set(columnKey(cell.position), cell.position.y);
        this.lastCompleted = { index: cell.index, position: cell.position };
        this.pendingCell = null;
        this.log('trilho_preservado', this.lastCompleted);
      }
    }
  }

  async buildCell(cell) {
    const point = vec(cell.position);
    this.pendingCell = { index: cell.index, position: cell.position, powered: cell.powered };
    this.completedRailColumns ??= new Map();
    if (cell.previous) this.completedRailColumns.set(columnKey(cell.previous), cell.previous.y);
    if (cell.position.tunnel) await this.openTunnelCell(cell);
    this.validateFloor(point);
    await this.moveNear(point);
    this.validateFloor(point);
    for (let height = 2; height >= 0; height--) await this.clear(point.offset(0, height, 0));

    const support = point.offset(0, -1, 0);
    const supportBlock = this.blockAt(support);
    this.validateFloor(point);
    const liquidSupport = LIQUID.has(supportBlock?.name);
    const unstableSupport = supportBlock?.name === 'gravel'
      || supportBlock?.name.endsWith('_concrete_powder');
    let usedStoneSupport = !SAND.has(supportBlock?.name)
      && (liquidSupport || unstableSupport || !supportsRail(supportBlock));
    const supportItem = cell.powered ? 'redstone_block' : (usedStoneSupport ? 'stone' : null);
    if (supportItem && supportBlock?.name !== supportItem) {
      await this.prepareRailFloor(point, supportItem, cell.previous,
        AIR.has(supportBlock?.name) ? 'sem_apoio' : liquidSupport ? 'liquido' : unstableSupport ? 'gravidade' : !supportsRail(supportBlock) ? 'apoio_incompativel' : 'alimentacao');
    }

    const railItem = cell.powered ? 'powered_rail' : 'rail';
    try {
      await this.replace(point, railItem);
    } catch (error) {
      // Formas de colisão não representam todas as regras do servidor/mods.
      // Se o piso aparentemente válido ainda for recusado, normalize-o uma vez.
      if (error.code !== 'RAILWAY_PLACEMENT' || supportItem
        || SAND.has(this.blockAt(support)?.name)
        || ['stone', 'redstone_block'].includes(this.blockAt(support)?.name)) throw error;
      await this.prepareRailFloor(point, 'stone', cell.previous, 'apoio_recusado');
      usedStoneSupport = true;
      await this.replace(point, railItem);
    }
    this.completedRailColumns.set(columnKey(point), point.y);
    this.lastCompleted = { index: cell.index, position: cell.position };
    this.pendingCell = null;
    this.log('bloco_concluido', { index: cell.index, position: cell.position,
      deltaY: cell.previous ? point.y - cell.previous.y : 0, powered: cell.powered,
      floor: this.blockAt(support)?.name, botPosition: this.bot.entity.position });
    return { usedStoneSupport };
  }

  async prepareRailFloor(point, supportItem, previous, reason) {
    const support = point.offset(0, -1, 0);
    const previousSupport = previous ? vec(previous).offset(0, -1, 0) : null;
    const supportBlock = this.blockAt(support);
    this.log('trocando_piso', { position: support, from: supportBlock?.name, to: supportItem, reason });
    await this.ensureMaterial(supportItem);
    const previousRail = this.isSolid(supportBlock) && previous?.y === point.y - 1
      ? this.blockAt(vec(previous)) : null;
    const restoreRamp = RAILS.has(previousRail?.name);
    if (restoreRamp) {
      await this.ensureMaterial(previousRail.name);
      if (!this.bot.canDigBlock(previousRail)) throw new RailwayError(`não posso remover ${previousRail.name} em ${format(previousRail.position)}`);
    }
    const existingRail = this.blockAt(point);
    // Retire o trilho antes de trocar o piso: o servidor pode destruir o
    // trilho pela falta de apoio depois que o cliente já o deu por pronto.
    if (RAILS.has(existingRail?.name)) {
      if (!this.bot.canDigBlock(existingRail)) throw new RailwayError(`não posso remover ${existingRail.name} em ${format(point)}`);
      await this.dig(existingRail);
    }
    // A rampa anterior depende também da face do piso mais alto. Retire-a
    // antes da troca para evitar sua destruição tardia pelo servidor.
    if (restoreRamp) await this.dig(previousRail);
    await this.replace(support, supportItem, { preferredReference: previousSupport });
    if (restoreRamp) {
      for (let attempt = 1; attempt <= PLACE_ATTEMPTS; attempt++) {
        // A confirmação do apoio pode chegar antes da destruição agendada
        // da rampa. Espere os updates e confirme também depois de repô-la.
        await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
        this.log('repondo_rampa', { position: previousRail.position, item: previousRail.name, support, attempt });
        await this.replace(previousRail.position, previousRail.name);
        await delay(PLACE_RETRY_MS, undefined, { signal: this.signal });
        if (this.blockAt(previousRail.position)?.name === previousRail.name) break;
        if (attempt === PLACE_ATTEMPTS) {
          throw new RailwayError(`a rampa em ${format(previousRail.position)} não permaneceu apoiada após trocar o piso`, 'RAILWAY_PLACEMENT');
        }
      }
    }
  }

  validateFloor(point) {
    const support = this.blockAt(point.offset(0, -1, 0));
    if (!this.isFloorCandidate(support) && !AIR.has(support?.name)) {
      throw new RailwayError(`o piso em ${format(point.offset(0, -1, 0))} não está carregado ou não pode receber apoio`, 'RAILWAY_TERRAIN_CHANGED');
    }
    if (!this.isPassable(this.blockAt(point)) || !this.hasClearance(point.x, point.z, point.y)) {
      throw new RailwayError(`o corredor em ${format(point)} está bloqueado ou contém líquido; o trilho precisa ficar acima da superfície`, 'RAILWAY_TERRAIN_CHANGED');
    }
  }

  async moveNear(point) {
    if (this.bot.entity.position.distanceTo(point) <= 2.5) return;
    this.log('aproximando', { target: point, botPosition: this.bot.entity.position });
    for (const waypoint of navigationWaypoints(this.bot.entity.position, point)) {
      this.signal.throwIfAborted();
      this.log('checkpoint_navegacao', { target: waypoint, destination: point });
      await this.controller.moveToGoal(new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, 2), this.signal, {
        onStalled: reason => this.teleportNear(waypoint, reason),
      });
    }
  }

  async teleportNear(point, reason) {
    this.signal.throwIfAborted();
    const destination = vec(integerPosition(point, 'destino do teleporte')).offset(0.5, 0, 0.5);
    this.log('teleportando', { target: destination, reason });
    this.bot.chat(`/tp ${this.bot.username} ${destination.x} ${destination.y} ${destination.z}`);
    const started = performance.now();
    while (this.bot.entity.position.distanceTo(destination) > 0.2) {
      this.signal.throwIfAborted();
      if (performance.now() - started > 5000) {
        throw new RailwayError('o servidor não confirmou o teleporte; confira a permissão para /tp', 'RAILWAY_TELEPORT_FAILED');
      }
      await delay(100, undefined, { signal: this.signal });
    }
    this.signal.throwIfAborted();
  }

  blockAt(point) {
    if (!this.planningBlocks) return this.bot.blockAt(point);
    const key = `${point.x},${point.y},${point.z}`;
    if (!this.planningBlocks.has(key)) this.planningBlocks.set(key, this.bot.blockAt(point));
    return this.planningBlocks.get(key);
  }
  isSolid(block) { return Boolean(block && block.boundingBox !== 'empty' && !LIQUID.has(block.name)); }

  isFloorCandidate(block) {
    return Boolean(block && !AIR.has(block.name) && !RAILS.has(block.name)
      && (this.isSolid(block) || LIQUID.has(block.name) || block.shapes?.length));
  }

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

  async replace(point, item, { preferredReference = null, buildSupport = true, beforePlace = null } = {}) {
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
      if (['stone', 'redstone_block'].includes(item) && !this.findReference(point, preferredReference)) {
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
        await beforePlace?.();
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
          if (!beforePlace) await this.moveNear(point);
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
