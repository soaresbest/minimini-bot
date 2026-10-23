import { setTimeout as delay } from 'node:timers/promises';
import { PLAYER_NAME } from './commands.js';

export const CAMERA_DURATION_MS = 700;
const FRAME_MS = 50;
const CONFIRMATION_MS = 10000;
const degrees = radians => radians * 180 / Math.PI;
export const wrapYaw = yaw => ((yaw + 180) % 360 + 360) % 360 - 180;
const finitePosition = p => p && [p.x, p.y, p.z].every(Number.isFinite);

export function travelRotation(from, to) {
  if (!finitePosition(from) || !finitePosition(to)) return null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 0.002 || Math.hypot(horizontal, dy) > 8) return null;
  return { yaw: wrapYaw(degrees(Math.atan2(-dx, dz))), pitch: -degrees(Math.atan2(dy, horizontal)) };
}

// Uma direção estável é alcançada em 700 ms. Novos alvos partem da
// interpolação atual, sem saltos e pelo caminho angular mais curto.
export class CameraInterpolation {
  constructor(rotation, now) {
    this.from = { ...rotation };
    this.target = { ...rotation };
    this.started = now;
  }
  at(now) {
    const t = Math.max(0, Math.min(1, (now - this.started) / CAMERA_DURATION_MS));
    const eased = t * t * (3 - 2 * t);
    return {
      yaw: wrapYaw(this.from.yaw + wrapYaw(this.target.yaw - this.from.yaw) * eased),
      pitch: this.from.pitch + (this.target.pitch - this.from.pitch) * eased,
    };
  }
  aim(rotation, now) {
    if (Math.abs(wrapYaw(rotation.yaw - this.target.yaw)) < 0.5 && Math.abs(rotation.pitch - this.target.pitch) < 0.5) return;
    this.from = this.at(now);
    this.target = { ...rotation };
    this.started = now;
  }
}

export function cameraCommand(player, rotation) {
  if (!PLAYER_NAME.test(player) || !Number.isFinite(rotation.yaw) || !Number.isFinite(rotation.pitch)) throw new Error('Câmera ou jogador inválido.');
  const yaw = wrapYaw(rotation.yaw).toFixed(3);
  const pitch = Math.max(-90, Math.min(90, rotation.pitch)).toFixed(3);
  // A condição é revalidada no servidor: nem latência nem desmontagem
  // entre a leitura e o envio podem girar a câmera de alguém a pé.
  return `/execute as ${player} on vehicle if entity @s[type=minecraft:minecart] run rotate ${player} ${yaw} ${pitch}`;
}

export class CartCamera {
  constructor(controller, player, signal) {
    this.controller = controller;
    this.bot = controller.bot;
    this.player = player;
    this.signal = signal;
    this.listeners = [];
    this.vehicles = new Map();
    this.cartPositions = new Map();
    this.cameraId = null;
    this.stopped = false;
  }
  listen(emitter, event, fn) {
    emitter.on(event, fn);
    this.listeners.push([emitter, event, fn]);
  }
  check() {
    this.signal.throwIfAborted();
    if (this.stopped || this.controller.closed) throw new Error('Acompanhamento encerrado');
    return this.controller.ensurePlayer(this.player);
  }
  async confirm(predicate, message) {
    const deadline = performance.now() + CONFIRMATION_MS;
    while (!predicate()) {
      this.check();
      if (performance.now() >= deadline) throw new Error(message);
      await delay(FRAME_MS, undefined, { signal: this.signal });
    }
    this.check();
  }
  reset() {
    this.previous = null;
    this.interpolation = null;
    this.lastMotion = null;
  }
  async run() {
    this.check();
    if (!PLAYER_NAME.test(this.player) || !PLAYER_NAME.test(this.bot.username)) throw new Error('Nome de jogador inválido.');
    if (!((this.bot.protocolVersion ?? this.bot.registry?.version?.version) >= 768)) throw new Error('cartlook requer Minecraft Java 1.21.2 ou posterior, com /rotate');
    const mode = this.bot.game.gameMode;
    this.originalMode = typeof mode === 'number' ? ['survival', 'creative', 'adventure', 'spectator'][mode] : mode;
    if (!['survival', 'creative', 'adventure', 'spectator'].includes(this.originalMode)) throw new Error('Não foi possível identificar o modo de jogo do bot');
    this.originalPhysics = this.bot.physicsEnabled;
    this.controller.cartCamera = this;
    this.bot.physicsEnabled = false;
    const cancel = () => this.stop();
    this.signal.addEventListener('abort', cancel, { once: true });
    for (const entity of Object.values(this.bot.entities)) {
      if (entity.vehicle) this.vehicles.set(entity.id, entity.vehicle.id);
    }
    this.listen(this.bot._client, 'set_passengers', ({ entityId, passengers }) => {
      for (const [passenger, vehicle] of this.vehicles) if (vehicle === entityId) this.vehicles.delete(passenger);
      for (const passenger of passengers) this.vehicles.set(passenger, entityId);
    });
    this.listen(this.bot._client, 'camera', ({ cameraId }) => { this.cameraId = cameraId; });
    this.listen(this.bot._client, 'respawn', () => {
      this.vehicles.clear();
      this.cartPositions.clear();
      this.cameraId = null;
      this.reset();
    });
    // O pacote experimental de carrinhos ainda não atualiza entity.position
    // na versão instalada do Mineflayer.
    this.listen(this.bot._client, 'move_minecart', ({ entityId, steps }) => {
      const position = steps.at(-1)?.position;
      if (finitePosition(position)) this.cartPositions.set(entityId, { ...position });
    });
    this.listen(this.bot, 'entityGone', entity => {
      this.cartPositions.delete(entity.id);
      this.vehicles.delete(entity.id);
      for (const [passenger, vehicle] of this.vehicles) if (vehicle === entity.id) this.vehicles.delete(passenger);
    });
    try {
      this.controller.task = `preparando câmera do carrinho de ${this.player}`;
      if (this.originalMode !== 'spectator') {
        this.changedMode = true;
        await this.controller.chat.command(`/gamemode spectator ${this.bot.username}`, { signal: this.signal, beforeSend: () => this.check() });
      }
      await this.confirm(() => this.bot.game.gameMode === 'spectator' || this.bot.game.gameMode === 3,
        'O servidor não confirmou o modo espectador; verifique a permissão de /gamemode');
      this.requestedSpectate = true;
      await this.controller.chat.command(`/spectate ${this.player} ${this.bot.username}`, { signal: this.signal, beforeSend: () => this.check() });
      await this.confirm(() => this.cameraId != null && this.cameraId === this.check().entity?.id,
        'O servidor não confirmou o jogador espectado; verifique a permissão de /spectate');
      this.controller.task = `câmera do carrinho de ${this.player}`;
      this.controller.say('Câmera do carrinho ativa, com transições de 700 ms. Requer /rotate; use stop para encerrar.');
      let missingSince = null;
      while (true) {
        const player = this.check();
        const now = performance.now();
        if (!['spectator', 3].includes(this.bot.game.gameMode)) throw new Error('O bot saiu do modo espectador');
        if (!player.entity || this.cameraId !== player.entity.id) {
          this.reset();
          missingSince ??= now;
          if (now - missingSince >= CONFIRMATION_MS) throw new Error('O acompanhamento do jogador foi perdido; execute cartlook novamente');
        } else {
          missingSince = null;
          this.frame(player.entity, now);
        }
        // Fila de chat (1,1 s) não comporta animação. Apenas este comando fixo
        // usa 20 Hz, sem backlog nem rajadas de compensação após atrasos.
        await delay(FRAME_MS, undefined, { signal: this.signal });
      }
    } finally {
      this.signal.removeEventListener('abort', cancel);
      this.stop();
    }
  }
  frame(player, now) {
    const vehicle = this.bot.entities[this.vehicles.get(player.id)];
    const position = this.cartPositions.get(vehicle?.id) ?? vehicle?.position;
    // Enquanto especta, a posição do bot acompanha a entidade observada.
    // Desativa a gravidade local e evita manter coordenadas antigas no cliente.
    const observedPosition = vehicle?.name === 'minecart' && finitePosition(position) ? position : player.position;
    if (finitePosition(observedPosition)) Object.assign(this.bot.entity.position, observedPosition);
    if (vehicle?.name !== 'minecart' || !finitePosition(position)) { this.reset(); return; }
    if (!this.previous || this.previous.vehicle !== vehicle.id || now - this.previous.time > 1000) {
      this.reset();
      this.previous = { ...position, vehicle: vehicle.id, time: now };
      return;
    }
    const distance = Math.hypot(position.x - this.previous.x, position.y - this.previous.y, position.z - this.previous.z);
    if (distance > 8) { this.reset(); return; }
    const direction = travelRotation(this.previous, position);
    this.previous = { ...position, vehicle: vehicle.id, time: now };
    if (direction) {
      this.lastMotion = now;
      if (!this.interpolation) {
        if (![player.yaw, player.pitch].every(Number.isFinite)) return;
        this.interpolation = new CameraInterpolation({ yaw: wrapYaw(180 - degrees(player.yaw)), pitch: -degrees(player.pitch) }, now);
      }
      this.interpolation.aim(direction, now);
    }
    if (this.interpolation) {
      this.check();
      this.bot.chat(cameraCommand(this.player, this.interpolation.at(now)));
      if (now - this.lastMotion >= CAMERA_DURATION_MS) this.interpolation = null;
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn);
    this.listeners.length = 0;
    if (this.controller.cartCamera !== this) return;
    this.controller.cartCamera = null;
    this.bot.physicsEnabled = this.originalPhysics;
    // Limpeza síncrona: termina antes de outra tarefa começar e não deixa
    // comandos atrasados desfazerem o espectador de uma tarefa nova.
    if (!this.controller.closed) {
      try {
        if (this.requestedSpectate) this.bot.chat('/spectate');
        if (this.changedMode) this.bot.chat(`/gamemode ${this.originalMode} ${this.bot.username}`);
      } catch { /* conexão encerrada durante o cancelamento */ }
    }
  }
}
