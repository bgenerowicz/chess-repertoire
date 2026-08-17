// Keeps the vendored chess.js honest: it must be the same version index.html
// loads from the CDN, and must not have been altered.

import { createChecker, pinnedChessVersion } from './harness.js';

const { check, report } = createChecker('vendor');

const provenance = JSON.parse(
  await Deno.readTextFile(new URL('./vendor/provenance.json', import.meta.url)));

check('index.html pins the vendored version', await pinnedChessVersion(), provenance.version);

const bytes = await Deno.readFile(new URL('./vendor/chess.min.js', import.meta.url));
const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
check('vendored file matches its recorded checksum', digest, provenance.sha256);

report();
