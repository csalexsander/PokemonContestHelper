// Effect-text classifier — turns Serebii Attackdex "Effect" column text into a
// typed PositionEffect (ARCHITECTURE-SPINE AD-2). This is a small classifier
// against a closed, known set of literal phrasings (see spec Design Notes),
// not general NLP: anything that doesn't match a known pattern falls through
// to `out-of-scope-conditional` rather than being guessed.
import type { PositionEffect } from '../../src/data/types.ts';

// Known Serebii typos observed in the Gen4 attackdex-dp category pages,
// corrected before classification so a misspelling doesn't silently fall
// through to the wrong bucket.
const KNOWN_TYPOS: Array<[RegExp, string]> = [
  [/\bfirt\b/gi, 'first'],
  [/^oints\b/i, 'Points'],
  [/\bturnt\b/gi, 'turn'],
];

function normalize(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  for (const [pattern, replacement] of KNOWN_TYPOS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

const REPEATABLE_PATTERN = /can be used twice consecutively\.?/i;

/**
 * Whether a raw Serebii Attackdex effect-text string marks this move as
 * usable twice in the same performance (Gen4 rule: most moves may be used
 * only once; a few, like Outrage or Arm Thrust, may repeat once, only on
 * consecutive turns). Independent of `parsePositionEffect` — a move can
 * carry both a position effect and this flag (the phrase is stripped
 * before position-effect classification so it can't block a match).
 */
export function parseRepeatable(rawText: string): boolean {
  return REPEATABLE_PATTERN.test(normalize(rawText));
}

/**
 * Human-readable effect text for a move, independent of how `parsePositionEffect`
 * classifies it — used to show the player the REAL Serebii wording for moves
 * classified as `out-of-scope-conditional` (a mechanic this project doesn't
 * simulate, but the player should still be able to read what it actually
 * does). Strips the "can be used twice consecutively" phrase since that's
 * already surfaced separately via `Move.repeatable`.
 */
export function normalizeEffectText(rawText: string): string {
  // Strip the repeatable phrase (and its own trailing period, if any) BEFORE
  // collapsing the overall trailing period — otherwise a mid-sentence period
  // left behind by the phrase removal (e.g. "...to appeal. Can be used
  // twice consecutively.") would survive as a stray trailing period.
  let text = rawText.replace(/\s+/g, ' ').trim().replace(REPEATABLE_PATTERN, '').trim();
  for (const [pattern, replacement] of KNOWN_TYPOS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\.$/, '').trim();
}

/**
 * Classify a raw Serebii Attackdex effect-text string into a PositionEffect.
 * See spec I/O & Edge-Case Matrix (story 1-gen4-static-dataset) for the
 * scenarios this must cover.
 */
export function parsePositionEffect(rawText: string): PositionEffect {
  const text = normalize(rawText).replace(REPEATABLE_PATTERN, '').trim();
  const lower = text.toLowerCase();

  if (lower === 'no added effect' || lower === '') {
    return { kind: 'none' };
  }

  // "Points +2 if first to appeal" / "First to appeal +1"
  const firstAdd =
    lower.match(/points?\s*\+(\d+)\s*if\s*first\s*to\s*appeal/) ??
    lower.match(/first\s*to\s*appeal\s*\+(\d+)/);
  if (firstAdd) {
    return { kind: 'bonus-if-first', op: 'add', amount: Number(firstAdd[1]) };
  }
  if (/points?\s*doubles?\s*if\s*first\s*to\s*appeal/.test(lower)) {
    return { kind: 'bonus-if-first', op: 'multiply', amount: 2 };
  }

  // "Points +2 if last to appeal" / "Points doubles if last to appeal" —
  // real turn-order-relative mechanic (Bulbapedia: "performs last IN THE
  // TURN", relative to OTHER contestants that turn — true for BOTH the
  // additive form, e.g. Frustration, and the multiplicative form, e.g.
  // Assurance; AD-16 briefly modeled the multiplicative form as a separate
  // structural "last move of the whole routine" mechanic, which was a
  // misreading later corrected — see AD-18).
  const lastAdd = lower.match(/points?\s*\+(\d+)\s*if\s*last\s*to\s*appeal/);
  if (lastAdd) {
    return { kind: 'bonus-if-last', op: 'add', amount: Number(lastAdd[1]) };
  }
  if (/points?\s*doubles?\s*if\s*last\s*to\s*appeal/.test(lower)) {
    return { kind: 'bonus-if-last', op: 'multiply', amount: 2 };
  }

  if (/^appeals?\s*first in the next turn/.test(lower)) {
    return { kind: 'sets-first-next-turn' };
  }
  if (/^appeals?\s*last in the next turn/.test(lower)) {
    return { kind: 'sets-last-next-turn' };
  }
  if (/points? of next appeal doubles/.test(lower)) {
    return { kind: 'doubles-next-move' };
  }

  // Anything depending on another Pokemon/judge, or any other phrasing
  // outside the known closed set, is out of scope for the scoring engine
  // (never guessed — see spec Boundaries & Constraints).
  return { kind: 'out-of-scope-conditional' };
}
