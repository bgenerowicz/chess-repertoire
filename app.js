'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const COURSES = [];

// ︎ (text variation selector) forces text rendering instead of colored emoji on iOS
const PIECES = {
  K:'♚︎', Q:'♛︎', R:'♜︎', B:'♝︎', N:'♞︎', P:'♟︎',
  k:'♚︎', q:'♛︎', r:'♜︎', b:'♝︎', n:'♞︎', p:'♟︎'
};

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const START_KEY = fenKey(START_FEN);

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  courseData: [], // { lines, trie } per course index — grows as user adds courses
  activeCourse: 0,
  // Board navigation
  navFens: [START_FEN],
  navFrom: [null],
  navTo:   [null],
  navComments: [null],
  navIdx: 0,
  navMode: 'idle',  // 'idle' | 'game' | 'study' | 'practice'
  // Analysis
  uploadedMoves: null,
  comparison: null,
  // Study
  studyLineIdx: null,
  studyDeviationIdx: null,
  // Practice
  practiceActive: false,
  practiceSource: false,   // true when analysis view was opened from a practice game
  practiceColor: 'w',
  practiceSelectedCourses: new Set(), // indices of courses checked in the practice list
  practiceData: null,      // { lines, trie } merged from selected courses for current session
  analysisLines: null,     // lines array currently shown in analysis/study (practiceData or course)
  practiceChess: null,
  practiceTrieKey: START_KEY,
  practiceInBook: true,
  practiceComparison: [],
  selectedSq: null,
  legalDests: []
};

// ── PGN Parsing ──────────────────────────────────────────────────────────────

function fenKey(fen) {
  // Strip half-move clock and full-move number for position comparison
  return fen.split(' ').slice(0, 4).join(' ');
}

function splitPGN(text) {
  // Split a multi-game PGN file into individual game strings
  const games = [];
  let start = -1;
  const lines = text.split('\n');
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('[Event ')) {
      if (start !== -1) {
        games.push(lines.slice(start, i).join('\n'));
      }
      start = i;
    }
  }
  if (start !== -1) games.push(lines.slice(start).join('\n'));
  return games;
}

function parseHeaders(gameText) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(gameText)) !== null) headers[m[1]] = m[2];
  return headers;
}

function tokenizeMoveText(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const end = text.indexOf('}', i + 1);
      if (end === -1) { i++; continue; }
      tokens.push({ type: 'comment', text: text.slice(i + 1, end).trim() });
      i = end + 1;
    } else if (ch === '(') {
      // Skip RAV (recursive annotation variation)
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
    } else if (ch === '$') {
      const m2 = text.slice(i).match(/^\$(\d+)/);
      if (m2) { tokens.push({ type: 'nag', value: parseInt(m2[1]) }); i += m2[0].length; }
      else i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      const rest = text.slice(i);
      const numM = rest.match(/^\d+\.+\s*/);
      if (numM) { i += numM[0].length; continue; }
      // Terminal markers
      if (/^(1-0|0-1|1\/2-1\/2|\*)/.test(rest)) { i += rest.match(/^[^\s]+/)[0].length; continue; }
      // Match any word starting with a letter — chess.js validates it
      const moveM = rest.match(/^[a-zA-Z][a-zA-Z0-9\-+=#+]*/);
      if (moveM) {
        tokens.push({ type: 'move', san: moveM[0] });
        i += moveM[0].length;
      } else {
        i++;
      }
    }
  }
  return tokens;
}

function parseGame(gameText) {
  const headers = parseHeaders(gameText);
  const moveSection = gameText.replace(/\[[^\]]+\]\s*/g, '').trim();
  const tokens = tokenizeMoveText(moveSection);

  const chess = new Chess();
  const moves = [];

  for (const token of tokens) {
    if (token.type === 'comment') {
      if (moves.length > 0 && !moves[moves.length - 1].comment) {
        moves[moves.length - 1].comment = token.text;
      }
    } else if (token.type === 'nag') {
      if (moves.length > 0 && !moves[moves.length - 1].nag) {
        moves[moves.length - 1].nag = token.value;
      }
    } else if (token.type === 'move') {
      const result = chess.move(token.san, { sloppy: true });
      if (result) {
        moves.push({
          san: result.san,
          from: result.from,
          to: result.to,
          fen: chess.fen(),
          comment: null,
          nag: null
        });
      }
    }
  }

  return { headers, moves };
}

function parseCourse(pgnText) {
  const gameStrings = splitPGN(pgnText);
  const lines = [];
  for (const gs of gameStrings) {
    const { headers, moves } = parseGame(gs);
    if (moves.length === 0) continue; // Skip intro/empty games
    const round = headers.Round || '';
    const parts = round.split(' / ');
    lines.push({
      chapter: parts[0] || round,
      name: parts.slice(1).join(' / ') || round,
      event: headers.Event || '',
      moves
    });
  }
  return lines;
}

// ── Opening Trie ─────────────────────────────────────────────────────────────

function buildTrie(lines) {
  // Map<positionKey, Map<san, {nextKey, lineIndices, comment, nag}>>
  const trie = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let key = START_KEY;

    for (const move of line.moves) {
      if (!trie.has(key)) trie.set(key, new Map());
      const node = trie.get(key);

      if (!node.has(move.san)) {
        node.set(move.san, {
          nextKey: fenKey(move.fen),
          lineIndices: [],
          comment: move.comment,
          nag: move.nag
        });
      }
      const entry = node.get(move.san);
      if (!entry.lineIndices.includes(i)) entry.lineIndices.push(i);

      key = fenKey(move.fen);
    }
  }

  return trie;
}

function compareToTrie(gameMoves, trie) {
  // Returns array of moves annotated with status
  const result = [];
  let key = START_KEY;
  let inBook = true;

  for (let i = 0; i < gameMoves.length; i++) {
    const move = gameMoves[i];
    if (inBook) {
      const node = trie.get(key);
      if (node && node.has(move.san)) {
        const entry = node.get(move.san);
        result.push({
          ...move,
          status: 'in-book',
          bookComment: entry.comment,
          lineIndices: [...entry.lineIndices]
        });
        key = entry.nextKey;
      } else {
        // First deviation
        const alternatives = node ? [...node.keys()] : [];
        result.push({ ...move, status: 'deviation', bookAlternatives: alternatives });
        key = fenKey(move.fen);
        inBook = false;
      }
    } else {
      result.push({ ...move, status: 'post-dev' });
    }
  }

  return result;
}

function getMatchedLines(comparison, lines) {
  // Find which book lines were being followed at the point of deepest in-book move
  const lastInBook = [...comparison].reverse().find(m => m.status === 'in-book');
  if (!lastInBook) return [];

  // Group by line, tracking how many moves matched
  const lineDepth = new Map();
  for (const move of comparison) {
    if (move.status !== 'in-book') break;
    for (const idx of move.lineIndices) {
      lineDepth.set(idx, (lineDepth.get(idx) || 0) + 1);
    }
  }

  return [...lineDepth.entries()]
    .map(([idx, depth]) => ({ line: lines[idx], lineIdx: idx, depth }))
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 8);
}

// ── Board Rendering ───────────────────────────────────────────────────────────

function renderBoard(fen, lastFrom, lastTo) {
  const board = document.getElementById('chessboard');
  board.innerHTML = '';

  const orientation = state.navMode === 'practice' ? state.practiceColor
    : (COURSES[state.activeCourse]?.orientation ?? 'w');
  const ranks = fen.split(' ')[0].split('/');  // rank 8 → rank 1

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    const rankIdx = orientation === 'w' ? displayRow : 7 - displayRow;
    const rankStr = ranks[rankIdx];

    // Expand FEN rank string into 8 cells
    const files = [];
    for (const ch of rankStr) {
      if (ch >= '1' && ch <= '8') for (let n = 0; n < +ch; n++) files.push('');
      else files.push(ch);
    }

    for (let displayCol = 0; displayCol < 8; displayCol++) {
      const fileIdx = orientation === 'w' ? displayCol : 7 - displayCol;
      const piece = files[fileIdx];

      // Square color: light when (rankIdx + fileIdx) % 2 === 0
      const isLight = (rankIdx + fileIdx) % 2 === 0;

      const fileLetter = 'abcdefgh'[fileIdx];
      const rankNum = 8 - rankIdx;
      const sqName = fileLetter + rankNum;

      const sq = document.createElement('div');
      sq.className = `square ${isLight ? 'light' : 'dark'}`;
      if (sqName === lastFrom || sqName === lastTo) sq.classList.add(sqName === lastFrom ? 'last-from' : 'last-to');

      // Square name attribute used by drag logic
      sq.dataset.sq = sqName;

      // Practice mode overlays
      if (state.practiceActive && state.practiceInBook) {
        const isPlayerTurn = state.practiceChess && state.practiceChess.turn() === state.practiceColor;
        if (sqName === state.selectedSq) {
          sq.classList.add('sq-selected');
        } else if (state.legalDests.includes(sqName)) {
          if (piece) sq.classList.add('sq-legal-capture');
          else       sq.classList.add('sq-legal');
        }
        if (isPlayerTurn) sq.classList.add('sq-interactive');

        const _sq = sqName;
        const _pieceChar = piece;
        sq.addEventListener('pointerdown', (e) => {
          if (!isPlayerTurn) return;
          e.preventDefault();
          startPieceDrag(e.clientX, e.clientY, _sq, _pieceChar);
        });
        sq.addEventListener('click', (e) => {
          if (drag.suppressClick) { drag.suppressClick = false; return; }
          handleBoardClick(_sq);
        });
      }

      // Corner labels (rank on col 0, file on rank 1)
      if (displayCol === 0) {
        const rl = document.createElement('span');
        rl.className = 'sq-label-rank';
        rl.textContent = rankNum;
        sq.appendChild(rl);
      }
      if (displayRow === 7) {
        const fl = document.createElement('span');
        fl.className = 'sq-label-file';
        fl.textContent = fileLetter;
        sq.appendChild(fl);
      }

      if (piece) {
        const p = document.createElement('span');
        const pieceType = { K:'king', Q:'queen', R:'rook', B:'bishop', N:'knight', P:'pawn' }[piece.toUpperCase()];
        p.className = `piece ${piece === piece.toUpperCase() ? 'w-piece' : 'b-piece'} piece-${pieceType}`;
        p.textContent = PIECES[piece] || '';
        sq.appendChild(p);
      }

      board.appendChild(sq);
    }
  }
}

function setNavState(fens, froms, tos, comments, idx) {
  state.navFens = fens;
  state.navFrom = froms;
  state.navTo = tos;
  state.navComments = comments;
  state.navIdx = idx;
  updateBoardDisplay();
}

function updateBoardDisplay() {
  const idx = state.navIdx;
  const fen = state.navFens[idx];
  renderBoard(fen, state.navFrom[idx], state.navTo[idx]);

  // Move indicator
  const total = state.navFens.length - 1;
  const indicator = document.getElementById('move-indicator');
  if (idx === 0) {
    indicator.textContent = 'Start';
  } else {
    const moveNum = Math.ceil(idx / 2);
    const isWhite = idx % 2 === 1;
    let san = '';
    if (state.navMode === 'game' && state.comparison) {
      san = state.comparison[idx - 1]?.san || '';
    } else if (state.navMode === 'study' && state.studyLineIdx !== null) {
      const lines = state.analysisLines ?? state.courseData[state.activeCourse]?.lines;
      san = lines?.[state.studyLineIdx]?.moves[idx - 1]?.san || '';
    }
    indicator.textContent = `${moveNum}${isWhite ? '.' : '...'} ${san}`;
  }

  // Comment
  const comment = state.navComments[idx];
  document.getElementById('position-comment').textContent = comment || '';

  // Nav buttons
  document.getElementById('start-btn').disabled = idx === 0;
  document.getElementById('prev-btn').disabled  = idx === 0;
  document.getElementById('next-btn').disabled  = idx >= total;
  document.getElementById('end-btn').disabled   = idx >= total;

  // Highlight current move in move list
  document.querySelectorAll('.move-token.current, .study-move-token.current')
    .forEach(el => el.classList.remove('current'));

  if (state.navMode === 'game' && idx > 0) {
    const el = document.querySelector(`.move-token[data-idx="${idx - 1}"]`);
    if (el) el.classList.add('current');
  } else if (state.navMode === 'study' && idx > 0) {
    const el = document.querySelector(`.study-move-token[data-idx="${idx - 1}"]`);
    if (el) el.classList.add('current');
  }
}

// ── UI – Analysis ─────────────────────────────────────────────────────────────

function renderAnalysis(comparison, lines) {
  state.analysisLines = lines; // remember for showStudyLine / updateStudyAnnotation
  const moveListEl = document.getElementById('move-list');
  moveListEl.innerHTML = '';

  const fens     = [START_FEN];
  const froms    = [null];
  const tos      = [null];
  const comments = [null];

  for (const m of comparison) {
    fens.push(m.fen);
    froms.push(m.from);
    tos.push(m.to);
    comments.push(m.bookComment || null);
  }

  state.navMode = 'game';
  // Jump to deviation point (position before the deviation move), or end if all in-book
  const devIdx = comparison.findIndex(m => m.status === 'deviation');
  const startNavIdx = devIdx >= 0 ? devIdx : fens.length - 1;
  setNavState(fens, froms, tos, comments, startNavIdx);

  // Render move tokens
  let moveNum = 0;
  for (let i = 0; i < comparison.length; i++) {
    const m = comparison[i];
    const isWhite = i % 2 === 0;

    if (isWhite) {
      moveNum++;
      const numEl = document.createElement('span');
      numEl.className = 'move-num';
      numEl.textContent = `${moveNum}.`;
      moveListEl.appendChild(numEl);
    }

    const token = document.createElement('span');
    token.className = `move-token ${m.status}`;
    token.dataset.idx = i;
    token.textContent = m.san;
    token.title = m.status === 'deviation'
      ? `Book: ${m.bookAlternatives.join(' / ') || '?'}`
      : m.bookComment || '';
    token.addEventListener('click', () => {
      state.navIdx = i + 1;
      updateBoardDisplay();
      updateContinueBar();
    });
    moveListEl.appendChild(token);
  }

  // Deviation info
  const devMove = comparison.find(m => m.status === 'deviation');
  const devInfoEl = document.getElementById('deviation-info');
  if (devMove) {
    const alternatives = devMove.bookAlternatives;
    const devIdx2 = comparison.indexOf(devMove);
    const moveNum = Math.floor(devIdx2 / 2) + 1;
    const isBlack = devIdx2 % 2 === 1;
    const moveLabel = isBlack ? `${moveNum}... ${devMove.san}` : `${moveNum}. ${devMove.san}`;
    devInfoEl.classList.remove('hidden');
    devInfoEl.innerHTML = `
      <strong>Deviation at ${moveLabel}:</strong>
      ${alternatives.length > 0
        ? `Book suggests: ${alternatives.map(a => `<span class="book-move">${a}</span>`).join(' or ')}`
        : 'No book move found for this position.'
      }
    `;
  } else {
    devInfoEl.classList.add('hidden');
    devInfoEl.textContent = '';
  }

  // Matched lines
  const matched = getMatchedLines(comparison, lines);
  const matchedEl = document.getElementById('matched-lines');
  matchedEl.innerHTML = '';

  if (matched.length === 0) {
    matchedEl.innerHTML = '<p class="no-match">No repertoire lines matched this game.</p>';
  } else {
    for (const { line, lineIdx, depth } of matched) {
      const item = document.createElement('div');
      item.className = 'line-item';
      item.innerHTML = `
        <div class="line-name">${escHtml(line.name)}</div>
        <div class="line-depth">Followed ${depth} move${depth !== 1 ? 's' : ''} of book</div>
      `;
      item.addEventListener('click', () => showStudyLine(lineIdx, comparison));
      matchedEl.appendChild(item);
    }
  }

  // Show analysis panel
  showPanel('analysis');
}

// ── UI – Study ────────────────────────────────────────────────────────────────

function showStudyLine(lineIdx, comparison) {
  const lines = state.analysisLines ?? state.courseData[state.activeCourse]?.lines ?? [];
  const line = lines[lineIdx];
  if (!line) return;
  state.studyLineIdx = lineIdx;

  // Find deviation index in this line (if any)
  let devMoveIdx = null;
  if (comparison) {
    const devMove = comparison.find(m => m.status === 'deviation');
    if (devMove) devMoveIdx = comparison.indexOf(devMove);
  }
  state.studyDeviationIdx = devMoveIdx;

  // Header
  document.getElementById('study-course-label').textContent = COURSES[state.activeCourse].name;
  document.getElementById('study-line-title').textContent = line.name || line.chapter;

  // Build study move tokens
  const studyMovesEl = document.getElementById('study-moves');
  studyMovesEl.innerHTML = '';

  const fens     = [START_FEN];
  const froms    = [null];
  const tos      = [null];
  const comments = [null];

  for (const m of line.moves) {
    fens.push(m.fen);
    froms.push(m.from);
    tos.push(m.to);
    comments.push(m.comment || null);
  }

  let moveNum = 0;
  for (let i = 0; i < line.moves.length; i++) {
    const m = line.moves[i];
    const isWhite = i % 2 === 0;

    if (isWhite) {
      moveNum++;
      const numEl = document.createElement('span');
      numEl.className = 'move-num';
      numEl.textContent = `${moveNum}.`;
      studyMovesEl.appendChild(numEl);
    }

    const token = document.createElement('span');
    token.className = 'study-move-token';
    if (devMoveIdx !== null && i === devMoveIdx) token.classList.add('dev-point');
    token.dataset.idx = i;
    token.textContent = m.san;
    token.addEventListener('click', () => {
      state.navIdx = i + 1;
      updateBoardDisplay();
      updateStudyAnnotation(i);
    });
    studyMovesEl.appendChild(token);
  }

  state.navMode = 'study';
  // Navigate to deviation point or start
  const startIdx = devMoveIdx !== null ? Math.max(0, devMoveIdx) : 0;
  setNavState(fens, froms, tos, comments, startIdx + 1);
  updateStudyAnnotation(startIdx);

  showPanel('study');
}

function updateStudyAnnotation(moveIdx) {
  const lines = state.analysisLines ?? state.courseData[state.activeCourse]?.lines;
  if (!lines) return;
  const line = lines[state.studyLineIdx];
  const comment = moveIdx >= 0 && moveIdx < line.moves.length
    ? line.moves[moveIdx].comment
    : null;
  document.getElementById('study-annotation').textContent = comment || '';

  // Update current highlight
  document.querySelectorAll('.study-move-token.current').forEach(el => el.classList.remove('current'));
  const el = document.querySelector(`.study-move-token[data-idx="${moveIdx}"]`);
  if (el) el.classList.add('current');
}

// ── Panel switching ───────────────────────────────────────────────────────────

function showPanel(which) {
  document.getElementById('empty-state').style.display    = which === 'empty'    ? '' : 'none';
  document.getElementById('analysis-view').style.display  = which === 'analysis' ? '' : 'none';
  document.getElementById('study-view').style.display     = which === 'study'    ? '' : 'none';
  document.getElementById('practice-view').style.display  = which === 'practice' ? '' : 'none';
}

// ── Course loading ────────────────────────────────────────────────────────────

async function loadCourse(courseIdx) {
  if (state.courseData[courseIdx]) return; // already loaded

  const course = COURSES[courseIdx];
  const statusEl = document.getElementById('header-status');
  statusEl.textContent = `Loading ${course.name}…`;
  statusEl.className = 'loading';

  try {
    const allLines = [];
    if (course.pgn) {
      // User-uploaded course: PGN text stored inline
      allLines.push(...parseCourse(course.pgn));
    } else {
      // Built-in course: fetch files from server
      for (const file of course.files) {
        const res = await fetch(file);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
        allLines.push(...parseCourse(await res.text()));
      }
    }
    const trie = buildTrie(allLines);
    state.courseData[courseIdx] = { lines: allLines, trie };
    statusEl.textContent = `${allLines.length} lines loaded`;
    statusEl.className = 'ready';
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    statusEl.className = 'error';
    console.error(err);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleAnalyze() {
  const pgn = document.getElementById('pgn-input').value.trim();
  const errorEl = document.getElementById('upload-error');
  errorEl.textContent = '';

  if (!pgn) { errorEl.textContent = 'Please paste a PGN game.'; return; }

  const courseData = state.courseData[state.activeCourse];
  if (!courseData) { errorEl.textContent = 'Course is still loading, please wait.'; return; }

  const { headers, moves } = parseGame(pgn);
  if (moves.length === 0) { errorEl.textContent = 'No moves found in PGN. Check the format.'; return; }

  state.uploadedMoves = moves;
  const comparison = compareToTrie(moves, courseData.trie);
  state.comparison = comparison;

  renderAnalysis(comparison, courseData.lines);
}

function handleTabClick(courseIdx) {
  state.activeCourse = courseIdx;
  renderCourseTabs(); // updates active highlight

  // Sync practice color to the new course orientation
  state.practiceColor = COURSES[courseIdx].orientation;
  updatePracticeColorDisplay();

  // Reload if we already had a game analyzed
  if (state.uploadedMoves) {
    const courseData = state.courseData[courseIdx];
    if (courseData) {
      const comparison = compareToTrie(state.uploadedMoves, courseData.trie);
      state.comparison = comparison;
      renderAnalysis(comparison, courseData.lines);
    }
  }

  loadCourse(courseIdx);
  renderBoard(START_FEN, null, null);
}

function renderCourseTabs() {
  const container = document.getElementById('course-tabs');
  container.innerHTML = '';

  if (COURSES.length === 0) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:0.78rem;color:var(--text-muted);padding:6px 4px;';
    hint.textContent = 'No courses — click + to add one';
    container.appendChild(hint);
    const statusEl = document.getElementById('header-status');
    if (statusEl) { statusEl.textContent = 'No courses loaded'; statusEl.className = ''; }
    return;
  }

  COURSES.forEach((course, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === state.activeCourse ? ' active' : '');
    btn.dataset.course = i;
    btn.addEventListener('click', () => handleTabClick(i));

    const label = document.createTextNode(course.name);
    btn.appendChild(label);

    if (!course.builtin) {
      const del = document.createElement('button');
      del.className = 'tab-delete';
      del.title = 'Remove course';
      del.textContent = '×';
      del.addEventListener('click', e => {
        e.stopPropagation();
        removeUserCourse(i);
      });
      btn.appendChild(del);
    }

    container.appendChild(btn);
  });
}

function addUserCourse(name, orientation, pgn, dbId) {
  COURSES.push({ name, orientation, pgn, dbId, builtin: false });
  state.courseData.push(null);
  renderPracticeCourseList();
  if (document.getElementById('courses-section')?.style.display !== 'none') {
    renderCoursesBrowser();
  }
}

// ── Courses browser ───────────────────────────────────────────────────────────

function renderCoursesBrowser() {
  const container = document.getElementById('courses-list');
  if (!container) return;
  container.innerHTML = '';

  if (COURSES.length === 0) {
    const p = document.createElement('p');
    p.className = 'courses-empty';
    p.textContent = 'No courses loaded. Click + to add a PGN.';
    container.appendChild(p);
    return;
  }

  COURSES.forEach((course, courseIdx) => {
    const card = document.createElement('div');
    card.className = 'course-card';

    // ── Header row ──────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'course-card-header';

    const arrow = document.createElement('span');
    arrow.className = 'course-card-expand';
    arrow.textContent = '▶';

    const nameEl = document.createElement('span');
    nameEl.className = 'course-card-name';
    nameEl.textContent = course.name;
    nameEl.title = course.name;

    const meta = document.createElement('span');
    meta.className = 'course-card-meta';
    const lineCount = state.courseData[courseIdx]?.lines.length;
    const orientLabel = course.orientation === 'w' ? '♔' : '♚';
    meta.textContent = lineCount != null ? `${orientLabel} ${lineCount} lines` : orientLabel;

    const delBtn = document.createElement('button');
    delBtn.className = 'course-card-delete';
    delBtn.title = 'Remove course';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeUserCourse(courseIdx).then(() => renderCoursesBrowser());
    });

    header.appendChild(arrow);
    header.appendChild(nameEl);
    header.appendChild(meta);
    header.appendChild(delBtn);

    // ── Lines list (hidden until expanded) ──────────────
    const linesDiv = document.createElement('div');
    linesDiv.className = 'course-card-lines';

    header.addEventListener('click', async () => {
      const isOpen = card.classList.toggle('open');
      if (isOpen && !state.courseData[courseIdx]) {
        linesDiv.innerHTML = '<p class="course-chapter-heading">Loading…</p>';
        await loadCourse(courseIdx);
        renderCourseLines(linesDiv, courseIdx);
        // update line count in meta
        meta.textContent = `${orientLabel} ${state.courseData[courseIdx].lines.length} lines`;
      } else if (isOpen && linesDiv.children.length === 0) {
        renderCourseLines(linesDiv, courseIdx);
      }
    });

    card.appendChild(header);
    card.appendChild(linesDiv);
    container.appendChild(card);
  });
}

function renderCourseLines(container, courseIdx) {
  container.innerHTML = '';
  const lines = state.courseData[courseIdx]?.lines ?? [];

  // Group by chapter
  const chapters = new Map();
  lines.forEach((line, lineIdx) => {
    const ch = line.chapter || 'Uncategorized';
    if (!chapters.has(ch)) chapters.set(ch, []);
    chapters.get(ch).push({ line, lineIdx });
  });

  for (const [chapter, entries] of chapters) {
    const heading = document.createElement('div');
    heading.className = 'course-chapter-heading';
    heading.textContent = chapter;
    container.appendChild(heading);

    for (const { line, lineIdx } of entries) {
      const item = document.createElement('div');
      item.className = 'course-line-item';
      item.textContent = line.name || line.chapter;
      item.addEventListener('click', () => browseCourseLine(courseIdx, lineIdx));
      container.appendChild(item);
    }
  }
}

function browseCourseLine(courseIdx, lineIdx) {
  const courseLines = state.courseData[courseIdx]?.lines;
  if (!courseLines) return;

  // Set analysisLines so showStudyLine uses the right array
  state.analysisLines = courseLines;
  showStudyLine(lineIdx, null);

  // Override the back button to return to the courses browser
  const backBtn = document.getElementById('back-btn');
  backBtn.textContent = '← Back to courses';
  backBtn._coursesReturn = true;
}

function renderPracticeCourseList() {
  const container = document.getElementById('practice-course-list');
  if (!container) return;
  container.innerHTML = '';

  if (COURSES.length === 0) {
    const p = document.createElement('p');
    p.className = 'practice-no-courses';
    p.textContent = 'Add a course with + to start practicing.';
    container.appendChild(p);
    updatePracticeColorDisplay();
    return;
  }

  COURSES.forEach((course, i) => {
    const row = document.createElement('label');
    row.className = 'practice-course-row' + (state.practiceSelectedCourses.has(i) ? ' selected' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.practiceSelectedCourses.has(i);
    cb.addEventListener('change', () => {
      if (cb.checked) state.practiceSelectedCourses.add(i);
      else             state.practiceSelectedCourses.delete(i);
      row.classList.toggle('selected', cb.checked);
      updatePracticeColorDisplay();
    });

    const name = document.createElement('span');
    name.className = 'pcr-name';
    name.textContent = course.name;

    const orient = document.createElement('span');
    orient.className = 'pcr-orient';
    orient.textContent = course.orientation === 'w' ? '♔ White' : '♚ Black';

    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(orient);
    container.appendChild(row);
  });

  updatePracticeColorDisplay();
}

async function removeUserCourse(courseIdx) {
  const course = COURSES[courseIdx];
  if (!course || course.builtin) return;

  if (course.dbId != null) await deleteUserCourse(course.dbId);

  COURSES.splice(courseIdx, 1);
  state.courseData.splice(courseIdx, 1);

  if (state.activeCourse >= COURSES.length) state.activeCourse = 0;
  // Also remove from practice selection if it was checked
  state.practiceSelectedCourses.delete(courseIdx);
  // Re-index any selected courses above the removed one
  const updated = new Set([...state.practiceSelectedCourses].map(i => i > courseIdx ? i - 1 : i));
  state.practiceSelectedCourses = updated;
  renderCourseTabs();
  renderPracticeCourseList();
  handleTabClick(state.activeCourse);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initDragListeners();

  // Load user courses from IndexedDB before rendering tabs
  try {
    const stored = await getUserCourses();
    for (const c of stored) addUserCourse(c.name, c.orientation, c.pgn, c.id);
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
  }

  renderCourseTabs();
  renderPracticeCourseList();
  renderBoard(START_FEN, null, null);

  // Mobile panel tabs
  const mainEl = document.querySelector('main');
  mainEl.classList.add('mobile-show-right');
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mainEl.classList.toggle('mobile-show-right', btn.dataset.panel === 'right');
      mainEl.classList.toggle('mobile-show-left',  btn.dataset.panel === 'left');
    });
  });

  // Info modal
  const infoModal = document.getElementById('info-modal');
  document.getElementById('info-btn').addEventListener('click', () => infoModal.style.display = 'flex');
  document.getElementById('info-close-btn').addEventListener('click', () => infoModal.style.display = 'none');
  infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.style.display = 'none'; });

  // Analyze button
  document.getElementById('analyze-btn').addEventListener('click', handleAnalyze);

  // Allow Ctrl+Enter to analyze
  document.getElementById('pgn-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAnalyze();
  });

  // Board navigation
  document.getElementById('start-btn').addEventListener('click', () => {
    state.navIdx = 0;
    updateBoardDisplay();
    if (state.navMode === 'study') updateStudyAnnotation(-1);
    updateContinueBar();
  });
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (state.navIdx > 0) {
      state.navIdx--;
      updateBoardDisplay();
      if (state.navMode === 'study') updateStudyAnnotation(state.navIdx - 1);
      updateContinueBar();
    }
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.navIdx < state.navFens.length - 1) {
      state.navIdx++;
      updateBoardDisplay();
      if (state.navMode === 'study') updateStudyAnnotation(state.navIdx - 1);
      updateContinueBar();
    }
  });
  document.getElementById('end-btn').addEventListener('click', () => {
    state.navIdx = state.navFens.length - 1;
    updateBoardDisplay();
    if (state.navMode === 'study') updateStudyAnnotation(state.navIdx - 1);
    updateContinueBar();
  });

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft')  document.getElementById('prev-btn').click();
    if (e.key === 'ArrowRight') document.getElementById('next-btn').click();
  });

  // Back button
  document.getElementById('back-btn').addEventListener('click', () => {
    const backBtn = document.getElementById('back-btn');
    if (backBtn._coursesReturn) {
      // Came from courses browser — go back there
      backBtn._coursesReturn = false;
      backBtn.textContent = '← Back to analysis';
      showPanel('empty');
      // Switch left panel to courses tab
      document.querySelectorAll('.lmode-btn').forEach(b => b.classList.toggle('active', b.dataset.lmode === 'courses'));
      document.getElementById('analyze-section').style.display  = 'none';
      document.getElementById('practice-section').style.display = 'none';
      document.getElementById('courses-section').style.display  = '';
      renderCoursesBrowser();
      return;
    }
    if (state.comparison) {
      state.navMode = 'game';
      const fens     = [START_FEN];
      const froms    = [null];
      const tos      = [null];
      const comments = [null];
      for (const m of state.comparison) {
        fens.push(m.fen);
        froms.push(m.from);
        tos.push(m.to);
        comments.push(m.bookComment || null);
      }
      const devIdx = state.comparison.findIndex(m => m.status === 'deviation');
      const navIdx = devIdx >= 0 ? devIdx : fens.length - 1;
      setNavState(fens, froms, tos, comments, navIdx);
    }
    showPanel('analysis');
  });

  // Left panel mode toggle
  document.querySelectorAll('.lmode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.lmode;
      document.querySelectorAll('.lmode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('analyze-section').style.display  = mode === 'analyze'  ? '' : 'none';
      document.getElementById('practice-section').style.display = mode === 'practice' ? '' : 'none';
      document.getElementById('courses-section').style.display  = mode === 'courses'  ? '' : 'none';
      if (mode === 'courses')  renderCoursesBrowser();
      if (mode === 'practice' && state.practiceActive) showPanel('practice');
      if (mode === 'analyze'  && !state.practiceActive) showPanel('empty');
    });
  });

  // Practice color is always derived from the active course (not a free pick)
  updatePracticeColorDisplay();

  // Start / Reset practice
  document.getElementById('start-practice-btn').addEventListener('click', startPractice);
  document.getElementById('reset-practice-btn').addEventListener('click', resetPractice);

  // Deviation prompt
  document.getElementById('retry-btn').addEventListener('click', retryFromDeviation);
  document.getElementById('show-solution-btn').addEventListener('click', revealPracticeAnalysis);

  // Continue from here (board area)
  document.getElementById('continue-from-btn').addEventListener('click', continuePracticeFrom);

  // ── Upload course form ────────────────────────────────────────────────────
  let ucColor = 'w';

  document.getElementById('add-course-btn').addEventListener('click', () => {
    const form = document.getElementById('upload-course-form');
    form.style.display = form.style.display === 'none' ? '' : 'none';
    document.getElementById('uc-error').textContent = '';
  });

  document.getElementById('uc-cancel-btn').addEventListener('click', () => {
    document.getElementById('upload-course-form').style.display = 'none';
  });

  document.querySelectorAll('.uc-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.uc-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ucColor = btn.dataset.color;
    });
  });

  document.getElementById('uc-file').addEventListener('change', e => {
    const file = e.target.files[0];
    const label = document.getElementById('uc-file-label');
    const span  = document.getElementById('uc-file-text');
    if (file) {
      span.textContent = file.name;
      label.classList.add('has-file');
    } else {
      span.textContent = 'Choose .pgn file';
      label.classList.remove('has-file');
    }
  });

  document.getElementById('uc-submit-btn').addEventListener('click', async () => {
    const name    = document.getElementById('uc-name').value.trim();
    const fileEl  = document.getElementById('uc-file');
    const errorEl = document.getElementById('uc-error');
    const submitBtn = document.getElementById('uc-submit-btn');

    errorEl.textContent = '';

    if (!name)           { errorEl.textContent = 'Please enter a course name.'; return; }
    if (!fileEl.files[0]) { errorEl.textContent = 'Please choose a .pgn file.'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Parsing…';

    try {
      const pgn   = await fileEl.files[0].text();
      const lines = parseCourse(pgn);
      if (lines.length === 0) throw new Error('No valid lines found in this PGN.');

      const dbId = await saveUserCourse(name, ucColor, pgn);
      addUserCourse(name, ucColor, pgn, dbId);
      renderCourseTabs();

      const newIdx = COURSES.length - 1;
      handleTabClick(newIdx);

      // Reset form
      document.getElementById('upload-course-form').style.display = 'none';
      document.getElementById('uc-name').value = '';
      fileEl.value = '';
      document.getElementById('uc-file-text').textContent = 'Choose .pgn file';
      document.getElementById('uc-file-label').classList.remove('has-file');
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Course';
    }
  });

  // Load first course (only if one exists — user may have none yet)
  if (COURSES.length > 0) loadCourse(0);
});

// ── Practice Mode ─────────────────────────────────────────────────────────────

function startPractice() {
  const selected = [...state.practiceSelectedCourses];
  if (selected.length === 0) {
    setPracticeMsg('Select at least one course above.', false);
    return;
  }

  // Validate: all selected courses must be the same color
  const orientations = [...new Set(selected.map(i => COURSES[i]?.orientation).filter(Boolean))];
  if (orientations.length > 1) {
    setPracticeMsg('Select courses of the same color only.', false);
    return;
  }

  // Ensure all selected courses are loaded
  const missing = selected.filter(i => !state.courseData[i]);
  if (missing.length > 0) {
    setPracticeMsg('Some courses are still loading, please wait.', false);
    Promise.all(missing.map(i => loadCourse(i))).then(startPractice);
    return;
  }

  // Merge lines from all selected courses into a single trie
  const allLines = selected.flatMap(i => state.courseData[i].lines);
  state.practiceData = { lines: allLines, trie: buildTrie(allLines) };

  state.practiceColor   = orientations[0];
  state.practiceChess   = new Chess();
  state.practiceTrieKey = START_KEY;
  state.practiceInBook  = true;
  state.practiceComparison = [];
  state.selectedSq      = null;
  state.legalDests      = [];
  state.practiceActive  = true;
  state.navMode         = 'practice';

  document.getElementById('start-practice-btn').style.display = 'none';
  document.getElementById('reset-practice-btn').style.display = '';
  setPracticeMsg('');

  setNavState([START_FEN], [null], [null], [null], 0);
  renderBoard(START_FEN, null, null);
  showPanel('practice');
  updatePracticePanel();

  if (state.practiceColor === 'b') setTimeout(playComputerMove, 500);
}

function resetPractice() {
  state.practiceActive  = false;
  state.practiceChess   = null;
  state.practiceComparison = [];
  state.selectedSq      = null;
  state.legalDests      = [];
  state.navMode         = 'idle';

  state.practiceSource = false;
  document.getElementById('start-practice-btn').style.display = '';
  document.getElementById('reset-practice-btn').style.display = 'none';
  document.getElementById('practice-inline-moves').innerHTML  = '';
  document.getElementById('deviation-prompt').style.display   = 'none';
  document.getElementById('continue-bar').style.display       = 'none';
  document.getElementById('practice-turn-msg').style.display  = '';
  setPracticeMsg('');

  setNavState([START_FEN], [null], [null], [null], 0);
  renderBoard(START_FEN, null, null);
  showPanel('empty');
}

function handleBoardClick(sqName) {
  if (!state.practiceActive || !state.practiceInBook) return;
  const chess = state.practiceChess;
  if (chess.turn() !== state.practiceColor) return;

  const piece = chess.get(sqName);

  if (state.selectedSq === sqName) {
    clearPracticeSelection();
    return;
  }

  if (state.selectedSq && state.legalDests.includes(sqName)) {
    submitUserMove(state.selectedSq, sqName);
    return;
  }

  if (piece && piece.color === state.practiceColor) {
    state.selectedSq  = sqName;
    const moves = chess.moves({ square: sqName, verbose: true });
    state.legalDests  = moves.map(m => m.to);
    renderBoard(chess.fen(), lastPracticeFrom(), lastPracticeTo());
    return;
  }

  clearPracticeSelection();
}

function clearPracticeSelection() {
  state.selectedSq = null;
  state.legalDests = [];
  if (state.practiceChess) {
    renderBoard(state.practiceChess.fen(), lastPracticeFrom(), lastPracticeTo());
  }
}

function lastPracticeFrom() {
  const last = state.practiceComparison[state.practiceComparison.length - 1];
  return last ? last.from : null;
}
function lastPracticeTo() {
  const last = state.practiceComparison[state.practiceComparison.length - 1];
  return last ? last.to : null;
}

function submitUserMove(from, to) {
  const chess = state.practiceChess;
  const result = chess.move({ from, to, promotion: 'q' });
  if (!result) return;

  state.selectedSq = null;
  state.legalDests = [];

  const san    = result.san;
  const newFen = chess.fen();
  const node   = state.practiceData.trie.get(state.practiceTrieKey);
  const inBook = node && node.has(san);

  const rec = {
    san,
    from: result.from,
    to:   result.to,
    fen:  newFen,
    status:           inBook ? 'in-book' : 'deviation',
    bookAlternatives: !inBook && node ? [...node.keys()] : [],
    bookComment:      inBook ? node.get(san).comment : null,
    lineIndices:      inBook ? [...node.get(san).lineIndices] : []
  };
  state.practiceComparison.push(rec);

  // Extend nav history so board nav still works
  state.navFens     = [...state.navFens,     newFen];
  state.navFrom     = [...state.navFrom,     result.from];
  state.navTo       = [...state.navTo,       result.to];
  state.navComments = [...state.navComments, rec.bookComment];
  state.navIdx      = state.navFens.length - 1;
  renderBoard(newFen, result.from, result.to);
  updateBoardIndicator();

  if (!inBook) {
    state.practiceInBook = false;
    finishPractice(false);
    return;
  }

  state.practiceTrieKey = node.get(san).nextKey;
  updatePracticePanel();

  // Check if computer has any response
  const nextNode = state.practiceData.trie.get(state.practiceTrieKey);
  if (!nextNode || nextNode.size === 0) {
    finishPractice(true);
    return;
  }

  setTimeout(playComputerMove, 380);
}

function playComputerMove() {
  if (!state.practiceActive || !state.practiceInBook) return;

  const node = state.practiceData.trie.get(state.practiceTrieKey);
  if (!node || node.size === 0) { finishPractice(true); return; }

  const sans  = [...node.keys()];
  const san   = sans[Math.floor(Math.random() * sans.length)];
  const entry = node.get(san);

  const chess  = state.practiceChess;
  const result = chess.move(san, { sloppy: true });
  if (!result) { finishPractice(true); return; }

  const newFen = chess.fen();
  const rec = {
    san:         result.san,
    from:        result.from,
    to:          result.to,
    fen:         newFen,
    status:      'computer',
    bookComment: entry.comment,
    lineIndices: [...entry.lineIndices]
  };
  state.practiceComparison.push(rec);
  state.practiceTrieKey = entry.nextKey;

  state.navFens     = [...state.navFens,     newFen];
  state.navFrom     = [...state.navFrom,     result.from];
  state.navTo       = [...state.navTo,       result.to];
  state.navComments = [...state.navComments, entry.comment];
  state.navIdx      = state.navFens.length - 1;
  renderBoard(newFen, result.from, result.to);
  updateBoardIndicator();
  updatePracticePanel();
}

function finishPractice(completed) {
  state.practiceActive = false;

  const userMoves = state.practiceComparison.filter(m => m.status !== 'computer').length;

  if (completed) {
    setPracticeMsg(`Line complete! ${userMoves} move${userMoves !== 1 ? 's' : ''} played.`, true);
    revealPracticeAnalysis();
  } else {
    showDeviationPrompt();
  }
}

function showDeviationPrompt() {
  const dev  = state.practiceComparison.find(m => m.status === 'deviation');
  const alts = dev?.bookAlternatives || [];

  const promptMsg = document.getElementById('deviation-prompt-msg');
  promptMsg.innerHTML = `<strong>Wrong:</strong> you played <strong>${dev?.san || '?'}</strong>.${
    alts.length
      ? ` Book says: ${alts.map(a => `<span class="book-move">${a}</span>`).join(' or ')}`
      : ''
  }`;

  document.getElementById('deviation-prompt').style.display = '';
  document.getElementById('practice-turn-msg').style.display = 'none';
  showPanel('practice');
  updateContinueBar();
}

function revealPracticeAnalysis() {
  document.getElementById('deviation-prompt').style.display = 'none';

  const displayComp = state.practiceComparison.map(m => ({
    ...m,
    status: m.status === 'computer' ? 'in-book' : m.status
  }));
  state.comparison    = displayComp;
  state.uploadedMoves = displayComp;
  state.practiceSource = true;   // remember we came from a practice game
  state.navMode       = 'game';
  renderAnalysis(displayComp, state.practiceData.lines);
  updateContinueBar();
}

function retryFromDeviation() {
  const devIdx = state.practiceComparison.findIndex(m => m.status === 'deviation');
  if (devIdx < 0) return;

  // navFens[devIdx] = the position BEFORE the wrong move
  const fen = state.navFens[devIdx];

  // Trim everything back to just before the deviation
  state.practiceComparison = state.practiceComparison.slice(0, devIdx);
  state.navFens     = state.navFens.slice(0, devIdx + 1);
  state.navFrom     = state.navFrom.slice(0, devIdx + 1);
  state.navTo       = state.navTo.slice(0, devIdx + 1);
  state.navComments = state.navComments.slice(0, devIdx + 1);
  state.navIdx      = devIdx;

  // Restore chess and trie state
  state.practiceChess   = new Chess(fen);
  state.practiceTrieKey = fenKey(fen);
  state.practiceInBook  = true;
  state.practiceActive  = true;
  state.selectedSq      = null;
  state.legalDests      = [];

  document.getElementById('deviation-prompt').style.display = 'none';
  document.getElementById('practice-turn-msg').style.display = '';
  document.getElementById('continue-bar').style.display = 'none';

  renderBoard(fen, state.navFrom[devIdx], state.navTo[devIdx]);
  showPanel('practice');
  updatePracticePanel();

  if (state.practiceChess.turn() !== state.practiceColor) {
    setTimeout(playComputerMove, 400);
  }
}

function continuePracticeFrom() {
  const idx = state.navIdx;
  const fen = state.navFens[idx];

  // Trim comparison — drop any moves at or after this nav index
  state.practiceComparison = state.practiceComparison.slice(0, idx).filter(
    m => m.status !== 'deviation'
  );
  state.navFens     = state.navFens.slice(0, idx + 1);
  state.navFrom     = state.navFrom.slice(0, idx + 1);
  state.navTo       = state.navTo.slice(0, idx + 1);
  state.navComments = state.navComments.slice(0, idx + 1);

  state.practiceChess   = new Chess(fen);
  state.practiceTrieKey = fenKey(fen);
  state.practiceInBook  = true;
  state.practiceActive  = true;
  state.practiceSource  = false;
  state.selectedSq      = null;
  state.legalDests      = [];

  document.getElementById('deviation-prompt').style.display = 'none';
  document.getElementById('practice-turn-msg').style.display = '';
  document.getElementById('continue-bar').style.display = 'none';
  document.getElementById('reset-practice-btn').style.display = '';
  document.getElementById('start-practice-btn').style.display = 'none';

  renderBoard(fen, state.navFrom[idx], state.navTo[idx]);
  showPanel('practice');
  updatePracticePanel();

  if (state.practiceChess.turn() !== state.practiceColor) {
    setTimeout(playComputerMove, 400);
  }
}

function updateContinueBar() {
  // Show "Continue from here" when in post-practice navigation at an in-book position
  const bar = document.getElementById('continue-bar');
  if (!bar) return;

  const isPostPractice = !state.practiceActive &&
    (state.navMode === 'practice' || state.practiceSource);
  if (!isPostPractice) { bar.style.display = 'none'; return; }

  const fen = state.navFens[state.navIdx];
  if (!fen) { bar.style.display = 'none'; return; }

  const trie = state.practiceData?.trie ?? state.courseData[state.activeCourse]?.trie;
  const inBook = trie && trie.has(fenKey(fen));
  bar.style.display = (inBook && state.navIdx > 0) ? '' : 'none';
}

function updatePracticePanel() {
  const userDepth = state.practiceComparison.filter(m => m.status !== 'computer').length;

  // Right panel depth
  const depthEl = document.getElementById('practice-depth-label');
  if (depthEl) depthEl.textContent = `${userDepth} move${userDepth !== 1 ? 's' : ''} deep`;

  // Right panel move list (mirrors left panel inline list)
  renderPracticeMoveList(
    document.getElementById('practice-right-moves'),
    'move-token'
  );

  // Left panel inline list
  renderPracticeMoveList(
    document.getElementById('practice-inline-moves'),
    'move-token'
  );

  // Turn message
  const turnEl = document.getElementById('practice-turn-msg');
  if (turnEl && state.practiceChess) {
    const turn = state.practiceChess.turn();
    turnEl.textContent = turn === state.practiceColor
      ? 'Your move'
      : 'Book is thinking…';
  }
}

function renderPracticeMoveList(container, tokenClass) {
  if (!container) return;
  container.innerHTML = '';
  let moveNum = 0;
  for (let i = 0; i < state.practiceComparison.length; i++) {
    const m = state.practiceComparison[i];
    const isWhite = i % 2 === 0;
    if (isWhite) {
      moveNum++;
      const n = document.createElement('span');
      n.className = 'move-num';
      n.textContent = `${moveNum}.`;
      container.appendChild(n);
    }
    const t = document.createElement('span');
    t.className = `${tokenClass} ${m.status === 'computer' ? 'computer-move' : m.status}`;
    t.textContent = m.san;
    container.appendChild(t);
  }
}

function setPracticeMsg(msg, success = true) {
  const el = document.getElementById('practice-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className   = success ? '' : 'deviation';
}

function updatePracticeColorDisplay() {
  const el = document.getElementById('practice-color-display');
  if (!el) return;
  const selected = [...state.practiceSelectedCourses];
  if (selected.length === 0) {
    el.textContent = 'Select courses above to practice';
    el.className = '';
    return;
  }
  const orientations = [...new Set(selected.map(i => COURSES[i]?.orientation).filter(Boolean))];
  if (orientations.length > 1) {
    el.textContent = '⚠ Mixed colors selected — pick one color';
    el.className = 'warn';
  } else {
    const color = orientations[0];
    state.practiceColor = color;
    el.textContent = color === 'w' ? '♔ Playing as White' : '♚ Playing as Black';
    el.className = '';
  }
}

function updateBoardIndicator() {
  const idx = state.navIdx;
  if (idx === 0) {
    document.getElementById('move-indicator').textContent = '—';
    return;
  }
  const moveNum = Math.ceil(idx / 2);
  const isWhite = idx % 2 === 1;
  let san = '';
  if (state.navMode === 'practice') {
    san = state.practiceComparison[idx - 1]?.san || '';
  }
  document.getElementById('move-indicator').textContent =
    `${moveNum}${isWhite ? '.' : '...'} ${san}`;
}

// ── Drag and Drop ─────────────────────────────────────────────────────────────

const drag = {
  active:       false,
  startSq:      null,
  pieceChar:    null,
  ghost:        null,
  overSq:       null,
  moved:        false,
  startX:       0,
  startY:       0,
  suppressClick: false
};

function getSquareAtPoint(clientX, clientY) {
  const board = document.getElementById('chessboard');
  if (!board) return null;
  const bbox = board.getBoundingClientRect();
  if (clientX < bbox.left || clientX > bbox.right ||
      clientY < bbox.top  || clientY > bbox.bottom) return null;

  const orientation = state.navMode === 'practice'
    ? state.practiceColor
    : COURSES[state.activeCourse].orientation;
  const sqSize = bbox.width / 8;
  const col = Math.max(0, Math.min(7, Math.floor((clientX - bbox.left) / sqSize)));
  const row = Math.max(0, Math.min(7, Math.floor((clientY - bbox.top)  / sqSize)));

  const fileIdx = orientation === 'w' ? col : 7 - col;
  const rankIdx = orientation === 'w' ? row : 7 - row;
  return 'abcdefgh'[fileIdx] + (8 - rankIdx);
}

function startPieceDrag(clientX, clientY, sqName, pieceChar) {
  if (!pieceChar) return;
  // Only allow dragging the player's own pieces
  const isOwnPiece = state.practiceChess &&
    state.practiceChess.turn() === state.practiceColor &&
    ((state.practiceColor === 'w') === (pieceChar === pieceChar.toUpperCase()));
  if (!isOwnPiece) return;

  drag.active    = true;
  drag.startSq   = sqName;
  drag.pieceChar = pieceChar;
  drag.startX    = clientX;
  drag.startY    = clientY;
  drag.moved     = false;
  drag.overSq    = null;

  // Select the piece (shows legal hints)
  state.selectedSq = sqName;
  const moves = state.practiceChess.moves({ square: sqName, verbose: true });
  state.legalDests = moves.map(m => m.to);
  renderBoard(state.practiceChess.fen(), lastPracticeFrom(), lastPracticeTo());

  // Ghost element
  const ghost = document.createElement('div');
  ghost.id = 'drag-ghost';
  const isWhite = pieceChar === pieceChar.toUpperCase();
  const ghostPieceType = { K:'king', Q:'queen', R:'rook', B:'bishop', N:'knight', P:'pawn' }[pieceChar.toUpperCase()];
  ghost.innerHTML = `<span class="piece ${isWhite ? 'w-piece' : 'b-piece'} piece-${ghostPieceType}">${PIECES[pieceChar]}</span>`;
  ghost.style.left = clientX + 'px';
  ghost.style.top  = clientY + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;

  // Dim source piece
  const srcEl = document.querySelector(`[data-sq="${sqName}"]`);
  if (srcEl) srcEl.classList.add('sq-drag-source');
}

function moveDrag(clientX, clientY) {
  if (!drag.active || !drag.ghost) return;

  drag.ghost.style.left = clientX + 'px';
  drag.ghost.style.top  = clientY + 'px';

  if (!drag.moved) {
    const dx = clientX - drag.startX, dy = clientY - drag.startY;
    if (dx * dx + dy * dy > 16) drag.moved = true;
  }

  // Update hover highlight
  const sq = getSquareAtPoint(clientX, clientY);
  if (sq !== drag.overSq) {
    if (drag.overSq) {
      const el = document.querySelector(`[data-sq="${drag.overSq}"]`);
      if (el) el.classList.remove('sq-drag-hover');
    }
    if (sq && state.legalDests.includes(sq)) {
      const el = document.querySelector(`[data-sq="${sq}"]`);
      if (el) el.classList.add('sq-drag-hover');
    }
    drag.overSq = sq;
  }
}

function endDrag(clientX, clientY) {
  if (!drag.active) return;

  const targetSq = getSquareAtPoint(clientX, clientY);
  const moved    = drag.moved;
  const startSq  = drag.startSq;

  // Cleanup ghost and overlays
  if (drag.ghost) { drag.ghost.remove(); drag.ghost = null; }
  if (drag.overSq) {
    const el = document.querySelector(`[data-sq="${drag.overSq}"]`);
    if (el) el.classList.remove('sq-drag-hover');
    drag.overSq = null;
  }
  const srcEl = document.querySelector(`[data-sq="${startSq}"]`);
  if (srcEl) srcEl.classList.remove('sq-drag-source');
  drag.active = false;

  if (!moved) {
    // Short press — let the click event handle it as normal selection
    return;
  }

  // Significant drag — suppress the resulting click and handle the drop
  drag.suppressClick = true;

  if (targetSq && targetSq !== startSq && state.legalDests.includes(targetSq)) {
    submitUserMove(startSq, targetSq);
  } else {
    clearPracticeSelection();
  }
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────

const DB_NAME    = 'chess-repertoire';
const DB_VERSION = 1;
const STORE      = 'user_courses';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveUserCourse(name, orientation, pgn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add({ name, orientation, pgn, createdAt: new Date() });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getUserCourses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteUserCourse(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// Wire up global pointer listeners (added once in DOMContentLoaded)
function initDragListeners() {
  document.addEventListener('pointermove', e => moveDrag(e.clientX, e.clientY));
  document.addEventListener('pointerup',   e => endDrag(e.clientX, e.clientY));
  // Cancel drag on focus loss
  document.addEventListener('pointercancel', () => {
    if (!drag.active) return;
    if (drag.ghost) { drag.ghost.remove(); drag.ghost = null; }
    drag.active = false;
    clearPracticeSelection();
  });
}
