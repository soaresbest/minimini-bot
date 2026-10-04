const KNOWN_FULL_SUPPORTS = new Set([
  'stone', 'cobblestone', 'dirt', 'grass_block', 'redstone_block', 'bedrock',
]);

/** Conservador: colisão parcial não significa uma face capaz de sustentar trilhos. */
export function supportsRail(block) {
  if (!block || block.name.endsWith('_leaves') || block.name === 'leaves' || block.name === 'leaves2') return false;
  // Soul sand tem forma de apoio completa, apesar da colisão mais baixa.
  if (block.name === 'soul_sand') return true;
  if (!Array.isArray(block.shapes)) return KNOWN_FULL_SUPPORTS.has(block.name);
  const top = block.shapes.filter(box => box.length === 6 && Math.abs(box[4] - 1) < 1e-7);
  if (!top.length) return false;
  // O apoio rígido usado por trilhos exige o anel externo de 2/16 blocos.
  // A união permite, por exemplo, a borda de um funil sem exigir centro cheio.
  const cuts = axis => [...new Set([0, 1 / 8, 7 / 8, 1,
    ...top.flatMap(box => [box[axis], box[axis + 3]])].filter(v => v >= 0 && v <= 1))].sort((a, b) => a - b);
  const xs = cuts(0), zs = cuts(2);
  for (let x = 1; x < xs.length; x++) {
    for (let z = 1; z < zs.length; z++) {
      const mx = (xs[x - 1] + xs[x]) / 2, mz = (zs[z - 1] + zs[z]) / 2;
      if (mx > 1 / 8 && mx < 7 / 8 && mz > 1 / 8 && mz < 7 / 8) continue;
      if (!top.some(box => box[0] <= mx && box[3] >= mx && box[2] <= mz && box[5] >= mz)) return false;
    }
  }
  return true;
}
