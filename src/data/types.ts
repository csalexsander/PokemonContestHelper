// Domain types — single source of truth for the whole app (ARCHITECTURE-SPINE AD-2).
// Engine and UI import these types; they never redeclare their own.

export type ContestCategory = 'beauty' | 'cool' | 'cute' | 'smart' | 'tough';

/**
 * `bonus-if-last`, additive AND multiplicative (ARCHITECTURE-SPINE AD-18,
 * superseding the now-reverted AD-16): Serebii's Attackdex text ("Points
 * [+N/doubles] if last to appeal") describes ONE real Gen4 mechanic —
 * performing last IN A GIVEN TURN, relative to OTHER contestants (Bulbapedia
 * confirms this for both the additive form, e.g. Frustration, and the
 * multiplicative form, e.g. Assurance: "the final performance" means the
 * last move performed within that turn's judging order, not the literal
 * 4th/final move of the whole routine). AD-16 briefly modeled the
 * multiplicative form as a separate structural `bonus-if-final-move` kind
 * (guaranteed whenever placed in the literal last slot) — this was a
 * misreading of "final performance" and has been reverted: both forms are
 * `bonus-if-last`, opponent-relative like every other `bonus-if-first`/
 * `bonus-if-last` move, gated by AD-11's grant requirement or AD-13's
 * conditional "assumed best scorer" model — never guaranteed by slot
 * position alone.
 */
export type PositionEffectKind =
  | 'none'
  | 'bonus-if-first'
  | 'bonus-if-last'
  | 'sets-first-next-turn'
  | 'sets-last-next-turn'
  | 'doubles-next-move'
  | 'out-of-scope-conditional';

/**
 * `op`/`amount` are only present when `kind` is `bonus-if-first` or
 * `bonus-if-last` — magnitude AND operation vary per move (e.g. Aura Sphere
 * is `{kind:'bonus-if-first', op:'add', amount:2}`, Frustration is
 * `{kind:'bonus-if-last', op:'add', amount:2}`, Assurance is
 * `{kind:'bonus-if-last', op:'multiply', amount:2}` — see
 * `PositionEffectKind`'s doc: the multiplicative form is NOT a distinct
 * mechanic, just a different magnitude operation on the same opponent-
 * relative "last in the turn" bonus). Every other `kind` carries no
 * `op`/`amount`.
 */
export interface PositionEffect {
  kind: PositionEffectKind;
  op?: 'add' | 'multiply';
  amount?: number;
}

export interface Move {
  /** Slug id, e.g. `aura-sphere`. Matches `^[a-z0-9]+(-[a-z0-9]+)*$`. */
  id: string;
  name: string;
  category: ContestCategory;
  appealPoints: number;
  positionEffect: PositionEffect;
  /**
   * Real Serebii effect text, normalized (typos fixed, "can be used twice
   * consecutively" stripped since `repeatable` already covers it). Shown to
   * the player for `positionEffect.kind === 'out-of-scope-conditional'`
   * moves so they can read what the move actually does, even though the
   * engine can't score it (depends on other Pokemon/judges — non-goal).
   */
  description: string;
  /**
   * Whether this move may be used twice in the same 4-turn combo (Gen4
   * rule: most moves may be used only once per performance; a few, like
   * Outrage or Arm Thrust, may be used twice — only on consecutive turns).
   * Independent of `positionEffect` — a move can have any effect and still
   * be repeatable. Default false.
   */
  repeatable: boolean;
}

/**
 * How a specific Pokemon learns a specific move in Gen4 (ARCHITECTURE-SPINE
 * AD-15) — reduced from PokemonDB's per-version tables to ONE canonical
 * origin: TM/HM/Move Tutor/Transfer-only all mean "no level requirement,
 * obtainable any time" and take priority over level-up (if a move is
 * reachable that way in ANY version, that's shown/gated on even if it's
 * level-up-only in another version). Only when every observation across
 * versions is level-up does it carry a real `level` (the lowest across
 * versions). Only when every observation is under an "Egg moves" heading
 * does it count as `'egg'`.
 */
export type MoveOrigin =
  | { method: 'level-up'; level: number }
  | { method: 'tm'; number: string }
  | { method: 'hm'; number: string }
  | { method: 'tutor' }
  | { method: 'transfer' }
  | { method: 'egg' };

export interface Pokemon {
  /** National Dex number, no zero-padding. */
  id: number;
  name: string;
  /** Move ids this Pokemon can learn in Gen 4. Every id exists as a key in the moves dataset. */
  learnableMoveIds: string[];
  /**
   * Subset of `learnableMoveIds` only obtainable by breeding (ARCHITECTURE-SPINE
   * AD-14) — a move counts as an egg move only if it's egg-only in EVERY Gen4
   * version it's listed for; if it's also reachable another way in any
   * version, it's not included here even if breeding also works. Equivalent
   * to `moveOrigins[id].method === 'egg'`, kept as its own field since it
   * predates AD-15 and is used directly by the egg-move machinery (AD-14).
   */
  eggMoveIds: string[];
  /** One canonical `MoveOrigin` per entry in `learnableMoveIds` (AD-15). */
  moveOrigins: Record<string, MoveOrigin>;
}

/**
 * A non-egg substitute for one egg-move slot of a `Combo`/`ConditionalCombo`
 * (AD-14) — same `positionEffect.kind` as the original move, so it fills the
 * same strategic role. `alternatives` is sorted best-first by the resulting
 * `totalScore` if that substitute were used instead, capped to a handful.
 */
export interface EggMoveSwap {
  slotIndex: number;
  alternatives: { moveId: string; totalScore: number }[];
}

/**
 * A same-`positionEffect.kind` substitute for one level-up-gated slot of a
 * `Combo` (ARCHITECTURE-SPINE AD-15) — `requiredLevel` is the alternative's
 * own level requirement (0 if it's obtainable via TM/HM/tutor/transfer/egg,
 * i.e. no level gate at all). The UI picks among these (plus the original
 * move) at render time based on the player-entered level — never
 * recomputed live (AD-1 stays strict, same choice as AD-14's egg swaps).
 */
export interface LevelMoveSwap {
  slotIndex: number;
  /** The original move's own required level. */
  originalLevel: number;
  alternatives: { moveId: string; requiredLevel: number; totalScore: number }[];
}

export interface Combo {
  /** Exactly 4 move ids (AD-5) — one per turn of the real Gen4 appeal round. */
  moveIds: string[];
  totalScore: number;
  /**
   * Precomputed swap options (AD-14) for any slot in `moveIds` that's an egg
   * move — always `[]` when the combo has no egg moves (e.g. every entry of
   * the "no egg moves" precomputed lists).
   */
  eggSwaps: EggMoveSwap[];
  /**
   * Precomputed swap options (AD-15) for any slot in `moveIds` whose only
   * way to learn it is level-up — always `[]` when the combo has no
   * level-gated moves.
   */
  levelSwaps: LevelMoveSwap[];
}

/**
 * One slot of a `ConditionalCombo` whose bonus is NOT guaranteed by any move
 * in the sequence — it requires the player to have been the BEST scorer
 * relative to OTHER contestants on the previous turn (Bulbapedia: "the best
 * scorer goes last"), earning this slot's move the "last" bonus for free
 * (ARCHITECTURE-SPINE AD-13). Always `'last'`: the mirror case — assuming
 * you were the WORST scorer, to earn a "first" bonus — is deliberately not
 * modeled, since it would require having intentionally scored badly the
 * previous turn, contradicting the point of maximizing your own score.
 */
export interface ConditionalSlot {
  slotIndex: number;
  requires: 'last';
}

/**
 * A combo whose score assumes best-case relative-scoring luck on turns not
 * covered by an explicit `sets-first-next-turn`/`sets-last-next-turn` grant
 * (AD-13). `totalScore` is the real in-game score IF every condition in
 * `conditions` holds — never guaranteed the way a plain `Combo` is.
 */
export interface ConditionalCombo extends Combo {
  conditions: ConditionalSlot[];
}

/**
 * Precomputed at build time by `scripts/precompute-combos.ts` (AD-10) — the
 * UI reads this, it never calls the Engine live. One canonical combo list
 * per Pokemon id (AD-8: category never changes scoring/ranking), even when
 * the array is `[]` (AD-5).
 */
export type PrecomputedCombos = Record<number, Combo[]>;

/**
 * Precomputed alongside `PrecomputedCombos` (AD-13) — a separate, clearly
 * labeled ceiling that assumes favorable turn-order luck. Never merged into
 * `PrecomputedCombos`'s ranking (AD-8/AD-13: the guaranteed floor and the
 * best-case ceiling are always shown as distinct lists).
 */
export type PrecomputedConditionalCombos = Record<number, ConditionalCombo[]>;
