# Pokemon Contest Combo Tool — Gen 4

Given a Pokemon, suggests the move combos that maximize its own Contest score in Generation 4 (Diamond/Pearl/Platinum), using only moves it can actually learn.

## Development

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check (app + scripts) and build for production
npm test         # run the unit tests
```

## Data

`src/data/moves.ts` and `src/data/pokemon.ts` are **generated files** — do not edit them by hand. They are produced by a one-time extraction script that pulls real data from Serebii, PokemonDB, and Bulbapedia (see `_bmad-output/planning-artifacts/specs/spec-pokemon-contest-combos/data-sources.md`):

```bash
npm run extract:gen4
```

Regenerate only when the Gen 4 dataset itself needs to change (e.g. a data-source correction) — not part of the normal app build.
