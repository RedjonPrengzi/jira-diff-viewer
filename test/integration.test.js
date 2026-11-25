'use strict';
/* Integration test: real diff.js + content.js over the fixture DOM via jsdom.
   Run from the project root: node test/integration.test.js */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'test', 'fixture.html'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://tenant.atlassian.net/browse/TEST-1'
});
const win = dom.window;
const doc = win.document;
const evalFile = (rel) => win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
evalFile('vendor/diff_match_patch_uncompressed.js');
evalFile('diff.js');
evalFile('content.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

const cases = [...doc.querySelectorAll('.jdv-case')];
const roots = () => doc.querySelectorAll('.jdv-root');

test('seven matching rows processed, two non-matching untouched', () => {
  // cases 1-5, 8 and 9 carry the data-testid; cases 6-7 must stay untouched.
  assert.strictEqual(roots().length, 7);
  assert.strictEqual(doc.querySelectorAll('[data-diffed]').length, 7);
});

test('case 1: one-word change highlights exactly the changed word', () => {
  const root = cases[0].querySelector('.jdv-root');
  assert.strictEqual(root.querySelector('.jdv-del').textContent, '2');
  assert.strictEqual(root.querySelector('.jdv-add').textContent, '5');
  assert.ok(root.textContent.includes('respond within '));
});

test('case 2: long unchanged run collapses, appended link in green', () => {
  const root = cases[1].querySelector('.jdv-root');
  const btn = root.querySelector('.jdv-collapsed');
  assert.ok(btn, 'expander present');
  assert.ok(/^\d{3,} unchanged characters$/.test(btn.textContent));
  const add = root.querySelector('.jdv-add');
  assert.ok(add.textContent.includes('INC-7781'));
  assert.strictEqual(root.querySelector('.jdv-del'), null);
});

test('case 3: mid-text swap produces del and ins', () => {
  const root = cases[2].querySelector('.jdv-root');
  // word-level diff: 'quarterly' and 'monthly' differ, so whole words highlight
  assert.strictEqual(root.querySelector('.jdv-del').textContent, 'quarterly');
  assert.strictEqual(root.querySelector('.jdv-add').textContent, 'monthly');
  assert.ok(root.textContent.includes(' capacity report'));
});

test('case 4: identical values produce no highlights', () => {
  const root = cases[3].querySelector('.jdv-root');
  assert.strictEqual(root.querySelectorAll('.jdv-add, .jdv-del').length, 0);
});

test('case 5: whitespace-only change gets the note', () => {
  const root = cases[4].querySelector('.jdv-root');
  assert.ok(root.querySelector('.jdv-note'));
});

test('case 7: 3-child row outside a history item is untouched', () => {
  assert.strictEqual(cases[6].querySelectorAll('.jdv-root, [data-diffed]').length, 0);
});

test('case 8: German label processed identically', () => {
  const root = cases[7].querySelector('.jdv-root');
  assert.strictEqual(root.querySelector('.jdv-del').textContent, '30');
  assert.strictEqual(root.querySelector('.jdv-add').textContent, '15');
});

test('case 9: real Jira Cloud markup with CSS-drawn arrow is diffed', () => {
  const row = cases[8].querySelector('[data-diffed]');
  assert.ok(row, 'values row processed');
  assert.strictEqual(row.children.length, 5);
  const root = row.querySelector('.jdv-root');
  assert.strictEqual(root.querySelector('.jdv-del').textContent, 'draft');
  assert.strictEqual(root.querySelector('.jdv-add').textContent, 'final');
});

test('toggle restores original children on every processed row', () => {
  const rows = doc.querySelectorAll('[data-diffed]');
  assert.strictEqual(rows.length, 7);
  for (const r of rows) {
    const orig = [r.children[0], r.children[1], r.children[2]];
    r.querySelector('.jdv-toggle').click();
    for (const k of orig) assert.strictEqual(k.style.display, '');
    assert.strictEqual(r.querySelector('.jdv-root').style.display, 'none');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
dom.window.close();
process.exit(failed ? 1 : 0);
