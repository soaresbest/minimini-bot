export function cleanChat(text) {
  return String(text).replace(/§./g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ChatQueue {
  constructor(bot, { intervalMs = 1100 } = {}) {
    this.bot = bot;
    this.queue = [];
    this.timer = null;
    this.intervalMs = intervalMs;
    this.closed = false;
    this.pendingCommand = null;
  }
  say(text, priority = false) {
    if (this.closed) return;
    const chars = Array.from(cleanChat(text));
    const chunks = [];
    // Prefix prevents a generated reply from becoming a Minecraft slash command.
    for (let i = 0; i < chars.length; i += 200) chunks.push(`[mini] ${chars.slice(i, i + 200).join('')}`);
    if (priority) this.queue.unshift(...chunks.slice(0, 12));
    else this.queue.push(...chunks.slice(0, 12));
    this.queue = this.queue.slice(0, 40);
    this.flush();
  }
  // Apenas comandos construídos pelo programa; respostas de IA usam say().
  command(text, { signal, beforeSend = () => {} }) {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Conexão encerrada.'));
    if (this.pendingCommand) return Promise.reject(new Error('Já há um comando aguardando envio.'));
    if (typeof text !== 'string' || !text.startsWith('/') || text.length > 256 || /[\r\n\x00]/.test(text)) {
      return Promise.reject(new Error('Comando de servidor inválido.'));
    }
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        signal.removeEventListener('abort', cancel);
        if (this.pendingCommand === entry) this.pendingCommand = null;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(signal.reason);
      const entry = { text, signal, beforeSend, finish };
      this.pendingCommand = entry;
      signal.addEventListener('abort', cancel, { once: true });
      this.flush();
    });
  }
  flush() {
    if (this.timer || this.closed || (!this.queue.length && !this.pendingCommand)) return;
    if (this.queue.length) {
      try { this.bot.chat(this.queue.shift()); } catch { /* connection may have ended */ }
    } else {
      const entry = this.pendingCommand;
      try {
        entry.signal.throwIfAborted();
        entry.beforeSend();
        this.bot.chat(entry.text);
        entry.finish();
      } catch (error) { entry.finish(error); }
    }
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.intervalMs);
    this.timer.unref?.();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue.length = 0;
    this.pendingCommand?.finish(new Error('Conexão encerrada.'));
  }
}
