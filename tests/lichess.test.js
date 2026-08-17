// Lichess recent-games picker: ndjson parsing, labelling, and selection.
// No network — the fixture mirrors the documented shape of the export endpoint.

import { loadApp, createChecker } from './harness.js';

const { getEl } = await loadApp([
  'lichessPlayerColor', 'lichessOpponentName', 'lichessResult',
  'renderLichessGames', 'selectLichessGame', 'state',
]);

const app = globalThis;
const { check, report } = createChecker('lichess');

const fixture = [
  { id: 'a1', variant: 'standard', speed: 'blitz', createdAt: 1755000000000, winner: 'white',
    players: { white: { user: { name: 'MyName' }, rating: 1800 }, black: { user: { name: 'Rival' }, rating: 1790 } },
    opening: { name: 'Sicilian Defense: Najdorf' }, pgn: '[Event "Rated blitz"]\n\n1. e4 c5 2. Nf3 d6 *' },
  { id: 'a2', variant: 'standard', speed: 'bullet', createdAt: 1754900000000, winner: 'white',
    players: { white: { user: { name: 'Rival2' } }, black: { user: { name: 'myname' } } },
    opening: { name: 'French Defense' }, pgn: '[Event "Rated bullet"]\n\n1. e4 e6 *' },
  { id: 'a3', variant: 'standard', speed: 'rapid', createdAt: 1754800000000,
    players: { white: { user: { name: 'MyName' } }, black: { aiLevel: 3 } },
    pgn: '[Event "vs AI"]\n\n1. d4 d5 *' },                                     // draw, AI opponent, no opening
  { id: 'a4', variant: 'crazyhouse', speed: 'blitz', createdAt: 1754700000000, winner: 'black',
    players: { white: { user: { name: 'MyName' } }, black: { user: { name: 'Zh' } } },
    pgn: '[Event "Crazyhouse"]\n\n1. e4 *' },                                   // must be filtered out
  { id: 'a5', variant: 'standard', speed: 'blitz', createdAt: 1754600000000, winner: 'black',
    players: { white: { user: { name: 'MyName' } }, black: { user: { name: 'Anon<script>' } } },
    pgn: '[Event "esc"]\n\n1. c4 *' },                                          // name needs escaping
];

// Mirror of the parse/filter step inside fetchLichessGames
const ndjson = fixture.map(g => JSON.stringify(g)).join('\n') + '\n';
const parsed = ndjson.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
  .filter(g => g.variant === 'standard' && g.pgn);

check('variant filter drops crazyhouse', parsed.map(g => g.id), ['a1', 'a2', 'a3', 'a5']);

check('color: user is white',                 app.lichessPlayerColor(fixture[0], 'MyName'), 'white');
check('color: case-insensitive match, black', app.lichessPlayerColor(fixture[1], 'MyName'), 'black');
check('color: no match returns null',         app.lichessPlayerColor(fixture[0], 'Someone'), null);

check('opponent: normal', app.lichessOpponentName(fixture[0], 'white'), 'Rival');
check('opponent: AI',     app.lichessOpponentName(fixture[2], 'white'), 'Stockfish level 3');

check('result: win',  app.lichessResult(fixture[0], 'white'), { text: 'W', cls: 'lg-win' });
check('result: loss', app.lichessResult(fixture[0], 'black'), { text: 'L', cls: 'lg-loss' });
check('result: draw', app.lichessResult(fixture[2], 'white'), { text: '½', cls: 'lg-draw' });
check('result: unknown color falls back to score',
      app.lichessResult(fixture[0], null), { text: '1-0', cls: 'lg-draw' });

// ── Rendering ──
app.renderLichessGames(parsed, 'MyName');
const rows = getEl('lichess-games').children;
check('renders one row per game', rows.length, 4);
check('stores games on state', app.state.lichessGames.length, 4);

const html = rows.map(r => r.innerHTML).join('\n');
check('win row marked', html.includes('lg-win'), true);
check('AI opponent shown', html.includes('Stockfish level 3'), true);
check('black games show black pawn glyph', rows[1].innerHTML.includes('♟'), true);
check('opening shown when present', rows[0].innerHTML.includes('Sicilian Defense: Najdorf'), true);
check('no trailing separator when opening missing', rows[2].innerHTML.includes('· ·'), false);
check('opponent name is escaped', rows[3].innerHTML.includes('&lt;script&gt;'), true);
check('raw script tag not emitted', rows[3].innerHTML.includes('<script>'), false);

// Selecting a game fills the textarea and runs handleAnalyze. handleAnalyze is
// module-scoped so it can't be stubbed; assert on its observable side effect
// instead — with no course loaded it writes a message to #upload-error.
getEl('upload-error').textContent = '';
app.selectLichessGame(1);
check('selection fills pgn-input', getEl('pgn-input').value, fixture[1].pgn);
check('selection triggers analyze', getEl('upload-error').textContent,
      'Course is still loading, please wait.');

// ── Empty result set ──
app.renderLichessGames([], 'MyName');
check('empty state rendered', getEl('lichess-games').children[0].textContent,
      'No standard games found for this user.');

report();
