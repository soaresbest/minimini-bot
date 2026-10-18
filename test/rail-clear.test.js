import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { railClearCommands, clearRailway } from '../src/rail-clear.js';
import { ChatQueue } from '../src/chat.js';
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

test('limpeza compartilha a fila do chat, repete e cancela sem comandos atrasados', async t => {
  const sent = [];
  const work = new AbortController();
  const chat = new ChatQueue({ chat: command => sent.push({ command, time: Date.now() }) }, { intervalMs: 20 });
  t.after(() => { work.abort(); chat.close(); });
  const controller = { ensurePlayer: () => ({}), say: message => chat.say(message), chat };
  chat.say('Entendido. Vou executar.');
  const running = clearRailway(controller, 'Steve', work.signal);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  assert.equal(sent.length, 1, 'não envia rajada após a confirmação');
  const deadline = Date.now() + 3000;
  while (sent.filter(entry => entry.command.startsWith('/')).length < 11) {
    assert.ok(Date.now() < deadline);
    await delay(10);
  }
  const commands = sent.filter(entry => entry.command.startsWith('/')).map(entry => entry.command);
  assert.deepEqual(commands.slice(0, 10), railClearCommands('Steve'));
  assert.equal(commands[10], commands[0]);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].time - sent[i - 1].time >= 15);
  work.abort();
  await rejected;
  const count = sent.length;
  await delay(60);
  assert.equal(sent.length, count);
  assert.equal(chat.pendingCommand, null);
});

test('jogador desconectado impede comandos e sinal cancelado não envia nada', async () => {
  const controller = { ensurePlayer: () => { throw new Error('desconectou'); }, bot: { chat: () => assert.fail('não enviar') } };
  await assert.rejects(clearRailway(controller, 'Steve', new AbortController().signal), /desconectou/);
  controller.ensurePlayer = () => ({});
  controller.say = () => {};
  await assert.rejects(clearRailway(controller, 'Steve', AbortSignal.abort()), { name: 'AbortError' });
});

test('fila revalida jogador antes do envio e rejeita pendência ao fechar', async t => {
  const sent = [];
  const chat = new ChatQueue({ chat: text => sent.push(text) }, { intervalMs: 20 });
  t.after(() => chat.close());
  chat.say('ocupando fila');
  await assert.rejects(chat.command('/execute', {
    signal: new AbortController().signal,
    beforeSend: () => { throw new Error('jogador desconectou'); },
  }), /desconectou/);
  assert.equal(sent.length, 1);
  const pending = chat.command('/execute', { signal: new AbortController().signal });
  const rejected = assert.rejects(pending, /Conexão encerrada/);
  chat.close();
  await rejected;
  assert.equal(sent.length, 1);
});
