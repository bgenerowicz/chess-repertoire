// Board flip: orientation, rendered square order, and pointer hit-testing.

import { loadApp, createChecker, addCourse } from './harness.js';

const { getEl } = await loadApp([
  'parseCourse', 'buildTrie', 'boardOrientation', 'renderBoard',
  'getSquareAtPoint', 'startExplore', 'exploreMove', 'state', 'COURSES', 'START_FEN',
]);

const app = globalThis;
const S = app.state;
const { check, report } = createChecker('flip');

const squares = () => getEl('chessboard').children.map(c => c.dataset.sq);
const pgn = '[Event "R"]\n[Round "L"]\n1. e4 e5 2. Nf3 *';

addCourse(app, 'White rep', 'w', pgn);

// ── Unflipped: White repertoire, White at the bottom ──
check('default orientation follows the course', app.boardOrientation(), 'w');
app.renderBoard(app.START_FEN, null, null);
let sq = squares();
check('renders 64 squares', sq.length, 64);
check('top-left is a8', sq[0], 'a8');
check('bottom-right is h1', sq[63], 'h1');
check('hit-test top-left corner', app.getSquareAtPoint(5, 5), 'a8');
check('hit-test bottom-right corner', app.getSquareAtPoint(395, 395), 'h1');

// ── Flipped ──
S.boardFlipped = true;
check('flip inverts orientation', app.boardOrientation(), 'b');
app.renderBoard(app.START_FEN, null, null);
sq = squares();
check('flipped top-left is h1', sq[0], 'h1');
check('flipped bottom-right is a8', sq[63], 'a8');
check('flipped hit-test top-left', app.getSquareAtPoint(5, 5), 'h1');
check('flipped hit-test bottom-right', app.getSquareAtPoint(395, 395), 'a8');
// Rendering and hit-testing must agree, or clicks land on mirrored squares
check('render and hit-test agree while flipped', app.getSquareAtPoint(5, 5), sq[0]);

// ── Flip is an override, not a replacement ──
addCourse(app, 'Black rep', 'b', pgn);
S.activeCourse = 1;
check('black course flipped shows White at bottom', app.boardOrientation(), 'w');
S.boardFlipped = false;
check('black course unflipped shows Black at bottom', app.boardOrientation(), 'b');
S.activeCourse = 0;

// ── Practice orientation is flipped too ──
S.navMode = 'practice';
S.practiceColor = 'b';
check('practice follows practice colour', app.boardOrientation(), 'b');
S.boardFlipped = true;
check('practice respects the flip', app.boardOrientation(), 'w');
S.boardFlipped = false;
S.navMode = 'idle';

// ── Moves still land on the right squares while flipped ──
app.startExplore(app.START_FEN);
S.boardFlipped = true;
app.exploreMove('e2', 'e4');
check('move played while flipped', S.exploreMoves.at(-1).san, 'e4');
check('and still matched against the book', S.exploreMoves.at(-1).inBook, true);

report();
