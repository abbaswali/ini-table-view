// Webview script for INI Table View
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const app = $('app'), navList = $('navList'), content = $('content');

  const saved = vscode.getState() || {};
  const state = {
    model: null,
    settings: { navPosition: 'top', hideEmptySections: true, navSort: 'grouped', keyOnly: false, keySections: [] },
    keyMap: new Map(),                          // lower-case section name → { group, color, order }
    collapsed: new Set(saved.collapsed || []),  // section names
    formView: new Set(saved.formView || []),    // section names
    secFilters: saved.secFilters || {},         // section name → { q, col }
    colWidths: saved.colWidths || {},           // section name → { colIndex: px }
    wrap: !!saved.wrap,
    showAll: new Set(),                        // sections where the row cap was lifted
    baseline: null,
    diffMode: saved.diffMode || 'all',
    sectionFilter: saved.sectionFilter || '',
    search: saved.search || '',
    scrollTop: saved.scrollTop || 0
  };

  const persist = () =>
    vscode.setState({
      collapsed: [...state.collapsed], formView: [...state.formView], secFilters: state.secFilters,
      colWidths: state.colWidths, wrap: state.wrap, diffMode: state.diffMode, sectionFilter: state.sectionFilter,
      search: state.search, scrollTop: content.scrollTop
    });

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const secId = (i) => 'sec-' + i;
  const setting = (key, value) => vscode.postMessage({ type: 'setting', key, value });

  // ---------- matching: substring, wildcards (* ?), "exact" ----------
  // "teams"        → any value containing teams
  // teams-oc*      → value starting with teams-oc     *8091*  → contains 8091
  // "OC-Anchor"    → exactly OC-Anchor                 all matching is case-insensitive
  function makeMatcher(q) {
    q = (q || '').trim();
    if (!q) return null;
    const exact = /^".*"$/.test(q) && q.length >= 2;
    if (exact) {
      const v = q.slice(1, -1).toLowerCase();
      return (s) => String(s).toLowerCase() === v;
    }
    if (/[*?]/.test(q)) {
      const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return (s) => re.test(String(s));
    }
    const v = q.toLowerCase();
    return (s) => String(s).toLowerCase().includes(v);
  }

  // ---------- global controls ----------
  $('sectionFilter').value = state.sectionFilter;
  $('valueSearch').value = state.search;
  $('wrapText').checked = state.wrap;

  let t;
  const debounce = (fn, ms = 150) => { clearTimeout(t); t = setTimeout(fn, ms); };

  $('sectionFilter').addEventListener('input', (e) => { state.sectionFilter = e.target.value.toLowerCase(); debounce(render); });
  $('valueSearch').addEventListener('input', (e) => { state.search = e.target.value; debounce(render); });
  $('hideEmpty').addEventListener('change', (e) => setting('hideEmptySections', e.target.checked));
  $('navSort').addEventListener('change', (e) => setting('navSort', e.target.value));
  $('keyOnly').addEventListener('change', (e) => setting('keyOnly', e.target.checked));
  $('wrapText').addEventListener('change', (e) => { state.wrap = e.target.checked; render(); });
  $('togglePos').addEventListener('click', () =>
    setting('navPosition', state.settings.navPosition === 'top' ? 'right' : 'top'));
  $('collapseAll').addEventListener('click', () => {
    const secs = visibleSections();
    const allCollapsed = secs.every(({ s }) => state.collapsed.has(s.name));
    secs.forEach(({ s }) => (allCollapsed ? state.collapsed.delete(s.name) : state.collapsed.add(s.name)));
    render();
  });

  // Ctrl/Cmd+F → value search, Ctrl/Cmd+Shift+F → tab filter
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      (e.shiftKey ? $('sectionFilter') : $('valueSearch')).focus();
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type !== 'model') return;
    const first = !state.model;
    state.model = msg.model;
    state.settings = msg.settings;
    state.baseline = msg.baseline;
    buildKeyMap();
    renderBaselineBar();
    $('fileName').textContent = msg.fileName;
    render();
    if (first) content.scrollTop = state.scrollTop;
  });

  // ---------- baseline comparison controls ----------
  const diffOn = () => !!(state.baseline && !state.baseline.error);
  const changesOnly = () => diffOn() && state.diffMode === 'changes';
  $('pickBaseline').addEventListener('click', () => vscode.postMessage({ type: 'pickBaseline' }));
  $('changeBaseline').addEventListener('click', () => vscode.postMessage({ type: 'pickBaseline' }));
  $('clearBaseline').addEventListener('click', () => vscode.postMessage({ type: 'clearBaseline' }));
  $('diffMode').addEventListener('change', (e) => { state.diffMode = e.target.value; render(); });

  function renderBaselineBar() {
    const b = state.baseline;
    $('pickBaseline').hidden = diffOn();
    $('baselineOn').hidden = !diffOn();
    $('pickBaseline').classList.toggle('warn', !!(b && b.error));
    $('pickBaseline').title = b && b.error ? b.error : 'Compare this file with a default / baseline INI';
    if (diffOn()) {
      $('baselineName').textContent = `vs ${b.name}${b.isDefault ? ' (default)' : ''} · Δ ${state.model.diffTotal || 0}`;
      $('baselineName').title = b.path;
      $('diffMode').value = state.diffMode;
    }
  }

  content.addEventListener('scroll', () => debounce(persist, 300), { passive: true });

  function buildKeyMap() {
    state.keyMap.clear();
    let order = 0;
    (state.settings.keySections || []).forEach((g) =>
      (g.sections || []).forEach((name) => {
        const k = String(name).toLowerCase();
        if (!state.keyMap.has(k)) state.keyMap.set(k, { group: g.group, color: g.color, order: order++ });
      }));
  }
  const keyInfo = (s) => state.keyMap.get(s.name.toLowerCase());

  // ---------- filtering ----------
  function baseRows(s) {
    if (!diffOn() || !s.diff) return s.rows;
    const all = s.rows.concat(s.diff.removed || []);
    return changesOnly() ? all.filter((r) => r.diff || r.removed) : all;
  }

  function globalRows(s) {
    const m = makeMatcher(state.search);
    const rows = baseRows(s);
    return m ? rows.filter((r) => r.cells.some(m)) : rows;
  }

  function sectionRows(s) {
    const rows = globalRows(s);
    const f = state.secFilters[s.name];
    const m = f && makeMatcher(f.q);
    if (!m) return rows;
    const col = f.col === undefined || f.col === '' ? -1 : Number(f.col);
    return rows.filter((r) => (col < 0 ? r.cells.some(m) : m(r.cells[col] ?? '')));
  }

  function visibleSections() {
    if (!state.model) return [];
    const gm = makeMatcher(state.search);
    return state.model.sections
      .map((s, i) => ({ s, i, rows: globalRows(s), key: keyInfo(s) }))
      .filter(({ s, rows }) => {
        if (state.sectionFilter && !s.name.toLowerCase().includes(state.sectionFilter)) return false;
        if (s.diff && s.diff.removedSection && !diffOn()) return false;
        if (changesOnly() && !(s.diff && s.diff.changes)) return false;
        if (diffOn() && s.diff && s.diff.changes && !gm) return true;
        if (gm) return rows.length > 0 || gm(s.name);
        if (state.settings.hideEmptySections && s.rows.length === 0) return false;
        return true;
      });
  }

  const reveal = (line) => vscode.postMessage({ type: 'reveal', line });

  function valueCell(tag, value, matchers) {
    const c = el(tag, 'val', value);
    const v = String(value);
    if (v === '') c.classList.add('empty');
    else if (/^-?\d+$/.test(v)) c.classList.add('num');
    if (v !== '' && matchers.some((m) => m(v))) c.classList.add('hit');
    c.title = v + '\n(Alt+click to copy)';
    c.addEventListener('click', (e) => { if (e.altKey) vscode.postMessage({ type: 'copy', text: v }); });
    return c;
  }

  // ---------- nav ----------
  function makeTab(x) {
    const { s, i, rows, key } = x;
    const tab = el('button', 'tab' + (key ? ' key' : ''));
    tab.dataset.target = secId(i);
    if (key) { tab.style.setProperty('--g', key.color); tab.title = `${key.group}: ${s.name}`; }
    else tab.title = s.name;
    tab.append(el('span', 'tab-name', s.name));
    if (s.rows.length) tab.append(el('span', 'badge', state.search.trim() ? `${rows.length}/${s.rows.length}` : String(s.rows.length)));
    if (diffOn() && s.diff && s.diff.changes) {
      const d = el('span', 'badge delta', 'Δ' + s.diff.changes);
      d.title = `${s.diff.changes} difference(s) vs baseline`;
      tab.append(d);
      tab.classList.add('has-delta');
    }
    tab.addEventListener('click', () => {
      spyPausedUntil = Date.now() + 1200;
      navList.querySelectorAll('.tab.active').forEach((b) => b.classList.remove('active'));
      tab.classList.add('active');
      state.collapsed.delete(s.name);
      const target = $(secId(i));
      target.classList.remove('collapsed');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 800);
    });
    return tab;
  }

  function groupLabel(text, color) {
    const g = el('div', 'nav-group', text);
    if (color) g.style.setProperty('--g', color);
    return g;
  }

  function renderNav(secs) {
    navList.replaceChildren();
    const { navSort, keyOnly } = state.settings;
    const byName = (a, b) => a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base' });
    const list = keyOnly ? secs.filter((x) => x.key) : secs.slice();

    if (navSort === 'alpha') list.sort(byName).forEach((x) => navList.append(makeTab(x)));
    else if (navSort === 'file') list.forEach((x) => navList.append(makeTab(x)));
    else {
      const groups = new Map();
      for (const x of list.filter((x) => x.key).sort((a, b) => a.key.order - b.key.order)) {
        if (!groups.has(x.key.group)) groups.set(x.key.group, { color: x.key.color, items: [] });
        groups.get(x.key.group).items.push(x);
      }
      for (const [name, g] of groups) {
        const wrap = el('div', 'nav-block');
        wrap.append(groupLabel(name, g.color));
        g.items.forEach((x) => wrap.append(makeTab(x)));
        navList.append(wrap);
      }
      const rest = list.filter((x) => !x.key).sort(byName);
      if (rest.length) {
        const wrap = el('div', 'nav-block other');
        wrap.append(groupLabel('Other (A–Z)'));
        rest.forEach((x) => wrap.append(makeTab(x)));
        navList.append(wrap);
      }
    }
    if (!navList.children.length) navList.append(el('div', 'empty-state small', 'No tabs match.'));
  }

  // ---------- render ----------
  function render() {
    persist();
    // remember focus in a section filter so a live model refresh doesn't steal it
    const act = document.activeElement;
    const refocus = act && act.dataset && act.dataset.secfilter
      ? { name: act.dataset.secfilter, pos: act.selectionStart } : null;

    const st = state.settings;
    app.className = 'nav-' + st.navPosition + (state.wrap ? ' wrap' : '');
    $('hideEmpty').checked = st.hideEmptySections;
    $('navSort').value = st.navSort || 'grouped';
    $('keyOnly').checked = !!st.keyOnly;
    $('togglePos').textContent = st.navPosition === 'top' ? '⇄ Tabs right' : '⇅ Tabs top';

    content.replaceChildren();
    if (!state.model) return;
    if (state.model.error) { content.append(el('div', 'error', 'Parse error: ' + state.model.error)); return; }

    const secs = visibleSections();
    renderNav(secs);
    const totalRows = secs.reduce((n, x) => n + x.rows.length, 0);
    $('stats').textContent = `${secs.length} / ${state.model.sections.length} sections · ${totalRows} rows`;
    if (diffOn()) $('baselineName').textContent = `vs ${state.baseline.name}${state.baseline.isDefault ? ' (default)' : ''} · Δ ${state.model.diffTotal || 0}`;

    if (!secs.length) {
      content.append(el('div', 'empty-state', 'Nothing matches. Loosen the filter, Sherlock.'));
      return;
    }

    for (const x of secs) content.append(buildSection(x));
    setupScrollSpy();

    if (refocus) {
      const inp = content.querySelector(`input[data-secfilter="${CSS.escape(refocus.name)}"]`);
      if (inp) { inp.focus(); inp.setSelectionRange(refocus.pos, refocus.pos); }
    }
  }

  function buildSection({ s, i, key }) {
    const block = el('section', 'section' + (key ? ' key' : ''));
    block.id = secId(i);
    if (key) block.style.setProperty('--g', key.color);
    if (state.collapsed.has(s.name)) block.classList.add('collapsed');

    const head = el('div', 'section-head');
    const title = el('h2', null);
    const meta = el('span', 'meta');
    title.append(el('span', 'chev', '▸'), document.createTextNode(' ' + s.name));
    if (key) title.append(el('span', 'group-pill', key.group));
    if (diffOn() && s.diff) {
      if (s.diff.ignored) title.append(el('span', 'diff-pill ign', 'not compared'));
      else if (s.diff.newSection) title.append(el('span', 'diff-pill add', 'not in baseline'));
      else if (s.diff.removedSection) title.append(el('span', 'diff-pill rem', 'only in baseline'));
      if (s.diff.changes) title.append(el('span', 'diff-pill chg', `Δ ${s.diff.changes}`));
    }
    title.append(meta);
    title.addEventListener('click', () => {
      state.collapsed.has(s.name) ? state.collapsed.delete(s.name) : state.collapsed.add(s.name);
      block.classList.toggle('collapsed');
      persist();
    });
    head.append(title);

    const actions = el('div', 'actions');

    // Per-section filter (only for sections with more than a couple of rows)
    if (s.rows.length > 2) {
      const f = state.secFilters[s.name] || { q: '', col: '' };
      const box = el('div', 'secfilter');
      const colSel = el('select');
      colSel.title = 'Column to filter on';
      colSel.append(new Option('All columns', ''));
      s.columns.forEach((c, ci) => colSel.append(new Option(c, String(ci))));
      colSel.value = f.col || '';
      const inp = el('input');
      inp.type = 'search';
      inp.placeholder = 'Filter… (teams*, *8091*, "exact")';
      inp.value = f.q || '';
      inp.dataset.secfilter = s.name;
      inp.title = 'Substring: teams   Wildcards: teams-oc*  *8091*  ?   Exact: "OC-Anchor"';
      const apply = () => {
        state.secFilters[s.name] = { q: inp.value, col: colSel.value };
        if (!inp.value) delete state.secFilters[s.name];
        refreshBody(block, s, meta);
        persist();
      };
      let ft;
      inp.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(apply, 120); });
      colSel.addEventListener('change', apply);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { inp.value = ''; apply(); } });
      inp.addEventListener('click', (e) => e.stopPropagation());
      box.append(colSel, inp);
      actions.append(box);
    }

    if (s.kind === 'table' && s.rows.length) {
      const viewBtn = el('button', null, state.formView.has(s.name) ? '▦ Table' : '☰ Form');
      viewBtn.title = 'Switch between table and form (one card per row) view';
      viewBtn.addEventListener('click', () => {
        state.formView.has(s.name) ? state.formView.delete(s.name) : state.formView.add(s.name);
        viewBtn.textContent = state.formView.has(s.name) ? '▦ Table' : '☰ Form';
        refreshBody(block, s, meta);
        persist();
      });
      actions.append(viewBtn);
    }
    const goBtn = el('button', null, `↗ Line ${s.line + 1}`);
    goBtn.title = 'Open the raw text at this section';
    goBtn.addEventListener('click', () => reveal(s.line));
    actions.append(goBtn);
    head.append(actions);
    block.append(head, el('div', 'section-body'));
    refreshBody(block, s, meta);
    return block;
  }

  function refreshBody(block, s, meta) {
    const rows = sectionRows(s);
    const total = baseRows(s).length;
    const filtered = rows.length !== total;
    meta.textContent = (filtered ? `${rows.length} of ` : '') + `${total} row${total === 1 ? '' : 's'}` +
      (s.kind === 'table' ? ` · ${s.columns.length - 1} fields` : '');
    meta.classList.toggle('filtered', filtered);

    const matchers = [makeMatcher(state.search), makeMatcher(state.secFilters[s.name]?.q)].filter(Boolean);
    const body = el('div', 'section-body');
    // Draw large sections in chunks so huge files don't freeze the view
    const form = s.kind === 'table' && state.formView.has(s.name);
    const cap = form ? 200 : 1500;
    let shown = rows;
    let more = null;
    if (rows.length > cap && !state.showAll.has(s.name)) {
      shown = rows.slice(0, cap);
      more = el('button', 'show-more', `Show all ${rows.length} rows (showing first ${cap}) · or use the filter above`);
      more.addEventListener('click', () => { state.showAll.add(s.name); refreshBody(block, s, meta); });
    }
    if (!rows.length) body.append(el('div', 'empty-state small', s.rows.length ? 'No rows match the filter.' : 'Empty section.'));
    else if (form) body.append(renderForm(s, shown, matchers));
    else body.append(renderTable(s, shown, matchers));
    if (more) body.append(more);
    block.querySelector('.section-body').replaceWith(body);
  }

  // ---------- tables ----------
  // Which columns to show: everything, or in "Changes only" mode just Index, Name and changed columns
  function visibleCols(s, rows) {
    const all = s.columns.map((_, ci) => ci);
    if (!changesOnly() || s.kind !== 'table') return all;
    if (rows.some((r) => r.removed || (r.diff && r.diff.added && !r.diff.changed))) return all;
    const keep = new Set([0]);
    const nameIdx = s.columns.findIndex((c, ci) => ci > 0 && /name$/i.test(c));
    if (nameIdx > 0) keep.add(nameIdx);
    rows.forEach((r) => r.diff && r.diff.changed && Object.keys(r.diff.changed).forEach((ci) => keep.add(Number(ci))));
    return all.filter((ci) => keep.has(ci));
  }

  function markRow(tr, r) {
    if (r.removed) { tr.classList.add('removed'); tr.title = 'Only in baseline (removed from this file)'; }
    else if (r.diff && r.diff.added) {
      tr.classList.add('added');
      tr.title = r.diff.template ? `New row; amber cells differ from the default row (${r.diff.template})` : 'Not in baseline (added)';
    }
  }

  function markCell(td, r, ci) {
    const ch = r.diff && r.diff.changed;
    if (!ch || !(ci in ch)) return;
    td.classList.add('chg');
    const src = r.diff.template ? `Default (from baseline ${r.diff.template})` : 'Baseline';
    td.title = `${src}: ${ch[ci] === '' ? '(empty)' : ch[ci]}\nNow: ${r.cells[ci] === '' ? '(empty)' : r.cells[ci]}\n(Alt+click to copy)`;
  }

  function renderTable(s, rows, matchers) {
    const wrap = el('div', 'table-wrap');
    const cols = visibleCols(s, rows);
    const narrow = s.kind !== 'table' || cols.length <= 6;
    const table = el('table', 'grid ' + s.kind + (narrow ? ' narrow' : ''));
    const thead = el('thead');
    const hr = el('tr');
    const widths = state.colWidths[s.name] || {};
    cols.forEach((ci) => {
      const th = el('th', null);
      th.dataset.ci = ci;
      th.append(el('span', 'th-label', s.columns[ci]));
      const grip = el('span', 'resizer');
      grip.title = 'Drag to resize · double-click to auto-fit';
      grip.addEventListener('mousedown', (e) => startResize(e, table, th, s.name, ci));
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (state.colWidths[s.name]) delete state.colWidths[s.name][ci];
        setColWidth(table, ci, null);
        persist();
      });
      th.append(grip);
      hr.append(th);
    });
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      markRow(tr, r);
      if (r.line >= 0) tr.addEventListener('dblclick', (e) => { if (!e.target.classList.contains('resizer')) reveal(r.line); });
      for (const ci of cols) {
        const td = valueCell('td', r.cells[ci] ?? '', matchers);
        td.dataset.ci = ci;
        if (ci === 0) td.classList.add('key');
        markCell(td, r, ci);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    for (const [ci, w] of Object.entries(widths)) setColWidth(table, Number(ci), w);
    if (cols.length < s.columns.length) {
      wrap.append(el('div', 'col-note', `Showing ${cols.length} of ${s.columns.length} columns (changed ones only)`));
    }
    return wrap;
  }

  function setColWidth(table, ci, w) {
    const v = w ? w + 'px' : '';
    table.querySelectorAll(`[data-ci="${ci}"]`).forEach((c) => {
      c.style.width = v; c.style.minWidth = v; c.style.maxWidth = v;
      c.classList.toggle('sized', !!w);
    });
  }

  function startResize(e, table, th, secName, ci) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = th.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const width = (ev) => Math.max(36, Math.round(startW + ev.clientX - startX));
    const move = (ev) => setColWidth(table, ci, width(ev));
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      (state.colWidths[secName] = state.colWidths[secName] || {})[ci] = width(ev);
      persist();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function renderForm(s, rows, matchers) {
    const wrap = el('div', 'cards');
    for (const r of rows) {
      const card = el('div', 'card');
      if (r.removed) card.classList.add('removed');
      else if (r.diff && r.diff.added) card.classList.add('added');
      const h = el('div', 'card-head');
      h.append(el('span', null, `${s.columns[0]} ${r.cells[0]}`));
      const nameIdx = s.columns.findIndex((c) => /name$/i.test(c));
      if (nameIdx > 0 && r.cells[nameIdx]) h.append(el('strong', null, r.cells[nameIdx]));
      if (r.removed) h.append(el('span', 'diff-pill rem', 'only in baseline'));
      else if (r.diff && r.diff.added) h.append(el('span', 'diff-pill add', 'added'));
      if (r.line >= 0) {
        const go = el('button', null, `↗ ${r.line + 1}`);
        go.addEventListener('click', () => reveal(r.line));
        h.append(go);
      }
      card.append(h);
      const grid = el('table', 'form');
      const changed = r.diff && r.diff.changed;
      for (let ci = 1; ci < s.columns.length; ci++) {
        if (changesOnly() && changed && !(ci in changed)) continue;
        const tr = el('tr');
        const td = valueCell('td', r.cells[ci] ?? '', matchers);
        markCell(td, r, ci);
        tr.append(el('th', null, s.columns[ci]), td);
        grid.append(tr);
      }
      card.append(grid);
      wrap.append(card);
    }
    return wrap;
  }

  // ---------- scroll spy ----------
  let observer;
  let spyPausedUntil = 0;
  function setupScrollSpy() {
    if (observer) observer.disconnect();
    const tabs = new Map([...navList.querySelectorAll('.tab')].map((b) => [b.dataset.target, b]));
    observer = new IntersectionObserver((entries) => {
      if (Date.now() < spyPausedUntil) return;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        tabs.forEach((b) => b.classList.remove('active'));
        const b = tabs.get(en.target.id);
        if (b) { b.classList.add('active'); b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      }
    }, { root: content, rootMargin: '0px 0px -80% 0px' });
    content.querySelectorAll('.section').forEach((s) => observer.observe(s));
  }

  vscode.postMessage({ type: 'ready' });
})();
