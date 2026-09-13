// One-time Gen4 data extraction script (ARCHITECTURE-SPINE: "Processo de
// extração do dataset estático"). NOT part of the app bundle and never
// imported by app code (AD-4) — run manually with `npm run extract:gen4`.
//
// Sources (see spec-pokemon-contest-combos/data-sources.md):
//  - Serebii Attackdex-DP, 5 category pages -> contest moves (src/data/moves.ts)
//  - PokemonDB moves/4 per Pokemon         -> learnable movesets + egg moves
//    (a move counts as an egg move only if it's EGG-ONLY in every Gen4
//    version it appears in — see extractMovesetSlugs)
//  - Bulbapedia National Dex list           -> every Pokemon usable in Gen4 (#1-#493)
//
// Static output is committed as typed TS modules under src/data/. No runtime
// fetch happens anywhere in the app (AD-4).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEffectText, parsePositionEffect, parseRepeatable } from './lib/effect-parser.ts';
import type { ContestCategory, Move, MoveOrigin, Pokemon } from '../src/data/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../src/data');

const CATEGORY_URLS: Record<ContestCategory, string> = {
  beauty: 'https://www.serebii.net/attackdex-dp/beauty.shtml',
  cool: 'https://www.serebii.net/attackdex-dp/cool.shtml',
  cute: 'https://www.serebii.net/attackdex-dp/cute.shtml',
  smart: 'https://www.serebii.net/attackdex-dp/smart.shtml',
  tough: 'https://www.serebii.net/attackdex-dp/tough.shtml',
};

const BULBAPEDIA_URL =
  'https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_by_National_Pok%C3%A9dex_number';

const USER_AGENT =
  'pokemon-contest-combos-data-extraction/1.0 (one-time build script; contact: repo owner)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status} ${res.statusText}): ${url}`);
  }
  return res.text();
}

/** Move id slug rule (ARCHITECTURE-SPINE Consistency Conventions). */
function slugify(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id) {
    throw new Error(`slugify produced an empty id for move name "${name}"`);
  }
  return id;
}

/** Join key used only to reconcile spelling differences between sites
 * (e.g. Serebii "Bubblebeam" vs PokemonDB "bubble-beam") — never stored,
 * see spec I/O matrix row "Move name mismatch between sites". */
function joinKey(id: string): string {
  return id.replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Serebii Attackdex-DP: contest moves per category
// ---------------------------------------------------------------------------

function parseCategoryPage(html: string, category: ContestCategory): Move[] {
  const rows = html.split('<tr>').map((r) => r.split('</tr>')[0]);
  const moves: Move[] = [];

  for (const row of rows) {
    const nameMatch = row.match(
      /href="\/attackdex-dp\/[a-z0-9-]+\.shtml">([^<]+)<\/a>/,
    );
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const idx = row.lastIndexOf('fooinfo">');
    if (idx < 0) {
      console.warn(`[serebii:${category}] no effect cell found for "${name}", skipping`);
      continue;
    }
    let effectCell = row.slice(idx + 'fooinfo">'.length);
    const appealPoints = (effectCell.match(/appeal\.gif/g) ?? []).length;
    effectCell = effectCell.split('<img')[0];
    const effectText = effectCell.replace(/<\/td>/g, '').replace(/\s+/g, ' ').trim();

    moves.push({
      id: slugify(name),
      name,
      category,
      appealPoints,
      positionEffect: parsePositionEffect(effectText),
      repeatable: parseRepeatable(effectText),
      description: normalizeEffectText(effectText),
    });
  }

  return moves;
}

async function extractMoves(): Promise<Record<string, Move>> {
  const moves: Record<string, Move> = {};

  for (const [category, url] of Object.entries(CATEGORY_URLS) as Array<
    [ContestCategory, string]
  >) {
    const html = await fetchText(url);
    const categoryMoves = parseCategoryPage(html, category);
    if (categoryMoves.length === 0) {
      throw new Error(`No moves parsed from ${url} — page structure may have changed`);
    }
    for (const move of categoryMoves) {
      const existing = moves[move.id];
      if (existing) {
        console.warn(
          existing.category !== move.category
            ? `[moves] "${move.id}" appears in both "${existing.category}" and "${move.category}" categories; keeping "${existing.category}"`
            : `[moves] duplicate "${move.id}" within category "${move.category}"; keeping the first occurrence`,
        );
        continue;
      }
      moves[move.id] = move;
    }
    await sleep(200);
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Bulbapedia: every Pokemon usable in Gen4 (Diamond/Pearl/Platinum) contests,
// i.e. all species from Generation I through Generation IV (National Dex
// #1-#493) — not just the species newly introduced in Gen4. Confirmed with
// the user: the tool must cover any Pokemon a player could actually bring
// into a Gen4 contest, not only Sinnoh natives.
// ---------------------------------------------------------------------------

async function extractGen4PokemonList(): Promise<Array<{ id: number; name: string }>> {
  const html = await fetchText(BULBAPEDIA_URL);
  const startIdx = html.indexOf('id="Generation_I"');
  const endIdx = html.indexOf('id="Generation_V"');
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error('Could not locate Generation I-IV sections on Bulbapedia page — page structure may have changed');
  }
  const section = html.slice(startIdx, endIdx);

  const re = /#(\d{4})<\/td>[\s\S]*?title="([^"(]+)(?: \(Pok[^"]*\))?"[^>]*>([^<]+)<\/a><br>/g;
  const list: Array<{ id: number; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(section))) {
    list.push({ id: Number(match[1]), name: match[3] });
  }
  if (list.length === 0) {
    throw new Error('Parsed zero Pokemon from Bulbapedia — page structure may have changed');
  }
  const seenIds = new Set<number>();
  for (const entry of list) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate Dex #${entry.id} parsed from Bulbapedia — page structure may have changed`);
    }
    seenIds.add(entry.id);
  }
  const EXPECTED_GEN4_USABLE_COUNT = 493; // National Dex #1-493, confirmed with the user (see spec)
  if (list.length !== EXPECTED_GEN4_USABLE_COUNT) {
    console.warn(
      `[bulbapedia] parsed ${list.length} Pokemon, expected ${EXPECTED_GEN4_USABLE_COUNT} — a row may have been silently missed by the extraction regex`,
    );
  }
  return list;
}

// ---------------------------------------------------------------------------
// PokemonDB: moveset per Pokemon, Gen4
// ---------------------------------------------------------------------------

function pokemonDbSlug(name: string): string {
  return name
    .replace(/♀/g, '-f')
    .replace(/♂/g, '-m')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MOVE_LINK_RE = /class="ent-name" href="\/move\/([a-z0-9-]+)"/g;
const LEVEL_ROW_RE = /<td class="cell-num">(\d+)<\/td><td class="cell-name"><a class="ent-name" href="\/move\/([a-z0-9-]+)"/g;
const TM_ROW_RE = /<a href="\/item\/tm(\d+)"[^>]*>\d+<\/a><\/td><td class="cell-name"><a class="ent-name" href="\/move\/([a-z0-9-]+)"/g;
const HM_ROW_RE = /<a href="\/item\/hm(\d+)"[^>]*>\d+<\/a><\/td><td class="cell-name"><a class="ent-name" href="\/move\/([a-z0-9-]+)"/g;

function extractMoveSlugs(html: string): Set<string> {
  const slugs = new Set<string>();
  let match: RegExpExecArray | null;
  MOVE_LINK_RE.lastIndex = 0;
  while ((match = MOVE_LINK_RE.exec(html))) {
    slugs.add(match[1]);
  }
  return slugs;
}

// One raw acquisition-method observation for a move, from one version's
// section — same shape as the domain `MoveOrigin` (src/data/types.ts),
// reused directly since `reduceOrigin` collapses a list of these into one.
type RawOrigin = MoveOrigin;

/**
 * PokemonDB's moves/4 page repeats one `<h3>...</h3>` section per acquisition
 * method (Level up, Egg moves, TM, HM, Move Tutor, Transfer-only) for EACH
 * Gen4 game version (D&P, Platinum, HG&SS). This walks every section once,
 * classifying it by its heading text, and records every raw origin
 * observation per move slug (a move can appear under several
 * headings/versions — the caller reduces these to one canonical origin).
 */
function extractSections(html: string): Map<string, RawOrigin[]> {
  const bySlug = new Map<string, RawOrigin[]>();
  function record(slug: string, origin: RawOrigin): void {
    const list = bySlug.get(slug);
    if (list) list.push(origin);
    else bySlug.set(slug, [origin]);
  }

  const sections = html.split(/<h3[^>]*>/);
  for (let i = 1; i < sections.length; i++) {
    const chunk = sections[i];
    const headingMatch = chunk.match(/^([^<]*)</);
    const heading = headingMatch ? headingMatch[1].trim() : '';

    if (heading === 'Moves learnt by level up') {
      LEVEL_ROW_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LEVEL_ROW_RE.exec(chunk))) record(m[2], { method: 'level-up', level: Number(m[1]) });
    } else if (heading === 'Moves learnt by TM') {
      TM_ROW_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TM_ROW_RE.exec(chunk))) record(m[2], { method: 'tm', number: m[1] });
    } else if (heading === 'Moves learnt by HM') {
      HM_ROW_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HM_ROW_RE.exec(chunk))) record(m[2], { method: 'hm', number: m[1] });
    } else if (heading === 'Move Tutor moves') {
      for (const slug of extractMoveSlugs(chunk)) record(slug, { method: 'tutor' });
    } else if (heading === 'Transfer-only moves') {
      for (const slug of extractMoveSlugs(chunk)) record(slug, { method: 'transfer' });
    } else if (heading === 'Egg moves') {
      for (const slug of extractMoveSlugs(chunk)) record(slug, { method: 'egg' });
    }
  }
  return bySlug;
}

/**
 * Reduces every raw origin observation for one move (across versions) to a
 * single canonical origin: TM/HM/Move Tutor/Transfer-only all mean "no level
 * requirement, obtainable any time" — if a move is reachable that way in ANY
 * version, that's the most useful thing to show/gate on, even if it's also
 * level-up-only in another version. Only when EVERY observation is
 * level-up does the move get a real level requirement (the LOWEST across
 * versions — the most favorable route). Only when EVERY observation is
 * 'egg' does it count as a true egg move (mirrors the prior egg-only rule).
 */
function reduceOrigin(observations: RawOrigin[]): RawOrigin {
  const tm = observations.find((o) => o.method === 'tm');
  if (tm) return tm;
  const hm = observations.find((o) => o.method === 'hm');
  if (hm) return hm;
  if (observations.some((o) => o.method === 'tutor')) return { method: 'tutor' };
  if (observations.some((o) => o.method === 'transfer')) return { method: 'transfer' };
  const levels = observations.filter((o): o is { method: 'level-up'; level: number } => o.method === 'level-up');
  if (levels.length > 0) {
    return { method: 'level-up', level: Math.min(...levels.map((o) => o.level)) };
  }
  return { method: 'egg' };
}

async function fetchMovesetSections(pokemonName: string): Promise<Map<string, RawOrigin[]>> {
  const slug = pokemonDbSlug(pokemonName);
  const url = `https://pokemondb.net/pokedex/${slug}/moves/4`;
  const html = await fetchText(url);
  return extractSections(html);
}

async function extractPokemon(
  moves: Record<string, Move>,
): Promise<{ pokemon: Pokemon[]; unmatchedSlugs: Set<string> }> {
  const dexList = await extractGen4PokemonList();
  dexList.sort((a, b) => a.id - b.id);

  const moveByJoinKey = new Map<string, Move>();
  for (const move of Object.values(moves)) {
    const key = joinKey(move.id);
    if (moveByJoinKey.has(key)) {
      console.warn(`[moves] join-key collision: "${move.id}" and "${moveByJoinKey.get(key)!.id}" both normalize to "${key}"; keeping the first`);
      continue;
    }
    moveByJoinKey.set(key, move);
  }

  const pokemon: Pokemon[] = [];
  const unmatchedSlugs = new Set<string>();

  for (const entry of dexList) {
    let bySlug: Map<string, RawOrigin[]>;
    try {
      bySlug = await fetchMovesetSections(entry.name);
    } catch (err) {
      console.warn(`[pokemondb] failed to fetch moveset for ${entry.name} (#${entry.id}): ${(err as Error).message}`);
      bySlug = new Map();
    }

    const learnableMoveIds: string[] = [];
    const eggMoveIds: string[] = [];
    const moveOrigins: Record<string, MoveOrigin> = {};
    const seen = new Set<string>();
    for (const [slug, observations] of bySlug) {
      const move = moveByJoinKey.get(joinKey(slug));
      if (!move) {
        unmatchedSlugs.add(slug);
        continue;
      }
      if (seen.has(move.id)) continue;
      seen.add(move.id);
      learnableMoveIds.push(move.id);
      const origin = reduceOrigin(observations);
      moveOrigins[move.id] = origin;
      if (origin.method === 'egg') eggMoveIds.push(move.id);
    }

    pokemon.push({ id: entry.id, name: entry.name, learnableMoveIds, eggMoveIds, moveOrigins });
    await sleep(150);
  }

  return { pokemon, unmatchedSlugs };
}

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

const FILE_HEADER = `// AUTO-GENERATED by scripts/extract-gen4-data.ts — do not edit by hand.
// Regenerate with: npm run extract:gen4
`;

function renderMovesFile(moves: Record<string, Move>): string {
  const sortedIds = Object.keys(moves).sort();
  const entries = sortedIds
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(moves[id])},`)
    .join('\n');
  return `${FILE_HEADER}import type { Move } from './types.ts';

export const moves: Record<string, Move> = {
${entries}
};
`;
}

function renderPokemonFile(pokemon: Pokemon[]): string {
  const entries = pokemon
    .map((p) => `  ${JSON.stringify(p)},`)
    .join('\n');
  return `${FILE_HEADER}import type { Pokemon } from './types.ts';

export const pokemon: Pokemon[] = [
${entries}
];
`;
}

async function main(): Promise<void> {
  console.log('Extracting Gen4 contest moves from Serebii Attackdex-DP...');
  const moves = await extractMoves();
  console.log(`  -> ${Object.keys(moves).length} moves`);

  console.log('Extracting Gen4 Pokemon list from Bulbapedia and movesets from PokemonDB...');
  const { pokemon, unmatchedSlugs } = await extractPokemon(moves);
  console.log(`  -> ${pokemon.length} Pokemon`);

  if (unmatchedSlugs.size > 0) {
    console.warn(
      `[movesets] ${unmatchedSlugs.size} distinct move slug(s) seen in PokemonDB movesets are absent from the contest-moves dataset ` +
        '(expected for non-contest moves; see spec I/O matrix "Move name mismatch between sites"). Sample:',
      [...unmatchedSlugs].slice(0, 20),
    );
  }

  // Acceptance: every learnableMoveIds entry exists as a key in moves, and
  // every eggMoveIds entry is itself a learnableMoveIds entry (egg moves are
  // a subset, never an addition).
  for (const p of pokemon) {
    for (const moveId of p.learnableMoveIds) {
      if (!moves[moveId]) {
        throw new Error(`Dangling move reference: Pokemon #${p.id} ${p.name} references unknown move id "${moveId}"`);
      }
    }
    for (const moveId of p.eggMoveIds) {
      if (!p.learnableMoveIds.includes(moveId)) {
        throw new Error(`Pokemon #${p.id} ${p.name} has "${moveId}" in eggMoveIds but not in learnableMoveIds`);
      }
    }
  }

  await writeFile(path.join(DATA_DIR, 'moves.ts'), renderMovesFile(moves), 'utf-8');
  await writeFile(path.join(DATA_DIR, 'pokemon.ts'), renderPokemonFile(pokemon), 'utf-8');
  console.log('Wrote src/data/moves.ts and src/data/pokemon.ts');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
