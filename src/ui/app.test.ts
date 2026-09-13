import { describe, expect, it } from 'vitest';
import { mount } from './app.ts';
import { combos, combosNoEgg, conditionalCombosNoEgg, moves, pokemon } from '../data/index.ts';

function searchInput(root: HTMLElement): HTMLInputElement {
  return root.querySelector<HTMLInputElement>('#pokemon-search')!;
}

function dropdown(root: HTMLElement): HTMLUListElement {
  return root.querySelector<HTMLUListElement>('#pokemon-dropdown')!;
}

function typeQuery(root: HTMLElement, query: string): void {
  const input = searchInput(root);
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event('input'));
}

function selectPokemonById(root: HTMLElement, id: number): void {
  typeQuery(root, String(id));
  const row = dropdown(root).querySelector<HTMLLIElement>(`li[data-id="${id}"]`);
  row!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

function setCategory(root: HTMLElement, category: string): void {
  const select = root.querySelector<HTMLSelectElement>('#category-select')!;
  select.value = category;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setIncludeEggMoves(root: HTMLElement, checked: boolean): void {
  const checkbox = root.querySelector<HTMLInputElement>('#egg-moves-toggle')!;
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event('change'));
}

function setLevel(root: HTMLElement, level: number): void {
  const input = root.querySelector<HTMLInputElement>('#level-input')!;
  input.value = String(level);
  input.dispatchEvent(new Event('change'));
}

/** Non-egg-move count — matches the app's default (includeEggMoves: false). */
function nonEggMoveIds(p: (typeof pokemon)[number]): string[] {
  const eggMoveIds = new Set(p.eggMoveIds);
  return p.learnableMoveIds.filter((id) => !eggMoveIds.has(id));
}

describe('mount', () => {
  it('renders the first Pokemon (by Dex number) in generic mode, excluding egg moves by default', () => {
    const root = document.createElement('div');
    mount(root);

    const sortedFirst = [...pokemon].sort((a, b) => a.id - b.id)[0];
    expect(searchInput(root).value).toBe(`#${sortedFirst.id} ${sortedFirst.name}`);

    const expectedIds = nonEggMoveIds(sortedFirst);
    const items = root.querySelectorAll('#move-list tbody tr');
    expect(items.length).toBe(expectedIds.length);

    if (expectedIds.length > 0) {
      // The table is sorted alphabetically by move name (per the user's
      // request), not by learnableMoveIds order — check the alphabetically
      // first move, not expectedIds[0].
      const alphabeticallyFirst = [...expectedIds].map((id) => moves[id]).sort((a, b) => a.name.localeCompare(b.name))[0];
      expect(items[0].textContent).toContain(alphabeticallyFirst.name);
      expect(items[0].textContent).toContain(alphabeticallyFirst.category);
      if (alphabeticallyFirst.appealPoints > 0) {
        expect(items[0].querySelector('.move-points')!.textContent).toBe('♥'.repeat(alphabeticallyFirst.appealPoints));
      }
    }
  });

  it('sorts the Learnable moves table alphabetically by name', () => {
    const withMoves = pokemon.find((p) => nonEggMoveIds(p).length > 2)!;
    const root = document.createElement('div');
    mount(root);
    selectPokemonById(root, withMoves.id);

    const names = [...root.querySelectorAll('#move-list tbody tr .move-name')].map((el) => el.textContent);
    const sortedNames = [...names].sort((a, b) => a!.localeCompare(b!));
    expect(names).toEqual(sortedNames);
  });

  it('filters the move list by category when a category is selected', () => {
    const withMoves = pokemon.find((p) => nonEggMoveIds(p).length > 0)!;
    const learnable = nonEggMoveIds(withMoves).map((id) => moves[id]);
    const categoryCounts = new Map<string, number>();
    for (const m of learnable) categoryCounts.set(m.category, (categoryCounts.get(m.category) ?? 0) + 1);
    const [category, expectedCount] = [...categoryCounts.entries()][0];

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withMoves.id);
    setCategory(root, category);

    expect(root.querySelectorAll('#move-list tbody tr').length).toBe(expectedCount);
  });

  it('shows an explicit empty state when the selected Pokemon has no moves in the filtered category', () => {
    // Requires a nonzero movepool so the empty state actually exercises category
    // filtering, not just a Pokemon that trivially has no moves of any kind.
    const noBeauty = pokemon.find(
      (p) => nonEggMoveIds(p).length > 0 && !nonEggMoveIds(p).some((id) => moves[id]?.category === 'beauty'),
    );
    expect(noBeauty, 'expected at least one Gen4 Pokemon with moves but no beauty move to exist').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, noBeauty!.id);
    setCategory(root, 'beauty');

    expect(root.querySelectorAll('#move-list tbody tr').length).toBe(0);
    expect(root.textContent).toContain('No moves found');
  });

  it('returns to the full unfiltered list when switching back to generic', () => {
    const withMoves = pokemon.find((p) => nonEggMoveIds(p).length > 0)!;

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withMoves.id);
    setCategory(root, 'beauty');
    setCategory(root, 'generic');

    expect(root.querySelectorAll('#move-list tbody tr').length).toBe(nonEggMoveIds(withMoves).length);
  });

  it('renders the precomputed (no-egg) combos for the default Pokemon', () => {
    const sortedFirst = [...pokemon].sort((a, b) => a.id - b.id)[0];
    const expected = combosNoEgg[sortedFirst.id] ?? [];

    const root = document.createElement('div');
    mount(root);

    expect(root.querySelectorAll('#combo-list li').length).toBe(expected.length);
    if (expected.length === 0) {
      expect(root.textContent).toContain('No combo found');
    } else {
      const items = root.querySelectorAll('#combo-list li');
      const expectedLabel = expected[0].moveIds.map((id) => moves[id].name).join(' → ');
      expect(items[0].querySelector('.combo-moves')!.textContent).toBe(expectedLabel);
      expect(items[0].querySelector('.combo-score')!.textContent).toBe(`${expected[0].totalScore} pt(s)`);
    }
  });

  it('keeps the same combo ranking regardless of category (AD-8) — category only highlights matching moves', () => {
    const withCombos = pokemon.find((p) => (combosNoEgg[p.id]?.length ?? 0) > 0);
    expect(withCombos, 'expected at least one Gen4 Pokemon with a precomputed combo to exist').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withCombos!.id);
    const genericLabels = [...root.querySelectorAll('#combo-list .combo-moves')].map((el) => el.textContent);
    const genericScores = [...root.querySelectorAll('#combo-list .combo-score')].map((el) => el.textContent);

    setCategory(root, 'beauty');
    const beautyLabels = [...root.querySelectorAll('#combo-list .combo-moves')].map((el) => el.textContent);
    const beautyScores = [...root.querySelectorAll('#combo-list .combo-score')].map((el) => el.textContent);

    // Same combos, same order, same scores — only the highlight class differs.
    expect(beautyLabels).toEqual(genericLabels);
    expect(beautyScores).toEqual(genericScores);
  });

  it('highlights combo moves matching the selected category, with no highlight in generic mode', () => {
    const withMatchingCombo = pokemon.find((p) => {
      const list = combosNoEgg[p.id] ?? [];
      return list.some((c) => c.moveIds.some((id) => moves[id]?.category === 'beauty'));
    });
    expect(withMatchingCombo, 'expected at least one Gen4 Pokemon with a beauty move in a combo').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withMatchingCombo!.id);
    expect(root.querySelectorAll('#combo-list .combo-move--match').length).toBe(0);

    setCategory(root, 'beauty');
    expect(root.querySelectorAll('#combo-list .combo-move--match').length).toBeGreaterThan(0);
  });

  it('renders the precomputed conditional combos as a separate list from Best combos', () => {
    const withConditional = pokemon.find((p) => (conditionalCombosNoEgg[p.id]?.length ?? 0) > 0);
    expect(withConditional, 'expected at least one Gen4 Pokemon with a precomputed conditional combo to exist').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withConditional!.id);
    const expected = conditionalCombosNoEgg[withConditional!.id]!;

    expect(root.querySelectorAll('#conditional-combo-list li').length).toBe(expected.length);
    const items = root.querySelectorAll('#conditional-combo-list li');
    expect(items[0].querySelector('.combo-score')!.textContent).toBe(`${expected[0].totalScore} pt(s)`);
  });

  it('flags conditional-combo moves that rely on assumed turn-order luck, and shows what each requires', () => {
    const withConditions = pokemon.find((p) => (conditionalCombosNoEgg[p.id] ?? []).some((c) => c.conditions.length > 0));
    expect(withConditions, 'expected at least one Gen4 Pokemon with a conditional combo that has a condition').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    selectPokemonById(root, withConditions!.id);
    expect(root.querySelectorAll('#conditional-combo-list .condition-flag').length).toBeGreaterThan(0);
    expect(root.querySelector('#conditional-combo-list .combo-conditions')).not.toBeNull();
  });

  it('shows the empty combo state for a Pokemon with no precomputed combos, without throwing', () => {
    const noCombos = pokemon.find((p) => (combosNoEgg[p.id]?.length ?? 0) === 0);
    expect(noCombos, 'expected at least one Gen4 Pokemon with zero precomputed combos to exist').toBeDefined();

    const root = document.createElement('div');
    mount(root);

    expect(() => selectPokemonById(root, noCombos!.id)).not.toThrow();

    expect(root.querySelectorAll('#combo-list li').length).toBe(0);
    expect(root.textContent).toContain('No combo found');
  });

  it('shows the real effect text for a move the engine can\'t model (out-of-scope-conditional)', () => {
    const pWithConditional = pokemon.find((p) =>
      p.learnableMoveIds.some((id) => moves[id]?.positionEffect.kind === 'out-of-scope-conditional' && moves[id]?.description),
    );
    expect(pWithConditional, 'expected at least one Gen4 Pokemon with an out-of-scope-conditional move that has a description').toBeDefined();
    const conditionalMoveId = pWithConditional!.learnableMoveIds.find(
      (id) => moves[id]?.positionEffect.kind === 'out-of-scope-conditional' && moves[id]?.description,
    )!;

    const root = document.createElement('div');
    mount(root);
    setIncludeEggMoves(root, true); // don't filter the move out if it happens to be an egg move
    selectPokemonById(root, pWithConditional!.id);

    const row = [...root.querySelectorAll('#move-list tbody tr')].find((r) => r.querySelector('.move-name')?.textContent?.startsWith(moves[conditionalMoveId].name));
    expect(row, `expected a row for "${moves[conditionalMoveId].name}"`).toBeDefined();
    expect(row!.querySelector('.move-effect')!.textContent).toContain(moves[conditionalMoveId].description);
  });

  describe('combo accordion', () => {
    it('is collapsed by default and expands to a 4-row move detail table on click', () => {
      const withCombos = pokemon.find((p) => (combosNoEgg[p.id]?.length ?? 0) > 0);
      const root = document.createElement('div');
      mount(root);
      selectPokemonById(root, withCombos!.id);

      const card = root.querySelector<HTMLElement>('#combo-list .combo-card')!;
      const accordion = card.querySelector<HTMLElement>('.combo-accordion')!;
      expect(accordion.hidden).toBe(true);
      expect(card.getAttribute('aria-expanded')).toBe('false');

      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(accordion.hidden).toBe(false);
      expect(card.getAttribute('aria-expanded')).toBe('true');
      const rows = accordion.querySelectorAll('tbody tr');
      expect(rows.length).toBe(4);

      // Clicking again collapses it.
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(accordion.hidden).toBe(true);
      expect(card.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the expanded combo detail table in the combo\'s own turn sequence (slot 1 -> 4), not alphabetical', () => {
      const withCombos = pokemon.find((p) => (combosNoEgg[p.id]?.length ?? 0) > 0);
      const root = document.createElement('div');
      mount(root);
      selectPokemonById(root, withCombos!.id);

      const card = root.querySelector<HTMLElement>('#combo-list .combo-card')!;
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const combo = combosNoEgg[withCombos!.id]![0];
      const expectedNames = combo.moveIds.map((id) => moves[id]!.name);
      const names = [...card.querySelectorAll('.combo-accordion tbody tr .move-name')].map((el) => el.textContent?.trim());
      expect(names).toEqual(expectedNames);
    });

    it('does not toggle when clicking inside an egg-swap select', () => {
      const withEggSwap = pokemon.find((p) => (combos[p.id] ?? []).some((c) => c.eggSwaps.some((s) => s.alternatives.length > 0)));
      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true);
      selectPokemonById(root, withEggSwap!.id);

      const select = root.querySelector<HTMLSelectElement>('#combo-list .egg-swap-select')!;
      const card = select.closest<HTMLElement>('.combo-card')!;
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(card.querySelector<HTMLElement>('.combo-accordion')!.hidden).toBe(true);
    });

    it('reflects an egg-swap selection change in an already-open accordion', () => {
      const withEggSwap = pokemon.find((p) => (combos[p.id] ?? []).some((c) => c.eggSwaps.some((s) => s.alternatives.length > 0)));
      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true);
      selectPokemonById(root, withEggSwap!.id);

      const select = root.querySelector<HTMLSelectElement>('#combo-list .egg-swap-select')!;
      const card = select.closest<HTMLElement>('.combo-card')!;
      card.dispatchEvent(new MouseEvent('click', { bubbles: true })); // expand first

      const altOption = [...select.options].find((o) => o.value !== select.options[0].value)!;
      select.value = altOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      const namesInAccordion = [...card.querySelectorAll('.combo-accordion tbody tr .move-name')].map((el) => el.textContent);
      const altName = moves[altOption.value].name;
      expect(namesInAccordion.some((n) => n?.startsWith(altName))).toBe(true);
    });
  });

  describe('level gating (AD-15)', () => {
    it('shows the real acquisition origin for each move in the Learnable moves table', () => {
      const withLevelMove = pokemon.find((p) => Object.values(p.moveOrigins).some((o) => o.method === 'level-up' && o.level > 1));
      expect(withLevelMove, 'expected at least one Gen4 Pokemon with a level-up move above level 1').toBeDefined();
      const [moveId, origin] = Object.entries(withLevelMove!.moveOrigins).find(([, o]) => o.method === 'level-up' && o.level > 1)!;

      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true); // don't filter the move out for an unrelated reason
      selectPokemonById(root, withLevelMove!.id);

      const row = [...root.querySelectorAll('#move-list tbody tr')].find((r) => r.querySelector('.move-name')?.textContent?.startsWith(moves[moveId].name));
      expect(row, `expected a row for "${moves[moveId].name}"`).toBeDefined();
      expect(row!.querySelector('.move-origin')!.textContent).toBe(`Level ${(origin as { level: number }).level}`);
    });

    it('hides a level-up move above the entered level, and restores it at max level', () => {
      const withLevelMove = pokemon.find((p) => Object.values(p.moveOrigins).some((o) => o.method === 'level-up' && o.level > 1));
      const [moveId] = Object.entries(withLevelMove!.moveOrigins).find(([, o]) => o.method === 'level-up' && o.level > 1)!;

      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true);
      selectPokemonById(root, withLevelMove!.id);

      const rowNames = () => [...root.querySelectorAll('#move-list tbody tr .move-name')].map((el) => el.textContent);
      expect(rowNames()).toContain(moves[moveId].name);

      setLevel(root, 1);
      expect(rowNames()).not.toContain(moves[moveId].name);

      setLevel(root, 100);
      expect(rowNames()).toContain(moves[moveId].name);
    });

    it('flags a combo move that is not yet learnable at the entered level, or substitutes it for an available alternative', () => {
      const withLevelSwap = pokemon.find((p) => (combos[p.id] ?? []).some((c) => c.levelSwaps.length > 0));
      expect(withLevelSwap, 'expected at least one Gen4 Pokemon with a level-gated combo slot').toBeDefined();

      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true);
      selectPokemonById(root, withLevelSwap!.id);
      const atMaxLevel = [...root.querySelectorAll('#combo-list .combo-moves')].map((el) => el.textContent);

      setLevel(root, 1);
      const atLevel1 = [...root.querySelectorAll('#combo-list .combo-moves')].map((el) => el.textContent);
      const hasLevelFlag = root.querySelectorAll('#combo-list .level-flag').length > 0;

      // At level 1, at least one combo either shows a "needs level" flag or
      // its move list changed (an automatic substitution happened).
      expect(hasLevelFlag || JSON.stringify(atLevel1) !== JSON.stringify(atMaxLevel)).toBe(true);
    });

    it('recomputes the combo score when a level substitution changes the actual move used', () => {
      // Find a case where even the BEST available (requiredLevel <= 1)
      // alternative scores differently from the original — otherwise the
      // picker may keep the same score with just a different move name
      // (both are valid outcomes; this test targets the score-changing one).
      const withLevelSwap = pokemon.find((p) =>
        (combos[p.id] ?? []).some((c) =>
          c.levelSwaps.some((s) => {
            const availableAtLevel1 = s.alternatives.filter((a) => a.requiredLevel <= 1);
            return availableAtLevel1.length > 0 && Math.max(...availableAtLevel1.map((a) => a.totalScore)) !== c.totalScore;
          }),
        ),
      );
      expect(withLevelSwap, 'expected at least one Gen4 Pokemon with a score-changing level substitution').toBeDefined();

      const root = document.createElement('div');
      mount(root);
      setIncludeEggMoves(root, true);
      selectPokemonById(root, withLevelSwap!.id);
      const scoresAtMaxLevel = [...root.querySelectorAll('#combo-list .combo-score')].map((el) => el.textContent);

      setLevel(root, 1);
      const scoresAtLevel1 = [...root.querySelectorAll('#combo-list .combo-score')].map((el) => el.textContent);

      expect(scoresAtLevel1).not.toEqual(scoresAtMaxLevel);
    });
  });

  describe('egg moves (AD-14)', () => {
    it('excludes egg moves from the move list and combos by default', () => {
      const withEgg = pokemon.find((p) => p.eggMoveIds.length > 0)!;

      const root = document.createElement('div');
      mount(root);

      selectPokemonById(root, withEgg.id);
      const rowNames = [...root.querySelectorAll('#move-list tbody tr .move-name')].map((el) => el.textContent);
      for (const eggId of withEgg.eggMoveIds) {
        expect(rowNames).not.toContain(moves[eggId].name);
      }
      expect(root.querySelectorAll('#combo-list .egg-flag').length).toBe(0);
    });

    it('includes egg moves in the move list and marks them when the toggle is checked', () => {
      const withEgg = pokemon.find((p) => p.eggMoveIds.length > 0)!;

      const root = document.createElement('div');
      mount(root);

      selectPokemonById(root, withEgg.id);
      setIncludeEggMoves(root, true);

      expect(root.querySelectorAll('#move-list tbody tr').length).toBe(withEgg.learnableMoveIds.length);
      const eggRow = [...root.querySelectorAll('#move-list tbody tr')].find((r) =>
        r.textContent?.includes(moves[withEgg.eggMoveIds[0]].name),
      );
      expect(eggRow?.querySelector('.egg-flag')).not.toBeNull();
    });

    it('renders an egg-move swap <select> in a Best combo, and updates the score on change', () => {
      const withEggSwap = pokemon.find((p) => (combos[p.id] ?? []).some((c) => c.eggSwaps.some((s) => s.alternatives.length > 0)));
      expect(withEggSwap, 'expected at least one Gen4 Pokemon with an egg-move swap option in a Best combo').toBeDefined();

      const root = document.createElement('div');
      mount(root);

      selectPokemonById(root, withEggSwap!.id);
      setIncludeEggMoves(root, true);

      const select = root.querySelector<HTMLSelectElement>('#combo-list .egg-swap-select');
      expect(select).not.toBeNull();
      const card = select!.closest('.combo-card')!;
      const scoreEl = card.querySelector('.combo-score')!;

      const altOption = [...select!.options].find((o) => o.value !== select!.options[0].value)!;
      select!.value = altOption.value;
      select!.dispatchEvent(new Event('change', { bubbles: true }));

      expect(scoreEl.textContent).toBe(`${altOption.dataset.score} pt(s)`);
    });
  });

  describe('Pokemon combobox', () => {
    it('filters the dropdown by a case-insensitive name substring', () => {
      const root = document.createElement('div');
      mount(root);

      typeQuery(root, 'char');

      const rows = [...dropdown(root).querySelectorAll('li[data-id]')];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.textContent!.toLowerCase()).toContain('char');
      }
    });

    it('also matches by National Dex number', () => {
      const root = document.createElement('div');
      mount(root);

      typeQuery(root, '387');

      const rows = [...dropdown(root).querySelectorAll('li[data-id]')];
      expect(rows.some((r) => r.getAttribute('data-id') === '387')).toBe(true);
    });

    it('shows an explicit "no results" row for an unmatched query', () => {
      const root = document.createElement('div');
      mount(root);

      typeQuery(root, 'zzzzzznotapokemon');

      expect(dropdown(root).querySelectorAll('li[data-id]').length).toBe(0);
      expect(dropdown(root).textContent).toContain('No Pokemon found');
    });

    it('selects a Pokemon via ArrowDown + Enter and updates the results', () => {
      const root = document.createElement('div');
      mount(root);

      const sortedFirst = [...pokemon].sort((a, b) => a.id - b.id)[0];
      const target = pokemon.find((p) => p.id !== sortedFirst.id)!;
      // Search the full "#id name" label so exactly one Pokemon matches —
      // a bare name or number substring could match several (e.g. "2" also
      // matches #12, #20, ...), which would make ArrowDown's landing spot
      // ambiguous for this test.
      typeQuery(root, `#${target.id} ${target.name}`);
      expect(dropdown(root).querySelectorAll('li[data-id]').length).toBe(1);

      const input = searchInput(root);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(input.value).toBe(`#${target.id} ${target.name}`);
      expect(root.querySelectorAll('#move-list tbody tr').length).toBe(nonEggMoveIds(target).length);
    });

    it('closes on Escape without changing the current selection, and reverts stray input text', () => {
      const root = document.createElement('div');
      mount(root);
      const sortedFirst = [...pokemon].sort((a, b) => a.id - b.id)[0];

      typeQuery(root, 'char');
      searchInput(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(dropdown(root).hidden).toBe(true);
      // Selection (and thus the results) is unchanged — Escape doesn't commit anything.
      expect(root.querySelectorAll('#move-list tbody tr').length).toBe(nonEggMoveIds(sortedFirst).length);
      expect(searchInput(root).value).toBe(`#${sortedFirst.id} ${sortedFirst.name}`);
    });

    it('reverts the input to the last valid selection on blur with unselected stray text', async () => {
      const root = document.createElement('div');
      mount(root);
      const sortedFirst = [...pokemon].sort((a, b) => a.id - b.id)[0];

      typeQuery(root, 'zzzzzznotapokemon');
      expect(dropdown(root).querySelectorAll('li[data-id]').length).toBe(0);

      searchInput(root).dispatchEvent(new FocusEvent('blur'));
      await new Promise((resolve) => setTimeout(resolve, 200)); // past the combobox's 150ms blur delay

      expect(searchInput(root).value).toBe(`#${sortedFirst.id} ${sortedFirst.name}`);
      // The stray query never committed a selection — results are still the default Pokemon's.
      expect(root.querySelectorAll('#move-list tbody tr').length).toBe(nonEggMoveIds(sortedFirst).length);
    });
  });
});
