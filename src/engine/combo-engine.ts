// Combo scoring engine (Story 3/6, spec 3-combo-scoring-engine +
// 6-position-and-category-correction). Pure logic, no DOM/browser API
// (ARCHITECTURE-SPINE AD-3). Combo = exactly 4 move slots (AD-5); search is
// exact — never brute force, never a heuristic pre-cut of the candidate
// pool (AD-7).
//
// Category never affects scoring (AD-8): the real game's category-match
// bonus feeds a judge's Voltage meter, whose big payout depends on which
// contestant fills it — a competitive, opponent-dependent mechanic this
// project doesn't simulate (non-goal). There is one canonical best-combo
// list per Pokemon.
import type { Combo, ConditionalCombo, ConditionalSlot, EggMoveSwap, LevelMoveSwap, Move, MoveOrigin, PositionEffectKind } from '../data/index.ts';

const COMBO_LENGTH = 4;

export interface FindBestCombosOptions {
  topN?: number;
  /**
   * When provided, each result also gets precomputed egg-move swap
   * suggestions (AD-14) for any slot whose move id is in this set. Omit
   * (the default) to skip that work entirely — every result's `eggSwaps`
   * is then `[]`.
   */
  eggMoveIds?: ReadonlySet<string>;
  /**
   * When provided, each result also gets precomputed level-up swap
   * suggestions (AD-15) for any slot whose only way to learn it is
   * level-up. Omit (the default) to skip that work entirely — every
   * result's `levelSwaps` is then `[]`.
   */
  moveOrigins?: ReadonlyMap<string, MoveOrigin>;
}

/**
 * Legality (AD-5): a non-repeatable move used at most once; a repeatable
 * move used at most twice, and only in adjacent slots. Shared by both
 * search functions and `findEggMoveSwaps` so the rule can never drift
 * between them. Hot path in the searches (called up to millions of times),
 * so it avoids any allocation beyond the 4-element destructure.
 */
function isLegalSequence(moveIds: readonly string[], movesById: ReadonlyMap<string, Move>): boolean {
  const [a, b, c, d] = moveIds;
  if (a === c || a === d || b === d) return false;
  if (a === b && !movesById.get(a)!.repeatable) return false;
  if (b === c && !movesById.get(b)!.repeatable) return false;
  if (c === d && !movesById.get(c)!.repeatable) return false;
  return true;
}

const MAX_EGG_SWAP_ALTERNATIVES = 5;

/**
 * For each slot of `moveIds` that's an egg move (AD-14), find non-egg
 * substitutes of the SAME `positionEffect.kind` from `pool` — preserving the
 * slot's strategic role — that keep the sequence legal, scored via
 * `scoreSequence` (the caller's choice of `scoreCombo` or
 * `scoreConditionalCombo`, so this works for both combo flavors). Sorted
 * best-first, capped to `MAX_EGG_SWAP_ALTERNATIVES`.
 */
export function findEggMoveSwaps(
  moveIds: readonly string[],
  movesById: ReadonlyMap<string, Move>,
  eggMoveIds: ReadonlySet<string>,
  pool: readonly Move[],
  scoreSequence: (ids: readonly string[]) => number,
): EggMoveSwap[] {
  if (moveIds.length !== COMBO_LENGTH) {
    throw new Error(`findEggMoveSwaps: expected exactly ${COMBO_LENGTH} moveIds, got ${moveIds.length}`);
  }
  const swaps: EggMoveSwap[] = [];
  for (let i = 0; i < moveIds.length; i++) {
    const currentId = moveIds[i];
    if (!eggMoveIds.has(currentId)) continue;
    const currentMove = movesById.get(currentId);
    if (!currentMove) continue;

    const alternatives: { moveId: string; totalScore: number }[] = [];
    for (const candidate of pool) {
      if (candidate.id === currentId) continue;
      if (eggMoveIds.has(candidate.id)) continue;
      if (candidate.positionEffect.kind !== currentMove.positionEffect.kind) continue;
      const trial = moveIds.slice();
      trial[i] = candidate.id;
      if (!isLegalSequence(trial, movesById)) continue;
      alternatives.push({ moveId: candidate.id, totalScore: scoreSequence(trial) });
    }
    alternatives.sort((a, b) => b.totalScore - a.totalScore);
    swaps.push({ slotIndex: i, alternatives: alternatives.slice(0, MAX_EGG_SWAP_ALTERNATIVES) });
  }
  return swaps;
}

// Safety cap only — the real size control is the skyline pruning below.
const MAX_LEVEL_SWAP_ALTERNATIVES = 10;

/**
 * For each slot of `moveIds` whose only way to learn it is level-up
 * (ARCHITECTURE-SPINE AD-15), find same-`positionEffect.kind` substitutes
 * from `pool` — preserving the slot's strategic role — that keep the
 * sequence legal, each carrying its OWN required level (0 if it's reachable
 * via TM/HM/tutor/transfer/egg, i.e. no level gate). The UI picks among the
 * original move and these alternatives at render time based on the
 * player-entered level; every alternative's `totalScore` is the resulting
 * combo score with just that one slot substituted, scored via the caller's
 * choice of `scoreCombo` or `scoreConditionalCombo`.
 */
export function findLevelSwaps(
  moveIds: readonly string[],
  movesById: ReadonlyMap<string, Move>,
  moveOrigins: ReadonlyMap<string, MoveOrigin>,
  pool: readonly Move[],
  scoreSequence: (ids: readonly string[]) => number,
): LevelMoveSwap[] {
  if (moveIds.length !== COMBO_LENGTH) {
    throw new Error(`findLevelSwaps: expected exactly ${COMBO_LENGTH} moveIds, got ${moveIds.length}`);
  }
  function requiredLevelOf(moveId: string): number {
    const origin = moveOrigins.get(moveId);
    return origin?.method === 'level-up' ? origin.level : 0;
  }

  const swaps: LevelMoveSwap[] = [];
  for (let i = 0; i < moveIds.length; i++) {
    const currentId = moveIds[i];
    const originalLevel = requiredLevelOf(currentId);
    if (originalLevel <= 0) continue; // not level-gated at all — no swap needed
    const currentMove = movesById.get(currentId);
    if (!currentMove) continue;

    const alternatives: { moveId: string; requiredLevel: number; totalScore: number }[] = [];
    for (const candidate of pool) {
      if (candidate.id === currentId) continue;
      if (candidate.positionEffect.kind !== currentMove.positionEffect.kind) continue;
      const trial = moveIds.slice();
      trial[i] = candidate.id;
      if (!isLegalSequence(trial, movesById)) continue;
      alternatives.push({ moveId: candidate.id, requiredLevel: requiredLevelOf(candidate.id), totalScore: scoreSequence(trial) });
    }
    // Lower level first (more useful at a low input level), ties broken by higher score.
    alternatives.sort((a, b) => (a.requiredLevel !== b.requiredLevel ? a.requiredLevel - b.requiredLevel : b.totalScore - a.totalScore));
    // Skyline reduction: drop any alternative whose score doesn't beat every
    // lower-or-equal-level alternative already kept — it could never be the
    // best QUALIFYING choice at any level (a cheaper-or-equal option always
    // scores at least as well). This is lossless for `pickLevelOption`'s
    // purposes (both the "best qualifying" and "closest above" branches),
    // and typically collapses dozens of candidates down to a handful.
    const skyline: typeof alternatives = [];
    let bestScoreSoFar = -Infinity;
    for (const alt of alternatives) {
      if (alt.totalScore > bestScoreSoFar) {
        skyline.push(alt);
        bestScoreSoFar = alt.totalScore;
      }
    }
    swaps.push({ slotIndex: i, originalLevel, alternatives: skyline.slice(0, MAX_LEVEL_SWAP_ALTERNATIVES) });
  }
  return swaps;
}

/**
 * Score a single move's contribution to a slot. See spec Design Notes for
 * the full derivation of `isFirst`/`isLast`/`doubleNext`. Shared by
 * `scoreCombo` (final display score) and the search's per-slot valuation
 * so the two can never drift apart.
 */
function requireAmount(move: Move): number {
  if (move.positionEffect.op === undefined) {
    throw new Error(`combo-engine: move "${move.id}" has kind "${move.positionEffect.kind}" but no op`);
  }
  if (move.positionEffect.amount === undefined) {
    throw new Error(`combo-engine: move "${move.id}" has kind "${move.positionEffect.kind}" but no amount`);
  }
  return move.positionEffect.amount;
}

/**
 * Whether `move` has a scoring effect of its OWN — it can gain extra points
 * (`bonus-if-first`) or extra/doubled points (`bonus-if-last`) by itself,
 * independent of any grant from a previous move. See `slotContribution`'s
 * `doubleNext` handling (AD-17).
 */
function hasOwnScoringEffect(move: Move): boolean {
  const kind = move.positionEffect.kind;
  return kind === 'bonus-if-first' || kind === 'bonus-if-last';
}

function slotContribution(move: Move, isFirst: boolean, isLast: boolean, doubleNext: boolean): number {
  const effect = move.positionEffect;
  let bonused = move.appealPoints;
  if (effect.kind === 'bonus-if-first' && isFirst) {
    const amount = requireAmount(move);
    bonused = effect.op === 'add' ? bonused + amount : bonused * amount;
  } else if (effect.kind === 'bonus-if-last' && isLast) {
    const amount = requireAmount(move);
    bonused = effect.op === 'add' ? bonused + amount : bonused * amount;
  }
  // AD-17: real Gen4 contests never stack two point-multipliers on the same
  // turn. A "doubles next move" grant (from a `doubles-next-move` move like
  // Psych Up the turn before) only has an effect on a move with no scoring
  // effect of its own — a plain filler, or a `sets-first-next-turn`/
  // `sets-last-next-turn` SETTER (which modifies the NEXT move, not its
  // own points). Landing it on a move that already gains or doubles its
  // OWN points (`bonus-if-first`/`bonus-if-last`) would illegally stack two
  // multipliers in one turn (confirmed by the user against real game
  // behavior, e.g. Psych Up -> Assurance) — the grant is simply wasted (not
  // applied) in that case, never layered on top of the move's own bonus.
  if (doubleNext && !hasOwnScoringEffect(move)) bonused *= 2;
  return bonused;
}

/**
 * Derive isFirst/isLast/doubleNext for `slotIndex` from the previous move in
 * the sequence, if any (ARCHITECTURE-SPINE AD-11).
 *
 * Real Gen4 Super Contests order each turn's performances by score relative
 * to the OTHER contestants ("the best scorer goes last, the worst goes
 * first, unless a specific appeal effect forces it") — something this
 * project explicitly does not simulate (non-goal: no opponents). So:
 *   - isFirst is true at slot 0 (accepted as the standard opening bet — no
 *     prior turn to rank by, and no better default exists) OR when the
 *     previous move set it (`sets-first-next-turn`).
 *   - isLast is true ONLY when the previous move set it
 *     (`sets-last-next-turn`) — never automatically at the final slot,
 *     since nothing guarantees your last move is actually performed last.
 * This asymmetry (slot 0 counts, slot 3 doesn't) is intentional.
 */
function slotContext(slotIndex: number, prevMove: Move | undefined): { isFirst: boolean; isLast: boolean; doubleNext: boolean } {
  const prevKind = prevMove?.positionEffect.kind;
  return {
    isFirst: slotIndex === 0 || prevKind === 'sets-first-next-turn',
    isLast: prevKind === 'sets-last-next-turn',
    doubleNext: slotIndex > 0 && prevKind === 'doubles-next-move',
  };
}

/** Score a fixed ordered 4-move sequence — the real in-game score. */
export function scoreCombo(moveIds: readonly string[], movesById: ReadonlyMap<string, Move>): number {
  if (moveIds.length !== COMBO_LENGTH) {
    throw new Error(`scoreCombo: expected exactly ${COMBO_LENGTH} moveIds, got ${moveIds.length}`);
  }
  const m = moveIds.map((id) => {
    const move = movesById.get(id);
    if (!move) throw new Error(`scoreCombo: unknown move id "${id}"`);
    return move;
  });

  let total = 0;
  for (let i = 0; i < m.length; i++) {
    const { isFirst, isLast, doubleNext } = slotContext(i, m[i - 1]);
    total += slotContribution(m[i], isFirst, isLast, doubleNext);
  }
  return total;
}

function lexicographicKey(moveIds: readonly string[], indexOf: ReadonlyMap<string, number>): number[] {
  return moveIds.map((id) => indexOf.get(id)!);
}

function compareLexicographic(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Search strategy
// ---------------------------------------------------------------------------
//
// A naive DFS over move *identities* (try every move in every slot) blows up
// combinatorially: a slot's contribution depends only on its own move's kind
// and on what the PREVIOUS slot's move granted (isFirst/isLast/doubleNext —
// see slotContext above), never on which *specific* move occupies any other
// slot. So most of a large movepool (dozens of same-kind moves with no
// granted context) are mutually interchangeable for a given slot, and a
// naive search re-explores every permutation of them for no scoring benefit
// — the actual bottleneck this rewrite fixes (found in review: seconds per
// Pokemon, unacceptable across 493).
//
// Reformulated as two small stages:
//   1. Which *kind* occupies each of the 4 slots — only 7 possible kinds, so
//      at most 7^4 = 2401 "kind-patterns", trivial to enumerate exhaustively.
//      A pattern fully determines each slot's context (isFirst/isLast/
//      doubleNext), since slot i's context depends only on slot i-1's kind
//      (and slot 0's context is always "isFirst").
//   2. For a fixed pattern, which *specific* move of the required kind goes
//      in each slot — resolved from a small per-(kind, context) list of the
//      pool's moves of that kind, sorted by value under that context. Slots
//      only compete when two of them want the literal same top move; trying
//      each slot's top few candidates (never more moves than there are
//      slots) is enough to resolve every possible collision exactly.
//
// This never skips a reachable score: every legal (kind-pattern, move
// assignment) pair a naive DFS could reach is still considered here, just
// without re-deriving mutually-equivalent orderings from scratch.

type Context = 'first' | 'last' | 'double' | 'none';

function contextFromKind(kind: PositionEffectKind): Context {
  if (kind === 'sets-first-next-turn') return 'first';
  if (kind === 'sets-last-next-turn') return 'last';
  if (kind === 'doubles-next-move') return 'double';
  return 'none';
}

function valueUnder(move: Move, ctx: Context): number {
  return slotContribution(move, ctx === 'first', ctx === 'last', ctx === 'double');
}

// ---------------------------------------------------------------------------
// Conditional combos (AD-13)
// ---------------------------------------------------------------------------
//
// `findBestCombos` above only credits a first/last bonus when a PREVIOUS
// move explicitly forces it (AD-11) — the honest floor, since nothing else
// guarantees where you land in the real, opponent-relative turn order.
// `findBestConditionalCombos` computes a separate, clearly-labeled CEILING:
// for any slot i>0 that ISN'T already forced by the previous move's kind,
// the player could ALSO simply happen to have been the BEST scorer the
// previous turn, which (Bulbapedia: "the best scorer goes last") earns this
// slot the "last" bonus with no move causing it — a real, and reasonably
// assumable, possibility: playing a strong move naturally tends to rank you
// well. The mirror case — assuming you were the WORST scorer, to earn a
// "first" bonus — is deliberately NOT modeled: it would require having
// intentionally scored badly the previous turn, which contradicts the whole
// point of maximizing your own score, so it isn't a strategy a rational
// player would aim for (confirmed with the user). Slot 0 keeps its existing
// non-conditional "opening bet" (AD-11) and a `sets-first-next-turn` GRANT
// is unaffected (still guaranteed, never conditional) — only the FREE
// "I might have been the worst scorer" assumption is excluded. A
// `doubles-next-move` grant still applies on top of a freely assumed "last",
// since doubling is the previous move's own effect, not opponent-dependent.
//
// Plausibility chaining (AD-13 refinement, confirmed with the user): the
// free "I was the best scorer" assumption for slot i is only offered when
// slot i-1 itself was ELEVATED that turn — its actual value exceeded its
// own baseline (a guaranteed or already-validated-conditional position
// bonus fired, OR it was doubled). Winning a turn against real opponents is
// only plausible if you were ALSO playing aggressively that turn; crediting
// the assumption after a plain neutral filler move (no bonus, no doubling)
// would assume winning turns you had no real shot at. Slot 0's "opening
// bet" counts as elevated only if it actually carries a first-turn bonus
// (an unconditional grant, so no plausibility question there). This makes
// the model reward exactly the chained "big turn -> bet -> big turn" shape
// real players use, not isolated one-off bets after filler turns.
//
// Still exact (AD-7): this is a wider but still fully enumerated search —
// same kind-pattern skeleton as findBestCombos, just a different (and for
// non-guaranteed slots, position-maximizing, plausibility-gated) per-slot
// valuation that now also threads one bit of state (was the previous slot
// elevated) through the search.

/**
 * At most this many slots per combo may rely on a freely-assumed "best
 * scorer" turn (AD-13). Stacking two or more independent such assumptions
 * in the same 4-turn round isn't one coherent bet a player could make —
 * each is an unrelated stroke of luck, and multiplying them compounds the
 * unreliability rather than describing a single realistic strategy. A
 * position bonus beyond this cap is only counted when it comes from an
 * explicit `sets-first-next-turn`/`sets-last-next-turn` chain (guaranteed,
 * not conditional, and never subject to this cap).
 */
const MAX_CONDITIONS_PER_COMBO = 1;

interface Achievable {
  value: number;
  /** Never `'first'` when `conditional` is true — see the block comment above: assuming "I was the worst scorer" is deliberately not modeled. */
  achieved: 'first' | 'last' | 'none';
  conditional: boolean;
  /** Whether `value` exceeds this move's own baseline (no position bonus, no doubling) — gates whether the NEXT slot may attempt a free conditional bet. */
  elevated: boolean;
}

/**
 * `elevatedPrev` gates the free "assume last" bet (see the block comment
 * above): it's only offered when the PREVIOUS slot was itself elevated.
 * Guaranteed grants ('first'/'last' buckets) and doubling are structural —
 * unaffected by `elevatedPrev`, since they don't depend on winning a turn
 * against opponents.
 */
function bestAchievableUnder(move: Move, bucket: Context, elevatedPrev: boolean): Achievable {
  // The zero-bonus baseline represents "no bonus of any kind fired", so
  // `elevated` correctly reflects whether a REAL position bonus applied.
  const base = slotContribution(move, false, false, false);
  if (bucket === 'first') {
    const value = slotContribution(move, true, false, false);
    return { value, achieved: 'first', conditional: false, elevated: value > base };
  }
  if (bucket === 'last') {
    const value = slotContribution(move, false, true, false);
    return { value, achieved: 'last', conditional: false, elevated: value > base };
  }
  const doubleNext = bucket === 'double';
  const vNone = slotContribution(move, false, false, doubleNext);
  if (elevatedPrev) {
    const vLast = slotContribution(move, false, true, doubleNext);
    if (vLast > vNone) return { value: vLast, achieved: 'last', conditional: true, elevated: true };
  }
  return { value: vNone, achieved: 'none', conditional: false, elevated: vNone > base };
}

/**
 * Ground-truth scorer for a fixed ordered 4-move sequence under the
 * best-case conditional model (AD-13) — the conditional counterpart to
 * `scoreCombo`. Shared by `findBestConditionalCombos`'s final recompute so
 * the two can never drift apart, exactly like `scoreCombo`/`slotContribution`.
 */
export function scoreConditionalCombo(
  moveIds: readonly string[],
  movesById: ReadonlyMap<string, Move>,
): { totalScore: number; conditions: ConditionalSlot[] } {
  if (moveIds.length !== COMBO_LENGTH) {
    throw new Error(`scoreConditionalCombo: expected exactly ${COMBO_LENGTH} moveIds, got ${moveIds.length}`);
  }
  const m = moveIds.map((id) => {
    const move = movesById.get(id);
    if (!move) throw new Error(`scoreConditionalCombo: unknown move id "${id}"`);
    return move;
  });

  let totalScore = 0;
  let elevatedPrev = false; // slot 0 has no predecessor to have been elevated
  const conditions: ConditionalSlot[] = [];
  for (let i = 0; i < m.length; i++) {
    const bucket: Context = i === 0 ? 'first' : contextFromKind(m[i - 1].positionEffect.kind);
    const result = bestAchievableUnder(m[i], bucket, elevatedPrev);
    totalScore += result.value;
    // `conditional` is only ever true when `achieved === 'last'` (see
    // `bestAchievableUnder` — the 'first' assumption is never modeled).
    if (result.conditional && result.achieved === 'last') {
      conditions.push({ slotIndex: i, requires: 'last' });
    }
    elevatedPrev = result.elevated;
  }
  return { totalScore, conditions };
}

/**
 * Find the top-N highest-scoring legal 4-move combos for a Pokemon's
 * learnable moves, via exact search (AD-7). The result does not depend on
 * contest category (AD-8) — there is one canonical list per Pokemon.
 */
export function findBestCombos(learnableMoves: readonly Move[], options: FindBestCombosOptions = {}): Combo[] {
  const requestedTopN = Math.floor(options.topN ?? 5);
  // Upper-bounded, not just lower-bounded: CANDIDATES_PER_SLOT grows with
  // topN and feeds a 4-nested loop below, so an unbounded caller-supplied
  // topN would make the search combinatorially slow (found in review).
  // 50 is far beyond any realistic UI need (AD-10's one caller asks for 5).
  const topN = Math.min(50, Math.max(1, Number.isFinite(requestedTopN) ? requestedTopN : 5));
  if (learnableMoves.length === 0) return [];

  // De-duplicated by id (keeps the LAST occurrence — Map construction
  // semantics) — the real data pipeline never produces duplicate ids within
  // one Pokemon's learnable moves, but nothing upstream enforces that as a
  // hard guarantee for every possible caller.
  const uniqueMoves = [...new Map(learnableMoves.map((m) => [m.id, m])).values()];
  const movesById = new Map(uniqueMoves.map((m) => [m.id, m]));
  const indexOf = new Map(uniqueMoves.map((m, i) => [m.id, i]));

  // Moves of each kind actually present in the pool — patterns naming an
  // absent kind for a slot are skipped outright (usually most of the 7).
  const byKind = new Map<PositionEffectKind, Move[]>();
  for (const m of uniqueMoves) {
    const list = byKind.get(m.positionEffect.kind);
    if (list) list.push(m);
    else byKind.set(m.positionEffect.kind, [m]);
  }
  const presentKinds = [...byKind.keys()];

  // Per (kind, context), moves of that kind sorted by value under that
  // context, descending. At most 4 slots ever need a pick from one list, so
  // each slot only ever needs to look at the top few entries to route
  // around a collision with another slot wanting the same move.
  const sortedByKindContext = new Map<string, Move[]>();
  function listFor(kind: PositionEffectKind, ctx: Context): Move[] {
    const key = `${kind}|${ctx}`;
    let list = sortedByKindContext.get(key);
    if (!list) {
      list = [...(byKind.get(kind) ?? [])].sort((a, b) => valueUnder(b, ctx) - valueUnder(a, ctx));
      sortedByKindContext.set(key, list);
    }
    return list;
  }

  const results: Array<{ moveIds: string[]; totalScore: number; key: string }> = [];

  /** Canonical key for the underlying *set* of 4 moves, ignoring order. */
  function moveSetKey(moveIds: readonly string[]): string {
    return [...moveIds].sort().join(',');
  }

  function worstKeptScore(): number {
    return results.length < topN ? -Infinity : results[results.length - 1].totalScore;
  }

  /**
   * Admits a completed 4-move assignment into the top-N: improves an
   * already-kept set's ordering if this scores higher, fills an empty slot
   * with a new distinct set, replaces the current worst-kept distinct set
   * if this one is strictly better, or drops it. Never holds two entries
   * that are permutations of the same 4 moves (a real bug found in review:
   * un-deduped, many moves with no order-dependent effect tie on every
   * ordering, so the top-N list could be one move set reordered N times —
   * e.g. Caterpie's committed data before this fix).
   *
   * Callers should skip calling this at all when `totalScore` can't possibly
   * help (see the `worstKeptScore()` pre-check at each call site) — this
   * function itself does a linear scan + array-sort per call, and with
   * `CANDIDATES_PER_SLOT^4` candidates tried per pattern, most won't beat
   * the current threshold once results has filled up.
   */
  function admit(moveIds: string[], totalScore: number): void {
    const key = moveSetKey(moveIds);
    const existingIdx = results.findIndex((r) => r.key === key);
    if (existingIdx !== -1) {
      if (totalScore > results[existingIdx].totalScore) {
        results[existingIdx] = { moveIds, totalScore, key };
        results.sort((a, b) => b.totalScore - a.totalScore);
      }
      return;
    }
    if (results.length < topN) {
      let i = 0;
      while (i < results.length && results[i].totalScore > totalScore) i++;
      results.splice(i, 0, { moveIds, totalScore, key });
      return;
    }
    if (totalScore > results[results.length - 1].totalScore) {
      results[results.length - 1] = { moveIds, totalScore, key };
      results.sort((a, b) => b.totalScore - a.totalScore);
    }
    // else: a new distinct set that doesn't beat the current worst kept — drop it.
  }

  // How many of each slot's top candidates to try. Must cover two needs:
  // (a) resolving a collision when multiple slots want the same top move(s)
  // — at most 4 slots ever compete, so 4 would do; (b) surfacing `topN`
  // *distinct* results when many of them come from the very same pattern
  // (e.g. a pool of nothing but `kind: 'none'` moves has exactly one
  // pattern, so all requested diversity must come from trying different
  // subsets within it) — needs roughly `topN` candidates. `topN + 3` covers
  // both with margin.
  const CANDIDATES_PER_SLOT = Math.max(6, topN + 3);

  for (const k0 of presentKinds) {
    const list0 = listFor(k0, 'first'); // slot 0 is always "first" context
    if (list0.length === 0) continue;
    const ctx1 = contextFromKind(k0);

    for (const k1 of presentKinds) {
      const list1 = listFor(k1, ctx1);
      if (list1.length === 0) continue;
      const ctx2 = contextFromKind(k1);

      for (const k2 of presentKinds) {
        const list2 = listFor(k2, ctx2);
        if (list2.length === 0) continue;
        const ctx3 = contextFromKind(k2);

        for (const k3 of presentKinds) {
          const list3 = listFor(k3, ctx3);
          if (list3.length === 0) continue;

          // Try each slot's top candidates and admit every legal
          // combination — not just this pattern's single best — since
          // several of the requested top-N results can come from the same
          // pattern (e.g. a pool of nothing but `kind: 'none'` moves has
          // exactly one pattern; all diversity must come from distinct
          // subsets within it). `admit` itself keeps only the global top-N
          // distinct move sets, so calling it more than necessary is safe.
          const c0 = list0.slice(0, CANDIDATES_PER_SLOT);
          const c1 = list1.slice(0, CANDIDATES_PER_SLOT);
          const c2 = list2.slice(0, CANDIDATES_PER_SLOT);
          const c3 = list3.slice(0, CANDIDATES_PER_SLOT);

          for (const m0 of c0) {
            const v0 = valueUnder(m0, 'first');
            for (const m1 of c1) {
              const v1 = valueUnder(m1, ctx1);
              for (const m2 of c2) {
                const v2 = valueUnder(m2, ctx2);
                for (const m3 of c3) {
                  const v3 = valueUnder(m3, ctx3);
                  const total = v0 + v1 + v2 + v3;
                  // Cheap check before the linear-scan-plus-sort admit() —
                  // once results has filled up, most attempts here don't
                  // beat the threshold and this skips them for ~free.
                  if (results.length >= topN && total <= worstKeptScore()) continue;
                  if (!isLegalSequence([m0.id, m1.id, m2.id, m3.id], movesById)) continue;
                  admit([m0.id, m1.id, m2.id, m3.id], total);
                }
              }
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => {
    if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
    return compareLexicographic(lexicographicKey(a.moveIds, indexOf), lexicographicKey(b.moveIds, indexOf));
  });

  // Recompute via scoreCombo (the ground-truth scorer) rather than trusting
  // the search's own valueUnder sums, so the two can never silently drift.
  return results.map((r) => {
    const totalScore = scoreCombo(r.moveIds, movesById);
    const eggSwaps = options.eggMoveIds
      ? findEggMoveSwaps(r.moveIds, movesById, options.eggMoveIds, uniqueMoves, (ids) => scoreCombo(ids, movesById))
      : [];
    const levelSwaps = options.moveOrigins
      ? findLevelSwaps(r.moveIds, movesById, options.moveOrigins, uniqueMoves, (ids) => scoreCombo(ids, movesById))
      : [];
    return { moveIds: r.moveIds, totalScore, eggSwaps, levelSwaps };
  });
}

/**
 * Find the top-N highest-scoring legal 4-move combos under the best-case
 * conditional model (AD-13) — same exact-search guarantee as
 * `findBestCombos` (AD-7), but slots not forced by a previous move's kind
 * may also assume favorable turn-order luck. Always shown as a separate,
 * clearly-labeled list from `findBestCombos`'s guaranteed results (AD-8),
 * never merged into them.
 */
export function findBestConditionalCombos(learnableMoves: readonly Move[], options: FindBestCombosOptions = {}): ConditionalCombo[] {
  const requestedTopN = Math.floor(options.topN ?? 5);
  const topN = Math.min(50, Math.max(1, Number.isFinite(requestedTopN) ? requestedTopN : 5));
  if (learnableMoves.length === 0) return [];

  const uniqueMoves = [...new Map(learnableMoves.map((m) => [m.id, m])).values()];
  const movesById = new Map(uniqueMoves.map((m) => [m.id, m]));
  const indexOf = new Map(uniqueMoves.map((m, i) => [m.id, i]));

  const byKind = new Map<PositionEffectKind, Move[]>();
  for (const m of uniqueMoves) {
    const list = byKind.get(m.positionEffect.kind);
    if (list) list.push(m);
    else byKind.set(m.positionEffect.kind, [m]);
  }
  const presentKinds = [...byKind.keys()];

  // Keyed by (kind, bucket, elevatedPrev) — the plausibility-chaining rule
  // means a slot's best move under 'double'/'none' buckets depends on
  // whether the PREVIOUS slot ends up elevated, which varies per candidate
  // actually chosen there (not just its kind). `candidatesFor` below covers
  // both possibilities since it isn't known yet at list-building time.
  const sortedByKindBucket = new Map<string, Move[]>();
  function listFor(kind: PositionEffectKind, bucket: Context, elevatedPrev: boolean): Move[] {
    const key = `${kind}|${bucket}|${elevatedPrev}`;
    let list = sortedByKindBucket.get(key);
    if (!list) {
      list = [...(byKind.get(kind) ?? [])].sort(
        (a, b) => bestAchievableUnder(b, bucket, elevatedPrev).value - bestAchievableUnder(a, bucket, elevatedPrev).value,
      );
      sortedByKindBucket.set(key, list);
    }
    return list;
  }

  const results: Array<{ moveIds: string[]; totalScore: number; conditionCount: number; key: string }> = [];

  function moveSetKey(moveIds: readonly string[]): string {
    return [...moveIds].sort().join(',');
  }

  function rank(r: { totalScore: number; conditionCount: number }): [number, number] {
    return [r.totalScore, -r.conditionCount]; // higher score first, then fewer conditions
  }

  function isBetter(a: { totalScore: number; conditionCount: number }, b: { totalScore: number; conditionCount: number }): boolean {
    const [as, ac] = rank(a);
    const [bs, bc] = rank(b);
    return as !== bs ? as > bs : ac > bc;
  }

  function worstKept(): { totalScore: number; conditionCount: number } {
    return results.length < topN ? { totalScore: -Infinity, conditionCount: Infinity } : results[results.length - 1];
  }

  function admit(moveIds: string[], totalScore: number, conditionCount: number): void {
    const key = moveSetKey(moveIds);
    const existingIdx = results.findIndex((r) => r.key === key);
    const candidate = { moveIds, totalScore, conditionCount, key };
    if (existingIdx !== -1) {
      if (isBetter(candidate, results[existingIdx])) {
        results[existingIdx] = candidate;
        results.sort((a, b) => (isBetter(a, b) ? -1 : isBetter(b, a) ? 1 : 0));
      }
      return;
    }
    if (results.length < topN) {
      let i = 0;
      while (i < results.length && isBetter(results[i], candidate)) i++;
      results.splice(i, 0, candidate);
      return;
    }
    if (isBetter(candidate, results[results.length - 1])) {
      results[results.length - 1] = candidate;
      results.sort((a, b) => (isBetter(a, b) ? -1 : isBetter(b, a) ? 1 : 0));
    }
  }

  // Per elevatedPrev branch; 'first'/'last' buckets are forced (elevatedPrev
  // irrelevant there) so they only ever need one branch's worth.
  const CANDIDATES_PER_BRANCH = Math.max(3, Math.ceil((topN + 3) / 2));

  function candidatesFor(kind: PositionEffectKind, bucket: Context): Move[] {
    if (bucket === 'first' || bucket === 'last') {
      return listFor(kind, bucket, false).slice(0, CANDIDATES_PER_BRANCH * 2);
    }
    // The real elevatedPrev for this slot depends on which move gets
    // chosen for the PREVIOUS slot, not known yet here — include the best
    // candidates from BOTH possibilities so whichever occurs at runtime is
    // covered by the nested loop below (which re-evaluates with the ACTUAL
    // propagated elevated flag, never trusting this list's ordering alone).
    const withBet = listFor(kind, bucket, true).slice(0, CANDIDATES_PER_BRANCH);
    const withoutBet = listFor(kind, bucket, false).slice(0, CANDIDATES_PER_BRANCH);
    const seen = new Set<string>();
    const merged: Move[] = [];
    for (const m of [...withBet, ...withoutBet]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    return merged;
  }

  for (const k0 of presentKinds) {
    const list0 = candidatesFor(k0, 'first');
    if (list0.length === 0) continue;
    const bucket1 = contextFromKind(k0);

    for (const k1 of presentKinds) {
      const list1 = candidatesFor(k1, bucket1);
      if (list1.length === 0) continue;
      const bucket2 = contextFromKind(k1);

      for (const k2 of presentKinds) {
        const list2 = candidatesFor(k2, bucket2);
        if (list2.length === 0) continue;
        const bucket3 = contextFromKind(k2);

        for (const k3 of presentKinds) {
          const list3 = candidatesFor(k3, bucket3);
          if (list3.length === 0) continue;

          for (const m0 of list0) {
            const a0 = bestAchievableUnder(m0, 'first', false);
            for (const m1 of list1) {
              const a1 = bestAchievableUnder(m1, bucket1, a0.elevated);
              for (const m2 of list2) {
                const a2 = bestAchievableUnder(m2, bucket2, a1.elevated);
                for (const m3 of list3) {
                  const a3 = bestAchievableUnder(m3, bucket3, a2.elevated);
                  const total = a0.value + a1.value + a2.value + a3.value;
                  const conditionCount = [a0, a1, a2, a3].filter((a) => a.conditional).length;
                  // At most ONE freely-assumed turn per combo (see MAX_CONDITIONS_PER_COMBO
                  // above): stacking two independent "I happened to be the best
                  // scorer that turn" bets isn't one coherent strategy a real
                  // player could count on — it's two unrelated strokes of luck.
                  if (conditionCount > MAX_CONDITIONS_PER_COMBO) continue;
                  if (results.length >= topN && !isBetter({ totalScore: total, conditionCount }, worstKept())) continue;
                  if (!isLegalSequence([m0.id, m1.id, m2.id, m3.id], movesById)) continue;
                  admit([m0.id, m1.id, m2.id, m3.id], total, conditionCount);
                }
              }
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => {
    if (isBetter(a, b)) return -1;
    if (isBetter(b, a)) return 1;
    return compareLexicographic(lexicographicKey(a.moveIds, indexOf), lexicographicKey(b.moveIds, indexOf));
  });

  return results.map((r) => {
    const { totalScore, conditions } = scoreConditionalCombo(r.moveIds, movesById);
    const eggSwaps = options.eggMoveIds
      ? findEggMoveSwaps(r.moveIds, movesById, options.eggMoveIds, uniqueMoves, (ids) => scoreConditionalCombo(ids, movesById).totalScore)
      : [];
    const levelSwaps = options.moveOrigins
      ? findLevelSwaps(r.moveIds, movesById, options.moveOrigins, uniqueMoves, (ids) => scoreConditionalCombo(ids, movesById).totalScore)
      : [];
    return { moveIds: r.moveIds, totalScore, conditions, eggSwaps, levelSwaps };
  });
}
