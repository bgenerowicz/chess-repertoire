# Chess Repertoire Trainer — Claude context

## What this is

A single-page chess opening repertoire tool. Three source files: `index.html`, `app.js`, `style.css`. No build step, no framework, no backend. Tests live in `tests/` and run under Deno.

One runtime dependency: **chess.js 0.10.3, loaded from cdnjs** in `index.html`. It is not vendored, so the app needs network on first load.

## Architecture

- **COURSES** — array of `{ name, orientation, pgn, dbId, builtin }`, populated at startup from IndexedDB and when the user adds a course. `orientation` is `'w'` or `'b'`.
- **state** — one global object holding all runtime state: nav position, active course, practice session, explore session, drag state, Lichess results.
- **Trie** — each course's PGN is parsed into a move trie keyed by position. Built lazily per course by `loadCourse`, and merged across courses for multi-course practice.
- **`fenKey(fen)`** — the trie key: the FEN minus the half-move clock and move number. Because keys are *positions*, any position can be looked up without knowing the path taken to reach it. Most of the app's matching leans on this.
- **Active course** — `state.activeCourse` is chosen **automatically**, not by the user. See below.
- **IndexedDB** — courses (name, orientation, raw PGN) persist via `saveUserCourse` / `getUserCourses` / `deleteUserCourse`. Parsed tries are not stored; they are rebuilt on load.
- **localStorage** — only `lichessUsername`, to prefill the import field.

### Automatic course selection

There is no course picker. `handleAnalyze` runs the game against **every** loaded course and keeps the deepest run of in-book moves (`pickBestCourse`). Consequences:

- Analysis needs *all* courses parsed, not just one — `handleAnalyze` loads any missing ones and re-enters itself.
- The header `#active-course` chip is a **passive readout**, not a control. It reports the course and how it was chosen.
- Manual override lives on the course cards in the Courses tab; it calls `handleTabClick` and clears `state.courseMatch`.
- `applyActiveCourse` is the only place `state.activeCourse` changes. It also syncs practice colour and redraws the chip.
- Board orientation follows the active course, so auto-selection also flips the board to the right side.

## Key functions

Parsing and matching:
- `parseCourse(pgnText)` — PGN string → array of line objects
- `buildTrie(lines)` — Map-based trie keyed by `fenKey`
- `compareToTrie(gameMoves, trie)` — annotates each move `in-book` / `deviation` / `post-dev`
- `pickBestCourse(moves)` — which loaded course a game follows furthest
- `bookContinuations(key)` — every book move from a position, unioned across all loaded courses, with course attribution
- `bookBranchesAt(comparison, lines, devIdx)` / `renderDeviationBranches` — the played-vs-book comparison at a deviation

Board and state:
- `loadCourse(courseIdx)` — parses and caches into `state.courseData[idx]`
- `renderBoard(fen, from, to)` — draws the board for a FEN
- `boardOrientation()` — which colour sits at the bottom
- `applyActiveCourse(courseIdx, match)` / `renderActiveCourse()` — active course and its header chip

Sessions:
- `startPractice()` — merges selected courses, validates same colour, begins a drill
- `playComputerMove()` — random book move from `state.practiceData.trie`
- `submitUserMove(from, to)` — the player's move in practice
- `exploreMove(from, to)` / `ensureExploreSession()` — free move-making (see Explore mode)

Lichess:
- `fetchLichessGames(username)` — recent standard games via the Lichess API
- `renderLichessGames(games, username)` / `selectLichessGame(idx)` — the recent-games picker

## Modes

`state.navMode`:

- `idle` — nothing loaded, or a session was just reset
- `game` — analysis of a pasted or imported PGN
- `study` — stepping through a course line with the nav buttons
- `practice` — active drill against the computer
- `explore` — free move-making, matched live against every loaded course

## Board rendering

- 8×8 CSS grid of 64 `.square` divs, sized entirely off the `--sq-size` custom property (`width: calc(var(--sq-size) * 8)`)
- `--sq-size` is `50px` on desktop; the `max-width: 768px` query overrides it to `min(100vw / 8, 50px)`
- **Never hardcode `50px`** — always go through `--sq-size`, or the mobile board breaks
- `boardOrientation()` is the single source of truth for orientation: practice colour or active course orientation, inverted by `state.boardFlipped` (the ⇅ button). **Both `renderBoard` and `getSquareAtPoint` must use it** — if only one does, the board looks right but clicks land on mirrored squares
- Pieces are Unicode symbols in `position: absolute; inset: 0` spans, centred with `line-height: var(--sq-size)`
- Per-piece classes (`piece-king`, `piece-pawn`, …) carry the scaling that compensates for Unicode glyph proportions: king `scaleX(1.35)`, pawn `scaleX(1.0)`, others `scaleX(1.18)`
- The drag ghost reuses the `.piece` classes inside a fixed `var(--sq-size)` square

## Input

- Click-to-select (`handleBoardClick`) or pointer drag (`startPieceDrag` / `moveDrag` / `endDrag`, wired in `initDragListeners`)
- These handlers are **shared by practice and explore** and branch on `state.practiceActive` — a change to one path needs checking against the other
- Listeners cover mouse and touch together, so iOS quirks (double-tap zoom, ghost clicks) surface here first

## Deviation branches

Where a game leaves book, `#deviation-branches` shows the played continuation next to the repertoire's, both navigable from the same position.

- Book branches are read off the course lines directly (`bookBranchesAt`), not via `getMatchedLines`, so they still appear when the game left book on move 1 — nothing "matched" in that case
- One row per *distinct* book move at the deviation, so both alternatives show when the repertoire branches there
- Clicking a played move drives the game nav in place; clicking a book move hands over to `showStudyLine(lineIdx, comparison, atMoveIdx)`, which lands on that exact move. "← Back to analysis" returns
- **Panel order matters**: deviation banner and branches come *before* the full game list, otherwise a long game pushes them below the fold. `branches.test.js` asserts the ordering in `index.html`
- `#move-list` is capped and scrolls on desktop so a long game can't push the sections below it away; mobile drops the cap (no nested scrolling on touch). `keepTokenVisible` keeps the deviation/current move in view inside it — it measures with `getBoundingClientRect`, not `offsetTop`, because the list is not a positioned ancestor and `offsetTop` would scroll to a wildly wrong place

## Explore mode

- The board accepts moves on **every screen except practice**. Picking up a piece starts a session from whatever position is displayed, so you can branch off a study line or an analysed game
- Either colour can be moved — it is an analysis board, not a drill. Practice stays restricted to the player's colour
- Matching is per-position, not per-line: `bookContinuations(fenKey(fen))` hits every loaded course's trie at once, so it works from any starting point without replaying a path
- **A position is only a trie key when it has continuations**, so the last move of a line is never found by `trie.has()`. `updateExplorePanel` falls back to whether the move that *reached* the position was in book — that is what separates "end of your repertoire" from "out of book". Getting this wrong makes completed lines report as off-book
- Navigating back and then moving truncates the line and branches (`ensureExploreSession`)
- Promotions are always to a queen, same as practice
- `resetExplore()` is called by `handleAnalyze`, `showStudyLine`, `handleTabClick`, and `startPractice` so those flows take back the board

## Lichess import

- The Analyze tab pulls recent games from `https://lichess.org/api/games/user/<name>` as ndjson with `pgnInJson=true`, so each record carries its own PGN plus metadata
- Results render as a clickable list (`#lichess-games`); picking one fills `#pgn-input` and runs `handleAnalyze()`
- Non-standard variants are filtered out — a Chess960 or Crazyhouse PGN cannot be compared against a repertoire trie
- The endpoint is strict: it allows roughly one request at a time and answers 429 otherwise. Aborting a response mid-stream can leave the block in place for a while, so don't hammer it while debugging
- This is the only outbound call besides the chess.js CDN script. `#info-modal` and the README both name it explicitly — keep that copy honest if the app gains another network call

## Layout

- Desktop is three columns: left panel (Analyze / Practice / Courses), board, right panel (analysis / study / practice / explore)
- Below 768px `#mobile-panel-tabs` switches panels; `main` carries `mobile-show-left` / `mobile-show-right`
- `mobile-show-right` (the "Game" tab) stacks **board + right panel** in one scrolling column, which is what makes the explore/analysis/study views reachable at all on mobile. `#right-panel` is `flex: none; overflow-y: visible` there so there is a single scrollbar, not a nested one
- `#practice-view` is hidden in that stack — practice has its own mobile UI (`#mobile-practice-bar` under the board, move list in the Practice tab) and would otherwise appear twice
- In study mode `#position-comment` (under the board) and `#study-annotation` (in the panel) render the **same** comment — `showStudyLine` feeds `navComments` from the same `move.comment`. Fine on desktop, where they're in different columns; on mobile the panel stacks under the board, so `#study-annotation` is hidden there. Anything that adds a third place for the comment needs the same treatment
- `#board-controls` is capped to the board width on mobile with buttons at `flex: 1 1 0` plus a `max-width`, so the row divides the available width. **Adding another button scales the rest down instead of pushing them off-screen — don't give them fixed widths again**
- `--sq-size` deliberately lets the board run edge-to-edge on mobile, with no allowance for `#board-panel`'s padding. That is not a bug: the board overflows into the padding without widening the page

## What to watch out for

- `playComputerMove` must use `state.practiceData.trie`, not `state.courseData[state.activeCourse].trie` — the merged trie is what enables multi-course practice
- The board is stationary; `#position-comment` has a fixed `height: 80px` on desktop to prevent layout shift as comment text changes (mobile resets it to `auto`)
- Courses deleted from the UI are also removed from IndexedDB via `deleteUserCourse(course.dbId)`
- The `DOMContentLoaded` handler `await`s `getUserCourses()` partway through, so **every listener registered after that line** (nav buttons, Analyze, flip, explore) attaches a tick later than the `load` event. Harmless for real users; automated clicks fired at `load` will miss

## Testing

`tests/run.sh` runs every suite. Requires **Deno** (`node` is not installed here); no network, no other dependencies.

```
tests/run.sh            # all suites
tests/run.sh explore    # only suites matching "explore"
tests/run.sh -v         # print every assertion
```

Suites: `autocourse`, `explore`, `flip`, `lichess`, `practice`, `vendor`. Add a new one as `tests/<name>.test.js` — `run.sh` picks it up automatically.

How it works, since the app has no module system:

- `app.js` is a classic script, so its top-level declarations are **not** exports. `harness.js` appends an epilogue assigning the requested names to `globalThis` and imports the result as a data URL. Indirect `eval` does not work — the declarations land in a scope the importing module cannot see.
- `loadApp(names, { fakeTimers })` stubs `document` / `localStorage` / `indexedDB` with a minimal `El` class and loads the **real** chess.js from `tests/vendor/`. Do not stub chess.js: several paths call `chess.move` before any early return. `fakeTimers` captures `setTimeout` so practice's computer reply can be run on demand.
- `tests/vendor/provenance.json` records the version and checksum. `vendor.test.js` fails if `index.html` is repointed at a different chess.js without re-vendoring, so the tests can't silently drift from what the page actually loads.
- Functions the tests reach must be top-level in `app.js`. Anything defined inside the `DOMContentLoaded` closure is unreachable — assert on its side effects instead (see the `selectLichessGame` case in `lichess.test.js`).
- The stub supports `querySelectorAll` for the selector shapes app.js uses (comma-separated `#id` / `.class` compounds, optionally with a descendant part). Attribute selectors are not supported — they only drive browser-only drag visuals. If a selector silently matches nothing, check it against `matchesCompound` in `harness.js` before assuming the app is wrong.

For **layout** there is no automated coverage; use headless Chrome (`--headless=new --screenshot --virtual-time-budget`). Two traps, both of which have already produced false conclusions here:

- It clamps the viewport to ~500px and crops the PNG, so a narrow `--window-size` yields a misleadingly cropped image. Load the page inside a fixed-width `<iframe>` to emulate a phone, and measure `scrollWidth` rather than trusting the picture.
- Virtual time stalls the IndexedDB `await` in init, so listeners never attach and simulated clicks do nothing. Drive the handler body directly.
