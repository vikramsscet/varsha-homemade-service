'use strict';

// Resolves a country name ("India") or ISO 3166-1 alpha-2 code ("in") to the alpha-2 code.
// Uses the runtime's built-in ICU data, so no dependency or hand-maintained list.
const display = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const A = 65;

let byName;
let codes;
const load = () => {
  if (byName) return;
  byName = new Map();
  codes = new Set();
  for (let i = 0; i < 26; i += 1) {
    for (let j = 0; j < 26; j += 1) {
      const code = String.fromCharCode(A + i, A + j);
      let name;
      try {
        name = display.of(code);
      } catch {
        name = undefined;
      }
      if (name) {
        codes.add(code);
        byName.set(name.toLowerCase(), code);
      }
    }
  }
};

const toCode = (value) => {
  load();
  const v = String(value).trim();
  const upper = v.toUpperCase();
  if (upper.length === 2 && codes.has(upper)) return upper;
  return byName.get(v.toLowerCase()) || null;
};

const toName = (code) => display.of(code) || code;

module.exports = { toCode, toName };
