import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';
import { validateConfig } from '../src/config.js';
import { planTunnel, TunnelTask, tunnelSections } from '../src/tunnel.js';

const dimension = { minY: -64, height: 384 };
const rawConfig = { server: { host: 'localhost' }, bots: [{ name: 'bot1' }] };
const config = validateConfig({
  ...rawConfig,
  tunnel: { wallBlock: 'minecraft:barrier', centerFloorBlock: 'smooth_stone', sideFloorBlock: 'stone_bricks' },
}).tunnel;

function applyBlocks(blocks, { min, max, block }) {
  for (let x = min[0]; x <= max[0]; x++) {
    for (let z = min[2]; z <= max[2]; z++) {
      for (let y = min[1]; y <= max[1]; y++) blocks.set([x, y, z].join(','), block);
    }
  }
}

test('túnel aceita seis inteiros e valida os padrões e materiais do JSON', () => {
  assert.deepEqual(parseCommand('TUNEL(-60,64,-17,15,69,-14)'), {
    type: 'tunnel', start: [-60, 64, -17], end: [15, 69, -14],
  });
  for (const input of ['tunnel(0,64,0,1,64)', 'tunnel(0,64,0,1.5,64,0)', 'tunnel(0,64,0,30000000,64,0)']) {
    assert.equal(parseCommand(input), null);
  }
  assert.deepEqual(validateConfig(rawConfig).tunnel, { ...config, wallBlock: 'stone_bricks' });
  assert.equal(config.wallBlock, 'barrier');
  assert.throws(() => validateConfig({ ...rawConfig, tunnel: { wallBlock: 'stone replace air' } }), /identificador de bloco/);
  assert.throws(() => validateConfig({ ...rawConfig, tunnel: { width: 4 } }), /ímpar/);
});

test('o túnel mantém os materiais e as passagens na curva e no poço', () => {
  const action = parseCommand('tunnel(-60,64,-17,15,69,-8)');
  const sections = [...tunnelSections(planTunnel(action, config, dimension))];
  const blocks = new Map();
  for (const section of sections) {
    for (const fill of section.commands) applyBlocks(blocks, fill);
  }
  assert.deepEqual(sections.slice(0, 3).map(({ min, max }) => [min[0], max[0]]), [[-60, -29], [-28, 3], [4, 15]]);
  assert.equal(blocks.get('-60,64,-17'), 'air');
  assert.equal(blocks.get('0,63,-17'), 'smooth_stone');
  assert.equal(blocks.get('0,63,-16'), 'stone_bricks');
  assert.equal(blocks.get('0,65,-15'), 'barrier');
  assert.equal(blocks.get('0,67,-17'), 'barrier');
  assert.equal(blocks.get('15,64,-17'), 'air');
  assert.equal(blocks.get('15,65,-16'), 'air');
  assert.equal(blocks.get('15,67,-8'), 'air');
  assert.equal(blocks.get('15,69,-8'), 'air');
  assert.equal(blocks.get('15,69,-6'), 'barrier');
  assert.equal(blocks.get('15,72,-8'), undefined);
  assert.throws(() => planTunnel(parseCommand('tunnel(0,-64,0,1,-64,0)'), config, dimension), /limites da dimensão/);
});

function mockTask(signal, afterCommand = () => {}) {
  const blocks = new Map();
  const sent = [];
  const bot = {
    entity: { position: { x: 1.5, y: 80, z: 1.5 } },
    game: { ...dimension, gameMode: 'survival' },
    physicsEnabled: true,
    registry: { blocksByName: Object.fromEntries(['air', 'barrier', 'smooth_stone', 'stone_bricks'].map(name => [name, {}])) },
    world: { getColumn: () => ({}) },
    blockAt: ({ x, y, z }) => ({ name: blocks.get([x, y, z].join(',')) ?? 'stone' }),
    chat(text) {
      sent.push(text);
      const [command, ...args] = text.split(' ');
      if (command === '/gamemode') this.game.gameMode = args[0];
      if (command === '/tp') {
        const [x, y, z] = args.map(Number);
        this.entity.position = { x, y, z };
      }
      if (['/fill', '/setblock'].includes(command)) {
        const min = args.slice(0, 3).map(Number);
        const max = command === '/fill' ? args.slice(3, 6).map(Number) : min;
        applyBlocks(blocks, { min, max, block: args.at(-1).replace('minecraft:', '') });
      }
    },
  };
  const controller = {
    bot, manager: { config: { tunnel: { ...config, width: 1 } } },
    chat: { async command(text, { beforeSend }) {
      signal.throwIfAborted();
      beforeSend?.();
      bot.chat(text);
      afterCommand(text);
    } },
  };
  return { bot, sent, blocks, task: new TunnelTask(controller, signal) };
}

test('a construção usa apenas comandos, confirma blocos e restaura o bot', async () => {
  const { bot, sent, blocks, task } = mockTask(new AbortController().signal);
  await task.run(parseCommand('tunnel(40,64,0,72,64,0)'));
  assert.equal(sent[0], '/gamemode spectator');
  assert.equal(sent.filter(text => text.startsWith('/tp ')).length, 3);
  assert.ok(sent.some(text => text.startsWith('/fill ') && text.endsWith('minecraft:air')));
  assert.ok(sent.includes('/setblock 72 63 0 minecraft:smooth_stone'));
  assert.equal(blocks.get('40,63,0'), 'smooth_stone');
  assert.equal(blocks.get('40,63,1'), 'barrier');
  assert.equal(sent.at(-1), '/gamemode survival');
  assert.deepEqual(bot.entity.position, { x: 1.5, y: 80, z: 1.5 });
  assert.equal(bot.physicsEnabled, true);
});

test('cancelar durante o trecho impede as próximas edições e restaura posição e modo', async () => {
  const abort = new AbortController();
  const { bot, sent, task } = mockTask(abort.signal, (text) => {
    if (text.startsWith('/fill ')) abort.abort();
  });
  await assert.rejects(task.run(parseCommand('tunnel(40,64,0,72,64,0)')), { name: 'AbortError' });
  assert.equal(sent.filter(text => /^\/(fill|setblock) /u.test(text)).length, 1);
  assert.deepEqual(sent.slice(-2), ['/tp 1.500000 80.000000 1.500000', '/gamemode survival']);
  assert.equal(bot.physicsEnabled, true);
});
