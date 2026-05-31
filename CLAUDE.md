# Chess Repertoire Trainer — Claude context

## What this is

A single-page, zero-dependency chess opening repertoire tool. Three files: `index.html`, `app.js`, `style.css`. No build step, no framework, no backend.

## Architecture

- **COURSES** — array of `{ name, orientation, pgn, dbId }` objects, populated at startup from IndexedDB and when the user adds a course
- **state** — single global object holding all runtime state (nav position, practice session, drag state, etc.)
- **Trie** — each course's PGN is parsed into a move trie keyed by FEN. The trie is built lazily when a course is first needed. Multiple courses can be merged into one trie for multi-course practice.
- **IndexedDB** — courses (name, orientation, raw PGN text) are persisted via `saveUserCourse` / `getUserCourses` / `deleteUserCourse`. Parsed trie data is not stored — it's rebuilt on load.

## Key functions

- `parseCourse(pgnText)` — parses a PGN string into an array of line objects
- `buildTrie(lines)` — builds a Map-based trie from parsed lines
- `loadCourse(courseIdx)` — parses and caches a course into `state.courseData[idx]`
- `renderBoard(fen, from, to)` — renders the board for a given FEN
- `startPractice()` — merges selected courses, validates same colour, begins practice session
- `playComputerMove()` — picks a random book move from `state.practiceData.trie` (not `state.courseData[activeCourse].trie` — that was a bug, already fixed)
- `submitUserMove(from, to)` — handles the player's move in practice mode

## Board rendering

- Board is a 400×400px CSS grid of 64 `.square` divs
- Each square is exactly 50×50px
- Pieces are Unicode symbols in `position: absolute; inset: 0` spans, centered with `line-height: 50px; text-align: center`
- Per-piece-type CSS classes (`piece-king`, `piece-queen`, etc.) allow individual sizing/scaling
- King gets `scaleX(1.35)`, pawns get `scaleX(1.0)`, others get `scaleX(1.18)` to compensate for Unicode glyph proportions
- Drag ghost uses the same `.piece` classes but inside a 50×50px fixed div

## Modes

- `idle` — no course loaded
- `study` — stepping through a course with nav buttons
- `game` — analysis of a pasted PGN game
- `practice` — active drill session against the computer

## What to watch out for

- `playComputerMove` must use `state.practiceData.trie`, not `state.courseData[state.activeCourse].trie` — the merged trie is what enables multi-course practice
- The board is stationary; `#position-comment` has a fixed `height: 80px` to prevent layout shift as comment text changes
- Courses deleted from the UI are also removed from IndexedDB via `deleteUserCourse(course.dbId)`
