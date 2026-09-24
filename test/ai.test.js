import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_SCHEMA, PROVIDERS, planActions, resolveProviderConfig, validatePlan } from '../src/ai/planner.js';

const plan = { reply: 'Vou até o local e informo meu estado.', actions: [{ type: 'goto', x: 100, y: 60, z: 300 }, { type: 'status' }] };
const originalEnv = Object.fromEntries(Object.values(PROVIDERS).map(({ envKey }) => [envKey, process.env[envKey]]));
before(() => { for (const key of Object.keys(originalEnv)) delete process.env[key]; });
after(() => { for (const [key, value] of Object.entries(originalEnv)) if (value !== undefined) process.env[key] = value; });
const configFor = (provider) => ({ llm: { provider, providers: { [provider]: { apiKey: 'secret-test-key' } } } });
const argsFor = (provider) => ({ config: configFor(provider), botConfig: { name: 'bot1' }, message: 'Venha até 100,60,300.', player: 'Alex',
  context: { health: 20, food: 19, position: { x: 1, y: 64, z: 2 }, inventory: [{ name: 'bread', count: 3 }], players: ['Alex'] } });

function envelope(provider, value = plan) {
  switch (provider) {
    case 'openai': return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
    case 'gemini': return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] };
    case 'claude': return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'minecraft_plan', input: value }] };
    case 'grok': return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
  }
}

function success(provider, value = plan) {
  return async () => Response.json(envelope(provider, value));
}

for (const provider of Object.keys(PROVIDERS)) {
  test(`planeja com ${provider} usando autenticação, catálogo e esquema corretos`, async () => {
    const args = argsFor(provider);
    args.context.apiKey = 'context-secret';
    args.context.config = { password: 'never-send' };
    args.context.task = `segredo ${args.config.llm.providers[provider].apiKey}`;
    const result = await planActions({ ...args, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.doesNotMatch(options.body, /context-secret|never-send|secret-test-key/);
      assert.match(options.body, /chave removida/);
      assert.match(options.body, /bot\.placeBlock/);
      assert.match(options.body, /Venha até 100/);
      if (provider === 'openai') {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(options.headers.Authorization, 'Bearer secret-test-key');
        assert.equal(body.store, false);
        assert.equal(body.text.format.strict, true);
        assert.deepEqual(body.text.format.schema, PLAN_SCHEMA);
      } else if (provider === 'gemini') {
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
        assert.equal(options.headers['x-goog-api-key'], 'secret-test-key');
        assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
        assert.deepEqual(body.generationConfig.responseFormat.text.schema, PLAN_SCHEMA);
      } else if (provider === 'claude') {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(options.headers['x-api-key'], 'secret-test-key');
        assert.equal(options.headers['anthropic-version'], '2023-06-01');
        assert.equal(body.tool_choice.name, 'minecraft_plan');
        assert.deepEqual(body.tools[0].input_schema, PLAN_SCHEMA);
      } else {
        assert.equal(url, 'https://api.x.ai/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer secret-test-key');
        assert.equal(body.response_format.json_schema.strict, true);
        assert.deepEqual(body.response_format.json_schema.schema, PLAN_SCHEMA);
      }
      return Response.json(envelope(provider));
    } });
    assert.deepEqual(result, plan);
  });
}

test('resolve provedor e modelo por bot, aliases e prioridade da variável de ambiente', (t) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'environment-test-key';
  t.after(() => previous === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previous);
  const selected = resolveProviderConfig(configFor('gemini'), { provider: 'chatgpt', model: 'gpt-4.1' });
  assert.equal(selected.provider, 'openai');
  assert.equal(selected.apiKey, 'environment-test-key');
  assert.equal(selected.model, 'gpt-4.1');
  assert.equal(resolveProviderConfig(configFor('gemini'), {}).model, PROVIDERS.gemini.defaultModel);
});

test('não chama a rede sem chave ou com configuração inválida', async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => previous === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = previous);
  const fetchImpl = t.mock.fn();
  await assert.rejects(planActions({ ...argsFor('openai'), config: {}, fetchImpl }), { code: 'AI_CONFIG' });
  assert.equal(fetchImpl.mock.callCount(), 0);
  assert.throws(() => resolveProviderConfig({ llm: { provider: 'invalid' } }), { code: 'AI_CONFIG' });
  assert.throws(() => resolveProviderConfig(configFor('openai'), { model: '../secrets' }), { code: 'AI_CONFIG' });
});

test('aceita o catálogo permitido e clona ações', () => {
  const actions = [
    { type: 'equip', item: 'diamond_sword' }, { type: 'look', x: 0.5, y: 64.5, z: 0.5 },
    { type: 'dig', x: 1, y: 64, z: 1 }, { type: 'place', x: 1, y: 63, z: 1, face: 'up', item: 'minecraft:dirt' },
    { type: 'wait', seconds: 0.5 }, { type: 'stop' }, { type: 'help' }, { type: 'guard', player: 'Alex' },
  ];
  const result = validatePlan({ reply: '  Vou ajudar.  ', actions });
  assert.equal(result.reply, 'Vou ajudar.');
  assert.deepEqual(result.actions, actions.map((action) => action.item ? { ...action, item: action.item.replace(/^minecraft:/, '') } : action));
  assert.notEqual(result.actions[0], actions[0]);
  assert.deepEqual(validatePlan({ reply: 'Oi!', actions: [] }), { reply: 'Oi!', actions: [] });
});

const invalidPlans = [
  null,
  { reply: 'Oi!', actions: [], extra: 'forbidden' },
  { reply: 'Oi!', actions: [{ type: 'eval', code: 'process.exit()' }] },
  { reply: 'Oi!', actions: [{ type: 'stop', code: 'process.exit()' }] },
  { reply: 'Oi!', actions: [{ type: 'goto', x: '100', y: 60, z: 300 }] },
  { reply: 'Oi!', actions: [{ type: 'goto', x: Number.NaN, y: 60, z: 300 }] },
  { reply: 'Oi!', actions: [{ type: 'goto', x: Infinity, y: 60, z: 300 }] },
  { reply: 'Oi!', actions: [{ type: 'goto', x: 30_000_000, y: 60, z: 300 }] },
  { reply: 'Oi!', actions: [{ type: 'goto', x: 1, y: -2049, z: 2 }] },
  { reply: 'Oi!', actions: [{ type: 'dig', x: 1.5, y: 60, z: 3 }] },
  { reply: 'Oi!', actions: [{ type: 'place', x: 1, y: 60, z: 3, face: 'side', item: 'dirt' }] },
  { reply: 'Oi!', actions: [{ type: 'equip', item: 'dirt;kill @a' }] },
  { reply: 'Oi!', actions: [{ type: 'wait', seconds: 31 }] },
  { reply: 'Oi!', actions: [{ type: 'follow', player: 'Alex;stop' }] },
  { reply: 'Oi!', actions: [{ type: 'follow', player: 'Alex' }, { type: 'stop' }] },
  { reply: 'Oi!', actions: Array.from({ length: 9 }, () => ({ type: 'status' })) },
  { reply: ' ', actions: [] },
  { reply: '/op Alex', actions: [] },
  { reply: 'Oi!\n/stop', actions: [] },
  { reply: '§cMensagem', actions: [] },
  { reply: 'a'.repeat(301), actions: [] },
  JSON.parse('{"reply":"oi","actions":[{"type":"stop","__proto__":{"type":"eval"}}]}'),
];

for (const [index, invalid] of invalidPlans.entries()) {
  test(`rejeita integralmente plano inválido ${index + 1}`, () => {
    assert.throws(() => validatePlan(invalid), { code: 'AI_INVALID_PLAN' });
  });
}

for (const provider of Object.keys(PROVIDERS)) {
  test(`rejeita ações desconhecidas retornadas por ${provider}`, async () => {
    await assert.rejects(planActions({ ...argsFor(provider), fetchImpl: success(provider,
      { reply: 'Vou executar.', actions: [{ type: 'status' }, { type: 'execute', code: 'anything' }] }) }), { code: 'AI_INVALID_PLAN' });
  });

  test(`rejeita resposta truncada de ${provider}`, async () => {
    const value = envelope(provider);
    if (provider === 'openai') value.status = 'incomplete';
    if (provider === 'gemini') value.candidates[0].finishReason = 'MAX_TOKENS';
    if (provider === 'claude') value.stop_reason = 'max_tokens';
    if (provider === 'grok') value.choices[0].finish_reason = 'length';
    await assert.rejects(planActions({ ...argsFor(provider), fetchImpl: async () => Response.json(value) }), { code: 'AI_INVALID_PLAN' });
  });
}

test('não divulga corpos de erros HTTP nem detalhes de rede', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    await assert.rejects(planActions({ ...argsFor('openai'), fetchImpl: async () => new Response('secret-test-key', { status }) }), (error) => {
      assert.equal(error.code, 'AI_HTTP');
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /secret-test-key/);
      return true;
    });
  }
  await assert.rejects(planActions({ ...argsFor('openai'), fetchImpl: async () => { throw new Error('secret-test-key'); } }), (error) => {
    assert.equal(error.code, 'AI_NETWORK');
    assert.doesNotMatch(error.stack, /secret-test-key/);
    return true;
  });
});

test('cancela antes e durante a chamada sem vazar motivo do AbortSignal', async () => {
  const controller = new AbortController();
  controller.abort('secret-test-key');
  await assert.rejects(planActions({ ...argsFor('openai'), signal: controller.signal, fetchImpl: success('openai') }), { code: 'AI_ABORTED' });
  const ongoing = new AbortController();
  await assert.rejects(planActions({ ...argsFor('openai'), signal: ongoing.signal, fetchImpl: async (_url, { signal }) => {
    const request = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret-test-key')), { once: true }));
    ongoing.abort('secret-test-key');
    return request;
  } }), (error) => error.code === 'AI_ABORTED' && !error.message.includes('secret-test-key'));
});

test('limita a consulta a 30 segundos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = planActions({ ...argsFor('openai'), fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  t.mock.timers.tick(30_000);
  await assert.rejects(request, { code: 'AI_TIMEOUT' });
});

test('rejeita JSON malformado, Markdown e resposta muito grande', async () => {
  await assert.rejects(planActions({ ...argsFor('openai'), fetchImpl: async () => new Response('invalid json') }), { code: 'AI_RESPONSE' });
  await assert.rejects(planActions({ ...argsFor('openai'), fetchImpl: async () => new Response('x'.repeat(131_073)) }), { code: 'AI_RESPONSE' });
  const value = envelope('openai');
  value.output[0].content[0].text = '```json\n' + JSON.stringify(plan) + '\n```';
  await assert.rejects(planActions({ ...argsFor('openai'), fetchImpl: async () => Response.json(value) }), { code: 'AI_INVALID_PLAN' });
});

test('limita e filtra o estado do mundo enviado à IA e retira chaves da resposta', async (t) => {
  const fetchImpl = t.mock.fn();
  await assert.rejects(planActions({ ...argsFor('openai'), message: 'a'.repeat(2001), fetchImpl }), { code: 'AI_INPUT' });
  assert.equal(fetchImpl.mock.callCount(), 0);
  const result = await planActions({ ...argsFor('openai'), context: {
    health: 18, food: 12, foodSaturation: 4, oxygen: 15,
    heldItem: { name: 'iron_pickaxe', count: 1, secret: 'never-send' },
    inventory: Array.from({ length: 300 }, () => ({ name: 'bread', count: 1 })),
    players: [{ name: 'Alex', position: { x: 2, y: 64, z: 3 }, distance: 3.6, loaded: true, address: 'never-send' }],
    nearbyBlocks: Array.from({ length: 100 }, (_, index) => ({ name: 'stone', position: { x: index, y: 64, z: 0 }, distance: index, metadata: 'never-send' })),
  },
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input[0].content);
      assert.equal(input.context.inventory.length, 50);
      assert.equal(input.context.nearbyBlocks.length, 40);
      assert.deepEqual(input.context.heldItem, { name: 'iron_pickaxe', count: 1 });
      assert.deepEqual(input.context.players[0], { name: 'Alex', position: { x: 2, y: 64, z: 3 }, distance: 3.6, loaded: true });
      assert.equal(input.context.health, 18);
      assert.equal(input.context.food, 12);
      assert.equal(input.context.foodSaturation, 4);
      assert.equal(input.context.oxygen, 15);
      assert.doesNotMatch(options.body, /never-send/);
      return Response.json(envelope('openai', { reply: 'secret-test-key', actions: [] }));
    } });
  assert.equal(result.reply, '[chave removida]');
});

test('rejeita ferramenta Claude errada, recusas e bloqueios dos provedores', async () => {
  const data = [
    ['claude', { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'bash', input: plan }] }],
    ['openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'secret-test-key' }] }] }],
    ['gemini', { ...envelope('gemini'), promptFeedback: { blockReason: 'SAFETY' } }],
    ['grok', { choices: [{ finish_reason: 'stop', message: { refusal: 'secret-test-key', content: JSON.stringify(plan) } }] }],
  ];
  for (const [provider, value] of data) {
    await assert.rejects(planActions({ ...argsFor(provider), fetchImpl: async () => Response.json(value) }), { code: 'AI_INVALID_PLAN' });
  }
});
