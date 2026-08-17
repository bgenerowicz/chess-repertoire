// Shared test harness.
//
// app.js is a classic browser script: its top-level declarations are globals in a
// browser, but not exports. To test it under Deno we append an epilogue that
// re-exposes the wanted names on globalThis, then import the whole thing as a
// module. (Indirect eval does not work — the declarations end up in a scope the
// importing module cannot see.)
//
// Paths are resolved from import.meta.url, so the suites run from any directory.

const APP_URL   = new URL('../app.js', import.meta.url);
const INDEX_URL = new URL('../index.html', import.meta.url);
const CHESS_URL = new URL('./vendor/chess.min.js', import.meta.url);

/** Minimal stand-in for a DOM element — only what app.js actually touches. */
export class El {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this._html = '';
    this.disabled = false;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.title = '';
    this.handlers = {};
    this._classes = new Set();
    this.classList = {
      add:      c => this._classes.add(c),
      remove:   c => this._classes.delete(c),
      toggle:   (c, on) => on ? this._classes.add(c) : this._classes.delete(c),
      contains: c => this._classes.has(c),
    };
  }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  get innerHTML() { return this._html; }
  addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  appendChild(child) { this.children.push(child); return child; }
  querySelectorAll() { return []; }
  click() { (this.handlers.click || []).forEach(fn => fn({})); }
  /** Concatenated text of this element's children — handy for chips built from spans. */
  childText() { return this.children.map(c => c.textContent).join(' '); }
  // A 400x400 board at the viewport origin, for getSquareAtPoint.
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  }
}

/**
 * Loads app.js under a stubbed DOM with the real chess.js.
 *
 * @param {string[]} expose  names to pull out of app.js onto globalThis
 * @param {boolean}  fakeTimers  capture setTimeout callbacks instead of running them
 * @returns {{ getEl, els, flushTimers }}
 */
export async function loadApp(expose = [], { fakeTimers = false } = {}) {
  const els = new Map();
  const getEl = id => {
    if (!els.has(id)) els.set(id, new El(id));
    return els.get(id);
  };

  globalThis.document = {
    addEventListener() {},
    getElementById: getEl,
    querySelector: () => new El(),
    querySelectorAll: () => [],
    createElement: tag => { const el = new El(); el.tag = tag; return el; },
    body: new El('body'),
  };
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.indexedDB = { open: () => ({ addEventListener() {} }) };

  const pending = [];
  if (fakeTimers) {
    globalThis.setTimeout = fn => { pending.push(fn); return pending.length; };
  }

  // Real chess.js, not a stub: several code paths call chess.move before any
  // early return, so a dummy constructor is not enough.
  const chessSrc = await Deno.readTextFile(CHESS_URL);
  const chessMod = await importSource(
    `const exports = {}; const module = { exports };\n${chessSrc}\n` +
    `export const loaded = module.exports.Chess || exports.Chess;`
  );
  globalThis.Chess = chessMod.loaded;
  if (typeof globalThis.Chess !== 'function') {
    throw new Error('vendored chess.js failed to load');
  }

  const appSrc = await Deno.readTextFile(APP_URL);
  await importSource(appSrc + '\n' + expose.map(n => `globalThis.${n} = ${n};`).join('\n'));

  return { getEl, els, flushTimers: () => { while (pending.length) pending.shift()(); } };
}

/** Imports JS source without touching the filesystem. */
function importSource(source) {
  return import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`);
}

/** The chess.js version index.html pins on the CDN, so tests can check the vendored copy matches. */
export async function pinnedChessVersion() {
  const html = await Deno.readTextFile(INDEX_URL);
  return html.match(/chess\.js\/([\d.]+)\/chess\.min\.js/)?.[1] ?? null;
}

export function vendoredChessPath() { return CHESS_URL; }

/** Tiny assertion collector. */
export function createChecker(suiteName) {
  let failed = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  };
  const report = () => {
    console.log(failed === 0
      ? `\n${suiteName}: all checks passed.`
      : `\n${suiteName}: ${failed} check(s) failed.`);
    if (failed) Deno.exit(1);
  };
  return { check, report };
}

/** Registers a course from PGN text and returns its index. */
export function addCourse(app, name, orientation, pgn) {
  const lines = app.parseCourse(pgn);
  app.COURSES.push({ name, orientation, pgn, builtin: false });
  app.state.courseData.push({ lines, trie: app.buildTrie(lines) });
  return app.COURSES.length - 1;
}
