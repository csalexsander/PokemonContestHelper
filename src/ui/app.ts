// Move Selection + Combo Display UI (Story 2/4/5). Reads directly from
// src/data/ only — never from src/engine/ (ARCHITECTURE-SPINE AD-1, AD-10):
// combos are already precomputed by scripts/precompute-combos.ts, not
// calculated live here.
// State: a single plain object for the app's actual selection, one update
// handler re-renders the results region functionally (AD-6). The Pokemon
// combobox's transient interaction state (query text, open/highlighted)
// lives in its own component closure, not in UiState — it's UI-only detail,
// not app selection, and must survive re-renders triggered by other controls
// (spec 5-ui-redesign-searchable-pokemon-picker: fixes the prior full-
// innerHTML-replace pattern that dropped focus on every interaction).
import {
  combos,
  combosNoEgg,
  conditionalCombos,
  conditionalCombosNoEgg,
  moves,
  pokemon,
  type Combo,
  type ConditionalCombo,
  type ContestCategory,
  type Move,
  type MoveOrigin,
} from '../data/index.ts';

type CategoryFilter = ContestCategory | 'generic';

const MAX_LEVEL = 100;
const MIN_LEVEL = 1;

interface UiState {
  pokemonId: number;
  category: CategoryFilter;
  /**
   * Egg moves require a bred Pokemon (AD-14), so they're excluded by
   * default from both the combo results and the Learnable moves list;
   * checking this opts back in.
   */
  includeEggMoves: boolean;
  /**
   * Pokemon's current level (ARCHITECTURE-SPINE AD-15) — defaults to
   * `MAX_LEVEL` (no restriction) so a player who doesn't care about level
   * sees the same results as before this feature existed. A level-up-gated
   * move above this level is excluded from the Learnable moves list, and
   * in a combo is automatically substituted for the best same-effect
   * alternative actually available at this level (TM/HM/tutor/transfer/egg
   * moves have no level gate at all) — or, if none qualifies, the
   * lowest-level alternative above it, flagged "needs level".
   */
  level: number;
}

const CATEGORIES: ContestCategory[] = ['beauty', 'cool', 'cute', 'smart', 'tough'];

const pokemonById = new Map(pokemon.map((p) => [p.id, p]));
const sortedPokemon = [...pokemon].sort((a, b) => a.id - b.id);

function movesFor(pokemonId: number, includeEggMoves: boolean, level: number): Move[] {
  const entry = pokemonById.get(pokemonId);
  if (!entry) return [];
  const eggMoveIds = new Set(entry.eggMoveIds);
  return entry.learnableMoveIds
    .filter((id) => includeEggMoves || !eggMoveIds.has(id))
    .filter((id) => {
      const origin = entry.moveOrigins[id];
      return !origin || origin.method !== 'level-up' || origin.level <= level;
    })
    .map((id) => {
      const move = moves[id];
      if (!move) console.warn(`[ui] "${entry.name}" (#${entry.id}) references unknown move id "${id}"`);
      return move;
    })
    .filter((m): m is Move => m !== undefined);
}

function eggMoveIdsFor(pokemonId: number): ReadonlySet<string> {
  return new Set(pokemonById.get(pokemonId)?.eggMoveIds ?? []);
}

function moveOriginsFor(pokemonId: number): Readonly<Record<string, MoveOrigin>> {
  return pokemonById.get(pokemonId)?.moveOrigins ?? {};
}

/** Human-readable acquisition method, for the Learnable moves "Origin" column. */
function originLabel(origin: MoveOrigin | undefined): string {
  if (!origin) return '—';
  switch (origin.method) {
    case 'level-up':
      return `Level ${origin.level}`;
    case 'tm':
      return `TM${origin.number}`;
    case 'hm':
      return `HM${origin.number}`;
    case 'tutor':
      return 'Move Tutor';
    case 'transfer':
      return 'Transfer';
    case 'egg':
      return 'Egg';
  }
}

/**
 * Precomputed combos for this Pokemon (AD-10) — [] if missing, never throws.
 * One canonical list per Pokemon: category never changes ranking or score
 * (AD-8 — the real game's category bonus feeds the judges' Voltage meter,
 * an opponent-dependent mechanic out of scope here), so there is nothing to
 * look up by mode. `includeEggMoves` picks between the precomputed "with"
 * and "without egg moves" lists (AD-14) — never computed live.
 */
function combosFor(pokemonId: number, includeEggMoves: boolean): Combo[] {
  return (includeEggMoves ? combos : combosNoEgg)[pokemonId] ?? [];
}

/**
 * Precomputed conditional combos for this Pokemon (AD-13) — a best-case
 * ceiling assuming favorable turn-order luck on slots no move guarantees.
 * Always a separate list from `combosFor`, never merged into it.
 */
function conditionalCombosFor(pokemonId: number, includeEggMoves: boolean): ConditionalCombo[] {
  return (includeEggMoves ? conditionalCombos : conditionalCombosNoEgg)[pokemonId] ?? [];
}

function conditionRequirementText(): string {
  return 'requires being the best scorer the previous turn';
}

const EGG_TITLE = 'Egg move — only available on a bred Pokemon';

const LEVEL_NOT_MET_TITLE_SUFFIX = ' — not learnable yet at the entered level';

/**
 * Picks which move actually fills a level-gated slot at `inputLevel`: the
 * original move if its own level is already met, otherwise the
 * highest-scoring alternative that IS met, otherwise (nothing qualifies)
 * the lowest-level option above `inputLevel` (ties broken by score) —
 * flagged `met: false` so the UI can show "needs level". Same-`kind`
 * substitutes never change how OTHER slots score (AD-14/AD-15's shared
 * reasoning), so `totalScore` deltas across independently-picked slots are
 * exact and additive — see `comboLabel`/`conditionalComboLabel`.
 */
function pickLevelOption(
  originalMoveId: string,
  originalLevel: number,
  comboTotalScore: number,
  alternatives: Combo['levelSwaps'][number]['alternatives'],
  inputLevel: number,
): { moveId: string; requiredLevel: number; totalScore: number; met: boolean } {
  const allOptions = [{ moveId: originalMoveId, requiredLevel: originalLevel, totalScore: comboTotalScore }, ...alternatives];
  const qualifying = allOptions.filter((o) => o.requiredLevel <= inputLevel);
  if (qualifying.length > 0) {
    return { ...qualifying.reduce((best, o) => (o.totalScore > best.totalScore ? o : best)), met: true };
  }
  const closest = allOptions.reduce((best, o) =>
    o.requiredLevel < best.requiredLevel || (o.requiredLevel === best.requiredLevel && o.totalScore > best.totalScore) ? o : best,
  );
  return { ...closest, met: false };
}

/**
 * Renders one combo slot and returns the score delta it contributes versus
 * the combo's precomputed `totalScore` (0 unless a level substitution
 * happened). Plain text normally; an egg move with precomputed swap
 * alternatives (AD-14) renders an inline `<select>` the user can change
 * (handled by a delegated listener in `mount`); a level-gated move not yet
 * learnable at `level` is auto-substituted per `pickLevelOption` (AD-15) —
 * both use only precomputed data, never a live Engine call (AD-1 stays
 * strict, per the user's explicit choice).
 */
function renderComboSlot(
  moveId: string,
  slotIndex: number,
  category: CategoryFilter,
  requires: 'last' | undefined,
  eggMoveIds: ReadonlySet<string>,
  moveOrigins: Readonly<Record<string, MoveOrigin>>,
  combo: Combo,
  level: number,
): { html: string; scoreDelta: number } {
  const isEgg = eggMoveIds.has(moveId);
  const origin = moveOrigins[moveId];
  const eggSwap = isEgg ? combo.eggSwaps.find((s) => s.slotIndex === slotIndex) : undefined;
  const levelSwap =
    !isEgg && origin?.method === 'level-up' ? combo.levelSwaps.find((s) => s.slotIndex === slotIndex) : undefined;

  let displayMoveId = moveId;
  let scoreDelta = 0;
  let needsLevelBadge = '';
  if (levelSwap) {
    const pick = pickLevelOption(moveId, levelSwap.originalLevel, combo.totalScore, levelSwap.alternatives, level);
    if (pick.moveId !== moveId) {
      displayMoveId = pick.moveId;
      scoreDelta = pick.totalScore - combo.totalScore;
    }
    if (!pick.met) {
      needsLevelBadge = ` <span class="level-flag" aria-hidden="true" title="Needs level ${escapeHtml(String(pick.requiredLevel))}${LEVEL_NOT_MET_TITLE_SUFFIX}">⬆Lv${pick.requiredLevel}</span>`;
    }
  }

  const move = moves[displayMoveId];
  const name = escapeHtml(move?.name ?? displayMoveId);
  const classes = ['combo-move'];
  if (move && category !== 'generic' && move.category === category) classes.push('combo-move--match');
  if (requires) classes.push('combo-move--conditional');
  const title = requires ? ` title="${escapeHtml(conditionRequirementText())}"` : isEgg ? ` title="${escapeHtml(EGG_TITLE)}"` : '';
  const conditionBadge = requires ? ' <span class="condition-flag" aria-hidden="true">*</span>' : '';
  const eggBadge = ' <span class="egg-flag" aria-hidden="true">🥚</span>';

  if (eggSwap && eggSwap.alternatives.length > 0) {
    const options = [
      `<option value="${escapeHtml(moveId)}" data-score="${combo.totalScore}" selected>🥚 ${name} (current)</option>`,
      ...eggSwap.alternatives.map((alt) => {
        const altName = escapeHtml(moves[alt.moveId]?.name ?? alt.moveId);
        return `<option value="${escapeHtml(alt.moveId)}" data-score="${alt.totalScore}">${altName} (${alt.totalScore} pt(s))</option>`;
      }),
    ].join('');
    return {
      html: `<span class="${classes.join(' ')}"${title}><select class="egg-swap-select" aria-label="Swap egg move ${name} for a non-egg alternative">${options}</select>${conditionBadge}</span>`,
      scoreDelta,
    };
  }

  return {
    html: `<span class="${classes.join(' ')}"${title} data-move-id="${escapeHtml(displayMoveId)}">${name}${isEgg ? eggBadge : ''}${conditionBadge}${needsLevelBadge}</span>`,
    scoreDelta,
  };
}

/** Renders each move name, highlighting the ones matching `category` — purely cosmetic (AD-8): it does not mean those moves scored differently. */
function comboLabel(
  combo: Combo,
  category: CategoryFilter,
  eggMoveIds: ReadonlySet<string>,
  moveOrigins: Readonly<Record<string, MoveOrigin>>,
  level: number,
): { html: string; displayScore: number } {
  let displayScore = combo.totalScore;
  const html = combo.moveIds
    .map((id, i) => {
      const slot = renderComboSlot(id, i, category, undefined, eggMoveIds, moveOrigins, combo, level);
      displayScore += slot.scoreDelta;
      return slot.html;
    })
    .join('<span class="combo-arrow"> → </span>');
  return { html, displayScore };
}

/** Like `comboLabel`, but also flags moves whose bonus assumes favorable turn-order luck (AD-13). */
function conditionalComboLabel(
  combo: ConditionalCombo,
  category: CategoryFilter,
  eggMoveIds: ReadonlySet<string>,
  moveOrigins: Readonly<Record<string, MoveOrigin>>,
  level: number,
): { html: string; displayScore: number } {
  const conditionBySlot = new Map(combo.conditions.map((c) => [c.slotIndex, c.requires]));
  let displayScore = combo.totalScore;
  const html = combo.moveIds
    .map((id, i) => {
      const slot = renderComboSlot(id, i, category, conditionBySlot.get(i), eggMoveIds, moveOrigins, combo, level);
      displayScore += slot.scoreDelta;
      return slot.html;
    })
    .join('<span class="combo-arrow"> → </span>');
  return { html, displayScore };
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function pokemonLabel(id: number, name: string): string {
  return `#${id} ${name}`;
}

/** Human-readable summary of a move's positionEffect, for the Learnable moves list. */
function effectLabel(move: Move): string {
  const { kind, op, amount } = move.positionEffect;
  const magnitude = op === 'multiply' ? `×${amount}` : `+${amount}`;
  switch (kind) {
    case 'bonus-if-first':
      return `${magnitude} if first`;
    case 'bonus-if-last':
      return `${magnitude} if last`;
    case 'sets-first-next-turn':
      return 'Sets first next turn';
    case 'sets-last-next-turn':
      return 'Sets last next turn';
    case 'doubles-next-move':
      return 'Doubles next move';
    case 'out-of-scope-conditional':
      // Not modeled (depends on other Pokemon/judges — non-goal), but the
      // player should still be able to read what the move actually does.
      return move.description ? `Not modeled: ${move.description}` : 'Not modeled';
    default:
      return '—';
  }
}

const MAX_RENDERED_HEARTS = 10;

/**
 * `appealPoints` as filled hearts — there's no fixed max scale in-game, so
 * this just repeats one heart per point (0 points renders no hearts, not a
 * blank/empty heart, since there's nothing to contrast it against). Capped
 * so a future move with an unusually high value can't blow out the table
 * layout with an unbroken run of glyphs.
 */
function pointsHearts(appealPoints: number): string {
  if (appealPoints <= 0) return '—';
  if (appealPoints > MAX_RENDERED_HEARTS) return `♥×${appealPoints}`;
  return '♥'.repeat(appealPoints);
}

/**
 * Shared Type/Name/Effect/Points/Origin table — used for both the Learnable
 * moves list and a combo's expanded detail (see `renderComboAccordion`).
 * The Learnable moves list is sorted alphabetically by move name (browsing
 * aid); a combo's expanded detail is NOT re-sorted — it keeps the combo's
 * actual turn sequence (slot 1 → 4), since that order is the point of
 * looking at it.
 */
function renderMoveTable(
  movesList: readonly Move[],
  moveOrigins: Readonly<Record<string, MoveOrigin>>,
  eggMoveIds: ReadonlySet<string>,
  tableId?: string,
  sortAlphabetically = true,
): string {
  if (movesList.length === 0) return '<p class="empty-state">No moves found.</p>';
  const sorted = sortAlphabetically ? [...movesList].sort((a, b) => a.name.localeCompare(b.name)) : movesList;
  return `<div class="move-table-wrap"><table${tableId ? ` id="${tableId}"` : ''} class="move-table">
      <thead><tr><th>Type</th><th>Name</th><th>Effect</th><th>Points</th><th>Origin</th></tr></thead>
      <tbody>
        ${sorted
          .map(
            (m) =>
              `<tr class="move-row move-row--${m.category}"><td class="move-category">${m.category}</td><td class="move-name">${escapeHtml(m.name)}${eggMoveIds.has(m.id) ? ` <span class="egg-flag" aria-hidden="true" title="${escapeHtml(EGG_TITLE)}">🥚</span>` : ''}</td><td class="move-effect">${escapeHtml(effectLabel(m))}</td><td class="move-points" aria-label="${m.appealPoints} pt(s)" title="${m.appealPoints} pt(s)">${pointsHearts(m.appealPoints)}</td><td class="move-origin">${escapeHtml(originLabel(moveOrigins[m.id]))}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
}

/**
 * Builds the expanded per-combo detail table (accordion content) from the 4
 * move ids CURRENTLY effective for a rendered combo card — read live from
 * the DOM (`.combo-move[data-move-id]` for plain slots, `.egg-swap-select`'s
 * value for swappable ones) so it reflects any egg-swap selection or
 * level-based substitution already displayed, not just the precomputed
 * original `Combo.moveIds`.
 */
function renderComboAccordion(
  moveIds: readonly string[],
  moveOrigins: Readonly<Record<string, MoveOrigin>>,
  eggMoveIds: ReadonlySet<string>,
): string {
  const movesList = moveIds.map((id) => moves[id]).filter((m): m is Move => m !== undefined);
  return renderMoveTable(movesList, moveOrigins, eggMoveIds, undefined, false);
}

/** Reads the 4 move ids a rendered combo card is CURRENTLY showing (post egg-swap/level substitution). */
function currentMoveIdsFromCard(card: HTMLElement): string[] {
  return [...card.querySelectorAll<HTMLElement>('.combo-moves > .combo-move')].map((slotEl) => {
    const select = slotEl.querySelector<HTMLSelectElement>('.egg-swap-select');
    return select ? select.value : (slotEl.dataset.moveId ?? '');
  });
}

// ---------------------------------------------------------------------------
// Searchable Pokemon combobox — vanilla TS/DOM, no library (stack.md).
// Substring, case-insensitive match against "#{id} {name}" (so both the
// name and the Dex number are searchable). Built once in mount(); its own
// query/open/highlighted state is local, never part of UiState.
// ---------------------------------------------------------------------------

interface ComboboxHandle {
  /** Reflect an externally-driven selection (e.g. initial state) into the input's displayed value. */
  setSelected(id: number): void;
}

function createPokemonCombobox(
  container: HTMLElement,
  onSelect: (id: number) => void,
): ComboboxHandle {
  container.innerHTML = `
    <input id="pokemon-search" type="text" autocomplete="off" aria-autocomplete="list" aria-expanded="false"
      aria-haspopup="listbox" aria-controls="pokemon-dropdown" role="combobox" placeholder="Search by name or #Dex..." />
    <ul class="combobox-dropdown" id="pokemon-dropdown" role="listbox" hidden></ul>
  `;
  const input = container.querySelector<HTMLInputElement>('#pokemon-search')!;
  const dropdown = container.querySelector<HTMLUListElement>('#pokemon-dropdown')!;

  let matches: typeof sortedPokemon = [];
  let highlighted = -1;
  let selectedId: number | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;

  function optionId(id: number): string {
    return `pokemon-option-${id}`;
  }

  function revertToSelection(): void {
    if (selectedId !== null) {
      const p = pokemonById.get(selectedId)!;
      input.value = pokemonLabel(p.id, p.name);
    }
  }

  function close(): void {
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    highlighted = -1;
  }

  function renderDropdown(): void {
    if (matches.length === 0) {
      dropdown.innerHTML = '<li class="combobox-empty">No Pokemon found</li>';
    } else {
      dropdown.innerHTML = matches
        .map(
          (p, i) =>
            `<li id="${optionId(p.id)}" role="option" data-id="${p.id}" aria-selected="${i === highlighted}" class="${i === highlighted ? 'highlighted' : ''}">${escapeHtml(pokemonLabel(p.id, p.name))}</li>`,
        )
        .join('');
    }
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (highlighted >= 0 && matches[highlighted]) {
      input.setAttribute('aria-activedescendant', optionId(matches[highlighted].id));
      dropdown.querySelector(`#${optionId(matches[highlighted].id)}`)?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function search(query: string): void {
    const q = query.trim().toLowerCase();
    matches = q === '' ? sortedPokemon : sortedPokemon.filter((p) => pokemonLabel(p.id, p.name).toLowerCase().includes(q));
    highlighted = matches.length > 0 ? 0 : -1;
    renderDropdown();
  }

  function choose(id: number): void {
    const p = pokemonById.get(id);
    if (!p) return;
    selectedId = id;
    input.value = pokemonLabel(p.id, p.name);
    close();
    onSelect(id);
  }

  input.addEventListener('input', () => {
    clearTimeout(blurTimer);
    search(input.value);
  });
  input.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    // Show the full list on focus rather than pre-filtering to whatever
    // label a prior selection left in the input — otherwise picking a
    // different Pokemon requires manually clearing the field first. The
    // text is also selected so typing immediately replaces it.
    search('');
    input.select();
  });
  input.addEventListener('blur', () => {
    // Delay so a click on a dropdown row registers before we close it.
    // Cancellable: a fast refocus (e.g. click away then immediately back)
    // clears this via the input/focus handlers above, so it can't close a
    // dropdown that was just reopened for a new interaction.
    blurTimer = setTimeout(() => {
      close();
      revertToSelection();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      search(input.value);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length > 0) {
        highlighted = (highlighted + 1) % matches.length;
        renderDropdown();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length > 0) {
        highlighted = (highlighted - 1 + matches.length) % matches.length;
        renderDropdown();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted >= 0 && matches[highlighted]) choose(matches[highlighted].id);
    } else if (e.key === 'Escape') {
      close();
      revertToSelection();
    }
  });
  dropdown.addEventListener('mousedown', (e) => {
    // mousedown (not click) fires before the input's blur handler.
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]');
    if (li) choose(Number(li.dataset.id));
  });

  return {
    setSelected(id: number): void {
      const p = pokemonById.get(id);
      if (!p) return;
      selectedId = id;
      input.value = pokemonLabel(p.id, p.name);
    },
  };
}

// ---------------------------------------------------------------------------
// Results (combos + moves) — the only region re-rendered on every state
// change; the combobox and category select are built once and never replaced.
// ---------------------------------------------------------------------------

function renderResults(root: HTMLElement, state: UiState): void {
  const eggMoveIds = eggMoveIdsFor(state.pokemonId);
  const moveOrigins = moveOriginsFor(state.pokemonId);
  const learnable = movesFor(state.pokemonId, state.includeEggMoves, state.level);
  const visible = state.category === 'generic' ? learnable : learnable.filter((m) => m.category === state.category);
  const rankedCombos = combosFor(state.pokemonId, state.includeEggMoves);
  const rankedConditionalCombos = conditionalCombosFor(state.pokemonId, state.includeEggMoves);
  const noteParts: string[] = [];
  if (state.includeEggMoves) {
    noteParts.push('<span class="egg-flag" aria-hidden="true">🥚</span> egg move — click to swap');
  }
  if (state.level < MAX_LEVEL) {
    noteParts.push(`<span class="level-flag" aria-hidden="true">⬆Lv</span> needs a higher level — best available shown`);
  }
  const bestCombosNote = noteParts.length > 0 ? `<p class="combo-note">${noteParts.join(' · ')}</p>` : '';

  root.innerHTML = `
    <section class="panel">
      <h2>Best combos</h2>
      ${bestCombosNote}
      ${
        rankedCombos.length === 0
          ? '<p class="empty-state">No combo found for this Pokemon.</p>'
          : `<ol id="combo-list" class="combo-list">
              ${rankedCombos
                .map((c, i) => {
                  const { html, displayScore } = comboLabel(c, state.category, eggMoveIds, moveOrigins, state.level);
                  return `<li class="combo-card" tabindex="0" role="button" aria-expanded="false">
                    <span class="combo-rank">${i + 1}</span><span class="combo-moves">${html}</span><span class="combo-score">${displayScore} pt(s)</span><span class="combo-expand-icon" aria-hidden="true">▸</span>
                    <div class="combo-accordion" hidden></div>
                  </li>`;
                })
                .join('')}
            </ol>`
      }
    </section>

    <section class="panel">
      <h2>Conditional combos</h2>
      <p class="combo-note"><span class="condition-flag" aria-hidden="true">*</span> needs a lucky turn-order bet (max 1 per combo)</p>
      ${
        rankedConditionalCombos.length === 0
          ? '<p class="empty-state">No conditional combo found for this Pokemon.</p>'
          : `<ol id="conditional-combo-list" class="combo-list">
              ${rankedConditionalCombos
                .map((c, i) => {
                  const conditionsText = c.conditions
                    .map((cond) => `Turn ${cond.slotIndex + 1}: ${conditionRequirementText()}`)
                    .join('; ');
                  const { html, displayScore } = conditionalComboLabel(c, state.category, eggMoveIds, moveOrigins, state.level);
                  return `<li class="combo-card combo-card--conditional" tabindex="0" role="button" aria-expanded="false">
                    <span class="combo-rank">${i + 1}</span>
                    <span class="combo-moves">${html}</span>
                    <span class="combo-score">${displayScore} pt(s)</span>
                    <span class="combo-expand-icon" aria-hidden="true">▸</span>
                    ${conditionsText ? `<span class="combo-conditions">${escapeHtml(conditionsText)}</span>` : ''}
                    <div class="combo-accordion" hidden></div>
                  </li>`;
                })
                .join('')}
            </ol>`
      }
    </section>

    <section class="panel">
      <h2>Learnable moves</h2>
      <div class="field">
        <label for="category-select">Category</label>
        <select id="category-select">
          <option value="generic"${state.category === 'generic' ? ' selected' : ''}>Generic (all categories)</option>
          ${CATEGORIES.map((c) => `<option value="${c}"${state.category === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <p class="move-count">${visible.length} move(s)${state.category === 'generic' ? '' : ` in "${state.category}"`}${state.level < MAX_LEVEL ? ` at level ${state.level}` : ''}</p>
      ${visible.length === 0 ? '<p class="empty-state">No moves found for this Pokemon and category.</p>' : renderMoveTable(visible, moveOrigins, eggMoveIds, 'move-list')}
    </section>
  `;
}

export function mount(root: HTMLElement): void {
  if (sortedPokemon.length === 0) {
    root.innerHTML = '<p>No Pokemon data available.</p>';
    return;
  }

  root.innerHTML = `
    <header class="app-header">
      <h1><span class="pokeball-icon" aria-hidden="true"></span>Pokemon Contest Combos <span class="gen-badge">Gen 4</span></h1>
    </header>
    <section class="controls">
      <div class="field">
        <label for="pokemon-search">Pokemon</label>
        <div class="combobox" id="pokemon-combobox"></div>
      </div>
      <div class="field field--checkbox">
        <label><input type="checkbox" id="egg-moves-toggle" /> Include egg moves (bred Pokemon only)</label>
      </div>
      <div class="field">
        <label for="level-input">Pokemon level</label>
        <input type="number" id="level-input" min="${MIN_LEVEL}" max="${MAX_LEVEL}" value="${MAX_LEVEL}" />
      </div>
    </section>
    <div id="results" aria-live="polite"></div>
  `;

  let state: UiState = { pokemonId: sortedPokemon[0].id, category: 'generic', includeEggMoves: false, level: MAX_LEVEL };
  const resultsEl = root.querySelector<HTMLElement>('#results')!;

  const update = (next: Partial<UiState>): void => {
    state = { ...state, ...next };
    renderResults(resultsEl, state);
  };

  const combobox = createPokemonCombobox(root.querySelector<HTMLElement>('#pokemon-combobox')!, (id) =>
    update({ pokemonId: id }),
  );
  combobox.setSelected(state.pokemonId);

  root.querySelector<HTMLInputElement>('#egg-moves-toggle')!.addEventListener('change', (e) => {
    update({ includeEggMoves: (e.target as HTMLInputElement).checked });
  });

  root.querySelector<HTMLInputElement>('#level-input')!.addEventListener('change', (e) => {
    const raw = Number((e.target as HTMLInputElement).value);
    const level = Number.isFinite(raw) ? Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(raw))) : MAX_LEVEL;
    (e.target as HTMLInputElement).value = String(level); // reflect any clamping back into the field
    update({ level });
  });

  /** Re-renders a combo card's expanded detail from whatever it's CURRENTLY showing (post egg-swap/level substitution). */
  function refreshAccordion(card: HTMLElement): void {
    const accordion = card.querySelector<HTMLElement>('.combo-accordion');
    if (!accordion || accordion.hidden) return;
    const moveIds = currentMoveIdsFromCard(card);
    accordion.innerHTML = renderComboAccordion(moveIds, moveOriginsFor(state.pokemonId), eggMoveIdsFor(state.pokemonId));
  }

  // Delegated so it survives renderResults' full innerHTML rebuild (AD-6) —
  // no per-select listener to re-attach. Swapping only updates the DOM: the
  // resulting score was already precomputed (AD-14), never computed live.
  resultsEl.addEventListener('change', (e) => {
    const categorySelect = (e.target as HTMLElement).closest<HTMLSelectElement>('#category-select');
    if (categorySelect) {
      update({ category: categorySelect.value as CategoryFilter });
      return;
    }
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('.egg-swap-select');
    if (!select) return;
    const option = select.selectedOptions[0];
    const score = option?.dataset.score;
    const card = select.closest<HTMLElement>('.combo-card');
    const scoreEl = card?.querySelector('.combo-score');
    if (scoreEl && score) scoreEl.textContent = `${score} pt(s)`;
    if (card) refreshAccordion(card);
  });

  // Click (or Enter/Space) on a combo card expands/collapses a detail table
  // of its 4 current moves (Type/Name/Effect/Points/Origin, same as the
  // Learnable moves table) — built live from the DOM so it reflects any
  // egg-swap/level substitution already displayed. Clicks inside the
  // egg-swap `<select>` are left alone so it can still be operated normally.
  function toggleAccordion(card: HTMLElement): void {
    const accordion = card.querySelector<HTMLElement>('.combo-accordion');
    if (!accordion) return;
    const opening = accordion.hidden;
    accordion.hidden = !opening;
    card.setAttribute('aria-expanded', String(opening));
    const icon = card.querySelector('.combo-expand-icon');
    if (icon) icon.textContent = opening ? '▾' : '▸';
    if (opening) refreshAccordion(card);
  }

  resultsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('select')) return;
    const card = target.closest<HTMLElement>('.combo-card');
    if (card) toggleAccordion(card);
  });

  resultsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    if (target.closest('select')) return;
    const card = target.closest<HTMLElement>('.combo-card');
    if (!card) return;
    e.preventDefault(); // avoid scrolling the page on Space
    toggleAccordion(card);
  });

  renderResults(resultsEl, state);
}
