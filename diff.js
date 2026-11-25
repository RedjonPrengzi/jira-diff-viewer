(function () {
  'use strict';

  const JDV = (globalThis.JDV = globalThis.JDV || {});

  JDV.COLLAPSE_THRESHOLD = 600;

  // The diff runs on tokens, not characters: letter/number/underscore runs,
  // whitespace runs and punctuation runs each become one token. Unicode-aware
  // so umlauts and non-latin scripts stay inside word tokens. The trade-off
  // is that a change at the tail of a long unbroken run (e.g. 300 identical
  // characters) highlights the whole run - that is intended.
  const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]+/gu;

  // Each unique token maps to one private-use char so diff_main compares
  // whole tokens. U+E000..U+F8FF minus slack gives 0x1800 chars; a diff that
  // needs more falls back to raw character input.
  const TOKEN_BASE = 0xe000;
  const TOKEN_MAX = 0x1800;

  // Shared table and index so identical tokens on both sides map to the same
  // char. Returns null once the token space is exhausted.
  function encodeTokens(text, table, index) {
    const tokens = text.match(TOKEN_RE) || [];
    let out = '';
    for (const token of tokens) {
      let code = index.get(token);
      if (code === undefined) {
        if (table.length >= TOKEN_MAX) return null;
        code = table.length;
        table.push(token);
        index.set(token, code);
      }
      out += String.fromCharCode(TOKEN_BASE + code);
    }
    return out;
  }

  function decodeChars(text, table) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      out += table[text.charCodeAt(i) - TOKEN_BASE];
    }
    return out;
  }

  JDV.buildSegments = function (oldText, newText, threshold) {
    const DMP = globalThis.diff_match_patch;
    if (typeof DMP !== 'function') {
      throw new Error('diff_match_patch is not loaded');
    }
    const oldStr = oldText == null ? '' : String(oldText);
    const newStr = newText == null ? '' : String(newText);
    const limit = typeof threshold === 'number' && !Number.isNaN(threshold)
      ? threshold
      : JDV.COLLAPSE_THRESHOLD;

    const dmp = new DMP();
    const table = [];
    const index = new Map();
    const oldEnc = encodeTokens(oldStr, table, index);
    const newEnc = encodeTokens(newStr, table, index);
    // Token space exhausted: diff the raw texts. Character-level output but
    // never wrong.
    const raw = oldEnc === null || newEnc === null;
    const diffs = dmp.diff_main(raw ? oldStr : oldEnc, raw ? newStr : newEnc);
    dmp.diff_cleanupSemantic(diffs);

    const DEL = typeof globalThis.DIFF_DELETE === 'number' ? globalThis.DIFF_DELETE : -1;
    const INS = typeof globalThis.DIFF_INSERT === 'number' ? globalThis.DIFF_INSERT : 1;

    const segments = [];
    for (const diff of diffs) {
      const op = diff[0];
      let text = diff[1];
      if (!raw) text = decodeChars(text, table);
      if (!text) continue;
      let type;
      if (op === DEL) type = 'del';
      else if (op === INS) type = 'ins';
      // A single all-equal diff (old === new) renders as plain text however
      // long it is; only equal runs shared with changes can collapse.
      else if (diffs.length === 1) type = 'equal';
      else type = text.length > limit ? 'collapsed' : 'equal';
      segments.push({ type, text });
    }

    return segments;
  };
})();
