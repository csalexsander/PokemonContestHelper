// Barrel export — single import surface for the Engine and UI layers
// (Story 2/3). Nothing outside src/data/ should import the generated
// moves.ts/pokemon.ts modules directly.
export type {
  Combo,
  ConditionalCombo,
  ConditionalSlot,
  ContestCategory,
  EggMoveSwap,
  LevelMoveSwap,
  Move,
  MoveOrigin,
  Pokemon,
  PositionEffect,
  PositionEffectKind,
  PrecomputedCombos,
  PrecomputedConditionalCombos,
} from './types.ts';
export { moves } from './moves.ts';
export { pokemon } from './pokemon.ts';
export { combos, combosNoEgg, conditionalCombos, conditionalCombosNoEgg } from './combos.ts';
