import { setImmediate as yieldToServer } from 'node:timers/promises';

/** Busca limitada em corredores ortogonais, com altura resolvida por programação dinâmica. */
export async function planDescentCorridor(options, signal) {
  const { start, goal, previous, forcedFirst, heightsAt, blocked = () => false, costAt = () => 0,
    goalDistance = 0 } = options;
  if (goalDistance || !Number.isInteger(goal.y) || goal.y >= start.y
    || Math.max(Math.abs(goal.x - start.x), Math.abs(goal.z - start.z)) > 96
    || start.y - goal.y > 256) return null;
  const candidates = [
    [start, { x: goal.x, z: start.z }, goal],
    [start, { x: start.x, z: goal.z }, goal],
  ];
  const distance = Math.abs(goal.x - start.x) + Math.abs(goal.z - start.z);
  const extra = Math.max(4, Math.ceil((start.y - goal.y - distance + 4) / 2));
  for (const margin of [extra, extra + 8, extra + 16]) {
    for (const sign of [-1, 1]) {
      const x = (sign < 0 ? Math.min(start.x, goal.x) : Math.max(start.x, goal.x)) + sign * margin;
      const z = (sign < 0 ? Math.min(start.z, goal.z) : Math.max(start.z, goal.z)) + sign * margin;
      candidates.push([start, { x, z: start.z }, { x, z: goal.z }, goal]);
      candidates.push([start, { x: start.x, z }, { x: goal.x, z }, goal]);
    }
  }
  let best = null;
  for (const corners of candidates) {
    signal.throwIfAborted();
    const columns = [{ x: start.x, z: start.z }];
    for (const end of corners.slice(1)) {
      let { x, z } = columns.at(-1);
      while ((x !== end.x || z !== end.z) && columns.length <= 512) {
        x += Math.sign(end.x - x);
        z += Math.sign(end.z - z);
        columns.push({ x, z });
      }
    }
    if (columns.length > 512 || new Set(columns.map(p => `${p.x},${p.z}`)).size !== columns.length
      || columns.slice(1).some(p => blocked(p.x, p.z)
        || Math.max(Math.abs(p.x - start.x), Math.abs(p.z - start.z)) > 96)) continue;
    let states = [{ position: start, slope: previous ? start.y - previous.y : 0,
      direction: previous ? direction(previous, start) : null, cost: 0, parent: null }];
    for (let i = 1; i < columns.length && states.length; i++) {
      const next = columns[i];
      const incoming = direction(columns[i - 1], next);
      const candidatesAtColumn = new Map();
      for (const state of states) {
        // Curvas ficam planas: não podem ocupar a parte baixa de uma rampa.
        if (state.direction && state.direction !== incoming && state.slope < 0) continue;
        for (const y of heightsAt(next.x, next.z, state.position.y, state.position)) {
          if (!Number.isInteger(y) || y > state.position.y || y < state.position.y - 1 || y < goal.y
            || y - goal.y > columns.length - i - 1) continue;
          if (i === 1 && forcedFirst && (next.x !== forcedFirst.x || next.z !== forcedFirst.z
            || (Number.isInteger(forcedFirst.y) && y !== forcedFirst.y))) continue;
          const slope = y - state.position.y;
          const cost = state.cost + 1 + Math.abs(slope) * 0.75 + costAt(next.x, y, next.z);
          const key = `${y},${slope}`;
          if (cost >= (candidatesAtColumn.get(key)?.cost ?? Infinity)) continue;
          candidatesAtColumn.set(key, { position: { ...next, y }, slope, direction: incoming, cost, parent: state });
        }
      }
      states = [...candidatesAtColumn.values()];
      if (i % 8 === 0) {
        await yieldToServer(undefined, { signal });
        options.onYield?.();
      }
    }
    for (const state of states) {
      if (state.position.x !== goal.x || state.position.z !== goal.z || state.position.y !== goal.y
        || state.cost >= (best?.cost ?? Infinity)) continue;
      best = state;
    }
    await yieldToServer(undefined, { signal });
    options.onYield?.();
  }
  if (!best) return null;
  const path = [];
  for (let node = best; node; node = node.parent) path.push(node.position);
  return path.reverse();
}

function direction(from, to) { return `${Math.sign(to.x - from.x)},${Math.sign(to.z - from.z)}`; }
