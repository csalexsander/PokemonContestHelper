import { describe, expect, it } from 'vitest';
import { findBestCombos, findBestConditionalCombos, findEggMoveSwaps, findLevelSwaps, scoreCombo, scoreConditionalCombo } from './combo-engine.ts';
import type { Move, MoveOrigin } from '../data/index.ts';

function move(overrides: Partial<Move> & { id: string }): Move {
  return {
    name: overrides.id,
    category: 'cool',
    appealPoints: 1,
    positionEffect: { kind: 'none' },
    repeatable: false,
    description: '',
    ...overrides,
  };
}

describe('scoreCombo', () => {
  it('sums plain appealPoints with no effects', () => {
    const moves = [move({ id: 'a', appealPoints: 2 }), move({ id: 'b', appealPoints: 3 })];
    const byId = new Map(moves.map((m) => [m.id, m]));
    expect(scoreCombo(['a', 'b', 'a', 'b'], byId)).toBe(2 + 3 + 2 + 3);
  });

  it('applies an additive first-turn bonus in slot 0 (the accepted opening bet)', () => {
    const bonusFirst = move({ id: 'bonus', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 5 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([bonusFirst, filler].map((m) => [m.id, m]));
    expect(scoreCombo(['bonus', 'filler', 'filler', 'filler'], byId)).toBe(2 + 5 + 1 + 1 + 1);
    // Wait: 'filler' repeated 3x is illegal in real play, but scoreCombo itself
    // is a pure scoring function and does not enforce legality (findBestCombos does).
  });

  it('does not apply a first-turn bonus outside slot 0 unless granted', () => {
    const bonusFirst = move({ id: 'bonus', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 5 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([bonusFirst, filler].map((m) => [m.id, m]));
    expect(scoreCombo(['filler', 'bonus', 'filler', 'filler'], byId)).toBe(1 + 2 + 1 + 1);
  });

  it('chains sets-first-next-turn into the following bonus-if-first move', () => {
    const setter = move({ id: 'setter', appealPoints: 1, positionEffect: { kind: 'sets-first-next-turn' } });
    const bonusFirst = move({ id: 'bonus', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 5 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([setter, bonusFirst, filler].map((m) => [m.id, m]));
    // slot0=setter(1), slot1=bonus gets first-bonus because slot0 granted it: 2+5=7
    expect(scoreCombo(['setter', 'bonus', 'filler', 'filler'], byId)).toBe(1 + 7 + 1 + 1);
  });

  it('wastes sets-first-next-turn placed in the last slot (no slot to grant it to)', () => {
    const setter = move({ id: 'setter', appealPoints: 1, positionEffect: { kind: 'sets-first-next-turn' } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([setter, filler].map((m) => [m.id, m]));
    expect(scoreCombo(['filler', 'filler', 'filler', 'setter'], byId)).toBe(1 + 1 + 1 + 1);
  });

  it('does NOT apply a last-turn bonus at the final slot on its own (AD-11) — real performance order is opponent-relative', () => {
    const bonusLast = move({ id: 'bonus', appealPoints: 3, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([bonusLast, filler].map((m) => [m.id, m]));
    // Unlike bonus-if-first at slot 0, bonus-if-last at slot 3 is NOT free —
    // nothing here grants "last", so it scores as plain appealPoints (3), not doubled (6).
    expect(scoreCombo(['filler', 'filler', 'filler', 'bonus'], byId)).toBe(1 + 1 + 1 + 3);
  });

  it('only applies a last-turn bonus when the previous move explicitly grants it', () => {
    const setter = move({ id: 'setter', appealPoints: 1, positionEffect: { kind: 'sets-last-next-turn' } });
    const bonusLast = move({ id: 'bonus', appealPoints: 3, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([setter, bonusLast, filler].map((m) => [m.id, m]));
    // slot1=bonus gets the last-bonus because slot0 (setter) granted it, even mid-combo.
    expect(scoreCombo(['setter', 'bonus', 'filler', 'filler'], byId)).toBe(1 + 6 + 1 + 1);
  });

  it('doubles the next move\'s score when that move has no scoring effect of its own', () => {
    const doubler = move({ id: 'doubler', appealPoints: 1, positionEffect: { kind: 'doubles-next-move' } });
    const filler = move({ id: 'filler', appealPoints: 2 });
    const byId = new Map([doubler, filler].map((m) => [m.id, m]));
    expect(scoreCombo(['doubler', 'filler', 'filler', 'filler'], byId)).toBe(1 + 4 + 2 + 2);
  });

  it('scores an out-of-scope-conditional move as base appealPoints only', () => {
    const conditional = move({ id: 'cond', appealPoints: 5, positionEffect: { kind: 'out-of-scope-conditional' } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([conditional, filler].map((m) => [m.id, m]));
    expect(scoreCombo(['cond', 'filler', 'filler', 'filler'], byId)).toBe(5 + 1 + 1 + 1);
  });

  it('rejects a sequence that is not exactly 4 moves', () => {
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([filler].map((m) => [m.id, m]));
    expect(() => scoreCombo(['filler', 'filler', 'filler'], byId)).toThrow(/exactly 4/);
  });

  describe('no double-multiplier stacking (AD-17)', () => {
    it('does not double a move with its own multiplicative bonus-if-last effect (Psych Up -> Assurance-style), even when that effect fires', () => {
      const doubler = move({ id: 'doubler', appealPoints: 0, positionEffect: { kind: 'doubles-next-move' } });
      const assuranceLike = move({ id: 'assurance', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } });
      const filler = move({ id: 'filler', appealPoints: 1 });
      const byId = new Map([doubler, assuranceLike, filler].map((m) => [m.id, m]));
      // slot1 = assurance-like, immediately after doubler. Its own bonus
      // doesn't fire here (doubler grants "double", not "last") — and per
      // AD-17 it ALSO cannot receive the granted double, since its KIND
      // (bonus-if-last) already has a scoring effect of its own. Confirms
      // the rule using AD-18's corrected (opponent-relative) bonus-if-last
      // model, in place of the reverted bonus-if-final-move.
      expect(scoreCombo(['doubler', 'assurance', 'filler', 'filler'], byId)).toBe(0 + 2 + 1 + 1);
    });

    it('does not double a move with a bonus-if-first/bonus-if-last kind, even in a slot where that bonus does not actually fire', () => {
      const doubler = move({ id: 'doubler', appealPoints: 0, positionEffect: { kind: 'doubles-next-move' } });
      const bonusFirst = move({ id: 'bonus', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 5 } });
      const filler = move({ id: 'filler', appealPoints: 1 });
      const byId = new Map([doubler, bonusFirst, filler].map((m) => [m.id, m]));
      // slot1 = bonus: the +5 doesn't fire here (doubler grants "double", not
      // "first") — but the grant is still wasted, not redirected into
      // doubling the plain base points, since the move's KIND itself (not
      // just whether it happens to fire this turn) disqualifies it from
      // receiving a double (per the user: a double must land on a move with
      // no points/doubling effect of its own, to avoid the ambiguity of
      // ever stacking two multipliers on it).
      expect(scoreCombo(['doubler', 'bonus', 'filler', 'filler'], byId)).toBe(0 + 2 + 1 + 1);
    });

    it('still doubles a sets-last-next-turn SETTER — it modifies the NEXT move, not its own points, so there is no stacking conflict', () => {
      const doubler = move({ id: 'doubler', appealPoints: 1, positionEffect: { kind: 'doubles-next-move' } });
      const setter = move({ id: 'setter', appealPoints: 2, positionEffect: { kind: 'sets-last-next-turn' } });
      const filler = move({ id: 'filler', appealPoints: 1 });
      const byId = new Map([doubler, setter, filler].map((m) => [m.id, m]));
      expect(scoreCombo(['doubler', 'setter', 'filler', 'filler'], byId)).toBe(1 + 4 + 1 + 1);
    });
  });
});

describe('findBestCombos', () => {
  it('chains a sets-last-next-turn setter into a multiplicative bonus-if-last move (Assurance-style, AD-18) as a GUARANTEED combo', () => {
    const setter = move({ id: 'setter', appealPoints: 1, positionEffect: { kind: 'sets-last-next-turn' } });
    const assuranceLike = move({ id: 'assurance', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } });
    const a = move({ id: 'a', appealPoints: 1 });
    const b = move({ id: 'b', appealPoints: 1 });
    const [best] = findBestCombos([setter, assuranceLike, a, b], { topN: 1 });
    const setterIdx = best.moveIds.indexOf('setter');
    expect(best.moveIds[setterIdx + 1]).toBe('assurance');
    expect(best.totalScore).toBe(1 + 4 + 1 + 1);
  });

  it('returns [] when there are fewer than 4 learnable moves and none are repeatable', () => {
    const moves = [move({ id: 'a' }), move({ id: 'b' }), move({ id: 'c' })];
    expect(findBestCombos(moves)).toEqual([]);
  });

  it('returns [] for an empty move pool', () => {
    expect(findBestCombos([])).toEqual([]);
  });

  it('forms legal combos from 3 moves when one is repeatable', () => {
    const moves = [move({ id: 'a', repeatable: true }), move({ id: 'b' }), move({ id: 'c' })];
    const results = findBestCombos(moves);
    expect(results.length).toBeGreaterThan(0);
    for (const combo of results) {
      expect(combo.moveIds).toHaveLength(4);
    }
  });

  it('never places a non-repeatable move more than once', () => {
    const moves = [move({ id: 'a' }), move({ id: 'b' }), move({ id: 'c' }), move({ id: 'd' })];
    const results = findBestCombos(moves, { topN: 20 });
    for (const combo of results) {
      const counts = new Map<string, number>();
      for (const id of combo.moveIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [, count] of counts) expect(count).toBeLessThanOrEqual(1);
    }
  });

  it('allows a repeatable move twice only in adjacent slots', () => {
    const repeatable = move({ id: 'rep', appealPoints: 100, repeatable: true });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const results = findBestCombos([repeatable, filler], { topN: 50 });
    for (const combo of results) {
      const positions = combo.moveIds.reduce<number[]>((acc, id, i) => (id === 'rep' ? [...acc, i] : acc), []);
      expect(positions.length).toBeLessThanOrEqual(2);
      if (positions.length === 2) expect(positions[1] - positions[0]).toBe(1);
    }
  });

  it('finds the true optimum on a small pool (brute-force cross-check)', () => {
    const moves = [
      move({ id: 'a', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 3 } }),
      move({ id: 'b', appealPoints: 4, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } }),
      move({ id: 'c', appealPoints: 2, positionEffect: { kind: 'sets-last-next-turn' } }),
      move({ id: 'd', appealPoints: 1, repeatable: true }),
      move({ id: 'e', appealPoints: 3 }),
    ];
    const byId = new Map(moves.map((m) => [m.id, m]));

    // Brute-force every legal ordered 4-tuple (small pool, fine for a test).
    let bruteBest = -Infinity;
    function isLegal(seq: string[]): boolean {
      const counts = new Map<string, number[]>();
      seq.forEach((id, i) => counts.set(id, [...(counts.get(id) ?? []), i]));
      for (const [id, idxs] of counts) {
        if (idxs.length > 2) return false;
        if (idxs.length === 2) {
          if (!byId.get(id)!.repeatable) return false;
          if (idxs[1] - idxs[0] !== 1) return false;
        }
      }
      return true;
    }
    for (const a of moves) for (const b of moves) for (const c of moves) for (const d of moves) {
      const seq = [a.id, b.id, c.id, d.id];
      if (!isLegal(seq)) continue;
      bruteBest = Math.max(bruteBest, scoreCombo(seq, byId));
    }

    const [best] = findBestCombos(moves, { topN: 1 });
    expect(best.totalScore).toBe(bruteBest);
  });

  it('finds the true top-5 ranked list on a small pool (brute-force cross-check, ranks 2-5)', () => {
    // Same idea as the rank-1 cross-check above, but verifies the FULL
    // reported ranking, not just the best entry — the kind-pattern rewrite's
    // CANDIDATES_PER_SLOT collision-resolution logic could in principle
    // under-select or misrank an entry beyond rank 1 without this failing
    // (found in review: no prior test computed an independent ground truth
    // for topN > 1).
    const moves = [
      move({ id: 'a', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 3 } }),
      move({ id: 'b', appealPoints: 4, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } }),
      move({ id: 'c', appealPoints: 2, positionEffect: { kind: 'sets-last-next-turn' } }),
      move({ id: 'd', appealPoints: 1, repeatable: true }),
      move({ id: 'e', appealPoints: 3 }),
      move({ id: 'f', appealPoints: 3, positionEffect: { kind: 'sets-first-next-turn' } }),
      move({ id: 'g', appealPoints: 2 }),
    ];
    const byId = new Map(moves.map((m) => [m.id, m]));

    function isLegal(seq: string[]): boolean {
      const counts = new Map<string, number[]>();
      seq.forEach((id, i) => counts.set(id, [...(counts.get(id) ?? []), i]));
      for (const [id, idxs] of counts) {
        if (idxs.length > 2) return false;
        if (idxs.length === 2) {
          if (!byId.get(id)!.repeatable) return false;
          if (idxs[1] - idxs[0] !== 1) return false;
        }
      }
      return true;
    }

    // Brute-force every legal ordered 4-tuple, reduce to the best score per
    // distinct move SET (findBestCombos never returns two permutations of
    // the same set — see `admit`'s dedup), then take the true top 5 sets.
    const bestScorePerSet = new Map<string, number>();
    for (const a of moves) for (const b of moves) for (const c of moves) for (const d of moves) {
      const seq = [a.id, b.id, c.id, d.id];
      if (!isLegal(seq)) continue;
      const setKey = [...seq].sort().join(',');
      const score = scoreCombo(seq, byId);
      if (score > (bestScorePerSet.get(setKey) ?? -Infinity)) bestScorePerSet.set(setKey, score);
    }
    const trueTop5Scores = [...bestScorePerSet.values()].sort((x, y) => y - x).slice(0, 5);

    const results = findBestCombos(moves, { topN: 5 });
    expect(results.map((r) => r.totalScore)).toEqual(trueTop5Scores);
  });

  it('is unaffected by a move\'s category — score comes only from positionEffect (AD-8)', () => {
    // Same moves, same appealPoints/effects, differing only in cosmetic `category`.
    const withCategory = [
      move({ id: 'a', appealPoints: 3, category: 'beauty' }),
      move({ id: 'b', appealPoints: 2, category: 'tough' }),
      move({ id: 'c', appealPoints: 4, category: 'cute' }),
      move({ id: 'd', appealPoints: 1, category: 'smart' }),
    ];
    const allCool = withCategory.map((m) => ({ ...m, category: 'cool' as const }));

    const [best1] = findBestCombos(withCategory, { topN: 1 });
    const [best2] = findBestCombos(allCool, { topN: 1 });
    expect(best1.totalScore).toBe(best2.totalScore);
    expect(best1.moveIds).toEqual(best2.moveIds);
  });

  it('clamps a zero or negative topN to at least 1 instead of throwing', () => {
    const moves = [move({ id: 'a' }), move({ id: 'b' }), move({ id: 'c' }), move({ id: 'd' })];
    expect(() => findBestCombos(moves, { topN: 0 })).not.toThrow();
    expect(findBestCombos(moves, { topN: 0 }).length).toBe(1);
    expect(() => findBestCombos(moves, { topN: -5 })).not.toThrow();
  });

  it('treats duplicate move objects sharing an id as a single candidate', () => {
    const a1 = move({ id: 'a', appealPoints: 1 });
    const a2 = move({ id: 'a', appealPoints: 1 }); // same id, distinct object — should not double-count as two pool slots
    const b = move({ id: 'b' });
    const c = move({ id: 'c' });
    const results = findBestCombos([a1, a2, b, c], { topN: 20 });
    for (const combo of results) {
      const aCount = combo.moveIds.filter((id) => id === 'a').length;
      expect(aCount).toBeLessThanOrEqual(1); // 'a' is not repeatable, so at most once despite two input objects
    }
  });

  it('allows two different repeatable moves to each appear twice in the same combo', () => {
    const repA = move({ id: 'repA', appealPoints: 3, repeatable: true });
    const repB = move({ id: 'repB', appealPoints: 2, repeatable: true });
    const results = findBestCombos([repA, repB], { topN: 10 });
    const hasAABB = results.some((c) => c.moveIds.join(',') === 'repA,repA,repB,repB' || c.moveIds.join(',') === 'repB,repB,repA,repA');
    expect(hasAABB).toBe(true);
  });

  it('never returns two entries that are permutations of the same 4 moves (distinct move sets only)', () => {
    // No position effects at all — every ordering of any 4 moves ties on
    // score, so without move-set dedup the naive DFS would return the same
    // 4 moves reordered N times instead of N genuinely different options
    // (found in review: this happened for ~15% of the real Gen4 dataset,
    // e.g. Caterpie's committed top-5 was one move set repeated 5x).
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => move({ id, appealPoints: 1 }));
    const results = findBestCombos(pool, { topN: 3 });
    const setKeys = results.map((r) => [...r.moveIds].sort().join(','));
    expect(new Set(setKeys).size).toBe(results.length);
  });

  it('returns fewer than topN when there are not enough distinct legal move sets', () => {
    // Only 5 moves, none repeatable -> exactly 5 distinct 4-move sets exist (choose 4 of 5).
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => move({ id, appealPoints: 1 }));
    const results = findBestCombos(pool, { topN: 10 });
    expect(results.length).toBe(5);
  });

  it('rejects NaN topN by falling back to the default instead of throwing', () => {
    const moves = [move({ id: 'a' }), move({ id: 'b' }), move({ id: 'c' }), move({ id: 'd' })];
    expect(() => findBestCombos(moves, { topN: Number.NaN })).not.toThrow();
    expect(findBestCombos(moves, { topN: Number.NaN }).length).toBe(1); // only 1 distinct set possible from exactly 4 moves
  });

  it('completes quickly on a large, realistic movepool', () => {
    // Unique appealPoints per move (not cycling through a handful of
    // values) so the pool isn't dominated by mass ties — a large pool of
    // near-identical moves is an intentionally pathological case for the
    // move-set dedup in `admit` (many permutations of many
    // equal-scoring sets), covered separately and with a looser budget
    // below; this test targets the realistic case Gen4 movepools actually
    // look like, where appeal points and effects vary move to move.
    const large = Array.from({ length: 80 }, (_, i) =>
      move({ id: `m${i}`, appealPoints: i + 1, category: (['beauty', 'cool', 'cute', 'smart', 'tough'] as const)[i % 5] }),
    );
    const start = performance.now();
    const results = findBestCombos(large, { topN: 5 });
    const elapsed = performance.now() - start;
    expect(results.length).toBe(5);
    expect(elapsed).toBeLessThan(2000);
  });

  it(
    'still completes in a bounded time on a large, heavily-tied movepool (pathological for move-set dedup)',
    () => {
      const large = Array.from({ length: 80 }, (_, i) =>
        move({ id: `m${i}`, appealPoints: (i % 7) + 1, category: (['beauty', 'cool', 'cute', 'smart', 'tough'] as const)[i % 5] }),
      );
      const start = performance.now();
      const results = findBestCombos(large, { topN: 5 });
      const elapsed = performance.now() - start;
      expect(results.length).toBe(5);
      // Looser budget: many-way ties are the worst case for the move-set
      // dedup (see src/engine/combo-engine.ts admit) and don't reflect
      // real Gen4 movepools, but this must still terminate in reasonable time
      // since precompute-combos.ts (AD-10) runs this once per Pokemon.
      expect(elapsed).toBeLessThan(15_000);
    },
    20_000,
  );
});

describe('scoreConditionalCombo', () => {
  it('treats a multiplicative bonus-if-last move (Assurance-style, AD-18) as an opponent-relative conditional bet, not a structural guarantee', () => {
    const filler = move({ id: 'filler', appealPoints: 1 });
    const doubler = move({ id: 'doubler', appealPoints: 0, positionEffect: { kind: 'doubles-next-move' } });
    const assuranceLike = move({ id: 'assurance', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } });
    const byId = new Map([filler, doubler, assuranceLike].map((m) => [m.id, m]));
    // slot2 (filler) is doubled by the doubler at slot1 -> elevated -> slot3
    // (assurance-like) may freely assume "best scorer" luck (AD-13),
    // earning its own ×2 as a CONDITIONAL bet — NOT the unconditional
    // structural guarantee the reverted AD-16 model would have granted
    // simply for being in slot 3.
    const { totalScore, conditions } = scoreConditionalCombo(['filler', 'doubler', 'filler', 'assurance'], byId);
    expect(totalScore).toBe(1 + 0 + 2 + 4);
    expect(conditions).toEqual([{ slotIndex: 3, requires: 'last' }]);
  });

  it('matches scoreCombo when no slot benefits from an assumed position', () => {
    const moves = [move({ id: 'a', appealPoints: 2 }), move({ id: 'b', appealPoints: 3 })];
    const byId = new Map(moves.map((m) => [m.id, m]));
    const seq = ['a', 'b', 'a', 'b'];
    expect(scoreConditionalCombo(seq, byId).totalScore).toBe(scoreCombo(seq, byId));
    expect(scoreConditionalCombo(seq, byId).conditions).toEqual([]);
  });

  it('reproduces the reported Quilava-style example: Fire Blast -> Frustration -> Double Team -> Fire Blast', () => {
    // Real-world worked example: Frustration (bonus-if-last) has nothing
    // granting it "last" explicitly, but the player COULD have been the top
    // scorer the previous turn — a real, non-guaranteed possibility this
    // model now surfaces (AD-13). Double Team -> Fire Blast is the
    // unconditional part (guaranteed by sets-first-next-turn, unchanged).
    const fireBlast = move({ id: 'fire-blast', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const frustration = move({ id: 'frustration', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 2 } });
    const doubleTeam = move({ id: 'double-team', appealPoints: 2, positionEffect: { kind: 'sets-first-next-turn' } });
    const byId = new Map([fireBlast, frustration, doubleTeam].map((m) => [m.id, m]));

    const { totalScore, conditions } = scoreConditionalCombo(['fire-blast', 'frustration', 'double-team', 'fire-blast'], byId);
    // slot0 Fire Blast: first (free opening bet) -> 2+2=4
    // slot1 Frustration: NOT guaranteed -> best-case assumes "last" -> 2+2=4 (conditional)
    // slot2 Double Team: no position benefit itself -> 2 (grants next slot "first")
    // slot3 Fire Blast: first is GUARANTEED by Double Team -> 2+2=4 (not conditional)
    expect(totalScore).toBe(4 + 4 + 2 + 4);
    expect(conditions).toEqual([{ slotIndex: 1, requires: 'last' }]);
  });

  it('does not mark a slot conditional when assuming a position would not have changed its score', () => {
    const plain = move({ id: 'plain', appealPoints: 5 }); // no positionEffect bonus either way
    const byId = new Map([plain].map((m) => [m.id, m]));
    const { conditions } = scoreConditionalCombo(['plain', 'plain', 'plain', 'plain'], byId);
    expect(conditions).toEqual([]);
  });

  it('rejects a sequence that is not exactly 4 moves', () => {
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([filler].map((m) => [m.id, m]));
    expect(() => scoreConditionalCombo(['filler', 'filler', 'filler'], byId)).toThrow(/exactly 4/);
  });
});

describe('findBestConditionalCombos', () => {
  it('returns [] for an empty move pool', () => {
    expect(findBestConditionalCombos([])).toEqual([]);
  });

  it('never scores lower than the guaranteed findBestCombos best for the same pool', () => {
    // The conditional model is a strict superset of achievable contexts, so
    // its best score can never be worse than the guaranteed model's best.
    const moves = [
      move({ id: 'a', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 3 } }),
      move({ id: 'b', appealPoints: 4, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } }),
      move({ id: 'c', appealPoints: 2, positionEffect: { kind: 'sets-last-next-turn' } }),
      move({ id: 'd', appealPoints: 1, repeatable: true }),
      move({ id: 'e', appealPoints: 3 }),
    ];
    const [guaranteedBest] = findBestCombos(moves, { topN: 1 });
    const [conditionalBest] = findBestConditionalCombos(moves, { topN: 1 });
    expect(conditionalBest.totalScore).toBeGreaterThanOrEqual(guaranteedBest.totalScore);
  });

  it('finds the true best conditional score on a small pool (brute-force cross-check)', () => {
    const moves = [
      move({ id: 'a', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 3 } }),
      move({ id: 'b', appealPoints: 4, positionEffect: { kind: 'bonus-if-last', op: 'multiply', amount: 2 } }),
      move({ id: 'c', appealPoints: 2, positionEffect: { kind: 'sets-last-next-turn' } }),
      move({ id: 'd', appealPoints: 1, repeatable: true }),
      move({ id: 'e', appealPoints: 3 }),
      move({ id: 'f', appealPoints: 2, positionEffect: { kind: 'doubles-next-move' } }),
    ];
    const byId = new Map(moves.map((m) => [m.id, m]));

    function isLegal(seq: string[]): boolean {
      const counts = new Map<string, number[]>();
      seq.forEach((id, i) => counts.set(id, [...(counts.get(id) ?? []), i]));
      for (const [id, idxs] of counts) {
        if (idxs.length > 2) return false;
        if (idxs.length === 2) {
          if (!byId.get(id)!.repeatable) return false;
          if (idxs[1] - idxs[0] !== 1) return false;
        }
      }
      return true;
    }

    let bruteBest = -Infinity;
    for (const a of moves) for (const b of moves) for (const c of moves) for (const d of moves) {
      const seq = [a.id, b.id, c.id, d.id];
      if (!isLegal(seq)) continue;
      const { totalScore, conditions } = scoreConditionalCombo(seq, byId);
      // Mirrors the search's own cap (at most 1 freely-assumed turn per
      // combo, AD-13) — without it, this brute force would compare against
      // scores the search deliberately never surfaces.
      if (conditions.length > 1) continue;
      bruteBest = Math.max(bruteBest, totalScore);
    }

    const [best] = findBestConditionalCombos(moves, { topN: 1 });
    expect(best.totalScore).toBe(bruteBest);
    // The returned combo's own conditions must justify its claimed score.
    expect(scoreConditionalCombo(best.moveIds, byId).totalScore).toBe(best.totalScore);
  });

  it('never recommends a combo relying on more than one freely-assumed turn (AD-13)', () => {
    // A chain where each conditional bet is legitimately enabled by the
    // previous slot's own elevation (slot0's guaranteed first-bonus enables
    // slot1's bet; slot1's bet, if it fires, enables slot2's bet too) — two
    // independent-but-plausible bets stacked in one combo, which the cap
    // still refuses to recommend as a single "coherent" strategy.
    const firstMove = move({ id: 'first-move', appealPoints: 1, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 5 } });
    const bonusLastA = move({ id: 'bonus-a', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 5 } });
    const bonusLastB = move({ id: 'bonus-b', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 5 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const pool = [firstMove, bonusLastA, bonusLastB, filler];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const results = findBestConditionalCombos(pool, { topN: 10 });
    for (const combo of results) {
      expect(combo.conditions.length).toBeLessThanOrEqual(1);
      expect(scoreConditionalCombo(combo.moveIds, byId).conditions.length).toBeLessThanOrEqual(1);
    }
    // Sanity: the 2-condition sequence really is legitimately chained (both
    // bets enabled) and WOULD score higher if the cap allowed it — confirms
    // the cap is actually doing something, not vacuously true.
    const twoConditionScore = scoreConditionalCombo(['first-move', 'bonus-a', 'bonus-b', 'filler'], byId);
    expect(twoConditionScore.conditions.length).toBe(2);
    expect(results.some((c) => c.totalScore >= twoConditionScore.totalScore)).toBe(false);
  });

  it('does not credit a conditional bet after a plain, non-elevated turn (plausibility chaining)', () => {
    // Neither slot0 nor slot1 here ever gets elevated (both are neutral
    // fillers with no bonus/doubling), so bonus-if-last at slot2 must NOT
    // be credited — winning that turn isn't plausible off two flat turns.
    const filler = move({ id: 'filler', appealPoints: 3 });
    const filler2 = move({ id: 'filler2', appealPoints: 3 });
    const bonusLast = move({ id: 'bonus-last', appealPoints: 2, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 5 } });
    const filler3 = move({ id: 'filler3', appealPoints: 1 });
    const byId = new Map([filler, filler2, bonusLast, filler3].map((m) => [m.id, m]));
    const { conditions, totalScore } = scoreConditionalCombo(['filler', 'filler2', 'bonus-last', 'filler3'], byId);
    expect(conditions).toEqual([]);
    expect(totalScore).toBe(3 + 3 + 2 + 1); // bonus-last scores only its base appealPoints
  });

  it('never returns two entries that are permutations of the same 4 moves', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => move({ id, appealPoints: 1 }));
    const results = findBestConditionalCombos(pool, { topN: 3 });
    const setKeys = results.map((r) => [...r.moveIds].sort().join(','));
    expect(new Set(setKeys).size).toBe(results.length);
  });

  it('clamps topN the same way findBestCombos does', () => {
    const moves = [move({ id: 'a' }), move({ id: 'b' }), move({ id: 'c' }), move({ id: 'd' })];
    expect(() => findBestConditionalCombos(moves, { topN: 0 })).not.toThrow();
    expect(findBestConditionalCombos(moves, { topN: 0 }).length).toBe(1);
  });
});

describe('findEggMoveSwaps', () => {
  it('returns [] when the combo has no egg moves', () => {
    const a = move({ id: 'a' });
    const b = move({ id: 'b' });
    const c = move({ id: 'c' });
    const d = move({ id: 'd' });
    const byId = new Map([a, b, c, d].map((m) => [m.id, m]));
    const swaps = findEggMoveSwaps(['a', 'b', 'c', 'd'], byId, new Set(), [a, b, c, d], (ids) => scoreCombo(ids, byId));
    expect(swaps).toEqual([]);
  });

  it('suggests only non-egg moves of the SAME positionEffect.kind, sorted best-first', () => {
    const eggMove = move({ id: 'egg', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const weakerAlt = move({ id: 'weaker', appealPoints: 1, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const strongerAlt = move({ id: 'stronger', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const wrongKind = move({ id: 'wrong-kind', appealPoints: 9, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 2 } });
    const otherEgg = move({ id: 'other-egg', appealPoints: 9, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const pool = [eggMove, weakerAlt, strongerAlt, wrongKind, otherEgg, filler];
    const eggMoveIds = new Set(['egg', 'other-egg']);

    const filler2 = move({ id: 'filler2', appealPoints: 1 });
    const filler3 = move({ id: 'filler3', appealPoints: 1 });
    const fullPool = [...pool, filler2, filler3];
    const fullById = new Map(fullPool.map((m) => [m.id, m]));
    const sequence = ['egg', 'filler', 'filler2', 'filler3'];

    const swaps = findEggMoveSwaps(sequence, fullById, eggMoveIds, fullPool, (ids) => scoreCombo(ids, fullById));
    expect(swaps).toHaveLength(1);
    expect(swaps[0].slotIndex).toBe(0);
    const altIds = swaps[0].alternatives.map((a) => a.moveId);
    expect(altIds).toContain('weaker');
    expect(altIds).toContain('stronger');
    expect(altIds).not.toContain('wrong-kind'); // different positionEffect.kind
    expect(altIds).not.toContain('other-egg'); // never suggests another egg move
    expect(altIds).not.toContain('egg'); // never suggests itself
    // Sorted best-first by resulting totalScore.
    expect(swaps[0].alternatives[0].moveId).toBe('stronger');
  });

  it('excludes a substitute that would make the sequence illegal', () => {
    const eggMove = move({ id: 'egg', appealPoints: 1, positionEffect: { kind: 'none' } });
    const collidingAlt = move({ id: 'filler', appealPoints: 9, positionEffect: { kind: 'none' } }); // already at slot 2 — using it at slot 0 too would be a non-adjacent illegal repeat
    const legalAlt = move({ id: 'legal-alt', appealPoints: 3, positionEffect: { kind: 'none' } });
    const b = move({ id: 'b', appealPoints: 1 });
    const c = move({ id: 'c', appealPoints: 1 });
    const pool = [eggMove, collidingAlt, legalAlt, b, c];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const legalSequence = ['egg', 'b', 'filler', 'c'];
    const swaps = findEggMoveSwaps(legalSequence, byId, new Set(['egg']), pool, (ids) => scoreCombo(ids, byId));
    expect(swaps).toHaveLength(1);
    const altIds = swaps[0].alternatives.map((a) => a.moveId);
    expect(altIds).not.toContain('filler'); // filler already occupies slot 2 (non-adjacent to slot 0) — illegal repeat
    expect(altIds).toContain('legal-alt');
  });

  it('rejects a sequence that is not exactly 4 moves', () => {
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([filler].map((m) => [m.id, m]));
    expect(() => findEggMoveSwaps(['filler', 'filler'], byId, new Set(), [filler], (ids) => scoreCombo(ids, byId))).toThrow(/exactly 4/);
  });
});

describe('findBestCombos / findBestConditionalCombos with eggMoveIds', () => {
  it('attaches eggSwaps only when eggMoveIds is provided', () => {
    const eggMove = move({ id: 'egg', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const alt = move({ id: 'alt', appealPoints: 3, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const b = move({ id: 'b', appealPoints: 1 });
    const c = move({ id: 'c', appealPoints: 1 });
    const pool = [eggMove, alt, b, c];

    const withoutOption = findBestCombos(pool, { topN: 1 });
    expect(withoutOption[0].eggSwaps).toEqual([]);

    const withOption = findBestCombos(pool, { topN: 1, eggMoveIds: new Set(['egg']) });
    if (withOption[0].moveIds.includes('egg')) {
      expect(withOption[0].eggSwaps.length).toBeGreaterThan(0);
    }
  });

  it('never returns eggSwaps for a combo with no egg moves in it', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => move({ id, appealPoints: 1 }));
    const results = findBestConditionalCombos(pool, { topN: 5, eggMoveIds: new Set(['nonexistent-in-pool']) });
    for (const combo of results) {
      expect(combo.eggSwaps).toEqual([]);
    }
  });
});

describe('findLevelSwaps', () => {
  it('returns [] when no slot is level-gated', () => {
    const a = move({ id: 'a' });
    const b = move({ id: 'b' });
    const c = move({ id: 'c' });
    const d = move({ id: 'd' });
    const byId = new Map([a, b, c, d].map((m) => [m.id, m]));
    const origins = new Map<string, MoveOrigin>([
      ['a', { method: 'tm', number: '01' }],
      ['b', { method: 'tutor' }],
      ['c', { method: 'egg' }],
      ['d', { method: 'transfer' }],
    ]);
    const swaps = findLevelSwaps(['a', 'b', 'c', 'd'], byId, origins, [a, b, c, d], (ids) => scoreCombo(ids, byId));
    expect(swaps).toEqual([]);
  });

  it('finds same-kind alternatives, each carrying its own required level (0 = no gate)', () => {
    const highLevelMove = move({ id: 'high', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    // Scores higher than tmAlt, so both survive the skyline pruning below
    // (a lower-or-equal-level alternative that scores at least as well
    // would otherwise make this one redundant — see the dedicated pruning test).
    const lowLevelAlt = move({ id: 'low', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const tmAlt = move({ id: 'tm-alt', appealPoints: 1, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const wrongKind = move({ id: 'wrong-kind', appealPoints: 9, positionEffect: { kind: 'bonus-if-last', op: 'add', amount: 2 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const filler2 = move({ id: 'filler2', appealPoints: 1 });
    const filler3 = move({ id: 'filler3', appealPoints: 1 });
    const pool = [highLevelMove, lowLevelAlt, tmAlt, wrongKind, filler, filler2, filler3];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const origins = new Map<string, MoveOrigin>([
      ['high', { method: 'level-up', level: 40 }],
      ['low', { method: 'level-up', level: 5 }],
      ['tm-alt', { method: 'tm', number: '01' }],
      ['wrong-kind', { method: 'level-up', level: 1 }],
    ]);

    const sequence = ['high', 'filler', 'filler2', 'filler3'];
    const swaps = findLevelSwaps(sequence, byId, origins, pool, (ids) => scoreCombo(ids, byId));
    expect(swaps).toHaveLength(1);
    expect(swaps[0].slotIndex).toBe(0);
    expect(swaps[0].originalLevel).toBe(40);
    const altIds = swaps[0].alternatives.map((a) => a.moveId);
    expect(altIds).toContain('low');
    expect(altIds).toContain('tm-alt');
    expect(altIds).not.toContain('wrong-kind'); // different positionEffect.kind
    expect(altIds).not.toContain('high'); // never suggests itself
    // Sorted by required level ascending (0 = TM, no gate, comes first).
    expect(swaps[0].alternatives[0]).toMatchObject({ moveId: 'tm-alt', requiredLevel: 0 });
    expect(swaps[0].alternatives.find((a) => a.moveId === 'low')).toMatchObject({ requiredLevel: 5 });
  });

  it('prunes an alternative dominated by a cheaper-or-equal, at-least-as-good one (skyline reduction)', () => {
    const highLevelMove = move({ id: 'high', appealPoints: 1, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    // 'weak' requires level 5 but scores no better than 'tm-alt', which
    // requires no level at all — 'weak' can never be the best qualifying
    // choice at any level, so it should be pruned entirely.
    const tmAlt = move({ id: 'tm-alt', appealPoints: 5, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const weak = move({ id: 'weak', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const filler = move({ id: 'filler', appealPoints: 1 });
    const filler2 = move({ id: 'filler2', appealPoints: 1 });
    const filler3 = move({ id: 'filler3', appealPoints: 1 });
    const pool = [highLevelMove, tmAlt, weak, filler, filler2, filler3];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const origins = new Map<string, MoveOrigin>([
      ['high', { method: 'level-up', level: 40 }],
      ['tm-alt', { method: 'tm', number: '01' }],
      ['weak', { method: 'level-up', level: 5 }],
    ]);

    const swaps = findLevelSwaps(['high', 'filler', 'filler2', 'filler3'], byId, origins, pool, (ids) => scoreCombo(ids, byId));
    const altIds = swaps[0].alternatives.map((a) => a.moveId);
    expect(altIds).toContain('tm-alt');
    expect(altIds).not.toContain('weak');
  });

  it('excludes a substitute that would make the sequence illegal', () => {
    const highLevelMove = move({ id: 'high', appealPoints: 1, positionEffect: { kind: 'none' } });
    const collidingAlt = move({ id: 'filler', appealPoints: 9, positionEffect: { kind: 'none' } }); // already at slot 2
    const legalAlt = move({ id: 'legal-alt', appealPoints: 3, positionEffect: { kind: 'none' } });
    const b = move({ id: 'b', appealPoints: 1 });
    const c = move({ id: 'c', appealPoints: 1 });
    const pool = [highLevelMove, collidingAlt, legalAlt, b, c];
    const byId = new Map(pool.map((m) => [m.id, m]));
    const origins = new Map<string, MoveOrigin>([['high', { method: 'level-up', level: 50 }]]);
    const legalSequence = ['high', 'b', 'filler', 'c'];

    const swaps = findLevelSwaps(legalSequence, byId, origins, pool, (ids) => scoreCombo(ids, byId));
    expect(swaps).toHaveLength(1);
    const altIds = swaps[0].alternatives.map((a) => a.moveId);
    expect(altIds).not.toContain('filler'); // occupies slot 2 (non-adjacent to slot 0) — illegal repeat
    expect(altIds).toContain('legal-alt');
  });

  it('rejects a sequence that is not exactly 4 moves', () => {
    const filler = move({ id: 'filler', appealPoints: 1 });
    const byId = new Map([filler].map((m) => [m.id, m]));
    expect(() => findLevelSwaps(['filler', 'filler'], byId, new Map(), [filler], (ids) => scoreCombo(ids, byId))).toThrow(/exactly 4/);
  });
});

describe('findBestCombos / findBestConditionalCombos with moveOrigins', () => {
  it('attaches levelSwaps only when moveOrigins is provided', () => {
    const highLevelMove = move({ id: 'high', appealPoints: 2, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const lowLevelAlt = move({ id: 'low', appealPoints: 3, positionEffect: { kind: 'bonus-if-first', op: 'add', amount: 2 } });
    const b = move({ id: 'b', appealPoints: 1 });
    const c = move({ id: 'c', appealPoints: 1 });
    const pool = [highLevelMove, lowLevelAlt, b, c];
    const origins = new Map<string, MoveOrigin>([
      ['high', { method: 'level-up', level: 60 }],
      ['low', { method: 'level-up', level: 5 }],
    ]);

    const withoutOption = findBestCombos(pool, { topN: 1 });
    expect(withoutOption[0].levelSwaps).toEqual([]);

    const withOption = findBestCombos(pool, { topN: 1, moveOrigins: origins });
    if (withOption[0].moveIds.includes('high')) {
      expect(withOption[0].levelSwaps.length).toBeGreaterThan(0);
    }
  });
});
