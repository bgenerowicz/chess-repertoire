// Deviation branches: at the point the game left book, both the played
// continuation and the repertoire's are shown and navigable.

import { loadApp, createChecker, addCourse } from './harness.js';

const { getEl } = await loadApp([
  'parseCourse', 'buildTrie', 'compareToTrie', 'bookBranchesAt',
  'renderDeviationBranches', 'handleAnalyze', 'state', 'COURSES',
]);

const app = globalThis;
const S = app.state;
const { check, report } = createChecker('branches');

// Two lines sharing a prefix, diverging at ply 5 (Black's 3rd move)
const pgn =
  '[Event "Rep"]\n[Round "Italian / Main"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 *\n\n' +
  '[Event "Rep"]\n[Round "Italian / Two Knights"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 *';
addCourse(app, 'White rep', 'w', pgn);
const lines = S.courseData[0].lines;

const gameMoves = pgn => app.parseCourse(pgn)[0].moves;

// A game that follows book for 5 plies then plays 3...d6, which is in neither line
const game = gameMoves('[Event "G"]\n[Round "x"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 d6 4. d3 Nf6 5. O-O Be7 *');
const comparison = app.compareToTrie(game, S.courseData[0].trie);

const devIdx = comparison.findIndex(m => m.status === 'deviation');
check('deviation found at 3...d6', [devIdx, comparison[devIdx].san], [5, 'd6']);

// ── bookBranchesAt ──
const branches = app.bookBranchesAt(comparison, lines, devIdx);
check('one branch per distinct book move', branches.map(b => b.san).sort(), ['Bc5', 'Nf6']);
check('branch continuation starts at the deviation ply',
  branches.find(b => b.san === 'Bc5').moves.map(m => m.san), ['Bc5', 'c3', 'Nf6']);
check('branch keeps its line index for navigation',
  branches.map(b => b.lineIdx).sort(), [0, 1]);

// A line that already diverged earlier must not be offered as a branch here
const early = app.compareToTrie(
  gameMoves('[Event "G"]\n[Round "x"]\n1. d4 d5 2. c4 e6 *'),
  S.courseData[0].trie);
check('game off-book immediately still reports a deviation',
  early.findIndex(m => m.status === 'deviation'), 0);
check('no book branches when nothing shares the prefix',
  app.bookBranchesAt(early, lines, 0).map(b => b.san), ['e4']);

// ── Rendering ──
app.renderDeviationBranches(comparison, lines);
const el = getEl('deviation-branches');
const rows = el.children;
check('renders a row per branch plus the played one', rows.length, 3);

const labels = rows.map(r => r.children[0].textContent);
check('first row is what was played', labels[0], 'You played');
check('remaining rows are book lines', labels.slice(1).every(l => l.startsWith('Book')), true);

const movesOf = row => row.children[1].children
  .filter(c => c.className.includes('db-move')).map(c => c.textContent);
check('played row shows the game continuation',
  movesOf(rows[0]), ['d6', 'd3', 'Nf6', 'O-O', 'Be7']);
check('book row shows the repertoire continuation',
  movesOf(rows[1]), ['Bc5', 'c3', 'Nf6']);
check('played moves are styled as the deviation',
  rows[0].children[1].children.find(c => c.className.includes('db-move')).className.includes('db-move-game'), true);

// ── Clicking navigates ──
// The played row drives the game nav directly.
S.navMode = 'game';
S.navFens = [null, ...comparison.map(m => m.fen)];   // nav array as renderAnalysis builds it
const playedTokens = rows[0].children[1].children.filter(c => c.className.includes('db-move'));
playedTokens[2].handlers.click[0]({});               // 4...Nf6, ply 7
check('clicking a played move moves the board there', S.navIdx, 8);
check('clicked move is marked current', playedTokens[2]._classes.has('current'), true);

// The book row hands over to the study view at the same move.
const bookTokens = rows[1].children[1].children.filter(c => c.className.includes('db-move'));
bookTokens[1].handlers.click[0]({});                 // 4.c3, ply 6
check('clicking a book move opens the study view', S.navMode, 'study');
check('study view lands on the clicked move', S.navIdx, 7);
check('only one move is current across both branches',
  playedTokens[2]._classes.has('current'), false);

// ── An all-book game shows nothing ──
const clean = app.compareToTrie(
  gameMoves('[Event "G"]\n[Round "x"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *'),
  S.courseData[0].trie);
app.renderDeviationBranches(clean, lines);
check('no deviation, no branch panel', getEl('deviation-branches').style.display, 'none');

report();
