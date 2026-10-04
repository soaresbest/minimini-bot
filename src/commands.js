export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export const HELP = [
  'goto(x,y,z), follow(player), guard(player), railway(x1,y1,z1,x2,y2,z2,true|false), stop, status, help, mode(ia|default)',
  'railway: true/comandos permite /give; false/inventario usa somente o inventário.',
  'bots, botadd(nome[,default|ia[,provedor]]), botremove(nome), botconfig(nome,mode|provider|model,valor)',
  'Exemplo: @bot1 goto(100,60,300). IA: @bot1 venha até mim. Provedores: openai, gemini, grok, claude.'
];

export function extractMention(message, name) {
  if (typeof message !== 'string' || !PLAYER_NAME.test(name) || message.length > 2000) return null;
  const re = new RegExp(`(^|\\s)@${name}(?=[\\s,:]|$)`, 'i');
  if (!re.test(message)) return null;
  return message.replace(re, '$1').replace(/^\s*[:,]\s*/, '').trim();
}

export function parseCommand(text) {
  const match = /^(\w+)\s*(?:\(([^()]*)\))?\s*$/i.exec(text.trim());
  if (!match) return null;
  const type = match[1].toLowerCase();
  const args = match[2] === undefined || match[2].trim() === '' ? [] : match[2].split(',').map(x => x.trim());
  if (['stop', 'status', 'help', 'bots'].includes(type)) return args.length === 0 ? { type } : null;
  if (type === 'goto' && args.length === 3 && args.every(x => /^-?\d+(?:\.\d+)?$/.test(x))) {
    const [x, y, z] = args.map(Number);
    if (Math.abs(x) <= 29999984 && Math.abs(z) <= 29999984 && y >= -64 && y <= 319) return { type, x, y, z };
  }
  if (['railway', 'trilhos'].includes(type) && args.length === 7 && args.slice(0, 6).every(x => /^-?\d+$/.test(x))) {
    const values = args.slice(0, 6).map(Number);
    const permission = args[6].toLowerCase();
    if (values.every((value, index) => Math.abs(value) <= (index % 3 === 1 ? 319 : 29999984))
      && ['true', 'false', 'comandos', 'inventario'].includes(permission)) {
      const [startX, startY, startZ, endX, endY, endZ] = values;
      if (startY >= -64 && startY <= 319 && endY >= -64 && endY <= 319) {
        return { type: 'railway', startX, startY, startZ, endX, endY, endZ, allowCommands: ['true', 'comandos'].includes(permission) };
      }
    }
  }
  if (['follow', 'guard'].includes(type) && args.length === 1 && PLAYER_NAME.test(args[0])) return { type, player: args[0] };
  if (type === 'mode' && args.length === 1 && ['ia', 'default'].includes(args[0].toLowerCase())) return { type, mode: args[0].toLowerCase() };
  if (type === 'botremove' && args.length === 1 && PLAYER_NAME.test(args[0])) return { type, name: args[0] };
  if (type === 'botadd' && args.length >= 1 && args.length <= 3 && PLAYER_NAME.test(args[0])) {
    const mode = (args[1] ?? 'default').toLowerCase();
    const provider = args[2]?.toLowerCase();
    if (['ia', 'default'].includes(mode) && (!provider || ['openai', 'gemini', 'grok', 'claude'].includes(provider))) return { type, name: args[0], mode, provider };
  }
  if (type === 'botconfig' && args.length === 3 && PLAYER_NAME.test(args[0]) && ['mode', 'provider', 'model'].includes(args[1].toLowerCase()) && /^[a-zA-Z0-9._:/-]{1,160}$/.test(args[2])) {
    return { type, name: args[0], key: args[1].toLowerCase(), value: args[2] };
  }
  return null;
}
