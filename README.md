# Chess Repertoire Trainer

A browser-based chess opening repertoire tool. Upload PGN files, study your lines, and drill them in practice mode — all locally in your browser with no account or server required.

## Features

- **Upload PGN courses** — import one or more PGN files as named repertoire courses
- **Study mode** — step through every line in a course with the board and move comments
- **Game analysis** — paste a PGN game to see where you deviated from your repertoire
- **Practice mode** — play your lines against the computer; select multiple courses to drill them together
- **Persistent storage** — courses are saved in your browser's IndexedDB and restored on reload
- **Local by default** — no server, no account; your courses are stored in your browser and never uploaded. The only outbound requests are the chess.js CDN script and, if you use it, the optional Lichess game import

## Usage

Open `index.html` in any modern browser, or visit the hosted version at:
**https://bgenerowicz.github.io/chess-repertoire**

### Adding a course

1. Click the **+** button in the header
2. Give the course a name and choose which colour you are playing
3. Select a PGN file and click **Add Course**

### Practice mode

1. Go to the **Practice** tab in the left panel
2. Check one or more courses (all must be the same colour)
3. Click **Start** — the computer plays the opponent's moves, you play yours
4. A deviation ends the line and shows you the correct move

### Game analysis

Paste a game PGN into the text area on the left and click **Analyze** to see which moves matched your repertoire and where you went off-book.

## Running locally

No build step needed. Just open `index.html` directly in a browser, or serve the folder with any static file server:

```bash
npx serve .
# or
python3 -m http.server
```

## Tests

The logic (repertoire matching, explore mode, practice, board orientation, Lichess parsing) has a test suite that runs without a browser or network. It needs [Deno](https://deno.land):

```bash
./tests/run.sh          # all suites
./tests/run.sh explore  # only suites matching "explore"
./tests/run.sh -v       # print every assertion
```

## Contributing

Bug reports and feature suggestions are welcome via [GitHub Issues](https://github.com/bgenerowicz/chess-repertoire/issues).
Pull requests are also welcome — please open an issue first to discuss larger changes.

## Tech stack

Plain HTML, CSS, and vanilla JavaScript. No frameworks, no build tools.
Chess logic uses [chess.js](https://github.com/jhlywa/chess.js), loaded from a CDN — the
only runtime dependency, so the page needs network access on first load.

## License

MIT — see [LICENSE](LICENSE).
