import { describe, expect, it } from 'vitest';
import { normalizeEffectText, parsePositionEffect, parseRepeatable } from './effect-parser.ts';

describe('parsePositionEffect', () => {
  it('classifies an additive first-turn bonus (Aura Sphere)', () => {
    expect(parsePositionEffect('Points +2 if first to appeal')).toEqual({
      kind: 'bonus-if-first',
      op: 'add',
      amount: 2,
    });
  });

  it('classifies the multiplicative "last to appeal" phrasing as bonus-if-last, same opponent-relative mechanic as the additive form (Assurance) — AD-18', () => {
    // AD-16 briefly treated this as a distinct structural "final
    // performance" mechanic; corrected (AD-18) to the same opponent-relative
    // "last in the turn" bonus as the additive form (e.g. Frustration), just
    // multiplicative instead of additive.
    expect(parsePositionEffect('Points doubles if last to appeal')).toEqual({
      kind: 'bonus-if-last',
      op: 'multiply',
      amount: 2,
    });
  });

  it('classifies the alternate "X to appeal +N" first-turn phrasing', () => {
    expect(parsePositionEffect('First to appeal +1')).toEqual({
      kind: 'bonus-if-first',
      op: 'add',
      amount: 1,
    });
  });

  it('classifies a multiplicative first-turn bonus', () => {
    expect(parsePositionEffect('Points doubles if first to appeal')).toEqual({
      kind: 'bonus-if-first',
      op: 'multiply',
      amount: 2,
    });
  });

  it('tolerates a trailing period', () => {
    expect(parsePositionEffect('No Added Effect.')).toEqual({ kind: 'none' });
  });

  it('tolerates the known Serebii "firt" typo', () => {
    expect(parsePositionEffect('Points +2 if firt to appeal')).toEqual({
      kind: 'bonus-if-first',
      op: 'add',
      amount: 2,
    });
  });

  it('tolerates the known Serebii leading "oints" typo (missing P)', () => {
    expect(parsePositionEffect('oints of next appeal doubles')).toEqual({ kind: 'doubles-next-move' });
  });

  it('tolerates the known Serebii "turnt" typo', () => {
    expect(parsePositionEffect('Appeals first in the next turnt')).toEqual({ kind: 'sets-first-next-turn' });
  });

  it('classifies an additive last-turn bonus', () => {
    expect(parsePositionEffect('Points +2 if last to appeal')).toEqual({
      kind: 'bonus-if-last',
      op: 'add',
      amount: 2,
    });
  });

  it('classifies "sets first next turn"', () => {
    expect(parsePositionEffect('Appeals first in the next turn')).toEqual({
      kind: 'sets-first-next-turn',
    });
  });

  it('classifies "sets last next turn"', () => {
    expect(parsePositionEffect('Appeals last in the next turn')).toEqual({
      kind: 'sets-last-next-turn',
    });
  });

  it('classifies "doubles next move"', () => {
    expect(parsePositionEffect('Points of next appeal doubles')).toEqual({
      kind: 'doubles-next-move',
    });
  });

  it('classifies an effect with no bonus as none', () => {
    expect(parsePositionEffect('No Added Effect')).toEqual({ kind: 'none' });
  });

  it('marks an effect depending on another pokemon as out-of-scope-conditional', () => {
    expect(
      parsePositionEffect(
        'Points +3 if previous pokemon reaches max voltage of a judge',
      ),
    ).toEqual({ kind: 'out-of-scope-conditional' });
  });

  it('marks an effect depending on the judge as out-of-scope-conditional', () => {
    expect(parsePositionEffect("Increases judge's voltage by 2")).toEqual({
      kind: 'out-of-scope-conditional',
    });
  });

  it('falls back to out-of-scope-conditional for unrecognized text rather than guessing', () => {
    expect(
      parsePositionEffect('Order of appealing is random in the next turn'),
    ).toEqual({ kind: 'out-of-scope-conditional' });
  });

  it('classifies "can be used twice consecutively" as no position effect, but repeatable', () => {
    expect(parsePositionEffect('Can be used twice consecutively')).toEqual({ kind: 'none' });
    expect(parseRepeatable('Can be used twice consecutively')).toBe(true);
  });

  it('does not mark an unrelated effect as repeatable', () => {
    expect(parseRepeatable('Points +2 if first to appeal')).toBe(false);
    expect(parseRepeatable('No Added Effect')).toBe(false);
  });

  it('extracts repeatable even when combined with a position effect in the same text', () => {
    expect(
      parsePositionEffect('Points +2 if first to appeal. Can be used twice consecutively.'),
    ).toEqual({ kind: 'bonus-if-first', op: 'add', amount: 2 });
    expect(
      parseRepeatable('Points +2 if first to appeal. Can be used twice consecutively.'),
    ).toBe(true);
  });
});

describe('normalizeEffectText', () => {
  it('preserves the real wording for an out-of-scope-conditional move', () => {
    const raw = 'Points +3 if Previous Pokemon Reaches Max Voltage of a Judge.';
    expect(parsePositionEffect(raw)).toEqual({ kind: 'out-of-scope-conditional' });
    expect(normalizeEffectText(raw)).toBe('Points +3 if Previous Pokemon Reaches Max Voltage of a Judge');
  });

  it('strips the "can be used twice consecutively" phrase, since Move.repeatable already covers it', () => {
    expect(normalizeEffectText('Points +2 if first to appeal. Can be used twice consecutively.')).toBe(
      'Points +2 if first to appeal',
    );
  });

  it('fixes known Serebii typos, same as parsePositionEffect', () => {
    expect(normalizeEffectText('Points +2 if firt to appeal')).toBe('Points +2 if first to appeal');
  });
});
