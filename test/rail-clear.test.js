import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { railClearCommands, clearRailway } from '../src/rail-clear.js';
import { parseCommand } from '../src/commands.js';
import { validatePlan } from '../src/ai/planner.js';

test('railclear valida o jogador e não amplia a lista de ações de IA', () => {
  assert.deepEqual(parseCommand('railclear(Steve)'), { type: 'railclear', player: 'Steve' });
  for (const value of ['railclear()', 'railclear(@a)', 'railclear(Steve,true)', 'railclear(Steve;kill)']) assert.equal(parseCommand(value), null);
  assert.throws(() => railClearCommands('@a'));
  assert.throws(() => validatePlan({ reply: 'Limpar.', actions: [{ type: 'railclear', player: 'Steve' }] }));
});

test('comandos restringem remoção a seres vivos junto a trilhos na posição do jogador', () => {
  const commands = railClearCommands('Steve');
  assert.equal(new Set(commands).size, 10);
  for (const command of commands) {
    assert.ok(command.length <= 256);
    assert.ok(command.startsWith('/execute at Steve as @e[type=!minecraft:player,type=!minecraft:armor_stand,distance=..16] at @s if data entity @s Health if block '));
    assert.ok(command.endsWith(' #minecraft:rails run kill @s'));
  }
  assert.ok(commands.some(command => command.includes('~0 ~-1 ~0')));
  assert.ok(commands.some(command => command.includes('~1 ~0 ~0')));
});

test('limpeza repete sem entidade local e cancelamento interrompe novos comandos', async () => {
  const sent = [];
  const work = new AbortController();
  const controller = { ensurePlayer: () => ({}), say: () => {}, bot: { chat: command => sent.push(command) } };
  const running = clearRailway(controller, 'Steve', work.signal);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  assert.equal(sent.length, 10);
  await delay(1100);
  assert.equal(sent.length, 20);
  work.abort();
  await rejected;
  await delay(50);
  assert.equal(sent.length, 20);
});

test('jogador desconectado impede comandos e sinal cancelado não envia nada', async () => {
  const controller = { ensurePlayer: () => { throw new Error('desconectou'); }, bot: { chat: () => assert.fail('não enviar') } };
  await assert.rejects(clearRailway(controller, 'Steve', new AbortController().signal), /desconectou/);
  controller.ensurePlayer = () => ({});
  controller.say = () => {};
  await assert.rejects(clearRailway(controller, 'Steve', AbortSignal.abort()), { name: 'AbortError' });
});
