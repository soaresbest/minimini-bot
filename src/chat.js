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
  flush() {
    if (this.timer || this.closed || !this.queue.length) return;
    try { this.bot.chat(this.queue.shift()); } catch { /* connection may have ended */ }
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.intervalMs);
    this.timer.unref?.();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue.length = 0;
  }
}
