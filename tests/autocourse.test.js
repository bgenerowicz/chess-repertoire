// Automatic repertoire selection: pick the course a game follows furthest.

import { loadApp, createChecker, addCourse } from './harness.js';

const { getEl } = await loadApp([
  'parseCourse', 'buildTrie', 'pickBestCourse', 'applyActiveCourse',
  'renderActiveCourse', 'handleAnalyze', 'boardOrientation', 'state', 'COURSES',
]);

const app = globalThis;
const S = app.state;
const { check, report } = createChecker('autocourse');

const chip = () => getEl('active-course').childText();
const movesOf = pgn => app.parseCourse(pgn)[0].moves;
const analyze = pgn => { getEl('pgn-input').value = pgn; app.handleAnalyze(); };

// Three courses, two of which open 1.d4 — so selection can't just key off the first move
addCourse(app, 'White e4',    'w', '[Event "R"]\n[Round "Italian"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 *');
addCourse(app, 'Black vs d4', 'b', '[Event "R"]\n[Round "Nimzo"]\n1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O *');
addCourse(app, 'White d4',    'w', '[Event "R"]\n[Round "London"]\n1. d4 d5 2. Bf4 *');

// ── pickBestCourse ──
check('picks the e4 course for an Italian game',
  app.pickBestCourse(movesOf('[Event "G"]\n[Round "x"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 d6 *')),
  { courseIdx: 0, depth: 7 });

check('picks the Black course for a Nimzo game',
  app.pickBestCourse(movesOf('[Event "G"]\n[Round "x"]\n1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 b6 *')),
  { courseIdx: 1, depth: 7 });

check('picks the d4 course over the Black one when 1.d4 d5',
  app.pickBestCourse(movesOf('[Event "G"]\n[Round "x"]\n1. d4 d5 2. Bf4 Nf6 3. e3 *')),
  { courseIdx: 2, depth: 3 });

check('unmatched game reports depth 0',
  app.pickBestCourse(movesOf('[Event "G"]\n[Round "x"]\n1. b3 g6 2. Bb2 Bg7 *')).depth, 0);

// ── handleAnalyze wires it up ──
S.activeCourse = 0;   // deliberately the wrong course to start from
analyze('[Event "G"]\n[Round "x"]\n1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 b6 *');
check('analyze switches to the matching course', S.activeCourse, 1);
check('match recorded', S.courseMatch, { courseIdx: 1, depth: 7 });
check('board orientation follows the matched course', app.boardOrientation(), 'b');
check('chip names the course and depth', chip(), '✓ Black vs d4 7 moves matched');
check('practice colour synced to matched course', S.practiceColor, 'b');

analyze('[Event "G"]\n[Round "x"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 d6 *');
check('analyze switches back for a White game', S.activeCourse, 0);
check('orientation follows back to White', app.boardOrientation(), 'w');
check('chip updates', chip(), '✓ White e4 7 moves matched');

analyze('[Event "G"]\n[Round "x"]\n1. b3 g6 2. Bb2 Bg7 *');
check('unmatched game still analyzes', S.courseMatch.depth, 0);
check('chip says nothing matched', chip(), '♔ White e4 no repertoire matched');

analyze('[Event "G"]\n[Round "x"]\n1. e4 c5 2. Nf3 d6 *');
check('singular move wording', chip(), '✓ White e4 1 move matched');

// ── Manual override ──
app.applyActiveCourse(2);
check('manual pick sets the course', S.activeCourse, 2);
check('manual pick clears the auto-match', S.courseMatch, null);
check('chip shows plain name when picked by hand', chip(), '♔ White d4');

// ── No courses at all ──
app.COURSES.length = 0;
S.courseData.length = 0;
app.renderActiveCourse();
check('empty state chip', getEl('active-course').textContent, 'No courses — click + to add one');

report();
