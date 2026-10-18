import { PLAYER_NAME } from './commands.js';

// Health é um campo NBT de entidades vivas. Armor stands também o possuem.
// Os seletores e comandos são fixos; somente o nome validado é interpolado.
const OFFSETS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
export function railClearCommands(player) {
  if (!PLAYER_NAME.test(player)) throw new Error('Nome de jogador inválido.');
  return OFFSETS.flatMap(([x, z]) => [0, -1].map(y =>
    `/execute at ${player} as @e[type=!minecraft:player,type=!minecraft:armor_stand,distance=..16] at @s if data entity @s Health if block ~${x} ~${y} ~${z} #minecraft:rails run kill @s`));
}

export async function clearRailway(controller, player, signal) {
  controller.ensurePlayer(player);
  const commands = railClearCommands(player);
  controller.task = `limpando trilhos próximos de ${player}`;
  controller.say('Limpeza contínua ativada; requer /execute e /kill no servidor. Remove também animais e aldeões próximos dos trilhos. Use stop para parar.');
  while (true) {
    signal.throwIfAborted();
    controller.ensurePlayer(player);
    for (const command of commands) {
      signal.throwIfAborted();
      await controller.chat.command(command, {
        signal,
        beforeSend: () => controller.ensurePlayer(player),
      });
    }
  }
}
