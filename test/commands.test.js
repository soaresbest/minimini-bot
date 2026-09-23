import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, extractMention } from '../src/commands.js';
import { ChatQueue, cleanChat } from '../src/chat.js';

test('somente uma menção completa ativa o bot; nome parcial e texto comum não ativam', () => {
  assert.equal(extractMention('@bot1 goto(1,2,3)', 'bot1'), 'goto(1,2,3)');
  assert.equal(extractMention('oi @BOT1 venha até mim', 'bot1'), 'oi  venha até mim');
  assert.equal(extractMention('@bot1: status', 'bot1'), 'status');
  for (const text of ['bot1 status', '@bot10 status', 'email@bot1 status', 'status']) assert.equal(extractMention(text, 'bot1'), null);
});

test('parser valida tipos, argumentos, limites e comandos administrativos', () => {
  assert.deepEqual(parseCommand('goto(-12.5, 64, 300)'), { type: 'goto', x: -12.5, y: 64, z: 300 });
  assert.deepEqual(parseCommand('FOLLOW(Steve)'), { type: 'follow', player: 'Steve' });
  assert.deepEqual(parseCommand('mode(ia)'), { type: 'mode', mode: 'ia' });
  assert.deepEqual(parseCommand('botadd(Bot2,ia,gemini)'), { type: 'botadd', name: 'Bot2', mode: 'ia', provider: 'gemini' });
  assert.deepEqual(parseCommand('botconfig(Bot2,model,gpt-4.1-mini)'), { type: 'botconfig', name: 'Bot2', key: 'model', value: 'gpt-4.1-mini' });
  for (const command of ['goto(NaN,60,0)', 'goto(0,1e3,0)', 'goto(30000000,64,0)', 'goto(1,2)', 'follow()', 'stop(now)', 'mode(js)', 'botadd(foo,,openai)', 'botconfig(foo,apiKey,secret)', 'process.exit()', 'help;stop']) assert.equal(parseCommand(command), null, command);
});

test('chat limpa controles, limita pacotes e impede comandos slash', () => {
  const sent = [];
  const chat = new ChatQueue({ chat: value => sent.push(value) });
  chat.say('/op Alice\n§c' + '😀'.repeat(500));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith('[mini] /op Alice'));
  assert.ok(Array.from(sent[0]).length <= 207);
  assert.equal(cleanChat('a\n§bb\u0000c'), 'a b c');
  chat.close();
  chat.say('não enviar');
  assert.equal(chat.queue.length, 0);
});
