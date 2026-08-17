// Practice mode. The click and drag handlers are shared with explore, so this
// suite guards against explore changes breaking the drill path.

import { loadApp, createChecker, addCourse } from './harness.js';

// Practice schedules the computer reply on a timer; capture it and run it on demand.
const { flushTimers } = await loadApp([
  'parseCourse', 'buildTrie', 'startPractice', 'handleBoardClick',
  'submitUserMove', 'playComputerMove', 'state', 'COURSES',
], { fakeTimers: true });

const app = globalThis;
const S = app.state;
const { check, report } = createChecker('practice');

addCourse(app, 'White rep', 'w',
  '[Event "Rep"]\n[Round "Italian / Main"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *');

S.practiceSelectedCourses = new Set([0]);
app.startPractice();
check('practice active', S.practiceActive, true);
check('nav mode is practice', S.navMode, 'practice');
check('explore did not hijack practice', S.exploreActive, false);

// Click-to-move: select e2, then play e4
app.handleBoardClick('e2');
check('practice selection works', S.selectedSq, 'e2');
check('practice legal dests', S.legalDests.sort(), ['e3', 'e4']);
app.handleBoardClick('e4');
check('user move recorded', S.practiceComparison.at(-1).san, 'e4');
check('user move in book', S.practiceComparison.at(-1).status, 'in-book');

flushTimers();   // computer replies
check('computer replied from the merged trie', S.practiceComparison.at(-1).san, 'e5');
check('reply marked as computer move', S.practiceComparison.at(-1).status, 'computer');

// A wrong move is flagged as a deviation
app.handleBoardClick('a2');
app.handleBoardClick('a4');
check('deviation detected', S.practiceComparison.at(-1).status, 'deviation');
check('practice went out of book', S.practiceInBook, false);

report();
