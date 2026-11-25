/* Jira diff viewer - content script.
   Replaces Jira history old/arrow/new rows with a unified inline diff.
   Merges into globalThis.JDV alongside diff.js. No chrome.* APIs so the
   same file runs under jsdom via window.eval. */
(function () {
  'use strict';

  const JDV = globalThis.JDV = globalThis.JDV || {};

  const CONFIG = JDV.CONFIG = {
    historyItemSelector:
      '[data-testid="issue-history.ui.history-items.generic-history-item.history-item"]',
    // An arrow cell is an icon cell when it is or contains one of these.
    iconSelector: 'svg,img,canvas,[role="img"]',
    // a11y-only subtrees inside an icon cell: svg <title>/<desc>, [hidden],
    // aria-hidden="true". Assistive class names are matched per-token in
    // visibleText - substring matching would accept decoys like
    // 'nonassistive-x'.
    a11yTextSelector: 'svg,[hidden],[aria-hidden="true"]',
    valueRowChildCount: 3,
    collapseThreshold: JDV.COLLAPSE_THRESHOLD != null ? JDV.COLLAPSE_THRESHOLD : 300,
    processedAttr: 'data-diffed',
    debounceMs: 10,
    // A middle cell with text is an arrow only if it consists of arrow-ish
    // glyphs AND contains a real arrow or icon-font (PUA) character;
    // '·', '-', '—' and words fail.
        arrowPattern: /^(?=.*[><→⟵⟶⇐⇒➜⟸⟹\uE000-\uF8FF])[\-=><→⟵⟶⇐⇒➜⟸⟹\s\uE000-\uF8FF]+$/,
    classes: {
      root: 'jdv-root',
      add: 'jdv-add',
      del: 'jdv-del',
      collapsed: 'jdv-collapsed',
      toggle: 'jdv-toggle',
      note: 'jdv-note'
    }
  };

  const CLS = CONFIG.classes;
  // Every element we append under a row (diff root + view toggle).
  CONFIG.ownSelector = '.' + CLS.root + ', .' + CLS.toggle;
  const OWN_SELECTOR = CONFIG.ownSelector;
  // A class token is a11y-only when it equals one of these or carries it as
  // a hyphenated part: 'jira-assistive' qualifies, 'nonassistive-x' does
  // not. A hashed Atlaskit class with no signal word stays undetectable;
  // it fails silent.
  const A11Y_CLASS_RE = /(^|-)(a11y|assistive|sr-only|visually-hidden)(-|$)/;
  // Per-row view state; keyed by element so originals can be restored exactly.
  // Kept on JDV so a content.js re-evaluation does not strand hidden rows.
  const rowState = JDV._rowState = JDV._rowState || new WeakMap();

  // The arrow cell is either an icon cell with no visible text (svg/img/canvas
  // or role="img" inside it, or itself one), an empty leaf element (Jira Cloud
  // draws the arrow with CSS on a childless div), or a short run of arrow
  // glyphs per CONFIG.arrowPattern. Icon cells may carry a11y text - svg
  // <title>/<desc>, aria-hidden or visually-hidden spans - that does not count
  // as visible. Anything else - a '·' separator, a word, an empty wrapper with
  // children - is not an arrow, so the element is not a values row (e.g.
  // 'Summary · Max Muster' meta lines).
  function isArrowCell(el) {
    const hasIcon = el.matches(CONFIG.iconSelector) ||
                    el.querySelector(CONFIG.iconSelector) !== null;
    const text = (hasIcon ? visibleText(el) : el.textContent || '').trim();
    if (text === '') return hasIcon || el.children.length === 0;
    return CONFIG.arrowPattern.test(text);
  }

  // textContent minus a11y-only and inline-hidden subtrees: what a sighted
  // user sees in the cell.
  function visibleText(el) {
    if (el.nodeType === 3) return el.nodeValue;
    if (el.nodeType !== 1 || el.matches(CONFIG.a11yTextSelector)) return '';
    if (el.style && (el.style.display === 'none' ||
                     el.style.visibility === 'hidden')) return '';
    for (const cls of el.classList) {
      if (A11Y_CLASS_RE.test(cls)) return '';
    }
    let text = '';
    for (const node of el.childNodes) text += visibleText(node);
    return text;
  }

  function isValueRow(el) {
    const kids = el.children;
    return kids.length === CONFIG.valueRowChildCount && isArrowCell(kids[1]);
  }

  // Top-down candidate walk: skips already-processed subtrees and stops
  // descending at the outermost value-row match. Positional only: never match
  // field labels or text, the Jira UI language varies per user.
  function findCandidates(container, out) {
    for (const el of container.children) {
      if (el.hasAttribute(CONFIG.processedAttr)) continue;
      if (isValueRow(el)) {
        out.push(el);
        continue;
      }
      findCandidates(el, out);
    }
  }

  function scanItem(item) {
    // Revalidate rows flagged earlier: React may have replaced their kids,
    // dropped our diff root or toggle, or edited text inside kept nodes.
    // Anything broken is rolled back so the candidate pass below can redo it.
    const processed = item.querySelectorAll('[' + CONFIG.processedAttr + ']');
    const wasOriginal = [];
    for (const el of processed) {
      if (!isRowBroken(el)) continue;
      // unprocessRow drops the state; remember "Show original" rows so they
      // can be toggled back after the candidate pass re-processes them.
      const state = rowState.get(el);
      if (state && !state.showingDiff) wasOriginal.push(el);
      unprocessRow(el);
    }
    // Orphaned artifacts: a row that lost its flag but kept .jdv- nodes can
    // never be revalidated (not in `processed`, and the extra children fail
    // isValueRow). Roll back the carrier of each stray artifact; if the bare
    // row still qualifies, the candidate pass below re-processes it.
    for (const el of item.querySelectorAll(OWN_SELECTOR)) {
      const carrier = el.parentElement;
      if (carrier && carrier.hasAttribute(CONFIG.processedAttr)) continue;
      if (!carrier || carrier === item) el.remove();
      else unprocessRow(carrier);
    }
    const candidates = [];
    findCandidates(item, candidates);
    for (const row of candidates) {
      if (row.hasAttribute(CONFIG.processedAttr)) continue;
      try {
        JDV.processRow(row);
      } catch (e) {
        // fail silent: a failed row must look like the extension is not installed
        unprocessRow(row);
      }
    }
    for (const row of wasOriginal) {
      if (row.hasAttribute(CONFIG.processedAttr)) toggleView(row);
    }
  }

  // A flagged row is broken when our recorded state is gone, our artifacts
  // left the row, extra siblings appeared, React swapped one of the three
  // kids, the middle cell stopped looking like an arrow, or text drifted.
  function isRowBroken(row) {
    const state = rowState.get(row);
    if (!state || !state.root || state.root.parentElement !== row ||
        !state.toggle || state.toggle.parentElement !== row) {
      return true;
    }
    // An emptied root renders as a blank box when shown.
    if (state.root.childNodes.length === 0) return true;
    const kids = state.kids;
    if (row.children.length !== kids.length + 2) return true;
    for (const k of kids) {
      if (k.parentElement !== row) return true;
    }
    // Extension-owned display state must not drift: a Jira re-render or stray
    // style write would otherwise leave the row double-rendered or hidden.
    if (state.showingDiff) {
      if (row.style.display !== 'block') return true;
      if (state.root.style.display !== '') return true;
      for (const k of kids) {
        if (k.style.display !== 'none') return true;
      }
    } else {
      if (row.style.display !== state.rowDisplay) return true;
      if (state.root.style.display !== 'none') return true;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].style.display !== state.childDisplay[i]) return true;
      }
    }
    if (!isArrowCell(kids[1])) return true;
    return kids[0].textContent !== state.oldText ||
           kids[2].textContent !== state.newText;
  }

  JDV.scan = function (root) {
    root = root || document;
    const items = [];
    if (root.nodeType === 1 && typeof root.matches === 'function' &&
        root.matches(CONFIG.historyItemSelector)) {
      items.push(root);
    }
    if (typeof root.querySelectorAll === 'function') {
      const found = root.querySelectorAll(CONFIG.historyItemSelector);
      for (let i = 0; i < found.length; i++) items.push(found[i]);
    }
    for (const item of items) scanItem(item);
  };

  JDV.processRow = function (row) {
    if (!row || row.hasAttribute(CONFIG.processedAttr)) return;
    if (row.children.length !== CONFIG.valueRowChildCount) return;
    // The public API enforces the same contract as detection.
    if (!isArrowCell(row.children[1])) return;

    // Compute the diff and build replacement nodes before mutating the row so
    // any error (e.g. missing diff engine) leaves Jira's DOM untouched.
    const doc = row.ownerDocument;
    const kids = [row.children[0], row.children[1], row.children[2]];
    const oldText = kids[0].textContent;
    const newText = kids[2].textContent;
    // Nothing to diff; an empty root plus toggle would be noise.
    if (oldText === '' && newText === '') return;
    const segs = JDV.buildSegments(oldText, newText, CONFIG.collapseThreshold);

    const rootEl = doc.createElement('div');
    rootEl.className = CLS.root;
    renderWhitespaceNote(segs, rootEl, doc);
    for (const seg of segs) renderSegment(seg, rootEl, doc);

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = CLS.toggle;
    toggle.textContent = 'Show original';
    toggle.addEventListener('click', () => toggleView(row));

    // Record inline displays before hiding so the toggle and rollback restore
    // exactly. Original children stay in the DOM untouched; Jira's React holds
    // references to these nodes. The texts let later scans detect drift.
    // A row still carrying .jdv- artifacts is a stateless survivor: its kids
    // are already hidden, so a 'none' read here is our own hiding - record ''.
    const hasArtifacts = row.querySelector(OWN_SELECTOR) !== null;
    const state = {
      kids: kids,
      childDisplay: kids.map(k => hasArtifacts && k.style.display === 'none'
        ? '' : k.style.display),
      rowDisplay: row.style.display,
      oldText: oldText,
      newText: newText,
      root: rootEl,
      toggle: toggle,
      showingDiff: true
    };
    rowState.set(row, state);

    row.setAttribute(CONFIG.processedAttr, '1');
    // Mirrors of the recorded displays on the DOM: they survive cloneNode and
    // innerHTML round-trips that strand the WeakMap entry, letting
    // unprocessRow restore exactly even with no state.
    row.setAttribute('data-jdv-kid-display', JSON.stringify(state.childDisplay));
    row.setAttribute('data-jdv-row-display', state.rowDisplay);
    kids.forEach(k => { k.style.display = 'none'; });
    row.style.display = 'block';
    row.appendChild(rootEl);
    row.appendChild(toggle);
  };

  // Full rollback of processRow: restores recorded inline displays, drops our
  // artifacts, and clears the flag so a later scan can redo the row.
  // Displays are read from rowState, then the data attributes processRow
  // mirrors them into - a row's DOM can outlive its WeakMap entry via
  // cloneNode or an ancestor innerHTML round-trip - and failing both, only
  // when our artifacts prove we touched the row, every non-artifact child
  // stuck at display:none is unhidden.
  function unprocessRow(row) {
    const state = rowState.get(row);
    if (state) {
      // Restore every recorded kid, even a reparented one: a moved kid must
      // not stay display:none (same restore as toggleView).
      for (let i = 0; i < state.kids.length; i++) {
        state.kids[i].style.display = state.childDisplay[i];
      }
      row.style.display = state.rowDisplay;
      // remove() works wherever the node ended up, including a sibling.
      if (state.root) state.root.remove();
      if (state.toggle) state.toggle.remove();
    } else {
      const origKids = [];
      for (const child of row.children) {
        if (!child.matches(OWN_SELECTOR)) origKids.push(child);
      }
      let displays = null;
      try {
        displays = JSON.parse(row.getAttribute('data-jdv-kid-display'));
      } catch (e) { /* malformed: fall through to the heuristic */ }
      if (Array.isArray(displays)) {
        for (let i = 0; i < origKids.length && i < displays.length; i++) {
          origKids[i].style.display = displays[i];
        }
        row.style.display = row.getAttribute('data-jdv-row-display') || '';
      } else if (row.querySelector(OWN_SELECTOR)) {
        for (const k of origKids) {
          if (k.style.display === 'none') k.style.display = '';
        }
      }
    }
    // Sweep artifacts at any depth: a reparented .jdv- node keeps rendering
    // a stale diff otherwise.
    for (const el of row.querySelectorAll(OWN_SELECTOR)) el.remove();
    row.removeAttribute(CONFIG.processedAttr);
    row.removeAttribute('data-jdv-kid-display');
    row.removeAttribute('data-jdv-row-display');
    rowState.delete(row);
  }

  function renderWhitespaceNote(segs, rootEl, doc) {
    let hasChange = false;
    let allWhitespace = true;
    for (const seg of segs) {
      if (seg.type === 'ins' || seg.type === 'del') {
        hasChange = true;
        if ((seg.text || '').trim() !== '') {
          allWhitespace = false;
          break;
        }
      }
    }
    if (hasChange && allWhitespace) {
      const note = doc.createElement('span');
      note.className = CLS.note;
      note.textContent = 'whitespace-only change';
      rootEl.appendChild(note);
    }
  }

  function renderSegment(seg, rootEl, doc) {
    if (seg.type === 'ins' || seg.type === 'del') {
      const span = doc.createElement('span');
      span.className = seg.type === 'ins' ? CLS.add : CLS.del;
      span.textContent = seg.text;
      rootEl.appendChild(span);
    } else if (seg.type === 'collapsed') {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = CLS.collapsed;
      btn.textContent = seg.text.length + ' unchanged characters';
      const text = seg.text;
      btn.addEventListener('click', () => {
        btn.replaceWith(doc.createTextNode(text));
      });
      rootEl.appendChild(btn);
    } else {
      rootEl.appendChild(doc.createTextNode(seg.text));
    }
  }

  function toggleView(row) {
    const state = rowState.get(row);
    if (!state) return;
    if (state.showingDiff) {
      state.root.style.display = 'none';
      state.kids.forEach((k, i) => { k.style.display = state.childDisplay[i]; });
      row.style.display = state.rowDisplay;
      state.toggle.textContent = 'Show diff';
    } else {
      state.root.style.display = '';
      state.kids.forEach(k => { k.style.display = 'none'; });
      row.style.display = 'block';
      state.toggle.textContent = 'Show original';
    }
    state.showingDiff = !state.showingDiff;
  }

  // The display we last wrote on a tracked row or one of its kids; null for
  // anything untracked.
  function recordedDisplay(el) {
    const state = rowState.get(el);
    if (state) return state.showingDiff ? 'block' : state.rowDisplay;
    const parent = el.parentElement;
    const pstate = parent && rowState.get(parent);
    if (!pstate) return null;
    const i = pstate.kids.indexOf(el);
    return i < 0 ? null : (pstate.showingDiff ? 'none' : pstate.childDisplay[i]);
  }

  // True only when every record is one of ours: mutations inside our
  // artifacts (expander, view toggle, root display), style writes on a
  // tracked row or kid that still hold the display we set, and flag writes
  // on a row that is still processed. Anything else - Jira editing a kid's
  // style, stripping the flag, swapping nodes - is real drift and must
  // schedule a scan.
  function isOwnMutation(records) {
    for (const rec of records) {
      const target = rec.target;
      const el = target && target.nodeType === 1 ? target : target && target.parentElement;
      if (!el) return false;
      if (el.closest(OWN_SELECTOR)) continue;
      if (rec.type !== 'attributes') return false;
      if (rec.attributeName === 'style') {
        const expected = recordedDisplay(el);
        if (expected === null || el.style.display !== expected) return false;
      } else if (rec.attributeName === CONFIG.processedAttr) {
        if (!el.hasAttribute(CONFIG.processedAttr) || !rowState.has(el)) {
          return false;
        }
      } else return false;
    }
    return records.length > 0;
  }

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    if (JDV._observer) JDV._observer.disconnect();
    let timer = 0;
    const observer = new MutationObserver((records) => {
      if (isOwnMutation(records)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        JDV.scan(document);
        observer.takeRecords();
      }, CONFIG.debounceMs);
    });
    JDV._observer = observer;
    // Attributes are bounded to the two that matter: style is the channel
    // display drift arrives on, the flag's removal orphans a row's artifacts.
    observer.observe(document, {
      childList: true, subtree: true, characterData: true,
      attributes: true,
      attributeFilter: ['style', CONFIG.processedAttr]
    });
    JDV.scan(document);
    observer.takeRecords();
  }
})();
