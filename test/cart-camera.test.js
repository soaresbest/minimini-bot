import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CartCamera, CameraInterpolation, travelRotation, cameraCommand, wrapYaw } from '../src/cart-camera.js';
import { parseCommand } from '../src/commands.js';
import { validatePlan } from '../src/ai/planner.js';

const origin = { x: 0, y: 64, z: 0 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function harness({ mode = 'survival', acknowledge = true } = {}) {
  const work = new AbortController();
  const bot = new EventEmitter();
  const cart = { id: 3, name: 'minecart', position: { ...origin } };
  const player = { id: 2, yaw: Math.PI, pitch: 0, position: { ...origin }, vehicle: cart };
  const sent = [];
  Object.assign(bot, {
    username: 'Bot1', protocolVersion: 775, physicsEnabled: true,
    _client: new EventEmitter(), game: { gameMode: mode },
    entity: { id: 1, position: { x: 1000, y: 0, z: 1000 } }, entities: { 2: player, 3: cart },
    chat(text) {
      sent.push({ text, time: performance.now() });
      if (acknowledge && text === '/gamemode spectator Bot1') bot.game.gameMode = 'spectator';
      if (acknowledge && text === '/spectate Steve Bot1') bot._client.emit('camera', { cameraId: 2 });
    },
  });
  let connected = true;
  const controller = {
    bot, closed: false, task: 'parado', say() {},
    ensurePlayer() { if (!connected) throw new Error('O jogador Steve não está conectado.'); return { entity: player }; },
    chat: { async command(text, { signal, beforeSend }) { signal.throwIfAborted(); beforeSend(); bot.chat(text); } },
  };
  const camera = new CartCamera(controller, 'Steve', work.signal);
  const running = camera.run();
  // A asserção de rejeição pode ocorrer depois do evento que a causou.
  running.catch(() => {});
  return { work, bot, cart, player, sent, controller, camera, running, disconnect: () => { connected = false; } };
}
async function ready(h) {
  for (let attempt = 0; !h.controller.task.startsWith('câmera do carrinho'); attempt++) {
    assert.ok(attempt < 100, 'confirmar espectador');
    await delay(5);
  }
}
async function stop(h) {
  h.work.abort();
  await assert.rejects(h.running, { name: 'AbortError' });
}
const rotations = h => h.sent.filter(({ text }) => text.includes(' run rotate '));

test('cartlook valida nomes e permanece fora da lista permitida para planos de IA', () => {
  assert.deepEqual(parseCommand('CaRtLoOk(Steve)'), { type: 'cartlook', player: 'Steve' });
  for (const text of ['cartlook()', 'cartlook(@a)', 'cartlook(Steve,true)', 'cartlook(Steve;kill)', 'cartlook(nome_muito_grande1)']) assert.equal(parseCommand(text), null);
  assert.throws(() => validatePlan({ reply: 'Câmera.', actions: [{ type: 'cartlook', player: 'Steve' }] }));
  assert.throws(() => cameraCommand('@a', { yaw: 0, pitch: 0 }));
  assert.throws(() => cameraCommand('Steve', { yaw: NaN, pitch: 0 }));
  assert.equal(cameraCommand('Steve', { yaw: 270, pitch: 100 }), '/execute as Steve on vehicle if entity @s[type=minecraft:minecart] run rotate Steve -90.000 90.000');
});

test('direção real cobre pontos cardeais, diagonal, subida, descida e inversão', () => {
  for (const [x, y, z, yaw, pitch] of [[0, 0, 1, 0, 0], [1, 0, 0, -90, 0], [0, 0, -1, -180, 0], [-1, 0, 0, 90, 0], [1, 0, 1, -45, 0], [1, 1, 0, -90, -45], [-1, -1, 0, 90, 45]]) {
    const rotation = travelRotation(origin, { x, y: 64 + y, z });
    near(rotation.yaw, yaw); near(rotation.pitch, pitch);
  }
  for (const point of [origin, { x: 0, y: 65, z: 0 }, { x: 1000, y: 64, z: 0 }, { x: NaN, y: 64, z: 0 }]) assert.equal(travelRotation(origin, point), null);
});

test('interpolação leva 700 ms, cruza ±180 pelo menor arco e retoma sem salto', () => {
  const interpolation = new CameraInterpolation({ yaw: 179, pitch: 0 }, 0);
  interpolation.aim({ yaw: -179, pitch: -40 }, 0);
  assert.deepEqual(interpolation.at(0), { yaw: 179, pitch: 0 });
  near(interpolation.at(350).yaw, -180); near(interpolation.at(350).pitch, -20);
  assert.deepEqual(interpolation.at(700), { yaw: -179, pitch: -40 });
  const before = interpolation.at(400);
  interpolation.aim({ yaw: 90, pitch: 45 }, 400);
  assert.deepEqual(interpolation.at(400), before);
  near(interpolation.at(1100).yaw, 90); near(interpolation.at(1100).pitch, 45);
  const stable = new CameraInterpolation({ yaw: 0, pitch: 0 }, 0);
  stable.aim({ yaw: 90, pitch: 45 }, 0);
  for (let now = 50; now < 700; now += 50) stable.aim({ yaw: 90, pitch: 45 }, now);
  assert.deepEqual(stable.at(700), { yaw: 90, pitch: 45 });
  near(wrapYaw(721), 1);
});

test('especta jogador distante, segue o carrinho e restaura o estado ao cancelar', async () => {
  const h = harness();
  await ready(h);
  assert.deepEqual(h.sent.slice(0, 2).map(entry => entry.text), ['/gamemode spectator Bot1', '/spectate Steve Bot1']);
  assert.equal(h.bot.physicsEnabled, false);
  h.camera.frame(h.player, 0);
  for (let time = 50; time <= 750; time += 50) {
    h.cart.position.x += 0.2; h.cart.position.y += 0.2;
    h.camera.frame(h.player, time);
  }
  assert.ok(rotations(h).at(-1).text.endsWith('-90.000 -45.000'));
  assert.deepEqual(h.bot.entity.position, h.cart.position);
  assert.deepEqual(h.player.position, origin, 'passageiro sem pacotes de posição próprios');
  await stop(h);
  assert.deepEqual(h.sent.slice(-2).map(entry => entry.text), ['/spectate', '/gamemode survival Bot1']);
  assert.equal(h.bot.physicsEnabled, true);
  assert.equal(h.controller.cartCamera, null);
  assert.equal(h.bot._client.eventNames().length, 0);
  assert.equal(h.bot.listenerCount('entityGone'), 0);
  const count = h.sent.length;
  await delay(80);
  assert.equal(h.sent.length, count, 'nenhum comando atrasado após stop');
});

test('desmontagem cancela rotação mesmo quando Mineflayer mantém vehicle antigo; remontagem funciona', async () => {
  const h = harness({ mode: 'spectator' }); await ready(h);
  h.camera.frame(h.player, 0);
  h.cart.position.z++; h.camera.frame(h.player, 50);
  const count = rotations(h).length;
  h.bot._client.emit('set_passengers', { entityId: 3, passengers: [] });
  h.cart.position.z++; h.camera.frame(h.player, 100);
  assert.equal(rotations(h).length, count);
  assert.equal(h.player.vehicle, h.cart, 'simula o vínculo desatualizado da dependência');
  h.bot._client.emit('set_passengers', { entityId: 3, passengers: [2] });
  h.camera.frame(h.player, 150);
  h.cart.position.z++; h.camera.frame(h.player, 200);
  assert.equal(rotations(h).length, count + 1);
  h.cart.name = 'boat'; h.camera.frame(h.player, 250);
  assert.equal(rotations(h).length, count + 1);
  await stop(h);
  assert.ok(!h.sent.some(({ text }) => text.startsWith('/gamemode')));
});

test('parada conclui interpolação e suspende envios; teleporte e perda de entidade não causam giros', async () => {
  const h = harness(); await ready(h);
  h.camera.frame(h.player, 0);
  h.cart.position.x++; h.camera.frame(h.player, 50);
  h.camera.frame(h.player, 751);
  assert.ok(rotations(h).at(-1).text.endsWith('-90.000 0.000'));
  const count = rotations(h).length;
  h.camera.frame(h.player, 801);
  assert.equal(rotations(h).length, count);
  h.cart.position.x += 100; h.camera.frame(h.player, 851);
  assert.equal(rotations(h).length, count);
  h.bot.emit('entityGone', h.cart);
  h.camera.frame(h.player, 901);
  assert.equal(rotations(h).length, count);
  await stop(h);
});

test('pacotes experimentais de carrinho alimentam a posição e respawn limpa amostras', async () => {
  const h = harness(); await ready(h);
  h.camera.frame(h.player, 0);
  h.bot._client.emit('move_minecart', { entityId: 3, steps: [{ position: { x: 1, y: 65, z: 0 } }] });
  h.camera.frame(h.player, 50);
  assert.deepEqual(h.bot.entity.position, { x: 1, y: 65, z: 0 });
  assert.deepEqual(h.camera.interpolation.target, { yaw: -90, pitch: -45 });
  h.bot._client.emit('respawn');
  assert.equal(h.camera.vehicles.size, 0);
  assert.equal(h.camera.cartPositions.size, 0);
  assert.equal(h.camera.interpolation, null);
  await stop(h);
});

test('desconexão do jogador encerra e ausência de confirmação impede rotações', async () => {
  const h = harness(); await ready(h);
  h.disconnect();
  await assert.rejects(h.running, /não está conectado/);
  assert.equal(h.controller.cartCamera, null);
  const pending = harness({ acknowledge: false });
  await delay(70);
  assert.equal(rotations(pending).length, 0);
  assert.ok(!pending.sent.some(({ text }) => text.startsWith('/spectate')));
  await stop(pending);
});

test('loop limita envios a 20 Hz e desconexão do bot não tenta comandos de limpeza', async () => {
  const h = harness(); await ready(h);
  const motion = setInterval(() => { h.cart.position.z += 0.1; }, 20);
  try { await delay(250); } finally { clearInterval(motion); }
  const entries = rotations(h);
  assert.ok(entries.length >= 2 && entries.length <= 6);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].time - entries[i - 1].time >= 45);
  h.controller.closed = true;
  const count = h.sent.length;
  await stop(h);
  assert.equal(h.sent.length, count);
});

test('protocolo antigo, jogador inválido e sinal cancelado não alteram o servidor', async () => {
  for (const variation of ['version', 'name', 'abort']) {
    const work = new AbortController();
    const bot = { username: 'Bot1', protocolVersion: variation === 'version' ? 767 : 775, chat: () => assert.fail('não enviar') };
    const controller = { bot, ensurePlayer: () => ({}) };
    if (variation === 'abort') work.abort();
    const camera = new CartCamera(controller, variation === 'name' ? '@a' : 'Steve', work.signal);
    await assert.rejects(camera.run());
  }
});

test('negações de modo espectador ou câmera expiram e limpam recursos', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const mode of ['survival', 'spectator']) {
    now = 0;
    const h = harness({ mode, acknowledge: false });
    await delay(10);
    now = 10001;
    await assert.rejects(h.running, mode === 'survival' ? /permissão de \/gamemode/ : /permissão de \/spectate/);
    assert.equal(rotations(h).length, 0);
    assert.equal(h.bot.physicsEnabled, true);
    assert.equal(h.controller.cartCamera, null);
    assert.equal(h.bot._client.eventNames().length, 0);
  }
});

test('perda da câmera pausa a rotação e expira sem tentar acompanhar outro jogador', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness(); await ready(h);
  h.bot._client.emit('camera', { cameraId: 99 });
  await delay(60);
  now = 10001;
  await assert.rejects(h.running, /acompanhamento do jogador foi perdido/);
  assert.equal(rotations(h).length, 0);
});
