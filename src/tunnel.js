import { setTimeout as delay } from 'node:timers/promises';
import vec3Package from 'vec3';

const { Vec3 } = vec3Package;
const AXES = [0, 1, 2];
const SECTION_LENGTH = 32;
const CONFIRMATION_MS = 8000;
const WORLD_LIMIT = 29999984;
const MODES = ['survival', 'creative', 'adventure', 'spectator'];

function box(a, b) {
  return { min: a.map((n, axis) => Math.min(n, b[axis])), max: a.map((n, axis) => Math.max(n, b[axis])) };
}

function intersection(a, b) {
  const min = a.min.map((n, axis) => Math.max(n, b.min[axis]));
  const max = a.max.map((n, axis) => Math.min(n, b.max[axis]));
  return min.every((n, axis) => n <= max[axis]) ? { min, max } : null;
}

function subtract(region, cut) {
  const overlap = intersection(region, cut);
  if (!overlap) return [region];
  const parts = [];
  const rest = box(region.min, region.max);
  for (const axis of AXES) {
    if (rest.min[axis] < overlap.min[axis]) {
      const part = box(rest.min, rest.max);
      part.max[axis] = overlap.min[axis] - 1;
      parts.push(part);
      rest.min[axis] = overlap.min[axis];
    }
    if (rest.max[axis] > overlap.max[axis]) {
      const part = box(rest.min, rest.max);
      part.min[axis] = overlap.max[axis] + 1;
      parts.push(part);
      rest.max[axis] = overlap.max[axis];
    }
  }
  return parts;
}

export function planTunnel({ start, end }, config, { minY, height }) {
  const radius = (config.width - 1) / 2;
  const groups = [];
  const addGroup = (first, last, axis) => {
    const interior = box(first, last);
    const horizontal = axis !== 1;
    const cross = axis === 0 ? 2 : 0;
    const outer = box(interior.min, interior.max);
    outer.min[1]--;
    interior.max[1] += config.height - 1;
    outer.max[1] = interior.max[1] + Number(horizontal);
    const expanded = axis === null || !horizontal ? [0, 2] : [cross];
    for (const direction of expanded) {
      interior.min[direction] -= radius;
      interior.max[direction] += radius;
      outer.min[direction] = interior.min[direction] - 1;
      outer.max[direction] = interior.max[direction] + 1;
    }
    const floor = box(interior.min, interior.max);
    floor.min[1] = floor.max[1] = outer.min[1];
    const center = box(floor.min, floor.max);
    center.min[cross] = center.max[cross] = first[cross];
    groups.push({ axis, descending: axis !== null && first[axis] > last[axis], interior, outer, floor, center });
  };

  const corner = [end[0], start[1], start[2]];
  const landing = [end[0], start[1], end[2]];
  const alongX = corner[0] !== start[0];
  const alongZ = landing[2] !== corner[2];
  const vertical = end[1] !== landing[1];
  if (alongX || (!alongZ && !vertical)) addGroup(start, corner, 0);
  if (alongX && alongZ) addGroup(corner, corner, null);
  if (alongZ) addGroup(corner, landing, 2);
  if (vertical) addGroup(landing, end, 1);

  // A prioridade preserva passagens nas junções e a faixa central no piso.
  const layers = [
    ['interior', 'air'],
    ['center', config.centerFloorBlock],
    ['floor', config.sideFloorBlock],
    ['outer', config.wallBlock],
  ];
  const occupied = [];
  for (const group of groups) {
    const { min, max } = group.outer;
    if (min[1] < minY || max[1] >= minY + height ||
        [min[0], min[2], max[0], max[2]].some(n => Math.abs(n) > WORLD_LIMIT)) {
      throw new Error('o túnel, incluindo piso, paredes e teto, ultrapassa os limites da dimensão');
    }
    group.fills = [];
  }
  for (const [layer, block] of layers) {
    for (const group of groups) {
      const region = group[layer];
      const parts = occupied.reduce((remaining, cut) => remaining.flatMap(part => subtract(part, cut)), [region]);
      // Revestir antes de abrir o interior reduz a entrada de água e areia.
      group.fills.unshift(...parts.map(part => ({ ...part, block })));
      occupied.push(region);
    }
  }
  return groups;
}

export function* tunnelSections(groups) {
  for (const { axis, descending, outer, fills } of groups) {
    const stepAxis = axis ?? 0;
    const start = descending ? outer.max[stepAxis] : outer.min[stepAxis];
    const end = descending ? outer.min[stepAxis] : outer.max[stepAxis];
    const direction = descending ? -1 : 1;
    for (let from = start; direction * (end - from) >= 0; from += direction * SECTION_LENGTH) {
      const to = from + direction * Math.min(SECTION_LENGTH - 1, Math.abs(end - from));
      const section = box(outer.min, outer.max);
      section.min[stepAxis] = Math.min(from, to);
      section.max[stepAxis] = Math.max(from, to);
      const commands = fills.flatMap(fill => {
        const region = intersection(section, fill);
        return region ? [{ ...region, block: fill.block }] : [];
      });
      if (commands.length) yield { ...section, commands };
    }
  }
}

function blockCommand({ min, max, block }) {
  const id = `minecraft:${block}`;
  if (min.every((n, axis) => n === max[axis])) return `/setblock ${min.join(' ')} ${id}`;
  return `/fill ${min.join(' ')} ${max.join(' ')} ${id}`;
}

function teleportCommand(point) {
  return `/tp ${point.map(n => n.toFixed(6)).join(' ')}`;
}

function sameBlocks(bot, { min, max, block }) {
  const position = new Vec3();
  for (let x = min[0]; x <= max[0]; x++) {
    for (let z = min[2]; z <= max[2]; z++) {
      for (let y = min[1]; y <= max[1]; y++) {
        position.set(x, y, z);
        if (bot.blockAt(position, false)?.name !== block) return false;
      }
    }
  }
  return true;
}

function chunksLoaded(bot, { min, max }) {
  for (let x = min[0] >> 4; x <= max[0] >> 4; x++) {
    for (let z = min[2] >> 4; z <= max[2] >> 4; z++) {
      if (!bot.world.getColumn(x, z)) return false;
    }
  }
  return true;
}

export class TunnelTask {
  constructor(controller, signal) {
    this.controller = controller;
    this.bot = controller.bot;
    this.signal = signal;
  }

  get mode() {
    const mode = this.bot.game.gameMode;
    return typeof mode === 'number' ? MODES[mode] : mode;
  }

  async confirm(test, failure) {
    const deadline = performance.now() + CONFIRMATION_MS;
    while (true) {
      this.signal.throwIfAborted();
      if (test()) return;
      if (performance.now() >= deadline) throw new Error(failure);
      await delay(50, undefined, { signal: this.signal });
    }
  }

  async command(text, beforeSend) {
    await this.controller.chat.command(text, { signal: this.signal, beforeSend });
  }

  at(point) {
    const { x, y, z } = this.bot.entity.position;
    return [x, y, z].every((n, axis) => Math.abs(n - point[axis]) < 0.01);
  }

  async teleport(point) {
    if (this.at(point)) return;
    await this.command(teleportCommand(point), () => { this.moved = true; });
    await this.confirm(() => this.at(point), 'o servidor não confirmou /tp');
  }

  stop() {
    if (this.controller.tunnelTask !== this) return;
    this.controller.tunnelTask = null;
    this.bot.physicsEnabled = this.originalPhysics;
    if (this.controller.closed) return;
    // Envie a restauração antes que outra tarefa possa alterar posição ou modo.
    try {
      if (this.moved) this.bot.chat(teleportCommand(this.originalPosition));
      if (this.changedMode) this.bot.chat(`/gamemode ${this.originalMode}`);
    } catch { /* A conexão pode ter sido encerrada. */ }
  }

  async run(action) {
    const config = this.controller.manager.config.tunnel;
    const groups = planTunnel(action, config, this.bot.game);
    for (const block of new Set(groups.flatMap(group => group.fills.map(fill => fill.block)))) {
      if (!Object.hasOwn(this.bot.registry.blocksByName, block)) throw new Error(`bloco de túnel desconhecido nesta versão: ${block}`);
    }
    this.originalMode = this.mode;
    if (!MODES.includes(this.originalMode)) throw new Error('não foi possível identificar o modo de jogo do bot');
    const { x, y, z } = this.bot.entity.position;
    this.originalPosition = [x, y, z];
    this.originalPhysics = this.bot.physicsEnabled;
    this.controller.tunnelTask = this;
    this.bot.physicsEnabled = false;
    const cancel = () => this.stop();
    this.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (this.originalMode !== 'spectator') {
        await this.command('/gamemode spectator', () => { this.changedMode = true; });
        await this.confirm(() => this.mode === 'spectator', 'o servidor não confirmou /gamemode spectator');
      }
      for (const section of tunnelSections(groups)) {
        this.signal.throwIfAborted();
        const point = section.min.map((n, axis) => Math.floor((n + section.max[axis]) / 2));
        this.controller.task = `construindo túnel perto de ${point.join(', ')}`;
        await this.teleport([point[0] + 0.5, point[1], point[2] + 0.5]);
        await this.confirm(() => chunksLoaded(this.bot, section), 'os chunks do trecho não carregaram');
        for (const fill of section.commands) {
          if (this.mode !== 'spectator') throw new Error('o bot saiu do modo espectador durante o túnel');
          if (sameBlocks(this.bot, fill)) continue;
          const command = blockCommand(fill);
          await this.command(command);
          await this.confirm(() => sameBlocks(this.bot, fill), `o servidor não confirmou ${command}; confira permissões, limites e o bloco escolhido`);
        }
      }
      if (this.moved) {
        await this.teleport(this.originalPosition);
        this.moved = false;
      }
      if (this.changedMode) {
        await this.command(`/gamemode ${this.originalMode}`);
        await this.confirm(() => this.mode === this.originalMode, 'o servidor não confirmou a restauração do modo de jogo');
        this.changedMode = false;
      }
    } finally {
      this.signal.removeEventListener('abort', cancel);
      this.stop();
    }
  }
}
