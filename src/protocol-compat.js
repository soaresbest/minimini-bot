import minecraftData from 'minecraft-data';

// Minecraft 26.1: BeehiveBlockEntity.Occupant.STREAM_CODEC usa
// TypedEntityData.streamCodec(EntityType.STREAM_CODEC): VarInt do tipo,
// CompoundTag anônimo, ticksInHive e minTicksInHive. minecraft-data 3.117.0
// ainda descreve o componente bees com o formato anterior (somente NBT).
// Aplicar pelo customPackets oficial, sem editar node_modules ou relaxar NBT.
export function protocolCompatibility(version) {
  if (!['26.1', '26.1.1', '26.1.2'].includes(version)) return undefined;
  const data = minecraftData(version);
  const component = structuredClone(data.protocol.types.SlotComponent);
  const fields = component[1].find(field => field.name === 'data').type[1].fields;
  const beeFields = fields.bees[1][0].type[1].type[1];
  // Não duplicar o prefixo se a dependência passar a incluir a correção.
  if (beeFields[0]?.name !== 'nbtData' || beeFields[0]?.type !== 'anonymousNbt') return undefined;
  beeFields.unshift({ name: 'entityType', type: 'varint' });
  return { [data.version.majorVersion]: { types: { SlotComponent: component } } };
}
