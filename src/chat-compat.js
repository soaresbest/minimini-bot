const patchedClients = new WeakSet();

// minecraft-protocol 1.68.0 consome as confirmações de chat ao enviar
// comandos offline, mesmo quando chat_command só transporta a string.
// O próximo chat_message fica com offset=0 e bits de mensagens que o
// servidor ainda não reconheceu (multiplayer.disconnect.chat_validation_failed).
// Desde 1.20.5, envie esses comandos sem tocar no estado das confirmações.
// Mensagens normais, comandos assinados e protocolos antigos ficam a cargo
// da dependência. Não desabilitar assinatura nem validação de mensagens.
export function installChatCompatibility(bot) {
  const client = bot._client;
  if (!client || patchedClients.has(client) || typeof client._signedChat !== 'function' ||
    !bot.supportFeature?.('seperateSignedChatCommandPacket')) return false;

  const signedChat = client._signedChat;
  client._signedChat = function (message, ...args) {
    if (typeof message === 'string' && message.startsWith('/') && !(this.profileKeys && this._session)) {
      return this.write('chat_command', { command: message.slice(1) });
    }
    return signedChat.call(this, message, ...args);
  };
  // play.js guarda uma referência direta antes de emitir login. Mineflayer
  // chama client.chat(), então atualize também esse alias já instalado.
  if (client.chat === signedChat) client.chat = client._signedChat;
  patchedClients.add(client);
  return true;
}
