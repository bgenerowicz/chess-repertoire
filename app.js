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
  courseMatch: null,   // { courseIdx, depth } when auto-detected, null when chosen manually
  // Board navigation
  navFens: [START_FEN],
  navFrom: [null],
  navTo:   [null],
  navComments: [null],
  navIdx: 0,
  boardFlipped: false,   // user override on top of the course/practice orientation
  navMode: 'idle',  // 'idle' | 'game' | 'study' | 'practice' | 'explore'
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
  legalDests: [],
  // Explore — free move-making on the board, matched against every loaded course
  exploreActive: false,
  exploreChess: null,
  exploreMoves: [],       // [{ san, from, to, fen, inBook, comment, courses }]
  exploreStartFen: START_FEN,
  // Lichess import
  lichessGames: []   // most recent games fetched for the entered username
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

// Which colour sits at the bottom: the course/practice colour, flipped if the user asked
function boardOrientation() {
  const base = state.navMode === 'practice'
    ? state.practiceColor
    : (COURSES[state.activeCourse]?.orientation ?? 'w');
  return state.boardFlipped ? (base === 'w' ? 'b' : 'w') : base;
}

function renderBoard(fen, lastFrom, lastTo) {
  const board = document.getElementById('chessboard');
  board.innerHTML = '';

  const orientation = boardOrientation();
  const ranks = fen.split(' ')[0].split('/');  // rank 8 → rank 1
  const sideToMove = fen.split(' ')[1] || 'w';

  // Practice restricts moves to the player's colour. Everywhere else the board is
  // a free exploration surface where either side can be moved.
  const practiceInteractive = state.practiceActive && state.practiceInBook;
  const exploreInteractive  = !state.practiceActive;

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

      // Interactive overlays — practice moves, or free exploration elsewhere
      if (practiceInteractive || exploreInteractive) {
        const isPlayerTurn = practiceInteractive
          ? (state.practiceChess && state.practiceChess.turn() === state.practiceColor)
          : true;
        if (sqName === state.selectedSq) {
          sq.classList.add('sq-selected');
        } else if (state.legalDests.includes(sqName)) {
          if (piece) sq.classList.add('sq-legal-capture');
          else       sq.classList.add('sq-legal');
        }

        // In explore, only the side to move (and its legal targets) invite a click
        const pieceMovable = piece && (piece === piece.toUpperCase() ? 'w' : 'b') === sideToMove;
        const inviting = practiceInteractive
          ? isPlayerTurn
          : (pieceMovable || state.legalDests.includes(sqName));
        if (inviting) sq.classList.add('sq-interactive');

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
    } else if (state.navMode === 'explore') {
      san = state.exploreMoves[idx - 1]?.san || '';
    }
    indicator.textContent = `${moveNum}${isWhite ? '.' : '...'} ${san}`;
  }

  // Book indicator
  const bookEl = document.getElementById('book-indicator');
  if (idx > 0 && state.navMode === 'game' && state.comparison) {
    const status = state.comparison[idx - 1]?.status;
    if (status === 'in-book') {
      bookEl.textContent = '✓';
      bookEl.className = 'book-in';
    } else if (status === 'deviation') {
      bookEl.textContent = '✗';
      bookEl.className = 'book-dev';
    } else {
      bookEl.textContent = '–';
      bookEl.className = 'book-out';
    }
  } else if (idx > 0 && state.navMode === 'study' && state.comparison) {
    const status = state.comparison[idx - 1]?.status;
    if (status === 'in-book') {
      bookEl.textContent = '✓';
      bookEl.className = 'book-in';
    } else if (status === 'deviation') {
      bookEl.textContent = '✗';
      bookEl.className = 'book-dev';
    } else {
      bookEl.textContent = '';
      bookEl.className = '';
    }
  } else if (idx > 0 && state.navMode === 'study') {
    bookEl.textContent = '✓';
    bookEl.className = 'book-in';
  } else if (idx > 0 && state.navMode === 'explore') {
    const inBook = state.exploreMoves[idx - 1]?.inBook;
    bookEl.textContent = inBook ? '✓' : '✗';
    bookEl.className   = inBook ? 'book-in' : 'book-dev';
  } else {
    bookEl.textContent = '';
    bookEl.className = '';
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
  document.querySelectorAll('.move-token.current, .study-move-token.current, .explore-move.current')
    .forEach(el => el.classList.remove('current'));

  if (state.navMode === 'game' && idx > 0) {
    const el = document.querySelector(`.move-token[data-idx="${idx - 1}"]`);
    if (el) {
      el.classList.add('current');
      keepTokenVisible(el, document.getElementById('move-list'));
    }
  } else if (state.navMode === 'study' && idx > 0) {
    const el = document.querySelector(`.study-move-token[data-idx="${idx - 1}"]`);
    if (el) el.classList.add('current');
  }

  // Explore panel tracks whatever position the nav buttons land on
  if (state.navMode === 'explore') updateExplorePanel();
}

// ── UI – Analysis ─────────────────────────────────────────────────────────────

// Centres a move token inside its own scroll container. A no-op on mobile, where
// the list isn't scrollable, and when the element hasn't been laid out yet.
// Measured with rects rather than offsetTop: the list is not a positioned
// ancestor, so offsetTop is relative to the panel and would scroll to the wrong
// place entirely.
function keepTokenVisible(token, container) {
  if (!token || !container || !container.clientHeight) return;
  if (container.scrollHeight <= container.clientHeight) return;

  const tokenRect = token.getBoundingClientRect();
  const boxRect   = container.getBoundingClientRect();
  const offset    = (tokenRect.top - boxRect.top) - (container.clientHeight - tokenRect.height) / 2;
  container.scrollTop = Math.max(0, container.scrollTop + offset);
}

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
  let devToken = null;
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
    if (m.status === 'deviation') devToken = token;
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

  renderDeviationBranches(comparison, lines);

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

  // Only measurable once the panel is visible
  keepTokenVisible(devToken, moveListEl);
}

// ── UI – Study ────────────────────────────────────────────────────────────────

// ── Deviation branches ────────────────────────────────────────────────────────
// At the point the game left book, show what was actually played alongside what
// the repertoire plays, both navigable from the same position.

const BRANCH_PLIES = 8;   // how much of each continuation to show

// Repertoire lines that follow the game up to `devIdx`, grouped by the move they
// play there. Read off the lines directly rather than via getMatchedLines, so it
// still works when the game left book on move 1 (nothing "matched" in that case).
function bookBranchesAt(comparison, lines, devIdx) {
  const played = comparison.slice(0, devIdx).map(m => m.san);
  const branches = [];
  const seen = new Set();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line.moves.length <= devIdx) continue;
    if (!played.every((san, i) => line.moves[i]?.san === san)) continue;

    const san = line.moves[devIdx].san;
    if (seen.has(san)) continue;
    seen.add(san);
    branches.push({ san, lineIdx, line, moves: line.moves.slice(devIdx) });
  }
  return branches;
}

// Renders `moves` as numbered, clickable tokens starting at ply `startPly`.
function appendBranchMoves(container, moves, startPly, tokenClass, onPick) {
  moves.slice(0, BRANCH_PLIES).forEach((move, i) => {
    const ply = startPly + i;
    const isWhite = ply % 2 === 0;

    if (isWhite || i === 0) {
      const num = document.createElement('span');
      num.className = 'db-num';
      num.textContent = `${Math.floor(ply / 2) + 1}${isWhite ? '.' : '...'}`;
      container.appendChild(num);
    }

    const token = document.createElement('span');
    token.className = `db-move ${tokenClass}`;
    token.textContent = move.san;
    if (move.comment) token.title = move.comment;
    token.addEventListener('click', () => {
      // Only one move across both branches is current — it's what the board shows
      document.querySelectorAll('#deviation-branches .db-move.current')
        .forEach(n => n.classList.remove('current'));
      token.classList.add('current');
      onPick(ply, i);
    });
    container.appendChild(token);
  });

  if (moves.length > BRANCH_PLIES) {
    const more = document.createElement('span');
    more.className = 'db-more';
    more.textContent = '…';
    container.appendChild(more);
  }
}

function renderDeviationBranches(comparison, lines) {
  const el = document.getElementById('deviation-branches');
  el.innerHTML = '';

  const devIdx = comparison.findIndex(m => m.status === 'deviation');
  if (devIdx < 0) { el.style.display = 'none'; return; }
  el.style.display = '';

  // What you actually played, from the deviation onward
  const gameRow = document.createElement('div');
  gameRow.className = 'db-row';
  const gameLabel = document.createElement('div');
  gameLabel.className = 'db-label db-label-game';
  gameLabel.textContent = 'You played';
  const gameMoves = document.createElement('div');
  gameMoves.className = 'db-moves';
  appendBranchMoves(gameMoves, comparison.slice(devIdx), devIdx, 'db-move-game',
    ply => {
      state.navIdx = ply + 1;
      updateBoardDisplay();
      updateContinueBar();
    });
  gameRow.appendChild(gameLabel);
  gameRow.appendChild(gameMoves);
  el.appendChild(gameRow);

  // What the repertoire plays instead
  const branches = bookBranchesAt(comparison, lines ?? [], devIdx);
  if (branches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'db-row db-empty';
    empty.textContent = 'No repertoire continuation from this position.';
    el.appendChild(empty);
    return;
  }

  for (const branch of branches) {
    const row = document.createElement('div');
    row.className = 'db-row';

    const label = document.createElement('div');
    label.className = 'db-label db-label-book';
    label.textContent = 'Book';
    const name = document.createElement('span');
    name.className = 'db-line-name';
    name.textContent = branch.line.name || branch.line.chapter || '';
    label.appendChild(name);

    const moves = document.createElement('div');
    moves.className = 'db-moves';
    appendBranchMoves(moves, branch.moves, devIdx, 'db-move-book',
      ply => showStudyLine(branch.lineIdx, comparison, ply));

    row.appendChild(label);
    row.appendChild(moves);
    el.appendChild(row);
  }
}

function showStudyLine(lineIdx, comparison, atMoveIdx = null) {
  resetExplore();
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
  // Navigate to the requested move, else the deviation point, else the start
  const startIdx = atMoveIdx != null ? atMoveIdx
    : (devMoveIdx !== null ? Math.max(0, devMoveIdx) : 0);
  setNavState(fens, froms, tos, comments, Math.min(startIdx + 1, fens.length - 1));
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
  document.getElementById('explore-view').style.display   = which === 'explore'  ? '' : 'none';
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
    statusEl.textContent = '';
    statusEl.className = '';
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    statusEl.className = 'error';
    console.error(err);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleAnalyze() {
  resetExplore();
  const pgn = document.getElementById('pgn-input').value.trim();
  const errorEl = document.getElementById('upload-error');
  errorEl.textContent = '';

  if (!pgn) { errorEl.textContent = 'Please paste a PGN game.'; return; }

  const { headers, moves } = parseGame(pgn);
  if (moves.length === 0) { errorEl.textContent = 'No moves found in PGN. Check the format.'; return; }

  // Every course has to be parsed before we can tell which one this game follows
  const missing = COURSES.map((_, i) => i).filter(i => !state.courseData[i]);
  if (missing.length > 0) {
    errorEl.textContent = 'Courses are still loading, please wait…';
    Promise.all(missing.map(i => loadCourse(i))).then(handleAnalyze);
    return;
  }

  // Pick the repertoire this game follows furthest rather than whatever was last used
  const best = pickBestCourse(moves);
  if (best) applyActiveCourse(best.courseIdx, best);

  const courseData = state.courseData[state.activeCourse];
  if (!courseData) { errorEl.textContent = 'Course is still loading, please wait.'; return; }

  state.uploadedMoves = moves;
  const comparison = compareToTrie(moves, courseData.trie);
  state.comparison = comparison;

  renderAnalysis(comparison, courseData.lines);

  // On mobile, switch to the board view. The analysis (matched lines included)
  // now stacks under the board there, so no modal is needed to surface it.
  const mainEl = document.querySelector('main');
  if (mainEl.classList.contains('mobile-show-left')) {
    mainEl.classList.remove('mobile-show-left');
    mainEl.classList.add('mobile-show-right');
    document.querySelectorAll('.mobile-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.panel === 'right' && !b.dataset.lmode));
    document.getElementById('back-btn')._analyzeReturn = true;
  }
}

function handleTabClick(courseIdx) {
  resetExplore();
  applyActiveCourse(courseIdx);   // manual pick — clears any auto-detected match

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

// How far does this game follow each loaded course? Returns the deepest match, or
// null when nothing is loaded. Ties keep the earliest course.
function pickBestCourse(moves) {
  let best = null;
  state.courseData.forEach((data, courseIdx) => {
    if (!data) return;
    const comparison = compareToTrie(moves, data.trie);
    let depth = 0;
    for (const move of comparison) {
      if (move.status !== 'in-book') break;
      depth++;
    }
    if (!best || depth > best.depth) best = { courseIdx, depth };
  });
  return best;
}

// Single place that switches repertoire, whether auto-detected or picked by hand
function applyActiveCourse(courseIdx, match = null) {
  state.activeCourse = courseIdx;
  state.courseMatch  = match;
  state.practiceColor = COURSES[courseIdx]?.orientation ?? state.practiceColor;
  updatePracticeColorDisplay();
  renderActiveCourse();
}

// Passive header chip — names the repertoire in play and how it was chosen.
// Switching is done from the Courses tab, not here.
function renderActiveCourse() {
  const el = document.getElementById('active-course');
  if (!el) return;
  el.innerHTML = '';

  const statusEl = document.getElementById('header-status');

  if (COURSES.length === 0) {
    el.className = 'ac-empty';
    el.textContent = 'No courses — click + to add one';
    if (statusEl) { statusEl.textContent = 'No courses loaded'; statusEl.className = ''; }
    return;
  }

  const course = COURSES[state.activeCourse];
  if (!course) return;
  const match = state.courseMatch;

  el.className = 'ac-chip' + (match && match.depth > 0 ? ' ac-matched' : '');

  const icon = document.createElement('span');
  icon.className = 'ac-icon';
  icon.textContent = match && match.depth > 0 ? '✓' : (course.orientation === 'w' ? '♔' : '♚');

  const name = document.createElement('span');
  name.className = 'ac-name';
  name.textContent = course.name;

  el.appendChild(icon);
  el.appendChild(name);

  if (match) {
    const note = document.createElement('span');
    note.className = 'ac-note';
    note.textContent = match.depth > 0
      ? `${match.depth} move${match.depth !== 1 ? 's' : ''} matched`
      : 'no repertoire matched';
    el.appendChild(note);
  }

  if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
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
    card.dataset.courseIdx = courseIdx;

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
    const orientLabel = course.orientation === 'w' ? '♔' : '♚';
    meta.textContent = orientLabel;

    // Manual override for when auto-detection picks the wrong repertoire
    const isActive = courseIdx === state.activeCourse;
    const useBtn = document.createElement('button');
    useBtn.className = 'course-card-use' + (isActive ? ' active' : '');
    useBtn.title = isActive ? 'Active repertoire' : 'Use this repertoire';
    useBtn.textContent = '✓';
    useBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (isActive) return;
      handleTabClick(courseIdx);
      renderCoursesBrowser();
    });

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
    header.appendChild(useBtn);
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
  renderActiveCourse();
  renderPracticeCourseList();
  handleTabClick(state.activeCourse);
}

// ── Explore Mode ──────────────────────────────────────────────────────────────
// Free move-making on the main board. Every position is looked up in all loaded
// courses at once — the trie is keyed by position, so this works from any
// starting point, including a position reached mid-study or mid-analysis.

// san → { comment, courses: [courseIdx] }, unioned across every loaded course
function bookContinuations(key) {
  const out = new Map();
  state.courseData.forEach((data, courseIdx) => {
    const node = data?.trie?.get(key);
    if (!node) return;
    for (const [san, entry] of node) {
      if (!out.has(san)) out.set(san, { comment: null, courses: [] });
      const rec = out.get(san);
      if (!rec.comment && entry.comment) rec.comment = entry.comment;
      if (!rec.courses.includes(courseIdx)) rec.courses.push(courseIdx);
    }
  });
  return out;
}

// Course indices whose repertoire contains this exact position
function coursesWithPosition(key) {
  const found = [];
  state.courseData.forEach((data, courseIdx) => {
    if (data?.trie?.has(key)) found.push(courseIdx);
  });
  return found;
}

function startExplore(fen) {
  state.exploreActive   = true;
  state.exploreChess    = new Chess(fen);
  state.exploreMoves    = [];
  state.exploreStartFen = fen;
  state.navMode         = 'explore';
  state.selectedSq      = null;
  state.legalDests      = [];

  setNavState([fen], [null], [null], [null], 0);
  showPanel('explore');
  updateExplorePanel();

  // Courses load lazily; explore needs all of them to match against
  const missing = COURSES.map((_, i) => i).filter(i => !state.courseData[i]);
  if (missing.length > 0) {
    Promise.all(missing.map(i => loadCourse(i))).then(() => {
      if (state.exploreActive) updateExplorePanel();
    });
  }
}

// Returns the chess object accepting moves, starting or rewinding a session as needed.
function ensureExploreSession() {
  if (!state.exploreActive) {
    startExplore(state.navFens[state.navIdx] ?? START_FEN);
  } else if (state.navIdx !== state.exploreMoves.length) {
    // User navigated back and is now branching — drop everything after this point
    state.exploreMoves = state.exploreMoves.slice(0, state.navIdx);
    state.navFens      = state.navFens.slice(0, state.navIdx + 1);
    state.navFrom      = state.navFrom.slice(0, state.navIdx + 1);
    state.navTo        = state.navTo.slice(0, state.navIdx + 1);
    state.navComments  = state.navComments.slice(0, state.navIdx + 1);
    state.exploreChess = new Chess(state.navFens[state.navIdx]);
  }
  return state.exploreChess;
}

function exploreMove(from, to) {
  const chess     = ensureExploreSession();
  const keyBefore = fenKey(chess.fen());
  const result    = chess.move({ from, to, promotion: 'q' });
  if (!result) return;

  state.selectedSq = null;
  state.legalDests = [];

  const book = bookContinuations(keyBefore).get(result.san);
  const fen  = chess.fen();

  state.exploreMoves.push({
    san:     result.san,
    from:    result.from,
    to:      result.to,
    fen,
    inBook:  !!book,
    comment: book?.comment ?? null,
    courses: book?.courses ?? []
  });

  state.navFens     = [...state.navFens,     fen];
  state.navFrom     = [...state.navFrom,     result.from];
  state.navTo       = [...state.navTo,       result.to];
  state.navComments = [...state.navComments, book?.comment ?? null];
  state.navIdx      = state.navFens.length - 1;

  updateBoardDisplay();   // refreshes the explore panel too
}

function handleExploreClick(sqName) {
  const chess = ensureExploreSession();
  const piece = chess.get(sqName);

  if (state.selectedSq === sqName) { clearExploreSelection(); return; }

  if (state.selectedSq && state.legalDests.includes(sqName)) {
    exploreMove(state.selectedSq, sqName);
    return;
  }

  if (piece && piece.color === chess.turn()) {
    state.selectedSq = sqName;
    state.legalDests = chess.moves({ square: sqName, verbose: true }).map(m => m.to);
    renderExploreBoard();
    return;
  }

  clearExploreSelection();
}

function clearExploreSelection() {
  state.selectedSq = null;
  state.legalDests = [];
  if (state.exploreActive) renderExploreBoard();
}

function renderExploreBoard() {
  const last = state.exploreMoves[state.navIdx - 1];
  renderBoard(state.exploreChess.fen(), last?.from ?? null, last?.to ?? null);
}

function resetExplore() {
  state.exploreActive = false;
  state.exploreChess  = null;
  state.exploreMoves  = [];
  state.selectedSq    = null;
  state.legalDests    = [];
  if (state.navMode === 'explore') state.navMode = 'idle';
}

function updateExplorePanel() {
  if (!state.exploreActive) return;

  const fen  = state.navFens[state.navIdx];
  const key  = fenKey(fen);
  const book = bookContinuations(key);
  const here = coursesWithPosition(key);

  // A position only appears as a trie key when it has continuations, so the last
  // move of a line isn't found there — but the move that reached it was in book.
  const lastMove     = state.exploreMoves[state.navIdx - 1];
  const inRepertoire = here.length > 0 || !!lastMove?.inBook;
  const courseIdxs   = here.length > 0 ? here : (lastMove?.courses ?? []);
  const names        = courseIdxs.map(i => COURSES[i]?.name).filter(Boolean).join(', ');

  // Status line
  const statusEl = document.getElementById('explore-status');
  if (COURSES.length === 0) {
    statusEl.textContent = 'No courses loaded — add one to match your moves against it.';
    statusEl.className   = 'explore-status-out';
  } else if (book.size > 0) {
    statusEl.textContent = `In your repertoire${names ? ` — ${names}` : ''}`;
    statusEl.className   = 'explore-status-in';
  } else if (inRepertoire) {
    statusEl.textContent = `End of your repertoire${names ? ` — ${names}` : ''}`;
    statusEl.className   = 'explore-status-end';
  } else {
    statusEl.textContent = 'Out of book';
    statusEl.className   = 'explore-status-out';
  }

  renderExploreMoveList();

  // Book continuations from the current position
  const contEl = document.getElementById('explore-continuations');
  contEl.innerHTML = '';
  for (const [san, { comment, courses }] of book) {
    const btn = document.createElement('button');
    btn.className = 'explore-cont';
    btn.innerHTML = `<span class="ec-san">${escHtml(san)}</span>` +
      (courses.length > 1 ? `<span class="ec-count">${courses.length} courses</span>` : '');
    if (comment) btn.title = comment;
    btn.addEventListener('click', () => playExploreSan(san));
    contEl.appendChild(btn);
  }

  document.getElementById('explore-cont-label').style.display = book.size > 0 ? '' : 'none';
}

function playExploreSan(san) {
  const chess = ensureExploreSession();
  const legal = chess.moves({ verbose: true }).find(m => m.san === san);
  if (legal) exploreMove(legal.from, legal.to);
}

function renderExploreMoveList() {
  const listEl = document.getElementById('explore-moves');
  listEl.innerHTML = '';

  state.exploreMoves.forEach((move, i) => {
    if (i % 2 === 0) {
      const num = document.createElement('span');
      num.className = 'explore-move-num';
      num.textContent = `${Math.floor(i / 2) + 1}.`;
      listEl.appendChild(num);
    }
    const token = document.createElement('span');
    token.className = `explore-move ${move.inBook ? 'in-book' : 'off-book'}`;
    token.textContent = move.san;
    token.dataset.idx = i;
    if (i === state.navIdx - 1) token.classList.add('current');
    if (move.comment) token.title = move.comment;
    token.addEventListener('click', () => {
      state.navIdx = i + 1;
      updateBoardDisplay();
      updateExplorePanel();
    });
    listEl.appendChild(token);
  });
}

// ── Lichess import ────────────────────────────────────────────────────────────

const LICHESS_MAX_GAMES = 15;

// Fetches the user's most recent standard games as ndjson, PGN included per game.
async function fetchLichessGames(username) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}`
            + `?max=${LICHESS_MAX_GAMES}&sort=dateDesc&pgnInJson=true&opening=true`;
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });

  if (res.status === 404) throw new Error('User not found.');
  if (res.status === 429) throw new Error('Too many requests — wait a moment and try again.');
  if (!res.ok) throw new Error(`Lichess returned ${res.status}.`);

  const text = (await res.text()).trim();
  if (!text) throw new Error('No games found for this user.');

  return text.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .filter(game => game.variant === 'standard' && game.pgn);
}

// 'white' | 'black' | null — null when the name doesn't match either side
function lichessPlayerColor(game, username) {
  const name = username.toLowerCase();
  if (game.players?.white?.user?.name?.toLowerCase() === name) return 'white';
  if (game.players?.black?.user?.name?.toLowerCase() === name) return 'black';
  return null;
}

function lichessOpponentName(game, color) {
  const opp = game.players?.[color === 'white' ? 'black' : 'white'];
  if (!opp) return 'Unknown';
  if (opp.aiLevel) return `Stockfish level ${opp.aiLevel}`;
  return opp.user?.name ?? 'Anonymous';
}

function lichessResult(game, color) {
  if (!game.winner) return { text: '½', cls: 'lg-draw' };
  if (!color)       return { text: game.winner === 'white' ? '1-0' : '0-1', cls: 'lg-draw' };
  return game.winner === color
    ? { text: 'W', cls: 'lg-win' }
    : { text: 'L', cls: 'lg-loss' };
}

function renderLichessGames(games, username) {
  const container = document.getElementById('lichess-games');
  container.innerHTML = '';
  state.lichessGames = games;

  if (games.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lg-empty';
    empty.textContent = 'No standard games found for this user.';
    container.appendChild(empty);
    return;
  }

  games.forEach((game, i) => {
    const color   = lichessPlayerColor(game, username);
    const result  = lichessResult(game, color);
    const date    = new Date(game.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const opening = game.opening?.name ?? '';

    const row = document.createElement('button');
    row.className = 'lg-row';
    row.innerHTML =
      `<span class="lg-result ${result.cls}">${result.text}</span>` +
      `<span class="lg-body">` +
        `<span class="lg-opp">${color === 'black' ? '♟' : '♙'} ${escHtml(lichessOpponentName(game, color))}</span>` +
        `<span class="lg-meta">${escHtml(game.speed ?? '')} · ${date}${opening ? ' · ' + escHtml(opening) : ''}</span>` +
      `</span>`;
    row.addEventListener('click', () => selectLichessGame(i));
    container.appendChild(row);
  });
}

function selectLichessGame(idx) {
  const game = state.lichessGames[idx];
  if (!game) return;

  document.getElementById('pgn-input').value = game.pgn;
  document.querySelectorAll('#lichess-games .lg-row')
    .forEach((el, i) => el.classList.toggle('selected', i === idx));

  handleAnalyze();
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

  renderActiveCourse();
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
      if (btn.dataset.lmode) {
        document.querySelector(`.lmode-btn[data-lmode="${btn.dataset.lmode}"]`)?.click();
      }
    });
  });

// Lichess import
  const lichessUsernameEl = document.getElementById('lichess-username');
  lichessUsernameEl.value = localStorage.getItem('lichessUsername') || '';
  const importLichessGames = async () => {
    const username = lichessUsernameEl.value.trim();
    const errorEl  = document.getElementById('lichess-error');
    const btn      = document.getElementById('lichess-import-btn');
    errorEl.textContent = '';
    if (!username) { errorEl.textContent = 'Enter a username.'; return; }
    localStorage.setItem('lichessUsername', username);
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      renderLichessGames(await fetchLichessGames(username), username);
    } catch (err) {
      document.getElementById('lichess-games').innerHTML = '';
      state.lichessGames = [];
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import games';
    }
  };
  document.getElementById('lichess-import-btn').addEventListener('click', importLichessGames);
  lichessUsernameEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') importLichessGames();
  });

  // Explore
  document.getElementById('explore-reset-btn').addEventListener('click', () => startExplore(START_FEN));

  // Flip board — navIdx tracks the displayed position in every mode, so a plain
  // redraw is enough; selection and legal-move hints survive it.
  document.getElementById('flip-btn').addEventListener('click', () => {
    state.boardFlipped = !state.boardFlipped;
    document.getElementById('flip-btn').classList.toggle('flipped', state.boardFlipped);
    updateBoardDisplay();
  });

  // Info modal
  const infoModal = document.getElementById('info-modal');
  document.getElementById('info-btn').addEventListener('click', () => infoModal.style.display = 'flex');
  document.getElementById('info-close-btn').addEventListener('click', () => infoModal.style.display = 'none');
  infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.style.display = 'none'; });

  // Practice lines modal
  document.getElementById('plm-close').addEventListener('click', closePracticeLinesModal);
  document.getElementById('practice-lines-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('practice-lines-modal')) closePracticeLinesModal();
  });

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
    if (backBtn._analyzeReturn) {
      backBtn._analyzeReturn = false;
      const mainEl = document.querySelector('main');
      mainEl.classList.remove('mobile-show-right');
      mainEl.classList.add('mobile-show-left');
      document.querySelectorAll('.mobile-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.lmode === 'analyze'));
      return;
    }
    if (backBtn._practiceReturn) {
      backBtn._practiceReturn = false;
      backBtn.textContent = '← Back to analysis';
      showPanel('practice');
      return;
    }
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

  document.querySelectorAll('.uc-src-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.uc-src-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const isPaste = btn.dataset.src === 'paste';
      document.getElementById('uc-file-label').style.display = isPaste ? 'none' : '';
      document.getElementById('uc-paste').style.display      = isPaste ? ''     : 'none';
    });
  });

  document.querySelectorAll('.uc-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.uc-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ucColor = btn.dataset.color;
    });
  });

  document.getElementById('uc-file-label').addEventListener('click', () => {
    document.getElementById('uc-file').click();
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
    const name      = document.getElementById('uc-name').value.trim();
    const fileEl    = document.getElementById('uc-file');
    const pasteEl   = document.getElementById('uc-paste');
    const errorEl   = document.getElementById('uc-error');
    const submitBtn = document.getElementById('uc-submit-btn');
    const isPaste   = document.querySelector('.uc-src-btn.active')?.dataset.src === 'paste';

    errorEl.textContent = '';

    if (!name) { errorEl.textContent = 'Please enter a course name.'; return; }
    if (isPaste && !pasteEl.value.trim()) { errorEl.textContent = 'Please paste PGN text.'; return; }
    if (!isPaste && !fileEl.files[0])     { errorEl.textContent = 'Please choose a .pgn file.'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Parsing…';

    try {
      const pgn   = isPaste ? pasteEl.value.trim() : await fileEl.files[0].text();
      const lines = parseCourse(pgn);
      if (lines.length === 0) throw new Error('No valid lines found in this PGN.');

      const dbId = await saveUserCourse(name, ucColor, pgn);
      addUserCourse(name, ucColor, pgn, dbId);
      renderActiveCourse();

      const newIdx = COURSES.length - 1;
      handleTabClick(newIdx);

      // Reset form
      document.getElementById('upload-course-form').style.display = 'none';
      document.getElementById('uc-name').value = '';
      fileEl.value = '';
      pasteEl.value = '';
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
  resetExplore();
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

  // Merge lines from all selected courses into a single trie, tracking course boundaries
  const allLines = [];
  const courseOffsets = [];
  for (const i of selected) {
    const courseLines = state.courseData[i].lines;
    courseOffsets.push({ courseIdx: i, start: allLines.length, end: allLines.length + courseLines.length });
    allLines.push(...courseLines);
  }
  state.practiceData = { lines: allLines, trie: buildTrie(allLines), courseOffsets };

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
  if (!state.practiceActive) { handleExploreClick(sqName); return; }
  if (!state.practiceInBook) return;
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
    updateMobilePracticeBar('complete');
    revealPracticeAnalysis();
  } else {
    showDeviationPrompt();
  }
}

function practiceSourceCourse() {
  if (!state.practiceData?.courseOffsets) return null;
  for (let i = state.practiceComparison.length - 1; i >= 0; i--) {
    const m = state.practiceComparison[i];
    if (m.lineIndices?.length) {
      const lineIdx = m.lineIndices[0];
      for (const { courseIdx, start, end } of state.practiceData.courseOffsets) {
        if (lineIdx >= start && lineIdx < end) return courseIdx;
      }
    }
  }
  return [...state.practiceSelectedCourses][0] ?? null;
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
  updateMobilePracticeBar('deviation', { played: dev?.san || '?', alts, sourceCourse: practiceSourceCourse() });
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

function resolveLineIdx(mergedIdx) {
  if (!state.practiceData?.courseOffsets) return null;
  for (const { courseIdx, start, end } of state.practiceData.courseOffsets) {
    if (mergedIdx >= start && mergedIdx < end) return { courseIdx, lineIdx: mergedIdx - start };
  }
  return null;
}

function showPracticeLinesModal() {
  const comparison = state.practiceComparison;
  const lines = state.practiceData?.lines;
  if (!comparison || !lines) return;

  const normalized = comparison.map(m => ({ ...m, status: m.status === 'computer' ? 'in-book' : m.status }));
  const matched = getMatchedLines(normalized, lines);
  const listEl = document.getElementById('plm-list');
  listEl.innerHTML = '';

  if (matched.length === 0) {
    listEl.innerHTML = '<p class="plm-empty">No matching lines found.</p>';
  } else {
    for (const { line, lineIdx, depth } of matched) {
      const resolved = resolveLineIdx(lineIdx);
      if (!resolved) continue;
      const courseName = COURSES[resolved.courseIdx]?.name || '';
      const item = document.createElement('div');
      item.className = 'plm-item';
      item.innerHTML = `
        <div class="plm-course">${escHtml(courseName)}</div>
        <div class="plm-line">${escHtml(line.name || line.chapter || '—')}</div>
        <div class="plm-depth">${depth} move${depth !== 1 ? 's' : ''} matched</div>`;
      item.addEventListener('click', () => {
        closePracticeLinesModal();
        browseCourseLine(resolved.courseIdx, resolved.lineIdx);
      });
      listEl.appendChild(item);
    }
  }

  document.getElementById('practice-lines-modal').style.display = '';
}

function closePracticeLinesModal() {
  document.getElementById('practice-lines-modal').style.display = 'none';
}

function updateMobilePracticeBar(mode, data = {}) {
  const bar = document.getElementById('mobile-practice-bar');
  if (!bar) return;
  if (!state.practiceActive && mode === 'turn') { bar.style.display = 'none'; return; }
  bar.style.display = '';

  if (mode === 'turn') {
    bar.innerHTML = `<span class="mpb-turn">${data.isPlayerTurn ? '♟ Your move' : '⏳ Book is thinking…'}</span>`;
  } else if (mode === 'deviation') {
    bar.innerHTML = `
      <div class="mpb-btns">
        <span class="mpb-wrong">✗ ${data.played}${data.alts.length ? ` &rarr; <strong>${data.alts.join(' or ')}</strong>` : ''}</span>
        <button id="mpb-retry">↩ Retry</button>
        <button class="mpb-primary" id="mpb-course">Study</button>
      </div>`;
    document.getElementById('mpb-retry').addEventListener('click', () =>
      document.getElementById('retry-btn').click());
    document.getElementById('mpb-course').addEventListener('click', showPracticeLinesModal);
  } else if (mode === 'complete') {
    bar.innerHTML = `<span class="mpb-turn">✓ Line complete!</span>`;
    if (!state.practiceActive) setTimeout(() => { bar.style.display = 'none'; }, 3000);
  }
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
    const isPlayerTurn = turn === state.practiceColor;
    turnEl.textContent = isPlayerTurn ? 'Your move' : 'Book is thinking…';
    updateMobilePracticeBar('turn', { isPlayerTurn });
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

  const orientation = boardOrientation();
  const sqSize = bbox.width / 8;
  const col = Math.max(0, Math.min(7, Math.floor((clientX - bbox.left) / sqSize)));
  const row = Math.max(0, Math.min(7, Math.floor((clientY - bbox.top)  / sqSize)));

  const fileIdx = orientation === 'w' ? col : 7 - col;
  const rankIdx = orientation === 'w' ? row : 7 - row;
  return 'abcdefgh'[fileIdx] + (8 - rankIdx);
}

function startPieceDrag(clientX, clientY, sqName, pieceChar) {
  if (!pieceChar) return;

  // In practice only the player's own pieces move; in explore either side may.
  const chess = state.practiceActive ? state.practiceChess : ensureExploreSession();
  if (!chess) return;
  const pieceColor = pieceChar === pieceChar.toUpperCase() ? 'w' : 'b';
  const movable = state.practiceActive
    ? (chess.turn() === state.practiceColor && pieceColor === state.practiceColor)
    : pieceColor === chess.turn();
  if (!movable) return;

  drag.active    = true;
  drag.startSq   = sqName;
  drag.pieceChar = pieceChar;
  drag.startX    = clientX;
  drag.startY    = clientY;
  drag.moved     = false;
  drag.overSq    = null;

  // Select the piece (shows legal hints)
  state.selectedSq = sqName;
  const moves = chess.moves({ square: sqName, verbose: true });
  state.legalDests = moves.map(m => m.to);
  if (state.practiceActive) renderBoard(chess.fen(), lastPracticeFrom(), lastPracticeTo());
  else                      renderExploreBoard();

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
    if (state.practiceActive) submitUserMove(startSq, targetSq);
    else                      exploreMove(startSq, targetSq);
  } else if (state.practiceActive) {
    clearPracticeSelection();
  } else {
    clearExploreSelection();
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
    if (state.practiceActive) clearPracticeSelection();
    else                      clearExploreSelection();
  });
}
