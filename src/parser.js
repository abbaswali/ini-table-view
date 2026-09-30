'use strict';

/**
 * Parses INI text into a model of sections.
 * Handles:
 *  - Standard INI:            [Section]  key = value
 *  - AudioCodes table INI:    [ ProxySet ] ... FORMAT Index = A, B, C; ... ProxySet 0 = "x", 1, 2; ... [ \ProxySet ]
 *  - Comments (; or #) — a leading comment block before any section becomes a "File header" section.
 *
 * Section shape:
 *  { name, line, kind: 'table' | 'kv' | 'comment', columns: [], rows: [{ line, cells: [] }] }
 */
function parseIni(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  let header = null;
  let seenSection = false;

  const startSection = (name, line) => {
    seenSection = true;
    current = { name, line, kind: 'kv', columns: ['Key', 'Value'], rows: [], hasFormat: false };
    sections.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;

    // Section open / close: [ Name ]  or  [ \Name ]
    const sec = /^\[\s*(.*?)\s*\]$/.exec(t);
    if (sec) {
      const name = sec[1];
      if (name.startsWith('\\')) {
        current = null; // AudioCodes closing tag
      } else {
        startSection(name, i);
      }
      continue;
    }

    // Comments
    if (t.startsWith(';') || t.startsWith('#')) {
      if (!seenSection) {
        if (!header) {
          header = { name: 'File header', line: i, kind: 'comment', columns: ['Comment'], rows: [] };
          sections.push(header);
        }
        header.rows.push({ line: i, cells: [t.replace(/^[;#]\s?/, '')] });
      }
      continue;
    }

    // Lines outside any section (plain key=value at the top of a standard INI)
    if (!current) startSection('(global)', i);

    const eq = t.indexOf('=');
    if (eq === -1) {
      current.rows.push({ line: i, cells: [t, ''] });
      continue;
    }

    const lhs = t.slice(0, eq).trim();
    let rhs = t.slice(eq + 1).trim();

    // FORMAT line → column headers
    if (/^FORMAT\s/i.test(lhs)) {
      if (rhs.endsWith(';')) rhs = rhs.slice(0, -1);
      const keySpec = lhs.replace(/^FORMAT\s+/i, '').trim();
      current.kind = 'table';
      current.hasFormat = true;
      current.columns = [keySpec, ...splitValues(rhs)];
      current.rows = current.rows.filter(r => r.table); // drop anything captured before FORMAT
      continue;
    }

    if (current.hasFormat) {
      // Table row: "TableName idx [idx...] = v1, v2, ...;"
      if (rhs.endsWith(';')) rhs = rhs.slice(0, -1);
      const lhsParts = lhs.split(/\s+/);
      const idx = lhsParts.slice(1).join(' ') || lhsParts[0];
      current.rows.push({ line: i, table: true, cells: [idx, ...splitValues(rhs)] });
    } else {
      current.rows.push({ line: i, cells: [lhs, stripQuotes(rhs)] });
    }
  }

  // Keep column count consistent for tables (pad short rows, extend header for long rows)
  for (const s of sections) {
    if (s.kind !== 'table') continue;
    const width = Math.max(s.columns.length, ...s.rows.map(r => r.cells.length));
    while (s.columns.length < width) s.columns.push(`(col ${s.columns.length})`);
    for (const r of s.rows) while (r.cells.length < width) r.cells.push('');
  }

  return { sections };
}

/** Split a comma-separated value list, respecting "quoted, strings". Quotes are removed. */
function splitValues(s) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

function stripQuotes(v) {
  // strip one pair of wrapping quotes, but leave quoted lists like 'a', 'b', 'c' intact
  if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0] && !v.slice(1, -1).includes(v[0])) return v.slice(1, -1);
  return v;
}

module.exports = { parseIni, splitValues };
