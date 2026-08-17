// Explore mode: free move-making matched against every loaded course at once.

import { loadApp, createChecker, addCourse } from './harness.js';

const { getEl } = await loadApp([
  'parseCourse', 'buildTrie', 'bookContinuations', 'coursesWithPosition',
  'startExplore', 'ensureExploreSession', 'exploreMove', 'handleExploreClick',
  'playExploreSan', 'resetExplore', 'updateExplorePanel', 'renderBoard', 'fenKey',
  'state', 'COURSES', 'START_FEN', 'START_KEY',
]);

const app = globalThis;
const S = app.state;
const { check, report } = createChecker('explore');

const status   = () => getEl('explore-status').textContent;
const contSans = () => getEl('explore-continuations').children
  .map(c => c.innerHTML.match(/ec-san">([^<]+)/)[1]);

// One White repertoire and one Black repertoire, live on the same board
addCourse(app, 'White rep', 'w',
  '[Event "White rep"]\n[Round "Italian / Main"]\n' +
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 {Italian Game} Bc5 *\n\n' +
  '[Event "White rep"]\n[Round "Italian / Two Knights"]\n' +
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 *');
addCourse(app, 'Black rep', 'b',
  '[Event "Black rep"]\n[Round "Nimzo / Main"]\n' +
  '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 {Nimzo-Indian} *');

// ── The start position sees both repertoires ──
app.startExplore(app.START_FEN);
check('starts in explore mode', S.navMode, 'explore');
check("start position offers both courses' first moves", contSans().sort(), ['d4', 'e4']);
check('status reports in-repertoire', status(), 'In your repertoire — White rep, Black rep');

// ── Following the White repertoire ──
app.exploreMove('e2', 'e4');
check('e4 recorded in book', S.exploreMoves.at(-1).inBook, true);
check('after e4 only the White course matches', status(), 'In your repertoire — White rep');
check('after e4 book replies', contSans(), ['e5']);

app.exploreMove('e7', 'e5');
app.exploreMove('g1', 'f3');
app.exploreMove('b8', 'c6');
app.exploreMove('f1', 'c4');
check('5 moves played', S.exploreMoves.length, 5);
check('branch point offers both book replies', contSans().sort(), ['Bc5', 'Nf6']);
check('Bc4 carries its comment', S.exploreMoves.at(-1).comment, 'Italian Game');

// ── Leaving the book ──
app.exploreMove('g8', 'e7');   // in neither course
check('off-book move flagged', S.exploreMoves.at(-1).inBook, false);
check('status says out of book', status(), 'Out of book');
check('no continuations offered', contSans(), []);

// ── Navigating back and branching replaces the tail ──
S.navIdx = 5;                     // back to the position after Bc4
app.handleExploreClick('g8');     // select the knight
check('selecting shows legal destinations', S.legalDests.sort(), ['e7', 'f6', 'h6']);
app.handleExploreClick('f6');     // play Nf6 instead
check('branch truncated the old tail', S.exploreMoves.length, 6);
check('branch move is Nf6', S.exploreMoves.at(-1).san, 'Nf6');
check('branch move is in book', S.exploreMoves.at(-1).inBook, true);
check('nav history truncated too', S.navFens.length, 7);

// ── Clicking a book continuation plays it ──
app.startExplore(app.START_FEN);
app.playExploreSan('d4');
check('playExploreSan plays the move', S.exploreMoves.at(-1).san, 'd4');
check('after d4 only the Black course matches', status(), 'In your repertoire — Black rep');
check('after d4 book reply', contSans(), ['Nf6']);

// ── Exploring from a mid-line position, not just the start ──
// FENs come from the parsed course rather than being hand-written.
const whiteLine = S.courseData[0].lines[0].moves;   // e4 e5 Nf3 Nc6 Bc4 Bc5
app.startExplore(whiteLine[4].fen);                 // position after Bc4
check('mid-line start has no move history', S.exploreMoves.length, 0);
check('mid-line position still matched against courses', status(), 'In your repertoire — White rep');
check('mid-line continuations offered', contSans().sort(), ['Bc5', 'Nf6']);

// ── End of a line, reached by playing the final book move ──
// Regression: a position is only a trie key when it has continuations, so the
// last move of a line is not found by trie.has() and used to read as off-book.
app.startExplore(whiteLine[4].fen);
app.playExploreSan('Bc5');
check('final book move is in book', S.exploreMoves.at(-1).inBook, true);
check('end of line reported', status(), 'End of your repertoire — White rep');
check('no continuations at end of line', contSans(), []);

// ── With no courses at all the board still works ──
app.COURSES.length = 0;
S.courseData.length = 0;
app.startExplore(app.START_FEN);
check('no-course status', status(), 'No courses loaded — add one to match your moves against it.');
app.exploreMove('e2', 'e4');
check('move still playable with no courses', S.exploreMoves.at(-1).san, 'e4');
check('and is marked off-book', S.exploreMoves.at(-1).inBook, false);
check('board renders with no courses', typeof getEl('chessboard').innerHTML, 'string');

report();
