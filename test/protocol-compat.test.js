import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { protocolCompatibility } from '../src/protocol-compat.js';

function varint(value) {
  const bytes = [];
  do { const next = value & 127; value >>>= 7; bytes.push(next | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}

// Bytes independentes do serializador: bees=77, uma abelha (tipo 11),
// CompoundTag vazio (0a00), 2925 ticks (ed16), mínimo 1200 (b009).
// Layout verificado nos codecs vanilla 26.1.2 de Occupant/TypedEntityData.
const beeComponent = Buffer.from('4d010b0a00ed16b009', 'hex');

test('compatibilidade corrige exatamente o erro 167832854 sem desativar limites NBT', () => {
  const olderSchema = structuredClone(minecraftData('1.21.11').protocol.types.SlotComponent);
  for (const version of ['1.16.5', '1.21.11', '26.2', 'auto']) assert.equal(protocolCompatibility(version), undefined);
  for (const version of ['26.1', '26.1.1', '26.1.2']) assert.ok(protocolCompatibility(version)?.['26.1']);

  // Chaves de cache distintas para comparar o leitor original e o corrigido.
  const original = minecraftProtocol.createDeserializer({ version: '26.1', state: 'play', noErrorLogging: true }).proto;
  assert.throws(() => original.read(beeComponent, 0, 'SlotComponent'), /array size is abnormally large, not reading: 167832854/);
  const options = { version: '26.1.2', state: 'play', customPackets: protocolCompatibility('26.1.2'), noErrorLogging: true };
  const fixed = minecraftProtocol.createDeserializer(options).proto;
  const result = fixed.read(beeComponent, 0, 'SlotComponent');
  assert.equal(result.size, beeComponent.length);
  assert.deepEqual(result.value.data.bees, [{ entityType: 11, nbtData: { type: 'compound', value: {} }, ticksInHive: 2925, minTicksInHive: 1200 }]);
  assert.deepEqual(fixed.createPacketBuffer('SlotComponent', result.value), beeComponent);

  // Inventário: componente seguinte continua alinhado após duas abelhas,
  // incluindo NBT não vazio (Health float = 20).
  const secondBee = Buffer.from('0b0a0500064865616c746841a000000000b009', 'hex');
  const twoBees = Buffer.concat([Buffer.from('4d02', 'hex'), beeComponent.subarray(2), secondBee]);
  const slot = Buffer.concat([
    Buffer.from([1]), varint(minecraftData('26.1.2').itemsByName.bee_nest.id),
    Buffer.from([2, 0]), twoBees, Buffer.from([3, 7]),
  ]);
  const packet = Buffer.concat([Buffer.from([0, 1, 0, 5]), slot]);
  const decoded = fixed.read(packet, 0, 'packet_set_slot');
  assert.equal(decoded.size, packet.length);
  assert.equal(decoded.value.item.components[0].data.bees.length, 2);
  assert.equal(decoded.value.item.components[0].data.bees[1].nbtData.value.Health.value, 20);
  assert.deepEqual(decoded.value.item.components[1], { type: 'damage', data: 7 });
  assert.deepEqual(fixed.createPacketBuffer('packet_set_slot', decoded.value), packet);

  // Reconexões reaproveitam o leitor corrigido; protocolos antigos não mudam.
  const reconnected = minecraftProtocol.createDeserializer({ ...options, customPackets: protocolCompatibility('26.1.2') }).proto;
  assert.equal(reconnected.read(beeComponent, 0, 'SlotComponent').size, beeComponent.length);
  assert.deepEqual(minecraftData('1.21.11').protocol.types.SlotComponent, olderSchema);
  assert.throws(() => fixed.read(Buffer.from('0b0a00ed16', 'hex'), 0, 'anonymousNbt'), /array size is abnormally large/);
  assert.throws(() => fixed.read(beeComponent.subarray(0, 4), 0, 'SlotComponent'));
});
