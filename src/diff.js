'use strict';

/**
 * Annotates a parsed INI model with differences against a baseline model
 * (typically a factory-default export of the same SBC).
 *
 * Matching rules
 *  - Sections by name (case-insensitive)
 *  - Table rows by their index (first cell), key/value rows by key
 *  - Columns by FORMAT column name, so a baseline from a different firmware still lines up
 *  - A row that is new in this file is compared with the baseline's first row of the same table
 *    (the factory template, e.g. IPGroup 0 "Default_IPG"), so only non-default cells light up
 *
 * opts.ignore: ["Section", "Section/Key-or-Column", ...]  (case-insensitive)
 *   "InterfaceTable"          → whole section excluded (built per deployment)
 *   "SYSTEM Params/HALocalMAC" → one key (kv sections) or one column (tables) excluded
 *
 * Adds to each section:  s.diff = { newSection, removed: [{cells}], changes, ignored }
 * Adds to each row:      r.diff = { added, template, changed: { colIndex: baselineValue } }
 * Baseline-only sections are appended with s.diff.removedSection = true.
 */
function diffModels(cur, base, opts = {}) {
  const norm = (n) => String(n).trim().toLowerCase();
  const ignoreSec = new Set();
  const ignoreItem = new Map(); // section → Set(key or column)
  for (const entry of opts.ignore || []) {
    const [sec, item] = String(entry).split('/');
    if (item === undefined) ignoreSec.add(norm(sec));
    else {
      if (!ignoreItem.has(norm(sec))) ignoreItem.set(norm(sec), new Set());
      ignoreItem.get(norm(sec)).add(norm(item));
    }
  }

  const baseSecs = new Map(base.sections.filter((s) => s.kind !== 'comment').map((s) => [norm(s.name), s]));
  const seen = new Set();
  let total = 0;

  for (const s of cur.sections) {
    if (s.kind === 'comment') continue;
    const sk = norm(s.name);
    seen.add(sk);
    if (ignoreSec.has(sk)) {
      s.diff = { ignored: true, removed: [], changes: 0 };
      continue;
    }
    const skip = ignoreItem.get(sk) || new Set();
    const colSkipped = (ci) => skip.has(norm(s.columns[ci]));
    const b = baseSecs.get(sk);

    if (!b) {
      let n = 0;
      s.rows.forEach((r) => {
        if (s.kind === 'kv' && skip.has(norm(r.cells[0]))) return;
        r.diff = { added: true };
        n++;
      });
      s.diff = { newSection: true, removed: [], changes: n };
      total += n;
      continue;
    }

    // column name → index in the baseline section
    const bCol = new Map(b.columns.map((c, i) => [norm(c), i]));
    const colIn = (ci) => (ci === 0 ? 0 : bCol.has(norm(s.columns[ci])) ? bCol.get(norm(s.columns[ci])) : -1);
    const bRows = new Map(b.rows.map((r) => [norm(r.cells[0]), r]));
    const template = s.kind === 'table' ? b.rows[0] : null;
    const curKeys = new Set();
    let changes = 0;

    const compare = (r, br) => {
      const changed = {};
      for (let ci = 1; ci < s.columns.length; ci++) {
        if (colSkipped(ci)) continue;
        const bi = colIn(ci);
        const bv = bi >= 0 ? br.cells[bi] ?? '' : undefined;
        if (bv === undefined) {
          if ((r.cells[ci] ?? '') !== '') changed[ci] = '(not in baseline)';
        } else if ((r.cells[ci] ?? '') !== bv) {
          changed[ci] = bv;
        }
      }
      return changed;
    };

    for (const r of s.rows) {
      const k = norm(r.cells[0]);
      curKeys.add(k);
      if (s.kind === 'kv' && skip.has(k)) continue;
      const br = bRows.get(k);
      if (!br) {
        r.diff = { added: true };
        if (template) {
          r.diff.template = `${b.name} ${template.cells[0]}`;
          r.diff.changed = compare(r, template);
        }
        changes++;
        continue;
      }
      const changed = compare(r, br);
      if (Object.keys(changed).length) {
        r.diff = { changed };
        changes++;
      }
    }

    // Baseline rows that no longer exist in the current file, re-mapped onto current columns
    const removed = b.rows
      .filter((br) => !curKeys.has(norm(br.cells[0])) && !(s.kind === 'kv' && skip.has(norm(br.cells[0]))))
      .map((br) => ({
        removed: true,
        line: -1,
        cells: s.columns.map((_, ci) => {
          const bi = colIn(ci);
          return bi >= 0 ? br.cells[bi] ?? '' : '';
        })
      }));
    changes += removed.length;
    s.diff = { newSection: false, removed, changes };
    total += changes;
  }

  // Sections present only in the baseline
  for (const [k, b] of baseSecs) {
    if (seen.has(k) || ignoreSec.has(k) || !b.rows.length) continue;
    cur.sections.push({
      ...b,
      rows: [],
      diff: { removedSection: true, removed: b.rows.map((r) => ({ removed: true, line: -1, cells: r.cells.slice() })), changes: b.rows.length }
    });
    total += b.rows.length;
  }

  cur.diffTotal = total;
  return cur;
}

module.exports = { diffModels };
