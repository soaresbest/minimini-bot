import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import chatPlugin from 'minecraft-protocol/src/client/chat.js';
import { installChatCompatibility } from '../src/chat-compat.js';

// Executa o plugin real da dependência e serializa os pacotes antes de
// verificá-los: campos extras do objeto JS podem desaparecer na rede.
function harness(version = '26.1.2', { fix = true } = {}) {
  const client = new EventEmitter();
  client.version = version;
  client.uuid = '00000000-0000-0000-0000-000000000001';
  const sent = [];
  const serializer = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false });
  const deserializer = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
  client.write = (name, params) => {
    sent.push(deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data);
  };
  chatPlugin(client, {});
  client.chat = client._signedChat; // Mesmo alias instalado por play.js.
  const bot = { _client: client, supportFeature: minecraftData(version).supportFeature };
  if (fix) installChatCompatibility(bot);
  let index = 0;
  const inbound = () => {
    const signature = Buffer.alloc(256);
    signature.writeInt32BE(++index);
    client.emit('player_chat', {
      senderUuid: '00000000-0000-0000-0000-000000000002',
      timestamp: BigInt(Date.now()), signature, plainMessage: 'cartlook(Steve)', previousMessages: [],
    });
    return signature;
  };
  return { client, bot, sent, inbound };
}

// Modelo independente da janela do servidor: 20 posições iniciais vazias,
// novas assinaturas no fim, offset deslocando a janela antes dos bits.
class ServerAcknowledgements {
  messages = Array(20).fill(null);
  cursor = 0;
  receive(signature) { this.messages.push(signature); }
  validate(packets) {
    for (const { name, params } of packets.slice(this.cursor)) {
      const count = name === 'chat_message' ? params.offset
        : name === 'chat_command_signed' ? params.messageCount
          : name === 'message_acknowledgement' ? params.count : 0;
      assert.ok(count >= 0 && count <= this.messages.length - 20, 'deslocamento válido');
      this.messages.splice(0, count);
      if (params.acknowledged) {
        for (let bit = 0; bit < 20; bit++) {
          if (params.acknowledged[Math.floor(bit / 8)] & (1 << (bit % 8))) {
            assert.ok(this.messages[bit], `confirmação de mensagem desconhecida no índice ${bit}`);
          }
        }
      }
    }
    this.cursor = packets.length;
  }
}

test('reproduz a falha real: comando sem assinatura perde offset e chat confirma mensagem desconhecida', () => {
  const h = harness('26.1.2', { fix: false });
  const server = new ServerAcknowledgements();
  server.receive(h.inbound());
  h.client.chat('/rotate Steve 0 0');
  h.client.chat('[mini] Câmera ativa');
  assert.deepEqual(h.sent[0], { name: 'chat_command', params: { command: 'rotate Steve 0 0' } });
  assert.equal(h.sent[1].params.offset, 0);
  assert.throws(() => server.validate(h.sent), /mensagem desconhecida no índice 19/);
});

for (const version of ['1.20.5', '1.21.3', '1.21.5', '26.1', '26.1.2']) {
  test(`comandos offline preservam confirmações até a mensagem seguinte em ${version}`, () => {
    const h = harness(version);
    const server = new ServerAcknowledgements();
    server.receive(h.inbound());
    const pending = structuredClone(h.client._lastSeenMessages);
    for (const command of ['/gamemode spectator Bot1', '/spectate Steve Bot1', '/rotate Steve 20 -45']) h.client.chat(command);
    assert.equal(h.client._lastSeenMessages.pending, 1);
    assert.deepEqual(structuredClone(h.client._lastSeenMessages), pending, 'não consome nem marca mensagens como confirmadas');
    h.client.chat('[mini] Câmera ativa');
    const packet = h.sent.at(-1);
    assert.equal(packet.name, 'chat_message');
    assert.equal(packet.params.offset, 1);
    assert.deepEqual(packet.params.acknowledged, Buffer.from([0, 0, 8]));
    server.validate(h.sent);
    assert.equal(h.client._lastSeenMessages.pending, 0);
  });
}

test('sessão longa intercala comandos de câmera, mensagens e confirmação automática sem perder a janela', () => {
  const h = harness();
  const server = new ServerAcknowledgements();
  for (let frame = 0; frame < 4000; frame++) {
    if (frame % 20 === 0) server.receive(h.inbound());
    h.client.chat(`/execute as Steve on vehicle if entity @s[type=minecraft:minecart] run rotate Steve ${frame % 180} 0`);
    if (frame === 2600 || frame === 3999) h.client.chat('[mini] status');
    server.validate(h.sent);
  }
  assert.ok(h.sent.some(packet => packet.name === 'message_acknowledgement'));
  assert.equal(h.sent.filter(packet => packet.name === 'chat_command').length, 4000);
  assert.equal(h.client._lastSeenMessages.pending, 0);
});

test('comandos sem assinatura não consomem a janela com chaves Microsoft mas sem sessão de chat', () => {
  const h = harness();
  h.client.profileKeys = {};
  h.inbound();
  h.client.chat('/rotate Steve 0 0');
  assert.equal(h.sent[0].name, 'chat_command');
  assert.equal(h.client._lastSeenMessages.pending, 1);
});

test('sessão Microsoft preserva comandos assinados, assinaturas de chat e offsets', () => {
  const h = harness();
  const server = new ServerAcknowledgements();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  h.client.profileKeys = { private: keys.privateKey, public: keys.publicKey };
  h.client._session = { uuid: '00000000-0000-0000-0000-000000000003', index: 0 };
  server.receive(h.inbound());
  h.client.emit('declare_commands', { rootIndex: 0, nodes: [
    { children: [1] },
    { children: [2], extraNodeData: { name: 'say' } },
    { children: [], extraNodeData: { name: 'message', parser: 'minecraft:message' } },
  ] });
  h.client.chat('/say Mensagem assinada');
  assert.equal(h.sent[0].name, 'chat_command_signed');
  assert.equal(h.sent[0].params.argumentSignatures[0].signature.length, 256);
  assert.equal(h.sent[0].params.messageCount, 1);
  server.validate(h.sent);
  h.client.chat('[mini] Câmera ativa');
  assert.equal(h.sent[1].params.signature.length, 256);
  assert.equal(h.sent[1].params.offset, 0);
  server.validate(h.sent);
});

test('protocolos anteriores continuam incluindo confirmações em chat_command', () => {
  for (const version of ['1.19.3', '1.20.4']) {
    const h = harness(version);
    assert.equal(installChatCompatibility(h.bot), false);
    h.inbound();
    h.client.chat('/rotate Steve 0 0');
    assert.equal(h.sent[0].name, 'chat_command');
    assert.equal(h.sent[0].params.messageCount, 1);
    assert.deepEqual(h.sent[0].params.acknowledged, Buffer.from([0, 0, 8]));
    assert.equal(h.client._lastSeenMessages.pending, 0);
  }
});

test('instalação é idempotente, espera o plugin de chat e isola reconexões', () => {
  assert.equal(installChatCompatibility({}), false);
  assert.equal(installChatCompatibility({ _client: {} }), false);
  const h = harness();
  const installed = h.client._signedChat;
  assert.equal(h.client.chat, installed);
  assert.equal(installChatCompatibility(h.bot), false);
  assert.equal(h.client._signedChat, installed);
  h.inbound();
  h.client.chat('/rotate Steve 0 0');
  const reconnected = harness();
  assert.equal(reconnected.client._lastSeenMessages.pending, 0);
  reconnected.inbound();
  reconnected.client.chat('/rotate Steve 0 0');
  reconnected.client.chat('Reconectado');
  assert.equal(reconnected.sent.at(-1).params.offset, 1);
});
