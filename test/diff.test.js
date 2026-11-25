'use strict';

const assert = require('node:assert');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Load order per contract: vendor exports via top-level `this` binding,
// which under CommonJS lands on module.exports.
const dmpModule = require(path.join(root, 'vendor', 'diff_match_patch_uncompressed.js'));
globalThis.diff_match_patch = dmpModule.diff_match_patch;
globalThis.DIFF_DELETE = dmpModule.DIFF_DELETE;
globalThis.DIFF_INSERT = dmpModule.DIFF_INSERT;
globalThis.DIFF_EQUAL = dmpModule.DIFF_EQUAL;

require(path.join(root, 'diff.js'));

const JDV = globalThis.JDV;
assert.ok(JDV, 'diff.js did not populate globalThis.JDV');
assert.strictEqual(JDV.COLLAPSE_THRESHOLD, 300);
assert.strictEqual(typeof JDV.buildSegments, 'function');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

const types = (segs) => segs.map((s) => s.type);
const textsOfType = (segs, type) =>
  segs.filter((s) => s.type === type).map((s) => s.text).join('');

test('one-word substitution produces del and ins segments', () => {
  const segs = JDV.buildSegments('within 2 seconds', 'within 5 seconds');
  const delText = textsOfType(segs, 'del');
  const insText = textsOfType(segs, 'ins');
  assert.ok(delText.includes('2'), `expected del to contain '2', got '${delText}'`);
  assert.ok(insText.includes('5'), `expected ins to contain '5', got '${insText}'`);
});

test('appended block at end of long text produces ins segment', () => {
  const base = 'line one\nline two\nline three\nline four\nline five\nline six';
  const appended = '\n\n[~accountid:123] added a note';
  const segs = JDV.buildSegments(base, base + appended);
  const insText = textsOfType(segs, 'ins');
  assert.ok(insText.includes('added a note'), `expected ins to contain appended text, got '${insText}'`);
});

test('mid-text change produces del and ins segments', () => {
  const oldText = 'alpha beta gamma delta epsilon zeta eta theta';
  const newText = 'alpha beta GAMMA delta epsilon zeta eta theta';
  const segs = JDV.buildSegments(oldText, newText);
  const delText = textsOfType(segs, 'del');
  const insText = textsOfType(segs, 'ins');
  assert.ok(delText.length > 0, 'expected a del segment');
  assert.ok(insText.length > 0, 'expected an ins segment');
  assert.ok(!delText.includes('alpha'), 'del should not contain unchanged prefix');
});

test('identical strings produce no ins/del segments', () => {
  const segs = JDV.buildSegments('same text', 'same text');
  assert.ok(!types(segs).includes('ins'), 'unexpected ins segment');
  assert.ok(!types(segs).includes('del'), 'unexpected del segment');
  assert.ok(!types(segs).includes('collapsed'), 'unexpected collapsed segment');
});

test('equal run longer than 300 chars becomes collapsed with full text', () => {
  const filler = 'x'.repeat(400);
  const oldText = filler + ' old tail';
  const newText = filler + ' new tail';
  const segs = JDV.buildSegments(oldText, newText);
  const collapsed = segs.filter((s) => s.type === 'collapsed');
  assert.strictEqual(collapsed.length, 1, `expected 1 collapsed segment, got ${collapsed.length}`);
  assert.ok(collapsed[0].text.startsWith(filler), 'collapsed segment must keep the full original run');
  assert.ok(collapsed[0].text.length > JDV.COLLAPSE_THRESHOLD);
});

test('equal run of 300 chars or less stays equal', () => {
  const filler = 'y '.repeat(150);
  const segs = JDV.buildSegments(filler + 'a', filler + 'b');
  assert.ok(!types(segs).includes('collapsed'), '300-char equal run must not collapse');
  const eq = segs.filter((s) => s.type === 'equal');
  assert.ok(eq.some((s) => s.text === filler), 'expected equal segment with the 300-char run');
});

test('empty to nonempty produces ins segment', () => {
  const segs = JDV.buildSegments('', 'hello world');
  const insText = textsOfType(segs, 'ins');
  assert.ok(insText.includes('hello world'), `expected ins to contain full text, got '${insText}'`);
});

test('nonempty to empty produces del segment', () => {
  const segs = JDV.buildSegments('hello world', '');
  const delText = textsOfType(segs, 'del');
  assert.ok(delText.includes('hello world'), `expected del to contain full text, got '${delText}'`);
});

test('null and undefined inputs are treated as empty strings', () => {
  const segs = JDV.buildSegments(null, undefined);
  assert.deepStrictEqual(segs, []);
});

test('wiki markup tokens diff as plain text without crashing', () => {
  const oldText = 'Assigned to [~accountid:123] with !image.png! attached';
  const newText = 'Assigned to [~accountid:456] with !screenshot.png! attached';
  const segs = JDV.buildSegments(oldText, newText);
  assert.ok(Array.isArray(segs) && segs.length > 0, 'expected non-empty segments');
  const delText = textsOfType(segs, 'del');
  const insText = textsOfType(segs, 'ins');
  assert.ok(delText.includes('123') && insText.includes('456'),
    `expected '123' deleted and '456' inserted, got del='${delText}' ins='${insText}'`);
  // All segment text must be plain strings; concatenation of ins+equal+collapsed must equal new text minus dels ordering check skipped.
  for (const s of segs) {
    assert.strictEqual(typeof s.text, 'string');
    assert.ok(['del', 'ins', 'equal', 'collapsed'].includes(s.type));
  }
});

test('NaN threshold falls back to default collapse threshold', () => {
  const filler = 'z'.repeat(350);
  const segs = JDV.buildSegments(filler + ' old', filler + ' new', NaN);
  assert.strictEqual(segs.filter((s) => s.type === 'collapsed').length, 1);
});

test('missing global DIFF_DELETE/DIFF_INSERT falls back to numeric op codes', () => {
  const savedDel = globalThis.DIFF_DELETE;
  const savedIns = globalThis.DIFF_INSERT;
  try {
    delete globalThis.DIFF_DELETE;
    delete globalThis.DIFF_INSERT;
    const segs = JDV.buildSegments('hello old', 'hello new');
    assert.ok(textsOfType(segs, 'del').includes('old'));
    assert.ok(textsOfType(segs, 'ins').includes('new'));
  } finally {
    globalThis.DIFF_DELETE = savedDel;
    globalThis.DIFF_INSERT = savedIns;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
