import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { BotManager } from '../src/manager.js';
import { validateConfig } from '../src/config.js';

const VERSION = '1.16.5';
const ALICE_UUID = '00000000-0000-0000-0000-000000000001';
const OTHER_BOT_UUID = '00000000-0000-0000-0000-000000000002';

async function waitUntil(predicate, message, signal) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10, undefined, { signal });
  }
}

test('cliente Mineflayer real conecta offline e responde a menções pelo protocolo Minecraft', { timeout: 15_000 }, async (t) => {
  // Servidor TCP restrito ao loopback. Não há autenticação, servidor ou LLM externos.
  const server = minecraftProtocol.createServer({ host: '127.0.0.1', port: 0, version: VERSION, 'online-mode': false });
  const received = [];
  const errors = [];
  let peer;
  let manager;
  let savedConfig;
  server.on('error', (error) => errors.push(error));
  t.after(async () => {
    manager?.close();
    const closed = once(server, 'close');
    server.close();
    for (const client of Object.values(server.clients)) client.socket.destroy();
    await closed;
  });

  server.on('playerJoin', (client) => {
    peer = client;
    client.on('error', (error) => errors.push(error));
    client.on('chat', ({ message }) => received.push(message));
    const data = minecraftData(VERSION);
    client.write('login', { ...data.loginPacket, entityId: client.id, gameMode: 0, worldName: 'minecraft:overworld' });
    client.write('player_info', { action: 'add_player', data: [
      { uuid: client.uuid, name: client.username, properties: [], gamemode: 0, ping: 0 },
      { uuid: ALICE_UUID, name: 'Alice', properties: [], gamemode: 0, ping: 0 },
      { uuid: OTHER_BOT_UUID, name: 'OtherBot', properties: [], gamemode: 0, ping: 0 },
    ] });
    client.write('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 });
    client.write('update_health', { health: 18, food: 20, foodSaturation: 5 });
  });

  await once(server, 'listening');
  const config = validateConfig({
    server: { host: '127.0.0.1', port: server.socketServer.address().port, version: VERSION },
    bots: [{ name: 'Bot1', auth: 'offline', mode: 'default' }],
    access: { ignoredPlayers: ['OtherBot'] }, settings: { commandCooldownMs: 0 },
  });
  manager = new BotManager(config, {
    log: () => {}, registrationPassword: () => '00123456',
    save: async value => { savedConfig = structuredClone(value); }
  });
  manager.start();
  const record = manager.records.get('bot1');
  record.bot.on('error', (error) => errors.push(error));
  // O fixture exercita conexão e comandos, sem simular chunks ou física de terreno.
  record.bot.physicsEnabled = false;
  await once(record.bot, 'spawn', { signal: t.signal });
  await waitUntil(() => received.some((text) => text.includes('Pronto!')), 'O bot deve anunciar sua entrada no chat.', t.signal);
  assert.equal(peer.username, 'Bot1');
  assert.equal(record.controller.ready, true);
  assert.ok(record.bot.players.Alice);
  assert.equal(record.bot.health, 18);
  assert.equal(record.bot.food, 20);
  await waitUntil(() => received.includes('/login 00123456'), 'O bot deve registrar e autenticar pelo chat.', t.signal);
  assert.ok(received.includes('/register 00123456 00123456'));
  assert.equal(savedConfig.registrations[`127.0.0.1:${config.server.port}`].bot1, '00123456');

  // A fila real continua sendo usada, com um intervalo menor para o teste.
  record.controller.chat.intervalMs = 5;
  const sendChat = (name, message, uuid = ALICE_UUID) => {
    peer.write('chat', { message: JSON.stringify({ translate: 'chat.type.text', with: [{ text: name }, { text: message }] }), position: 0, sender: uuid });
  };
  const waitForReply = async (pattern, after = received.length) => {
    await waitUntil(() => received.slice(after).some((text) => pattern.test(text)), `Resposta não recebida: ${pattern}`, t.signal);
    return received.slice(after).find((text) => pattern.test(text));
  };

  const initialCount = received.length;
  sendChat('Alice', 'status');
  sendChat('OtherBot', '@Bot1 stop', OTHER_BOT_UUID);
  sendChat('Nobody', '@Bot1 stop');
  const barrier = new Promise((resolve) => {
    const onChat = (_name, message) => {
      if (message !== 'barreira sem menção') return;
      record.bot.removeListener('chat', onChat);
      resolve();
    };
    record.bot.on('chat', onChat);
    t.after(() => record.bot?.removeListener('chat', onChat));
  });
  // Todos os pacotes anteriores chegam antes desta mensagem no mesmo socket TCP.
  sendChat('Alice', 'barreira sem menção');
  await barrier;
  await delay(50, undefined, { signal: t.signal });
  assert.equal(received.length, initialCount, 'Mensagens sem menção, de bots e de jogadores desconhecidos devem ser ignoradas.');

  let offset = received.length;
  sendChat('Alice', '@Bot1 status');
  const status = await waitForReply(/Vida 18\/20; fome 20\/20/, offset);
  assert.match(status, /inventário: vazio/);
  assert.match(status, /^\[mini\]/);

  offset = received.length;
  sendChat('Alice', '@Bot1 follow(Alice)');
  await waitForReply(/Entendido\. Vou executar/, offset);
  await waitUntil(() => record.controller.following?.player === 'Alice', 'follow deve iniciar a tarefa.', t.signal);
  assert.match(record.controller.task, /aguardando Alice/);

  offset = received.length;
  sendChat('Alice', '@Bot1 stop');
  await waitForReply(/Parei aqui/, offset);
  assert.equal(record.controller.following, null);
  assert.equal(record.controller.task, 'parado');
  assert.equal(record.controller.abort, null);

  offset = received.length;
  sendChat('Alice', '@Bot1 comando_desconhecido');
  await waitForReply(/Não entendi\. Use help\./, offset);
  assert.deepEqual(errors, []);
  const ended = once(record.bot, 'end', { signal: t.signal });
  manager.close();
  await ended;
  assert.equal(manager.records.size, 0);
  assert.equal(record.controller.closed, true);
  assert.equal(record.removed, true);
});
