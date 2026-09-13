// Verifies committed src/data/combos.ts actually matches a fresh
// findBestCombos computation against the real dataset — not just that the
// app renders whatever the file happens to contain (a regression in
// precompute-combos.ts itself would otherwise ship undetected).
import { describe, expect, it } from 'vitest';
import { findBestCombos, findBestConditionalCombos } from '../src/engine/combo-engine.ts';
import { moves } from '../src/data/moves.ts';
import { pokemon } from '../src/data/pokemon.ts';
import { combos, combosNoEgg, conditionalCombos, conditionalCombosNoEgg } from '../src/data/combos.ts';
import type { Move } from '../src/data/types.ts';

function learnableFor(p: (typeof pokemon)[number]): Move[] {
  return p.learnableMoveIds.map((id) => moves[id]).filter((m): m is Move => m !== undefined);
}

describe('combos.ts matches a fresh findBestCombos computation', () => {
  // The search is fast enough now (see ARCHITECTURE-SPINE AD-12) to check
  // every Pokemon, not just a sample — a stronger regression guard for the
  // same cost as a handful used to be.
  it(
    'every Pokemon exactly matches a fresh computation',
    () => {
      const mismatches: string[] = [];
      for (const p of pokemon) {
        const fresh = findBestCombos(learnableFor(p), { topN: 5, eggMoveIds: new Set(p.eggMoveIds), moveOrigins: new Map(Object.entries(p.moveOrigins)) });
        if (JSON.stringify(combos[p.id] ?? []) !== JSON.stringify(fresh)) {
          mismatches.push(`#${p.id} ${p.name}`);
        }
      }
      expect(mismatches, `Pokemon whose committed combos don't match a fresh computation: ${mismatches.join(', ')}`).toEqual([]);
    },
    15_000,
  );

  it('every Pokemon has an entry (possibly empty, never missing) in combos.ts', () => {
    for (const p of pokemon) {
      expect(combos[p.id], `missing combos entry for #${p.id} ${p.name}`).toBeDefined();
    }
  });

  it('no Pokemon\'s combo list contains two entries that are permutations of the same 4 moves', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const list = combos[p.id] ?? [];
      const setKeys = list.map((c) => [...c.moveIds].sort().join(','));
      if (new Set(setKeys).size !== list.length) offenders.push(`#${p.id} ${p.name}`);
    }
    expect(offenders, `Pokemon with duplicate move-set entries: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('conditionalCombos.ts matches a fresh findBestConditionalCombos computation (AD-13)', () => {
  it(
    'every Pokemon exactly matches a fresh computation',
    () => {
      const mismatches: string[] = [];
      for (const p of pokemon) {
        const fresh = findBestConditionalCombos(learnableFor(p), { topN: 5, eggMoveIds: new Set(p.eggMoveIds), moveOrigins: new Map(Object.entries(p.moveOrigins)) });
        if (JSON.stringify(conditionalCombos[p.id] ?? []) !== JSON.stringify(fresh)) {
          mismatches.push(`#${p.id} ${p.name}`);
        }
      }
      expect(mismatches, `Pokemon whose committed conditional combos don't match a fresh computation: ${mismatches.join(', ')}`).toEqual([]);
    },
    90_000,
  );

  it('every Pokemon has an entry (possibly empty, never missing)', () => {
    for (const p of pokemon) {
      expect(conditionalCombos[p.id], `missing conditionalCombos entry for #${p.id} ${p.name}`).toBeDefined();
    }
  });

  it('never scores lower than the guaranteed combos list for the same Pokemon', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const guaranteedBest = combos[p.id]?.[0]?.totalScore ?? -Infinity;
      const conditionalBest = conditionalCombos[p.id]?.[0]?.totalScore ?? -Infinity;
      if (conditionalBest < guaranteedBest) offenders.push(`#${p.id} ${p.name}`);
    }
    expect(offenders, `Pokemon whose conditional best is lower than their guaranteed best: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('combosNoEgg / conditionalCombosNoEgg (AD-14)', () => {
  it(
    'every Pokemon exactly matches a fresh computation over the pool minus egg moves',
    () => {
      const mismatches: string[] = [];
      const conditionalMismatches: string[] = [];
      for (const p of pokemon) {
        const eggMoveIds = new Set(p.eggMoveIds);
        const learnableNoEgg = learnableFor(p).filter((m) => !eggMoveIds.has(m.id));
        const moveOrigins = new Map(Object.entries(p.moveOrigins));
        const fresh = findBestCombos(learnableNoEgg, { topN: 5, moveOrigins });
        if (JSON.stringify(combosNoEgg[p.id] ?? []) !== JSON.stringify(fresh)) {
          mismatches.push(`#${p.id} ${p.name}`);
        }
        const freshConditional = findBestConditionalCombos(learnableNoEgg, { topN: 5, moveOrigins });
        if (JSON.stringify(conditionalCombosNoEgg[p.id] ?? []) !== JSON.stringify(freshConditional)) {
          conditionalMismatches.push(`#${p.id} ${p.name}`);
        }
      }
      expect(mismatches, `Pokemon whose committed combosNoEgg don't match a fresh computation: ${mismatches.join(', ')}`).toEqual([]);
      expect(
        conditionalMismatches,
        `Pokemon whose committed conditionalCombosNoEgg don't match a fresh computation: ${conditionalMismatches.join(', ')}`,
      ).toEqual([]);
    },
    90_000,
  );

  it('never contains an egg move in any combo', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const eggMoveIds = new Set(p.eggMoveIds);
      const allNoEggCombos = [...(combosNoEgg[p.id] ?? []), ...(conditionalCombosNoEgg[p.id] ?? [])];
      if (allNoEggCombos.some((c) => c.moveIds.some((id) => eggMoveIds.has(id)))) {
        offenders.push(`#${p.id} ${p.name}`);
      }
    }
    expect(offenders, `Pokemon whose "no egg" combos still contain an egg move: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never scores higher than the "with egg moves" list for the same Pokemon', () => {
    // The "with egg" pool is a superset of the "no egg" pool, so its best
    // achievable score can never be lower — equivalently, "no egg" can never
    // score higher.
    const offenders: string[] = [];
    for (const p of pokemon) {
      const withEggBest = combos[p.id]?.[0]?.totalScore ?? -Infinity;
      const noEggBest = combosNoEgg[p.id]?.[0]?.totalScore ?? -Infinity;
      if (noEggBest > withEggBest) offenders.push(`#${p.id} ${p.name}`);
    }
    expect(offenders, `Pokemon whose "no egg" best exceeds their "with egg" best: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('eggSwaps (AD-14)', () => {
  it('every egg move in a "with egg" combo has at least an empty eggSwaps entry for its slot', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const eggMoveIds = new Set(p.eggMoveIds);
      for (const combo of combos[p.id] ?? []) {
        const eggSlots = combo.moveIds.map((id, i) => (eggMoveIds.has(id) ? i : -1)).filter((i) => i !== -1);
        const swapSlots = new Set(combo.eggSwaps.map((s) => s.slotIndex));
        if (eggSlots.some((i) => !swapSlots.has(i))) offenders.push(`#${p.id} ${p.name}`);
      }
    }
    expect(offenders, `Pokemon with an egg-move slot missing an eggSwaps entry: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never suggests an egg move as a swap alternative', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const eggMoveIds = new Set(p.eggMoveIds);
      for (const combo of combos[p.id] ?? []) {
        for (const swap of combo.eggSwaps) {
          if (swap.alternatives.some((a) => eggMoveIds.has(a.moveId))) offenders.push(`#${p.id} ${p.name}`);
        }
      }
    }
    expect(offenders, `Pokemon with an egg move suggested as its own swap alternative: ${offenders.join(', ')}`).toEqual([]);
  });

  it('"no egg" combos never have eggSwaps', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const all = [...(combosNoEgg[p.id] ?? []), ...(conditionalCombosNoEgg[p.id] ?? [])];
      if (all.some((c) => c.eggSwaps.length > 0)) offenders.push(`#${p.id} ${p.name}`);
    }
    expect(offenders, `Pokemon whose "no egg" combos unexpectedly have eggSwaps: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('levelSwaps (AD-15)', () => {
  it('every level-up-gated move in a combo has a levelSwaps entry for its slot', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      const allLists = [...(combos[p.id] ?? []), ...(combosNoEgg[p.id] ?? []), ...(conditionalCombos[p.id] ?? []), ...(conditionalCombosNoEgg[p.id] ?? [])];
      for (const combo of allLists) {
        const gatedSlots = combo.moveIds
          .map((id, i) => (p.moveOrigins[id]?.method === 'level-up' ? i : -1))
          .filter((i) => i !== -1);
        const swapSlots = new Set(combo.levelSwaps.map((s) => s.slotIndex));
        if (gatedSlots.some((i) => !swapSlots.has(i))) offenders.push(`#${p.id} ${p.name}`);
      }
    }
    expect(offenders, `Pokemon with a level-gated slot missing a levelSwaps entry: ${offenders.join(', ')}`).toEqual([]);
  });

  it('sorts levelSwaps alternatives ascending by required level', () => {
    const offenders: string[] = [];
    for (const p of pokemon) {
      for (const combo of combos[p.id] ?? []) {
        for (const swap of combo.levelSwaps) {
          const levels = swap.alternatives.map((a) => a.requiredLevel);
          const sorted = [...levels].sort((a, b) => a - b);
          if (JSON.stringify(levels) !== JSON.stringify(sorted)) offenders.push(`#${p.id} ${p.name}`);
        }
      }
    }
    expect(offenders, `Pokemon with levelSwaps alternatives not sorted ascending by required level: ${offenders.join(', ')}`).toEqual([]);
  });
});
