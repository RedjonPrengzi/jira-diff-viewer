'use strict';
/* DOM tests for content.js. Run from the project root: node test/dom.test.js
   Loads vendor/diff_match_patch_uncompressed.js, the real diff.js, then
   content.js, all via dom.window.eval. */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const TESTID = 'issue-history.ui.history-items.generic-history-item.history-item';

const doms = [];

function load(bodyHtml, opts) {
  opts = opts || {};
  const dom = new JSDOM(`<!doctype html><html${opts.lang ? ' lang="' + opts.lang + '"' : ''}><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    url: 'https://tenant.atlassian.net/browse/TEST-1'
  });
  doms.push(dom);
  const win = dom.window;
  const evalFile = (rel) => win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  evalFile('vendor/diff_match_patch_uncompressed.js');
  if (!opts.skipDiff) evalFile('diff.js');
  evalFile('content.js');
  return { win, doc: win.document, JDV: win.JDV, evalFile };
}

const item = (inner) => `<div data-testid="${TESTID}">${inner}</div>`;
const row = (oldT, newT, mid = '<span><svg></svg></span>') =>
  `<div class="valuerow"><div>${oldT}</div>${mid}<div>${newT}</div></div>`;
const label = (text) => `<div><span>${text}</span></div>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

async function main() {
  await test('row processed into unified diff', () => {
    const { doc } = load(item(label('Description') + row('The quick brown fox', 'The quick red fox')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.style.display, 'block');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    const kids = r.children;
    for (let i = 0; i < 3; i++) assert.strictEqual(kids[i].style.display, 'none');
    const rootEl = r.querySelector('.jdv-root');
    assert.strictEqual(rootEl.querySelector('.jdv-del').textContent, 'brown');
    assert.strictEqual(rootEl.querySelector('.jdv-add').textContent, 'red');
    assert.ok(rootEl.textContent.includes('The quick '));
    assert.ok(rootEl.textContent.includes(' fox'));
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('rescan and observer refire stay idempotent', async () => {
    const { doc, JDV } = load(item(row('aaa OLD bbb', 'aaa NEW bbb')));
    const r = doc.querySelector('.valuerow');
    JDV.scan(doc);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
    doc.body.appendChild(doc.createElement('div'));
    await sleep(80);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('toggle restores original view exactly', () => {
    const { doc } = load(item(
      `<div class="valuerow"><div style="display:inline">alpha old omega</div>` +
      `<span><svg></svg></span><div>alpha new omega</div></div>`));
    const r = doc.querySelector('.valuerow');
    const orig = [r.children[0], r.children[1], r.children[2]];
    const toggle = r.querySelector('.jdv-toggle');
    const rootEl = r.querySelector('.jdv-root');
    assert.strictEqual(toggle.textContent, 'Show original');
    toggle.click();
    assert.strictEqual(rootEl.style.display, 'none');
    assert.strictEqual(toggle.textContent, 'Show diff');
    assert.strictEqual(r.style.display, '');
    assert.strictEqual(orig[0].style.display, 'inline');
    assert.strictEqual(orig[1].style.display, '');
    assert.strictEqual(orig[2].style.display, '');
    assert.strictEqual(r.children[0], orig[0]);
    assert.strictEqual(r.children[1], orig[1]);
    assert.strictEqual(r.children[2], orig[2]);
    toggle.click();
    assert.strictEqual(rootEl.style.display, '');
    assert.strictEqual(toggle.textContent, 'Show original');
    for (const k of orig) assert.strictEqual(k.style.display, 'none');
    assert.strictEqual(r.style.display, 'block');
  });

  await test('long equal run collapses and expands on click', () => {
    const base = 'x'.repeat(650);
    const { doc } = load(item(row(base + ' BEFORE', base + ' AFTER')));
    const btn = doc.querySelector('.jdv-collapsed');
    assert.ok(btn, 'collapsed expander exists');
    // 'x'*650 + the shared space is one equal run of 651 chars
    assert.strictEqual(btn.textContent, '651 unchanged characters');
    btn.click();
    assert.strictEqual(doc.querySelector('.jdv-collapsed'), null);
    assert.ok(doc.querySelector('.jdv-root').textContent.includes(base));
  });

  await test('non-matching structures stay untouched', () => {
    const { doc } = load(
      item(`<div class="tworow"><div>OLD</div><div>NEW</div></div>`) +
      item(`<div class="longmid"><div>OLD</div><div>changed on 2026-11-23 by user</div><div>NEW</div></div>`) +
      // meta/header row: 3 children with a '·' separator must not diff as old/new
      item(`<div class="meta"><span>Summary</span><span>·</span><span>Max Muster</span></div>` + row('real OLD', 'real NEW')) +
      `<div class="outside"><div>OLD</div><span><svg></svg></span><div>NEW</div></div>`);
    assert.strictEqual(doc.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(doc.querySelectorAll('.jdv-toggle').length, 1);
    assert.strictEqual(doc.querySelectorAll('[data-diffed]').length, 1);
    const meta = doc.querySelector('.meta');
    assert.strictEqual(meta.hasAttribute('data-diffed'), false);
    assert.strictEqual(meta.querySelectorAll('.jdv-root, [data-diffed]').length, 0);
  });

  await test('identical old/new marks row with no highlights', () => {
    const { doc } = load(item(row('same text', 'same text')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.ok(r.querySelector('.jdv-root'));
    assert.strictEqual(r.querySelectorAll('.jdv-add, .jdv-del').length, 0);
    assert.strictEqual(r.querySelector('.jdv-root').textContent, 'same text');
  });

  await test('multiple value rows in one item processed independently', () => {
    const { doc } = load(item(
      label('Description') + row('first OLD', 'first NEW') +
      label('Fix versions') + row('v1', 'v2')));
    assert.strictEqual(doc.querySelectorAll('.jdv-root').length, 2);
    assert.strictEqual(doc.querySelectorAll('.jdv-toggle').length, 2);
    assert.strictEqual(doc.querySelectorAll('[data-diffed]').length, 2);
    const dels = [...doc.querySelectorAll('.jdv-del')].map((e) => e.textContent);
    const adds = [...doc.querySelectorAll('.jdv-add')].map((e) => e.textContent);
    assert.deepStrictEqual(dels.sort(), ['OLD', 'v1']);
    assert.deepStrictEqual(adds.sort(), ['NEW', 'v2']);
  });

  await test('whitespace-only change gets muted note', () => {
    const { doc } = load(item(row('a b', 'a  b')));
    const note = doc.querySelector('.jdv-note');
    assert.ok(note);
    assert.strictEqual(note.textContent, 'whitespace-only change');
    assert.strictEqual(doc.querySelector('.jdv-root').firstElementChild, note);
  });

  await test('observer processes lazily added history item', async () => {
    const { doc } = load('<div id="container"></div>');
    assert.strictEqual(doc.querySelectorAll('.jdv-root').length, 0);
    doc.getElementById('container').innerHTML =
      item(label('Description') + row('observer OLD', 'observer NEW'));
    await sleep(80);
    assert.strictEqual(doc.querySelectorAll('.jdv-root').length, 1);
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.ok(r.querySelector('.jdv-del'));
    assert.ok(r.querySelector('.jdv-add'));
  });

  await test('text-glyph arrow cell still qualifies', () => {
    const { doc } = load(item(row('text OLD', 'text NEW', '<span>→</span>')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
  });

  await test('empty leaf middle child qualifies (Jira Cloud draws the arrow via CSS)', () => {
    const { doc } = load(item(row('text OLD', 'text NEW', '<div class="_313842dnbC"></div>')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
  });

  await test('self-heal: React-replaced kids reprocess with new text', () => {
    const { doc, JDV } = load(item(row('first OLD text', 'first NEW text')));
    const r = doc.querySelector('.valuerow');
    const oldRoot = r.querySelector('.jdv-root');
    const swap = doc.createElement('div');
    swap.innerHTML =
      '<div>second OLD text</div><span><svg></svg></span><div>second NEW text</div>';
    const fresh = [...swap.children];
    for (const k of [r.children[0], r.children[1], r.children[2]]) k.remove();
    for (let i = fresh.length - 1; i >= 0; i--) r.insertBefore(fresh[i], r.firstChild);
    JDV.scan(doc);
    assert.strictEqual(oldRoot.isConnected, false);
    const roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].querySelector('.jdv-del').textContent, 'OLD');
    assert.strictEqual(roots[0].querySelector('.jdv-add').textContent, 'NEW');
    assert.ok(roots[0].textContent.includes('second'));
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('self-heal: a removed diff root is rebuilt on next scan', () => {
    const { doc, JDV } = load(item(row('heal OLD text', 'heal NEW text')));
    const r = doc.querySelector('.valuerow');
    const oldRoot = r.querySelector('.jdv-root');
    oldRoot.remove();
    JDV.scan(doc);
    const roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.notStrictEqual(roots[0], oldRoot);
    assert.strictEqual(roots[0].querySelector('.jdv-del').textContent, 'OLD');
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('characterData edit reprocesses the row via observer', async () => {
    const { doc } = load(item(row('drift OLD value', 'drift NEW value')));
    const r = doc.querySelector('.valuerow');
    const oldRoot = r.querySelector('.jdv-root');
    r.children[0].firstChild.nodeValue = 'drift EDITED value';
    await sleep(80);
    assert.strictEqual(oldRoot.isConnected, false);
    const roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].querySelector('.jdv-del').textContent, 'EDITED');
    assert.strictEqual(roots[0].querySelector('.jdv-add').textContent, 'NEW');
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('missing diff engine leaves row clean and retries later', () => {
    const { doc, JDV, evalFile } = load(item(
      '<div class="valuerow" style="display:flex">' +
      '<div style="display:inline">retry OLD</div>' +
      '<span style="display:inline-flex"><svg></svg></span>' +
      '<div>retry NEW</div></div>'), { skipDiff: true });
    const r = doc.querySelector('.valuerow');
    JDV.scan(doc);
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 0);
    assert.strictEqual(r.style.display, 'flex');
    assert.strictEqual(r.children[0].style.display, 'inline');
    assert.strictEqual(r.children[1].style.display, 'inline-flex');
    assert.strictEqual(r.children[2].style.display, '');
    evalFile('diff.js');
    JDV.scan(doc);
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    r.querySelector('.jdv-toggle').click();
    assert.strictEqual(r.style.display, 'flex');
    assert.strictEqual(r.children[0].style.display, 'inline');
    assert.strictEqual(r.children[1].style.display, 'inline-flex');
  });

  await test('direct repeated processRow is idempotent and ignores malformed rows', () => {
    const { doc, JDV } = load(item(
      '<div class="valuerow" style="display:flex">' +
      '<div style="display:inline">dup OLD</div>' +
      '<span><svg></svg></span><div>dup NEW</div></div>' +
      '<div class="short"><div>only one</div></div>'));
    const r = doc.querySelector('.valuerow');
    JDV.processRow(r);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
    r.querySelector('.jdv-toggle').click();
    assert.strictEqual(r.style.display, 'flex');
    assert.strictEqual(r.children[0].style.display, 'inline');

    const shortRow = doc.querySelector('.short');
    JDV.processRow(shortRow);
    assert.strictEqual(shortRow.hasAttribute('data-diffed'), false);
    assert.strictEqual(shortRow.querySelectorAll('.jdv-root').length, 0);
  });

  await test('nested empty wrapper middle child is not an arrow, role="img" is', () => {
    const { doc } = load(
      item(row('nest OLD', 'nest NEW', '<span><span></span></span>')) +
      item(row('br OLD', 'br NEW', '<div><br></div>')) +
      item(row('role OLD', 'role NEW', '<span role="img"></span>')));
    const rows = doc.querySelectorAll('.valuerow');
    assert.strictEqual(rows[0].hasAttribute('data-diffed'), false);
    assert.strictEqual(rows[1].hasAttribute('data-diffed'), false);
    assert.strictEqual(rows[2].getAttribute('data-diffed'), '1');
  });

  await test('self-heal: removed toggle button is rebuilt on next scan', () => {
    const { doc, JDV } = load(item(row('tog OLD', 'tog NEW')));
    const r = doc.querySelector('.valuerow');
    const oldToggle = r.querySelector('.jdv-toggle');
    oldToggle.remove();
    JDV.scan(doc);
    const toggles = r.querySelectorAll('.jdv-toggle');
    assert.strictEqual(toggles.length, 1);
    assert.notStrictEqual(toggles[0], oldToggle);
  });

  await test('self-heal: middle cell mutating to non-arrow rolls back cleanly', () => {
    const { doc, JDV } = load(item(
      '<div class="valuerow" style="display:flex">' +
      '<div style="display:inline">same</div>' +
      '<span><svg></svg></span><div>same</div></div>'));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    r.children[1].textContent = '·';
    JDV.scan(doc);
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
    assert.strictEqual(r.querySelectorAll('.jdv-root, .jdv-toggle').length, 0);
    assert.strictEqual(r.style.display, 'flex');
    assert.strictEqual(r.children[0].style.display, 'inline');
  });

  await test('HTML-like wiki text renders inertly without creating elements', () => {
    const { doc } = load(item(row(
      'plain &lt;script&gt;alert(1)&lt;/script&gt; text',
      'plain &lt;img src=x onerror=alert(2)&gt; text')));
    const rootEl = doc.querySelector('.jdv-root');
    assert.strictEqual(rootEl.querySelectorAll('script, img').length, 0);
    assert.ok(rootEl.textContent.includes('script'));
    assert.ok(rootEl.textContent.includes('onerror=alert(2)'));
  });

  await test('own UI clicks (expand/toggle) do not trigger observer rescans', async () => {
    const base = 'q'.repeat(650);
    const { doc, JDV } = load(item(row(base + ' OLD', base + ' NEW')));
    let scans = 0;
    const origScan = JDV.scan;
    JDV.scan = function (...args) {
      scans++;
      return origScan.apply(this, args);
    };
    doc.querySelector('.jdv-collapsed').click();
    doc.querySelector('.jdv-toggle').click();
    doc.querySelector('.jdv-toggle').click();
    await sleep(60);
    assert.strictEqual(scans, 0);
  });

  await test('nested candidates: only the outermost row wins', () => {
    const { doc } = load(item(
      '<div class="outer"><div class="outer-old">' +
        '<div class="inner">' +
          '<div>inner OLD</div><span><svg></svg></span><div>inner NEW</div>' +
        '</div>' +
      '</div><span><svg></svg></span><div class="outer-new">outer NEW text</div></div>'));
    const outer = doc.querySelector('.outer');
    const inner = doc.querySelector('.inner');
    assert.strictEqual(outer.getAttribute('data-diffed'), '1');
    assert.strictEqual(inner.hasAttribute('data-diffed'), false);
    assert.strictEqual(doc.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(doc.querySelector('.jdv-root').parentElement, outer);
    assert.strictEqual(doc.querySelectorAll('.jdv-toggle').length, 1);
    assert.strictEqual(inner.querySelectorAll('.jdv-root').length, 0);
  });

  await test('arrow cell with a11y-only text still qualifies', () => {
    const { doc } = load(
      item(row('t1 OLD', 't1 NEW', '<span><svg><title>Arrow right</title></svg></span>')) +
      item(row('t2 OLD', 't2 NEW', '<span><svg></svg><span aria-hidden="true">changes to</span></span>')) +
      item(row('t3 OLD', 't3 NEW', '<span><svg></svg><span class="visually-hidden">to</span></span>')) +
      item(row('t4 OLD', 't4 NEW', '<span><svg></svg><span class="jira-assistive">to</span></span>')));
    const rows = doc.querySelectorAll('.valuerow');
    assert.strictEqual(rows.length, 4);
    for (const r of rows) {
      assert.strictEqual(r.getAttribute('data-diffed'), '1');
      assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    }
  });

  await test('icon-font PUA glyph middle cell qualifies', () => {
    const mid = '<span>' + String.fromCharCode(0xE001) + '</span>';
    const { doc } = load(item(row('pua OLD', 'pua NEW', mid)));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
  });

  await test('icon cell with visible text is still rejected', () => {
    const { doc } = load(
      item(row('m1 OLD', 'm1 NEW', '<span><svg></svg>Summary</span>')) +
      item(row('m2 OLD', 'm2 NEW', '<span><i></i>Summary</span>')));
    const rows = doc.querySelectorAll('.valuerow');
    assert.strictEqual(rows.length, 2);
    for (const r of rows) {
      assert.strictEqual(r.hasAttribute('data-diffed'), false);
      assert.strictEqual(r.querySelectorAll('.jdv-root').length, 0);
    }
  });

  await test('display drift re-heals without double-render', () => {
    const { doc, JDV } = load(item(row('drift OLD value', 'drift NEW value')));
    const r = doc.querySelector('.valuerow');
    const kids = [r.children[0], r.children[1], r.children[2]];
    for (const k of kids) k.style.display = '';
    r.style.display = '';
    JDV.scan(doc);
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
    for (const k of kids) assert.strictEqual(k.style.display, 'none');
    assert.strictEqual(r.style.display, 'block');
  });

  await test('heal preserves the "Show original" view', () => {
    const { doc, JDV } = load(item(row('view OLD value', 'view NEW value')));
    const r = doc.querySelector('.valuerow');
    const kids = [r.children[0], r.children[1], r.children[2]];
    r.querySelector('.jdv-toggle').click();
    assert.strictEqual(r.querySelector('.jdv-toggle').textContent, 'Show diff');
    kids[0].firstChild.nodeValue = 'view EDITED value';
    JDV.scan(doc);
    const roots = r.querySelectorAll('.jdv-root');
    const toggles = r.querySelectorAll('.jdv-toggle');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(toggles.length, 1);
    assert.strictEqual(toggles[0].textContent, 'Show diff');
    assert.strictEqual(roots[0].style.display, 'none');
    assert.ok(roots[0].textContent.includes('EDITED'));
    for (const k of kids) assert.strictEqual(k.style.display, '');
  });

  await test('reparented kid gets its recorded display restored on heal', () => {
    const { doc, JDV } = load(item(
      '<div class="valuerow" style="display:flex">' +
      '<div style="display:inline">moved OLD</div>' +
      '<span><svg></svg></span><div>moved NEW</div></div>' +
      '<div class="elsewhere"></div>'));
    const r = doc.querySelector('.valuerow');
    const kid = r.children[0];
    doc.querySelector('.elsewhere').appendChild(kid);
    JDV.scan(doc);
    assert.strictEqual(kid.style.display, 'inline');
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
  });

  await test('identical values over threshold render as plain text', () => {
    const text = 'y'.repeat(700);
    const { doc } = load(item(row(text, text)));
    const rootEl = doc.querySelector('.jdv-root');
    assert.strictEqual(rootEl.textContent, text);
    assert.strictEqual(doc.querySelectorAll('.jdv-collapsed').length, 0);
    assert.strictEqual(doc.querySelectorAll('.jdv-add, .jdv-del').length, 0);
  });

  await test('processRow ignores rows with more than 3 children', () => {
    const { doc, JDV } = load(item(
      '<div class="four"><div>a OLD</div><span><svg></svg></span>' +
      '<div>b NEW</div><div>extra</div></div>'));
    const four = doc.querySelector('.four');
    JDV.processRow(four);
    assert.strictEqual(four.hasAttribute('data-diffed'), false);
    assert.strictEqual(four.querySelectorAll('.jdv-root, .jdv-toggle').length, 0);
  });

  await test('content.js re-evaluation keeps row state via JDV._rowState', () => {
    const { doc, JDV, evalFile } = load(item(row('reeval OLD value', 'reeval NEW value')));
    const r = doc.querySelector('.valuerow');
    assert.ok(JDV._rowState, 'rowState not exposed on JDV');
    assert.ok(JDV._rowState.get(r), 'no state recorded for processed row');
    evalFile('content.js');
    // Fresh closure, same WeakMap: a broken row still heals instead of
    // stranding hidden kids with unreachable state.
    r.querySelector('.jdv-root').remove();
    JDV.scan(doc);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
    assert.strictEqual(r.children[0].style.display, 'none');
  });

  await test('self-heal: cloned flagged row without state restores via data attrs', () => {
    const { doc, JDV } = load(item(
      '<div class="valuerow" style="display:flex">' +
      '<div style="display:inline">clone OLD</div>' +
      '<span><svg></svg></span><div>clone NEW</div></div>'));
    const r = doc.querySelector('.valuerow');
    const clone = r.cloneNode(true);
    r.parentElement.appendChild(clone);
    // The clone inherited flag, artifacts and the recorded displays, but no
    // WeakMap entry exists for it.
    assert.strictEqual(clone.getAttribute('data-jdv-kid-display'), '["inline","",""]');
    assert.strictEqual(clone.getAttribute('data-jdv-row-display'), 'flex');
    assert.strictEqual(JDV._rowState.has(clone), false);
    JDV.scan(doc);
    // Unprocessed via the data attrs, then re-processed cleanly.
    assert.strictEqual(clone.getAttribute('data-diffed'), '1');
    assert.strictEqual(clone.querySelectorAll('.jdv-root').length, 1);
    clone.querySelector('.jdv-toggle').click();
    // "Show original" must reveal the real kids, not a blank row.
    const kids = clone.children;
    assert.strictEqual(kids[0].style.display, 'inline');
    assert.strictEqual(kids[1].style.display, '');
    assert.strictEqual(kids[2].style.display, '');
    assert.strictEqual(clone.style.display, 'flex');
  });

  await test('self-heal: diff root reparented deeper inside the row is rebuilt', () => {
    const { doc, JDV } = load(item(row('deep OLD', 'deep NEW')));
    const r = doc.querySelector('.valuerow');
    const root = r.querySelector('.jdv-root');
    r.children[0].appendChild(root);
    JDV.scan(doc);
    assert.strictEqual(root.isConnected, false);
    const roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].parentElement, r);
    assert.ok(roots[0].textContent.includes('NEW'));
  });

  await test('self-heal: diff root reparented to a sibling is removed', () => {
    const { doc, JDV } = load(item(
      row('sib OLD', 'sib NEW') + '<div class="sibling"></div>'));
    const r = doc.querySelector('.valuerow');
    const stray = r.querySelector('.jdv-root');
    doc.querySelector('.sibling').appendChild(stray);
    JDV.scan(doc);
    assert.strictEqual(stray.isConnected, false);
    assert.strictEqual(doc.querySelector('.sibling').children.length, 0);
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('style attribute drift heals through the observer', async () => {
    const { doc } = load(item(row('obs OLD value', 'obs NEW value')));
    const r = doc.querySelector('.valuerow');
    const kid = r.children[0];
    kid.setAttribute('style', 'display:inline');
    await sleep(80);
    assert.strictEqual(kid.style.display, 'none');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
  });

  await test('observer watches style and flag attributes only', () => {
    const { win, JDV, evalFile } = load(item(row('attr OLD', 'attr NEW')));
    let args = null;
    const Orig = win.MutationObserver;
    win.MutationObserver = class extends Orig {
      observe(target, opts) { args = opts; super.observe(target, opts); }
    };
    evalFile('content.js');
    assert.ok(args && args.attributes === true);
    // args.attributeFilter was built inside the jsdom realm; spread it into
    // a local array before deepStrictEqual's prototype check.
    assert.deepStrictEqual([...args.attributeFilter].sort(),
      ['style', JDV.CONFIG.processedAttr].sort());
  });

  await test('root display drift heals in diff and original views', () => {
    const { doc, JDV } = load(item(row('rd OLD value', 'rd NEW value')));
    const r = doc.querySelector('.valuerow');
    // Diff view: a hidden root must be rebuilt shown.
    r.querySelector('.jdv-root').style.display = 'none';
    JDV.scan(doc);
    let roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].style.display, '');
    // Original view: a shown root must be rebuilt hidden.
    r.querySelector('.jdv-toggle').click();
    r.querySelector('.jdv-root').style.display = '';
    JDV.scan(doc);
    roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].style.display, 'none');
    assert.strictEqual(r.querySelector('.jdv-toggle').textContent, 'Show diff');
  });

  await test('emptied diff root heals on rescan', () => {
    const { doc, JDV } = load(item(row('empty OLD value', 'empty NEW value')));
    const r = doc.querySelector('.valuerow');
    const root = r.querySelector('.jdv-root');
    root.innerHTML = '';
    JDV.scan(doc);
    const roots = r.querySelectorAll('.jdv-root');
    assert.strictEqual(roots.length, 1);
    assert.notStrictEqual(roots[0], root);
    assert.ok(roots[0].querySelector('.jdv-add'));
  });

  await test('flag-stripped row is rolled back and re-processed', () => {
    const { doc, JDV } = load(item(row('strip OLD value', 'strip NEW value')));
    const r = doc.querySelector('.valuerow');
    const oldRoot = r.querySelector('.jdv-root');
    r.removeAttribute('data-diffed');
    JDV.scan(doc);
    // The orphan sweep removed the stale artifacts; the bare row qualified
    // again and was re-processed.
    assert.strictEqual(oldRoot.isConnected, false);
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
    assert.strictEqual(r.querySelectorAll('.jdv-toggle').length, 1);
    r.querySelector('.jdv-toggle').click();
    assert.strictEqual(r.children[0].style.display, '');
    assert.ok(r.children[0].textContent.includes('OLD'));
  });

  await test('decoy a11y class does not discount visible text', () => {
    const { doc } = load(item(row('na OLD', 'na NEW',
      '<span><svg></svg><span class="nonassistive-x">changes to</span></span>')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
    assert.strictEqual(r.querySelectorAll('.jdv-root, .jdv-toggle').length, 0);
  });

  await test('inline-hidden label in icon cell is discounted', () => {
    const { doc } = load(item(row('ih OLD', 'ih NEW',
      '<span><svg></svg><span style="display:none">changes to</span></span>')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.getAttribute('data-diffed'), '1');
    assert.strictEqual(r.querySelectorAll('.jdv-root').length, 1);
  });

  await test('processRow rejects a 3-child row without an arrow middle', () => {
    const { doc, JDV } = load(item(
      '<div class="notarrow"><div>a OLD</div><span>·</span><div>b NEW</div></div>'));
    const r = doc.querySelector('.notarrow');
    JDV.processRow(r);
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
    assert.strictEqual(r.querySelectorAll('.jdv-root, .jdv-toggle').length, 0);
    assert.strictEqual(r.children[0].style.display, '');
  });

  await test('empty old and new skip processing entirely', () => {
    const { doc } = load(item(row('', '')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.hasAttribute('data-diffed'), false);
    assert.strictEqual(r.querySelectorAll('.jdv-root, .jdv-toggle').length, 0);
    assert.strictEqual(r.children.length, 3);
  });

  await test('rendered ins/equal text reproduces the new value, del/equal the old', () => {
    const { doc } = load(item(row('alpha OLD omega', 'alpha NEW omega')));
    const rootEl = doc.querySelector('.jdv-root');
    const without = (sel) => {
      const c = rootEl.cloneNode(true);
      for (const d of c.querySelectorAll(sel)) d.remove();
      return c.textContent;
    };
    assert.strictEqual(without('.jdv-del'), 'alpha NEW omega');
    assert.strictEqual(without('.jdv-add'), 'alpha OLD omega');
  });


  await test('row gets positioning context and padding for the absolute toggle', () => {
    const { doc } = load(item(row('pos OLD value', 'pos NEW value')));
    const r = doc.querySelector('.valuerow');
    assert.strictEqual(r.style.position, 'relative');
    assert.strictEqual(r.style.paddingBottom, '34px');
    assert.strictEqual(r.getAttribute('data-jdv-row-position'), '');
    assert.strictEqual(r.getAttribute('data-jdv-row-padding'), '');
  });

  await test('german interface renders german UI strings', () => {
    const filler = 'x'.repeat(650);
    const { doc } = load(item(row(filler + ' BEFORE', filler + ' AFTER') + row('a  b', 'a b')), { lang: 'de' });
    const rows = doc.querySelectorAll('.valuerow');
    const toggle = rows[0].querySelector('.jdv-toggle');
    assert.strictEqual(toggle.textContent, 'Original anzeigen');
    assert.strictEqual(rows[0].querySelector('.jdv-collapsed').textContent, '651 unveränderte Zeichen');
    toggle.click();
    assert.strictEqual(toggle.textContent, 'Diff anzeigen');
    assert.strictEqual(rows[1].querySelector('.jdv-note').textContent, 'nur Leerzeichen geändert');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const d of doms) d.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(e && e.stack ? e.stack : e);
  process.exit(1);
});
